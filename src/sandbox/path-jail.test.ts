import { describe, test, expect, beforeEach, beforeAll, afterAll } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { setProjectRoot, getProjectRoot, jailPath, isInsideJail } from "./path-jail.ts";

describe("Safari Zone Path Jail", () => {
  const root = "/tmp/test-project-root";

  beforeEach(() => {
    setProjectRoot(root);
  });

  test("returns correct project root", () => {
    expect(getProjectRoot()).toBe(root);
  });

  test("allows valid relative paths within root", () => {
    expect(jailPath("src/index.ts")).toBe(`${root}/src/index.ts`);
    expect(jailPath("./package.json")).toBe(`${root}/package.json`);
    expect(jailPath(".")).toBe(root);
  });

  test("blocks path traversal escape attempts", () => {
    expect(() => jailPath("../outside.txt")).toThrow("🔒 Access denied");
    expect(() => jailPath("../../etc/passwd")).toThrow("🔒 Access denied");
    expect(() => jailPath("src/../../etc/passwd")).toThrow("🔒 Access denied");
  });

  test("blocks absolute paths outside root", () => {
    expect(() => jailPath("/etc/passwd")).toThrow("🔒 Access denied");
    expect(() => jailPath("/tmp/other-project/file.txt")).toThrow("🔒 Access denied");
  });

  test("isInsideJail correctly identifies safe vs unsafe paths", () => {
    expect(isInsideJail("src/file.ts")).toBe(true);
    expect(isInsideJail("../outside.ts")).toBe(false);
    expect(isInsideJail("/etc/shadow")).toBe(false);
  });
});

describe("Path Jail — symlinks", () => {
  const originalRoot = getProjectRoot();
  let root: string;
  let outside: string;

  beforeAll(() => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codemon-jail-")));
    root = path.join(base, "project");
    outside = path.join(base, "outside");

    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(root, "src", "inside.ts"), "ok\n");
    fs.writeFileSync(path.join(outside, "secret.txt"), "secret\n");

    // A link inside the project that points out of it — `path.resolve` alone
    // yields an in-root string, so a prefix check would pass.
    fs.symlinkSync(outside, path.join(root, "escape"), "dir");
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "secret-link"), "file");
    fs.symlinkSync(path.join(root, "src"), path.join(root, "src-link"), "dir");
  });

  afterAll(() => {
    setProjectRoot(originalRoot);
    fs.rmSync(path.dirname(root), { recursive: true, force: true });
  });

  beforeEach(() => {
    setProjectRoot(root);
  });

  test("blocks reading through a directory symlink that leaves the root", () => {
    expect(() => jailPath("escape/secret.txt")).toThrow("Access denied");
    expect(isInsideJail("escape/secret.txt")).toBe(false);
  });

  test("blocks a file symlink pointing outside the root", () => {
    expect(() => jailPath("secret-link")).toThrow("Access denied");
  });

  test("blocks writing to a not-yet-created file under an escaping symlink", () => {
    // Nothing exists at this path, so the check has to resolve the deepest
    // ancestor that does — otherwise writes slip through where reads cannot.
    expect(() => jailPath("escape/planted.txt")).toThrow("Access denied");
  });

  test("still allows symlinks that stay inside the root", () => {
    expect(isInsideJail("src-link/inside.ts")).toBe(true);
    expect(jailPath("src-link/inside.ts")).toBe(path.join(root, "src-link", "inside.ts"));
  });

  test("still allows ordinary paths, existing or not", () => {
    expect(jailPath("src/inside.ts")).toBe(path.join(root, "src", "inside.ts"));
    expect(jailPath("src/brand-new.ts")).toBe(path.join(root, "src", "brand-new.ts"));
  });

  test("names the real destination in the error", () => {
    expect(() => jailPath("escape/secret.txt")).toThrow(outside);
  });
});
