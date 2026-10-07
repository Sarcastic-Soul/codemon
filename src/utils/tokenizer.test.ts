import { describe, test, expect } from "bun:test";
import { formatTokenCount } from "./tokenizer.ts";

describe("formatTokenCount", () => {
  test("small counts are exact", () => {
    expect(formatTokenCount(0)).toBe("0");
    expect(formatTokenCount(999)).toBe("999");
  });

  test("thousands use k, without a trailing .0", () => {
    expect(formatTokenCount(2300)).toBe("2.3k");
    expect(formatTokenCount(8000)).toBe("8k");
    expect(formatTokenCount(200_000)).toBe("200k");
  });

  test("millions use M", () => {
    expect(formatTokenCount(1_040_384)).toBe("1.04M");
    expect(formatTokenCount(2_000_000)).toBe("2M");
  });
});
