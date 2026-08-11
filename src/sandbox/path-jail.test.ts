import { describe, test, expect, beforeEach } from "bun:test";
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
