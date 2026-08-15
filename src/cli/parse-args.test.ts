import { describe, test, expect } from "bun:test";
import { parseArgs, USAGE } from "./parse-args.ts";

function ok(argv: string[]) {
  const result = parseArgs(argv);
  if (!result.ok) throw new Error(`expected a parse, got: ${result.error}`);
  return result.args;
}

function err(argv: string[]) {
  const result = parseArgs(argv);
  if (result.ok) throw new Error(`expected an error, got: ${JSON.stringify(result.args)}`);
  return result.error;
}

describe("flags that take a value", () => {
  test("both spellings produce the same value", () => {
    expect(ok(["--model", "anthropic:claude-sonnet-4-5"]).flags.model).toBe(
      "anthropic:claude-sonnet-4-5",
    );
    expect(ok(["--model=anthropic:claude-sonnet-4-5"]).flags.model).toBe(
      "anthropic:claude-sonnet-4-5",
    );
  });

  test("a missing value is an error, not a `true` that crashes later", () => {
    // `--model` used to reach parseModelString(true) → TypeError before render.
    expect(err(["--model"])).toContain("no value given");
    // `--region` used to reach path.resolve(true) → ERR_INVALID_ARG_TYPE.
    expect(err(["--region"])).toContain("no value given");
    expect(err(["--model", "--debug"])).toContain("no value given");
    expect(err(["--model="])).toContain("no value given");
  });

  test("a value may start with a dash", () => {
    expect(ok(["--region", "-weird-dir"]).flags.region).toBe("-weird-dir");
    expect(ok(["--region=--weird-dir"]).flags.region).toBe("--weird-dir");
  });

  test("a value is taken literally, not re-parsed as a flag", () => {
    const { flags } = ok(["--model", "openai:gpt-4o", "--debug"]);
    expect(flags.model).toBe("openai:gpt-4o");
    expect(flags.debug).toBe(true);
  });
});

describe("flags that take no value", () => {
  test("booleans parse to true", () => {
    const { flags } = ok(["--continue", "--debug", "--no-index"]);
    expect(flags.continue).toBe(true);
    expect(flags.debug).toBe(true);
    expect(flags["no-index"]).toBe(true);
  });

  test("giving one a value is an error rather than a silent no-op", () => {
    expect(err(["--debug=verbose"])).toContain("does not take a value");
  });

  test("-h is help, the one short flag the docs promise", () => {
    expect(ok(["-h"]).flags.help).toBe(true);
  });
});

describe("--audit takes an optional value", () => {
  test("bare --audit means the most recent session", () => {
    expect(ok(["--audit"]).flags.audit).toBe(true);
  });

  test("--audit <id> keeps the id", () => {
    expect(ok(["--audit", "a1b2c3"]).flags.audit).toBe("a1b2c3");
  });
});

describe("enum validation", () => {
  test("an unknown mode names the valid ones", () => {
    const message = err(["--mode", "nonsense"]);
    expect(message).toContain("Unknown permission mode");
    expect(message).toContain("safe | standard | yolo");
  });

  test("an unknown sandbox names the valid ones", () => {
    const message = err(["--sandbox", "vm"]);
    expect(message).toContain("Unknown sandbox mode");
    expect(message).toContain("subprocess | docker");
  });

  test("valid values pass through", () => {
    const { flags } = ok(["--mode", "safe", "--sandbox", "docker"]);
    expect(flags.mode).toBe("safe");
    expect(flags.sandbox).toBe("docker");
  });
});

describe("unknown options", () => {
  test("a typo is rejected instead of ignored", () => {
    const message = err(["--modle", "openai:gpt-4o"]);
    expect(message).toContain("Unknown option: --modle");
  });

  test("a near miss suggests the real flag", () => {
    expect(err(["--mode-", "safe"])).toContain("did you mean --mode?");
    expect(err(["--edbug"])).toContain("did you mean --debug?");
  });
});

describe("positional arguments", () => {
  test("bare tokens are collected, and `--` ends flag parsing", () => {
    const { flags, positional } = ok(["hello", "--debug", "--", "--not-a-flag"]);
    expect(flags.debug).toBe(true);
    expect(positional).toEqual(["hello", "--not-a-flag"]);
  });

  test("no arguments is a clean empty parse", () => {
    expect(ok([])).toEqual({ flags: {}, positional: [] });
  });
});

describe("usage text", () => {
  test("documents every flag the parser accepts", () => {
    for (const flag of ["--region", "--mode", "--model", "--sandbox", "--no-index",
                        "--continue", "--rewind", "--sessions", "--audit", "--eval",
                        "--debug", "--help"]) {
      expect(USAGE).toContain(flag);
    }
  });

  test("documents the precedence chain the config loader implements", () => {
    expect(USAGE).toContain("CODEMON_MODEL");
    expect(USAGE).toContain("codemon.json");
    expect(USAGE).toContain("defaultModel");
  });
});
