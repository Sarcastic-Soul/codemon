import { describe, test, expect } from "bun:test";
import { checkPermission, recordUserDecision } from "./gate.ts";
import type { PermissionMode } from "./rules.ts";
import { dbListDecisions } from "../storage/audit.repo.ts";

describe("permission gate", () => {
  test("safe mode allows read and asks about write and bash", () => {
    expect(checkPermission("read_file", "read", "safe")).toBe("allow");
    expect(checkPermission("write_file", "write", "safe")).toBe("ask");
    expect(checkPermission("bash", "bash", "safe")).toBe("ask");
  });

  test("yolo mode allows everything", () => {
    expect(checkPermission("bash", "bash", "yolo")).toBe("allow");
  });

  test("an unknown mode asks rather than throwing", () => {
    // Previously: TypeError: undefined is not an object (reading 'autoDeny'),
    // on the first tool call of the session.
    expect(() => checkPermission("read_file", "read", "bogus" as PermissionMode)).not.toThrow();
    expect(checkPermission("read_file", "read", "bogus" as PermissionMode)).toBe("ask");
    expect(checkPermission("bash", "bash", "bogus" as PermissionMode)).toBe("ask");
  });
});

describe("audit trail", () => {
  test("gate decisions are persisted with their arguments", () => {
    // No session is active in tests, so decisions land under the empty id.
    const before = dbListDecisions("").length;

    checkPermission("read_file", "read", "yolo", { path: "src/audited.ts" });
    recordUserDecision("bash", "bash", false, { command: "rm -rf /" });

    const after = dbListDecisions("");
    expect(after.length).toBe(before + 2);

    const allow = after.at(-2)!;
    expect(allow.toolName).toBe("read_file");
    expect(allow.decision).toBe("allow");
    expect(allow.args).toContain("src/audited.ts");

    const denied = after.at(-1)!;
    expect(denied.toolName).toBe("bash");
    expect(denied.decision).toBe("ask-deny");
    expect(denied.args).toContain("rm -rf /");
  });

  test("oversized arguments are truncated rather than copied whole", () => {
    // write_file carries an entire file body; the trail wants an identifier,
    // not a second copy of the repository.
    checkPermission("write_file", "write", "yolo", { content: "x".repeat(50_000) });

    const latest = dbListDecisions("").at(-1)!;
    expect(latest.args).toContain("[truncated]");
    expect(latest.args.length).toBeLessThan(2_200);
  });
});
