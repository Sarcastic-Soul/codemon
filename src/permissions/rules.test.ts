import { describe, test, expect } from "bun:test";
import { getRuleSet, isPermissionMode, PERMISSION_MODES, type PermissionMode } from "./rules.ts";

describe("Poké Ball Permission Gate Rules", () => {
  test("safe mode auto-allows read, requires confirmation for write and bash", () => {
    const safe = getRuleSet("safe");
    expect(safe.autoAllow.has("read")).toBe(true);
    expect(safe.autoAllow.has("write")).toBe(false);
    expect(safe.autoAllow.has("bash")).toBe(false);
    expect(safe.requireConfirm.has("write")).toBe(true);
    expect(safe.requireConfirm.has("bash")).toBe(true);
  });

  test("standard mode auto-allows read and write, requires confirmation for bash", () => {
    const standard = getRuleSet("standard");
    expect(standard.autoAllow.has("read")).toBe(true);
    expect(standard.autoAllow.has("write")).toBe(true);
    expect(standard.autoAllow.has("bash")).toBe(false);
    expect(standard.requireConfirm.has("bash")).toBe(true);
    expect(standard.requireConfirm.has("write")).toBe(false);
  });

  test("yolo mode auto-allows read, write, and bash without confirmation", () => {
    const yolo = getRuleSet("yolo");
    expect(yolo.autoAllow.has("read")).toBe(true);
    expect(yolo.autoAllow.has("write")).toBe(true);
    expect(yolo.autoAllow.has("bash")).toBe(true);
    expect(yolo.requireConfirm.size).toBe(0);
  });

  test("an unknown mode fails closed instead of returning undefined", () => {
    // Modes reach here from config files and CLI flags that TypeScript never
    // checks. This used to return undefined and take the gate down with it.
    const bogus = getRuleSet("bogus" as PermissionMode);

    expect(bogus).toBeDefined();
    expect(bogus.autoAllow.size).toBe(0);
    expect(bogus.requireConfirm.has("read")).toBe(true);
    expect(bogus.requireConfirm.has("write")).toBe(true);
    expect(bogus.requireConfirm.has("bash")).toBe(true);
  });

  test("isPermissionMode accepts exactly the three real modes", () => {
    for (const mode of PERMISSION_MODES) {
      expect(isPermissionMode(mode)).toBe(true);
    }
    for (const value of ["bogus", "", "SAFE", true, undefined, null, 3]) {
      expect(isPermissionMode(value)).toBe(false);
    }
  });
});
