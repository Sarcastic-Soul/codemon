import { describe, test, expect } from "bun:test";
import * as fs from "fs";
import * as path from "path";

/**
 * Every tool module must survive being the first thing a process loads: an
 * import cycle back to `registry.ts` only throws when entered from one side.
 * Each import gets its own subprocess, since nothing in a single-process test
 * run pins which module loaded first.
 */
const TOOLS_DIR = import.meta.dir;
const AGENT_LOOP = path.resolve(TOOLS_DIR, "../core/agent-loop.ts");

const ENTRY_POINTS = [
  ...fs
    .readdirSync(TOOLS_DIR)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => path.join(TOOLS_DIR, f)),
  // The far side of the cycle: loading the loop first has to work too.
  AGENT_LOOP,
];

async function importInFreshProcess(module: string): Promise<{ ok: boolean; stderr: string }> {
  const proc = Bun.spawn(["bun", "--eval", `await import(${JSON.stringify(module)})`], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NO_COLOR: "1" },
  });

  const [stderr, exitCode] = await Promise.all([
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { ok: exitCode === 0, stderr };
}

describe("module initialization", () => {
  for (const module of ENTRY_POINTS) {
    const name = path.relative(path.resolve(TOOLS_DIR, "../.."), module);

    test(`${name} loads when it is the entry point`, async () => {
      const { ok, stderr } = await importInFreshProcess(module);

      // The assertion carries stderr so a failure names the cycle rather than
      // just reporting a non-zero exit.
      expect(ok ? "" : stderr.trim()).toBe("");
      expect(ok).toBe(true);
    }, 20_000);
  }

  test("the registry exposes every move once loaded", async () => {
    const { toolRegistry, BUILTIN_TOOL_NAMES } = await import("./registry.ts");

    const expected = [
      "bash", "edit_file", "glob", "grep", "list_dir",
      "read_file", "spawn_subagent", "todo_write", "web_fetch", "write_file",
    ];

    // Asserted against the built-in set rather than the whole registry: MCP
    // servers register into the same map at runtime, so the registry is no
    // longer a fixed list.
    expect([...BUILTIN_TOOL_NAMES].sort()).toEqual(expected);
    expect([...toolRegistry.keys()].sort()).toEqual(expected);
  });
});
