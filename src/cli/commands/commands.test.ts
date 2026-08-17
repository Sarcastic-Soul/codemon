import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  ALL_COMMANDS,
  BUILTIN_COMMANDS,
  BUILTIN_NAMES,
  dispatchCommand,
  registerCommand,
  splitCommand,
  type CommandContext,
} from "./index.ts";
import { expandArguments, loadCustomCommands, parseCommandFile } from "./custom.ts";
import { planCommand } from "./plan.ts";
import { initCommand, INIT_PROMPT } from "./init.ts";
import { DEFAULTS } from "../../config/defaults.ts";

function context(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    exit: () => {},
    addMessage: () => {},
    setMessages: () => {},
    setShowConnectorModal: () => {},
    config: DEFAULTS,
    projectRoot: "/tmp",
    planMode: false,
    setPlanMode: () => {},
    ...overrides,
  } as CommandContext;
}

describe("command parsing", () => {
  test("the token is lowercased but the arguments are not", () => {
    // The arguments can be a file path or a sentence for the model; lowercasing
    // the whole line was what made `/compact Focus On Auth` unusable.
    expect(splitCommand("/COMPACT Focus On Auth")).toEqual({
      token: "/compact",
      args: "Focus On Auth",
    });
  });

  test("a bare command has empty arguments", () => {
    expect(splitCommand("  /help  ")).toEqual({ token: "/help", args: "" });
  });
});

describe("dispatch", () => {
  test("an unknown command reports no match rather than throwing", async () => {
    const result = await dispatchCommand("/nope", context());
    expect(result.matched).toBe(false);
  });

  test("a command's return value reaches the caller", async () => {
    const result = await dispatchCommand("/plan on", context());
    expect(result.matched).toBe(true);
    expect(result.result).toHaveProperty("notice");
  });

  test("an async command is awaited", async () => {
    registerCommand({
      names: ["/slow-test-command"],
      description: "test",
      hint: "test",
      async execute() {
        await new Promise((r) => setTimeout(r, 5));
        return { notice: "finished" };
      },
    });

    const result = await dispatchCommand("/slow-test-command", context());
    expect(result.result).toEqual({ notice: "finished" });
  });
});

describe("/plan", () => {
  /** Captures what the command asked plan mode to become. */
  function recorder() {
    const seen: boolean[] = [];
    return { seen, setPlanMode: (v: boolean) => { seen.push(v); } };
  }

  test("a bare /plan toggles", () => {
    const off = recorder();
    planCommand.execute(context({ planMode: false, setPlanMode: off.setPlanMode }), "");
    expect(off.seen).toEqual([true]);

    const on = recorder();
    planCommand.execute(context({ planMode: true, setPlanMode: on.setPlanMode }), "");
    expect(on.seen).toEqual([false]);
  });

  test("on and off are explicit", () => {
    const rec = recorder();
    const ctx = context({ planMode: false, setPlanMode: rec.setPlanMode });

    planCommand.execute(ctx, "on");
    expect(rec.seen).toEqual([true]);

    // Already off, so nothing to do — and it says so instead of toggling.
    const result = planCommand.execute(ctx, "off");
    expect(result).toHaveProperty("notice");
    expect((result as { notice: string }).notice).toContain("already");
  });
});

describe("/init", () => {
  test("it submits the bootstrap prompt", () => {
    const result = initCommand.execute(context(), "");
    expect(result).toEqual({ submit: INIT_PROMPT });
  });

  test("it refuses in plan mode rather than being denied mid-run", () => {
    const result = initCommand.execute(context({ planMode: true }), "");
    expect(result).toHaveProperty("notice");
    expect((result as { notice: string }).notice).toContain("plan mode");
  });
});

describe("custom command files", () => {
  test("frontmatter sets the description and hint", () => {
    const parsed = parseCommandFile(
      "---\ndescription: Review the diff\nhint: review\n---\nRun git diff.\n",
      "review",
    );

    expect(parsed.description).toBe("Review the diff");
    expect(parsed.hint).toBe("review");
    expect(parsed.body).toBe("Run git diff.");
  });

  test("without frontmatter the first line becomes the description", () => {
    const parsed = parseCommandFile("Run the tests and fix what breaks.\nMore detail.", "test");
    expect(parsed.description).toBe("Run the tests and fix what breaks.");
    expect(parsed.body).toContain("More detail.");
  });

  test("malformed frontmatter is treated as body text rather than an error", () => {
    // A command that runs with a generic description beats one that refuses to
    // load because a colon was in the wrong place.
    const parsed = parseCommandFile("---\nthis is not key: value\n---\nBody here.", "x");
    expect(parsed.body).toBe("Body here.");
    expect(parsed.description).toBe("Body here.");
  });

  test("$ARGUMENTS is substituted wherever it appears", () => {
    expect(expandArguments("Focus on: $ARGUMENTS. Really: $ARGUMENTS", "auth")).toBe(
      "Focus on: auth. Really: auth",
    );
  });

  test("arguments are appended when the placeholder is absent", () => {
    // Silently discarding what the user typed makes the command look broken.
    expect(expandArguments("Review the diff.", "auth only")).toBe("Review the diff.\n\nauth only");
  });

  test("no arguments and no placeholder leaves the body alone", () => {
    expect(expandArguments("Review the diff.", "")).toBe("Review the diff.");
  });
});

describe("loading custom commands", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "codemon-cmds-"));
    fs.mkdirSync(path.join(root, ".codemon", "commands"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    // Drop anything this test registered, so the registry does not leak between
    // test files that also read ALL_COMMANDS.
    for (let i = ALL_COMMANDS.length - 1; i >= 0; i--) {
      if (!BUILTIN_COMMANDS.includes(ALL_COMMANDS[i]!)) ALL_COMMANDS.splice(i, 1);
    }
  });

  const write = (name: string, body: string) =>
    fs.writeFileSync(path.join(root, ".codemon", "commands", name), body);

  test("a markdown file becomes a command that submits its body", async () => {
    write("review.md", "---\ndescription: Review\n---\nReview the diff for $ARGUMENTS.");

    const { loaded } = loadCustomCommands(root);
    expect(loaded).toContain("/review");

    const result = await dispatchCommand("/review auth bugs", context());
    expect(result.result).toEqual({ submit: "Review the diff for auth bugs." });
  });

  test("a file cannot shadow a built-in", () => {
    // No one gets to redefine /exit.
    write("exit.md", "Do not exit.");

    const { loaded, skipped } = loadCustomCommands(root);
    expect(loaded).not.toContain("/exit");
    expect(skipped).toContain("/exit");
    expect(BUILTIN_NAMES.has("/exit")).toBe(true);
  });

  test("an empty file is ignored", () => {
    write("blank.md", "   \n\n");
    const { loaded } = loadCustomCommands(root);
    expect(loaded).not.toContain("/blank");
  });

  test("a missing directory is not an error", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "codemon-nocmds-"));
    expect(() => loadCustomCommands(empty)).not.toThrow();
    fs.rmSync(empty, { recursive: true, force: true });
  });

  test("loaded commands show up in /help and in completion", async () => {
    write("ship.md", "Ship it.");
    loadCustomCommands(root);

    expect(ALL_COMMANDS.some((c) => c.names[0] === "/ship")).toBe(true);

    // commandSuggestions() reads the same array, so `/` completion is free.
    const { commandSuggestions } = await import("../suggestions.ts");
    expect(commandSuggestions().some((s) => s.value === "ship")).toBe(true);
  });
});
