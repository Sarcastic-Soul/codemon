import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { parseArgs, subcommandOf } from "./parse-args.ts";
import { EXIT, headlessFlags, runHeadless } from "./headless.ts";
import { createSession, endSession } from "../core/session.ts";
import { closeDb, initDb } from "../storage/db.ts";
import { getProjectRoot, setProjectRoot } from "../sandbox/path-jail.ts";
import { DEFAULTS, type CodemonConfig } from "../config/defaults.ts";
import type { Provider, StreamEvent } from "../providers/types.ts";
import type { Bootstrapped } from "../core/bootstrap.ts";

function ok(argv: string[]) {
  const parsed = parseArgs(argv);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.args;
}

describe("run subcommand parsing", () => {
  test("a quoted prompt becomes the rest", () => {
    expect(subcommandOf(ok(["run", "fix the failing test"]))).toEqual({
      name: "run",
      rest: "fix the failing test",
    });
  });

  test("an unquoted sentence joins back together", () => {
    expect(subcommandOf(ok(["run", "fix", "the", "test"]))?.rest).toBe("fix the test");
  });

  test("flags after the prompt still parse", () => {
    const args = ok(["run", "do it", "--json", "--mode", "yolo", "--max-turns", "3"]);
    expect(subcommandOf(args)?.rest).toBe("do it");
    expect(args.flags.json).toBe(true);
    expect(args.flags.mode).toBe("yolo");
    expect(headlessFlags(args.flags)).toEqual({ json: true, maxTurns: 3 });
  });

  test("no subcommand means the TUI", () => {
    expect(subcommandOf(ok(["--continue"]))).toBeNull();
    expect(subcommandOf(ok([]))).toBeNull();
  });

  test("--max-turns rejects a non-number rather than silently disabling the cap", () => {
    expect(parseArgs(["run", "x", "--max-turns", "lots"]).ok).toBe(false);
    expect(parseArgs(["run", "x", "--max-turns", "0"]).ok).toBe(false);
  });

  test("--plan parses as a boolean", () => {
    expect(ok(["--plan"]).flags.plan).toBe(true);
    expect(parseArgs(["--plan=yes"]).ok).toBe(false);
  });
});

describe("headless run", () => {
  let root: string;
  let originalRoot: string;
  let stdout: string;
  let stderr: string;
  let restore: Array<() => void>;

  beforeEach(() => {
    originalRoot = getProjectRoot();
    root = fs.mkdtempSync(path.join(os.tmpdir(), "codemon-headless-"));
    setProjectRoot(root);
    initDb(path.join(root, ".codemon", "sessions.db"));
    createSession(root, "test:model");

    stdout = "";
    stderr = "";
    const outWrite = process.stdout.write.bind(process.stdout);
    const errWrite = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: string) => { stdout += chunk; return true; }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string) => { stderr += chunk; return true; }) as typeof process.stderr.write;
    restore = [
      () => { process.stdout.write = outWrite; },
      () => { process.stderr.write = errWrite; },
    ];
  });

  afterEach(() => {
    for (const fn of restore) fn();
    endSession();
    setProjectRoot(originalRoot);
    closeDb();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function boot(provider: Provider | undefined, overrides: Partial<CodemonConfig> = {}): Bootstrapped {
    return {
      config: { ...DEFAULTS, repoIndex: false, ...overrides },
      projectRoot: root,
      provider,
      keyError: provider ? null : "No API key configured for provider 'test'",
    };
  }

  const replies = (text: string): Provider => ({
    streamMessage() {
      return (async function* (): AsyncGenerator<StreamEvent> {
        yield { type: "text", text };
        yield { type: "finish", finishReason: "stop" };
      })();
    },
  });

  function callsTool(toolName: string, args: Record<string, unknown>): Provider {
    let turn = 0;
    return {
      streamMessage() {
        const first = turn++ === 0;
        return (async function* (): AsyncGenerator<StreamEvent> {
          if (first) {
            yield { type: "tool-call", toolCallId: "c1", toolName, toolArgs: args };
            yield { type: "finish", finishReason: "tool-calls" };
            return;
          }
          yield { type: "text", text: "done" };
          yield { type: "finish", finishReason: "stop" };
        })();
      },
    };
  }

  test("a text reply goes to stdout and exits 0", async () => {
    const code = await runHeadless({ boot: boot(replies("the answer")), prompt: "go", json: false });

    expect(code).toBe(EXIT.ok);
    expect(stdout).toContain("the answer");
  });

  test("tool activity goes to stderr, so redirecting stdout yields just the answer", async () => {
    const code = await runHeadless({
      boot: boot(callsTool("read_file", { path: "nope.txt" }), { permissionMode: "yolo" }),
      prompt: "go",
      json: false,
    });

    expect(code).toBe(EXIT.ok);
    expect(stdout).not.toContain("read_file");
    expect(stderr).toContain("read_file");
  });

  test("a tool needing confirmation is denied and exits 3, without running", async () => {
    // A git hook that starts running `rm` because nobody was watching is the
    // failure this avoids.
    const code = await runHeadless({
      boot: boot(callsTool("bash", { command: "echo hi" }), { permissionMode: "standard" }),
      prompt: "go",
      json: false,
    });

    expect(code).toBe(EXIT.denied);
    expect(stderr).toContain("denied");
    expect(stderr).toContain("--mode yolo");
  });

  test("no provider exits 1 with the key error", async () => {
    const code = await runHeadless({ boot: boot(undefined), prompt: "go", json: false });

    expect(code).toBe(EXIT.error);
    expect(stderr).toContain("No API key configured");
  });

  test("an empty prompt exits 1 rather than sending a blank turn", async () => {
    const code = await runHeadless({ boot: boot(replies("x")), prompt: "   ", json: false });

    expect(code).toBe(EXIT.error);
    expect(stderr).toContain("No prompt given");
  });

  test("a stream error exits 1", async () => {
    const broken: Provider = {
      streamMessage() {
        return (async function* (): AsyncGenerator<StreamEvent> {
          yield { type: "error", error: new Error("upstream is down") };
        })();
      },
    };

    const code = await runHeadless({ boot: boot(broken), prompt: "go", json: false });
    expect(code).toBe(EXIT.error);
    expect(stderr).toContain("upstream is down");
  });

  test("exhausting the turn budget exits 2", async () => {
    const spinner: Provider = {
      streamMessage() {
        return (async function* (): AsyncGenerator<StreamEvent> {
          yield { type: "tool-call", toolCallId: "c", toolName: "read_file", toolArgs: { path: "nope.txt" } };
          yield { type: "finish", finishReason: "tool-calls" };
        })();
      },
    };

    const code = await runHeadless({
      boot: boot(spinner, { permissionMode: "yolo" }),
      prompt: "go",
      json: false,
      maxTurns: 2,
    });

    expect(code).toBe(EXIT.maxTurns);
  });

  test("--json emits one valid JSON object per line", async () => {
    await runHeadless({
      boot: boot(callsTool("read_file", { path: "nope.txt" }), { permissionMode: "yolo" }),
      prompt: "go",
      json: true,
    });

    const lines = stdout.trim().split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(1);

    const types = lines.map((line) => (JSON.parse(line) as { type: string }).type);
    expect(types).toContain("tool-start");
    expect(types).toContain("text");
  });

  test("a JSON permission event is serialisable — the resolver is stripped", async () => {
    await runHeadless({
      boot: boot(callsTool("bash", { command: "echo hi" }), { permissionMode: "standard" }),
      prompt: "go",
      json: true,
    });

    const events = stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { type: string; resolve?: unknown });

    const permission = events.find((e) => e.type === "permission-required");
    expect(permission).toBeDefined();
    expect(permission!.resolve).toBeUndefined();
  });

  test("plan mode denies a write in a headless run", async () => {
    const code = await runHeadless({
      boot: boot(callsTool("write_file", { path: "x.txt", content: "no" }), {
        permissionMode: "yolo",
        planMode: true,
      }),
      prompt: "go",
      json: false,
    });

    expect(code).toBe(EXIT.ok);
    expect(stderr).toContain("plan mode is active");
    expect(fs.existsSync(path.join(root, "x.txt"))).toBe(false);
  });
});
