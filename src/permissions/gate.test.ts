import { describe, test, expect, afterEach } from "bun:test";
import { checkPermission, recordUserDecision, rememberAlways, clearSessionGrants } from "./gate.ts";
import type { PermissionMode } from "./rules.ts";
import { PERMISSION_MODES } from "./rules.ts";
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
    expect(checkPermission("mcp__x__y", "network", "bogus" as PermissionMode)).toBe("ask");
  });
});

describe("network level", () => {
  test("a remote tool is never auto-allowed outside yolo", () => {
    // The whole reason `network` exists: classifying MCP tools as `write` would
    // have auto-allowed them in standard mode, the default.
    expect(checkPermission("mcp__github__search", "network", "safe")).toBe("ask");
    expect(checkPermission("mcp__github__search", "network", "standard")).toBe("ask");
    expect(checkPermission("mcp__github__search", "network", "yolo")).toBe("allow");
  });

  test("standard still auto-allows a local write, so the two are genuinely different", () => {
    expect(checkPermission("write_file", "write", "standard")).toBe("allow");
    expect(checkPermission("mcp__github__search", "network", "standard")).toBe("ask");
  });
});

describe("plan mode", () => {
  afterEach(() => clearSessionGrants());

  const plan = { planMode: true };

  test("writes are denied in every permission mode", () => {
    for (const mode of PERMISSION_MODES) {
      expect(checkPermission("write_file", "write", mode, { path: "a.ts" }, plan)).toBe("deny");
      expect(checkPermission("edit_file", "write", mode, { path: "a.ts" }, plan)).toBe("deny");
      expect(checkPermission("mcp__x__y", "network", mode, {}, plan)).toBe("deny");
    }
  });

  test("reads are untouched", () => {
    expect(checkPermission("read_file", "read", "safe", { path: "a.ts" }, plan)).toBe("allow");
    expect(checkPermission("todo_write", "read", "safe", {}, plan)).toBe("allow");
  });

  test("plan mode beats a session 'always allow' grant", () => {
    // The ordering bug this guards: `sessionAlways` is checked before the mode
    // rules, so a plan check placed after it would be bypassed by any tool the
    // user had previously blanket-approved.
    rememberAlways("write_file", "write");
    expect(checkPermission("write_file", "write", "yolo")).toBe("allow");
    expect(checkPermission("write_file", "write", "yolo", { path: "a.ts" }, plan)).toBe("deny");
  });

  test("read-only bash is let through to the normal rules, not waved past them", () => {
    // Narrowing only. `git log` still prompts in safe mode exactly as it would
    // without plan mode — plan mode may never widen what is permitted.
    expect(checkPermission("bash", "bash", "yolo", { command: "git log" }, plan)).toBe("allow");
    expect(checkPermission("bash", "bash", "safe", { command: "git log" }, plan)).toBe("ask");
    expect(checkPermission("bash", "bash", "standard", { command: "git log" }, plan)).toBe("ask");
  });

  test("bash that is not read-only is denied even in yolo", () => {
    expect(checkPermission("bash", "bash", "yolo", { command: "rm -rf ." }, plan)).toBe("deny");
    expect(checkPermission("bash", "bash", "yolo", { command: "git log | tee f" }, plan)).toBe("deny");
  });

  test("a bash call with no command argument is denied", () => {
    // Nothing to check means nothing that can be shown safe.
    expect(checkPermission("bash", "bash", "yolo", {}, plan)).toBe("deny");
  });

  test("plan-mode denials are recorded in the audit trail", () => {
    const before = dbListDecisions("").length;
    checkPermission("write_file", "write", "yolo", { path: "blocked.ts" }, plan);

    const after = dbListDecisions("");
    expect(after.length).toBe(before + 1);
    expect(after.at(-1)!.decision).toBe("deny");
    expect(after.at(-1)!.args).toContain("blocked.ts");
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
