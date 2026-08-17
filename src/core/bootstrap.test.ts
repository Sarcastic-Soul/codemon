import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { bootstrap } from "./bootstrap.ts";
import { closeDb } from "../storage/db.ts";
import { getProjectRoot, setProjectRoot } from "../sandbox/path-jail.ts";

let root: string;
let originalRoot: string;

beforeEach(() => {
  originalRoot = getProjectRoot();
  root = fs.mkdtempSync(path.join(os.tmpdir(), "codemon-boot-"));
});

afterEach(() => {
  setProjectRoot(originalRoot);
  // bootstrap() points the global handle at a database inside the temp dir.
  // Left open it would outlive the directory, and every later test in the run
  // would query a file that no longer exists.
  closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});

const boot = (flags: Record<string, string | true> = {}) =>
  bootstrap({ region: root, ...flags }, { isolated: true });

describe("bootstrap", () => {
  test("it returns a usable config for a temp dir", () => {
    const result = boot();

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.projectRoot).toBe(fs.realpathSync(root));
    expect(result.value.config.permissionMode).toBe("standard");
  });

  test("flags override the config", () => {
    const result = boot({ mode: "yolo", model: "openai:gpt-4o", plan: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.config.permissionMode).toBe("yolo");
    expect(result.value.config.model).toBe("openai:gpt-4o");
    expect(result.value.config.planMode).toBe(true);
  });

  test("plan mode is off unless asked for", () => {
    const result = boot();
    expect(result.ok && result.value.config.planMode).toBe(false);
  });

  test("a config file with a bad permission mode is an error, not a crash", () => {
    fs.mkdirSync(path.join(root, ".codemon"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".codemon", "config.json"),
      JSON.stringify({ permissionMode: "sudo" }),
    );

    const result = boot();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Unknown permission mode");
  });

  test("a bad sandbox mode is caught too", () => {
    fs.mkdirSync(path.join(root, ".codemon"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".codemon", "config.json"),
      JSON.stringify({ sandbox: "vm" }),
    );

    const result = boot();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Unknown sandbox mode");
  });

  test("it sets the path jail to the resolved region", () => {
    boot();
    expect(getProjectRoot()).toBe(fs.realpathSync(root));
  });

  test(".codemon is added to an existing .gitignore", () => {
    fs.writeFileSync(path.join(root, ".gitignore"), "node_modules\n");
    boot();

    expect(fs.readFileSync(path.join(root, ".gitignore"), "utf8")).toContain(".codemon/");
  });

  test("no stray .gitignore is written outside a repo", () => {
    boot();
    expect(fs.existsSync(path.join(root, ".gitignore"))).toBe(false);
  });

  test("a missing API key is reported rather than thrown", () => {
    const result = boot({ model: "anthropic:nonexistent-model-for-test" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Either a key is configured in this environment or it is not; both are
    // valid, but the two fields must agree.
    expect(result.value.keyError === null).toBe(result.value.provider !== undefined);
  });

  test("the database is created under the region", () => {
    boot();
    expect(fs.existsSync(path.join(root, ".codemon", "sessions.db"))).toBe(true);
  });
});
