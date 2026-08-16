import { describe, test, expect } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * The CLI validates its flags at module scope and exits, so these run it as a
 * real process. Each uses a throwaway cwd — a bad flag must be rejected before
 * anything touches the filesystem.
 */
const CLI = path.join(import.meta.dir, "index.tsx");

async function runCli(args: string[]) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codemon-cli-"));
  try {
    const proc = Bun.spawn(["bun", CLI, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode, cwd, sideEffects: fs.readdirSync(cwd) };
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

describe("--mode validation", () => {
  test("an unknown mode exits with a readable message, not a stack trace", async () => {
    const { stderr, exitCode } = await runCli(["--mode", "nonsense"]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("Unknown permission mode");
    expect(stderr).toContain("safe | standard | yolo");
    expect(stderr).not.toContain("TypeError");
    expect(stderr).not.toContain("at <anonymous>");
  });

  test("a valueless --mode is caught too", async () => {
    // The parser stores `true` for a flag with nothing after it, which used to
    // travel all the way to the gate.
    const { stderr, exitCode } = await runCli(["--mode"]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("no value given");
  });

  test("rejection happens before any session state is written", async () => {
    const { sideEffects } = await runCli(["--mode", "nonsense"]);
    expect(sideEffects).toEqual([]);
  });

  test("--help still works and lists the valid modes", async () => {
    const { stdout, exitCode } = await runCli(["--help"]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("safe | standard | yolo");
    expect(stdout).toContain("--audit");
  });
});

describe("flags with a missing value", () => {
  test("--model with nothing after it prints usage instead of a TypeError", async () => {
    const { stderr, exitCode } = await runCli(["--model"]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("no value given");
    expect(stderr).toContain("Usage: codemon [options]");
    expect(stderr).not.toContain("TypeError");
  });

  test("--region with nothing after it never reaches path.resolve", async () => {
    const { stderr, exitCode } = await runCli(["--region"]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("no value given");
    expect(stderr).not.toContain("ERR_INVALID_ARG_TYPE");
  });

  test("an unknown sandbox mode is rejected with the valid ones", async () => {
    const { stderr, exitCode } = await runCli(["--sandbox", "vm"]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("Unknown sandbox mode");
    expect(stderr).toContain("subprocess | docker");
  });

  test("an unknown flag is rejected rather than silently ignored", async () => {
    const { stderr, exitCode } = await runCli(["--modle", "openai:gpt-4o"]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("Unknown option: --modle");
  });

  test("nothing is written to disk before a flag is rejected", async () => {
    const { sideEffects } = await runCli(["--model"]);
    expect(sideEffects).toEqual([]);
  });
});

/**
 * Startup side effects — the gitignore entry and the database handle — live at
 * module scope, so `--sessions` is the cheapest flag that runs all of startup.
 */
describe("startup housekeeping", () => {
  async function runIn(cwd: string, args: string[] = ["--sessions"]) {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "codemon-conf-"));
    try {
      const proc = Bun.spawn(["bun", CLI, ...args], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, CODEMON_CONFIG_DIR: configDir },
      });
      const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
      return { stderr, exitCode };
    } finally {
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  }

  function tempRepo(gitignore?: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codemon-region-"));
    fs.mkdirSync(path.join(dir, ".git"));
    if (gitignore !== undefined) fs.writeFileSync(path.join(dir, ".gitignore"), gitignore);
    return dir;
  }

  test("a repo without a .gitignore gets one, so the database stays untracked", async () => {
    // It used to be appended to only when it already existed, which left
    // `.codemon/` showing up in `git status` on any repo that had none.
    const dir = tempRepo();
    try {
      const { exitCode } = await runIn(dir);
      expect(exitCode).toBe(0);
      expect(fs.readFileSync(path.join(dir, ".gitignore"), "utf8")).toContain(".codemon/");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an existing .gitignore is appended to without running the lines together", async () => {
    const dir = tempRepo("dist"); // no trailing newline
    try {
      await runIn(dir);
      const lines = fs.readFileSync(path.join(dir, ".gitignore"), "utf8").split("\n");
      expect(lines).toContain("dist");
      expect(lines).toContain(".codemon/");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an entry that is already there is not added twice", async () => {
    const dir = tempRepo(".codemon/\n");
    try {
      await runIn(dir);
      const body = fs.readFileSync(path.join(dir, ".gitignore"), "utf8");
      expect(body.split("\n").filter((l) => l === ".codemon/").length).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no .gitignore is invented outside a repo", async () => {
    // Nothing to hide from, and leaving one behind in someone's directory is
    // worse than not having it.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codemon-region-"));
    try {
      await runIn(dir);
      expect(fs.existsSync(path.join(dir, ".gitignore"))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the database is closed on exit, leaving no WAL sidecars behind", async () => {
    // `closeDb` was exported and never called, so `-wal` and `-shm` were left
    // beside the database after every run.
    const dir = tempRepo();
    try {
      await runIn(dir);
      const written = fs.readdirSync(path.join(dir, ".codemon"));
      expect(written).toContain("sessions.db");
      expect(written).not.toContain("sessions.db-wal");
      expect(written).not.toContain("sessions.db-shm");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
