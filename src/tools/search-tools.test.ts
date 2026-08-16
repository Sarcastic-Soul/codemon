import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { grepTool } from "./grep.ts";
import { globTool } from "./glob.ts";
import { shellExecArgv } from "../sandbox/shell-executor.ts";
import { setProjectRoot, getProjectRoot } from "../sandbox/path-jail.ts";

/**
 * `grep` and `glob` take model-supplied arguments at permission level "read",
 * which every mode auto-allows. These pin down that the arguments never reach a
 * shell and that both tools stay inside the path jail.
 */

interface GrepResult {
  matches: string;
  count: number;
  truncated?: boolean;
  message?: string;
}

interface GlobResult {
  files: string[];
  count: number;
  truncated: boolean;
}

function runGrep(args: Record<string, unknown>): Promise<GrepResult> {
  return grepTool.execute(grepTool.parameters.parse(args)) as Promise<GrepResult>;
}

function runGlob(args: Record<string, unknown>): Promise<GlobResult> {
  return globTool.execute(globTool.parameters.parse(args)) as Promise<GlobResult>;
}

/** Shell payload that creates `name` in the cwd if it is ever parsed as syntax. */
function injection(name: string): string {
  return `x' ; touch ${name} ; echo '`;
}

describe("search tools", () => {
  const originalRoot = getProjectRoot();
  let root: string;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "codemon-search-"));
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.mkdirSync(path.join(root, "node_modules", "pkg"), { recursive: true });

    fs.writeFileSync(path.join(root, "src", "greeter.ts"), "export const greeting = 'hello';\n");
    fs.writeFileSync(path.join(root, "src", "helper.js"), "// greeting helper\n");
    fs.writeFileSync(path.join(root, "README.md"), "# greeting docs\n");
    fs.writeFileSync(path.join(root, "node_modules", "pkg", "index.ts"), "greeting\n");
  });

  afterAll(() => {
    setProjectRoot(originalRoot);
    fs.rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    setProjectRoot(root);
  });

  /** Every file the injection payloads would create if a shell ever saw them. */
  function canaries(): string[] {
    return fs
      .readdirSync(root)
      .filter((f) => f.startsWith("PWNED"));
  }

  describe("grep", () => {
    test("finds matches in the project", async () => {
      const result = await runGrep({ pattern: "greeting" });
      expect(result.count).toBeGreaterThan(0);
      expect(result.matches).toContain("greeting");
    });

    test("treats shell metacharacters in `path` as literal path text", async () => {
      // The payload names a path that does not exist, so the search fails —
      // what matters is that it fails as a lookup, not as a command.
      await runGrep({ pattern: "greeting", path: injection("PWNED_GREP_PATH") }).catch(() => {});
      expect(canaries()).toEqual([]);
    });

    test("treats shell metacharacters in `include` as literal glob text", async () => {
      await runGrep({
        pattern: "greeting",
        include: injection("PWNED_GREP_INCLUDE"),
      }).catch(() => {});
      expect(canaries()).toEqual([]);
    });

    test("treats shell metacharacters in `pattern` as literal search text", async () => {
      const result = await runGrep({ pattern: injection("PWNED_GREP_PATTERN") });
      expect(result.count).toBe(0);
      expect(canaries()).toEqual([]);
    });

    test("rejects an absolute path outside the project root", async () => {
      expect(runGrep({ pattern: "root", path: "/etc/passwd" })).rejects.toThrow("Access denied");
    });

    test("rejects a traversal path outside the project root", async () => {
      expect(runGrep({ pattern: "root", path: "../../etc" })).rejects.toThrow("Access denied");
    });

    test("honours the include filter", async () => {
      const result = await runGrep({ pattern: "greeting", include: "*.md" });
      expect(result.matches).toContain("README.md");
      expect(result.matches).not.toContain("greeter.ts");
    });
  });

  describe("grep match counting", () => {
    // `count` used to be the number of output lines, which with context on is
    // mostly context lines and `--` separators — overstating matches severalfold.
    beforeAll(() => {
      const lines = Array.from({ length: 20 }, (_, i) => `filler ${i + 1}`);
      lines[2] = "needle one";
      lines[16] = "needle two";
      fs.writeFileSync(path.join(root, "counted.txt"), lines.join("\n") + "\n");
    });

    test("counts matched lines rather than output lines", async () => {
      const result = await runGrep({
        pattern: "needle",
        path: "counted.txt",
        context_lines: 1,
      });

      // Two matches, but six context lines and a `--` separator around them.
      expect(result.count).toBe(2);
      expect(result.matches).toContain("filler 2");
      expect(result.matches.trim().split("\n").length).toBeGreaterThan(result.count);
    });

    test("counts every output line when context is off", async () => {
      const result = await runGrep({
        pattern: "needle",
        path: "counted.txt",
        context_lines: 0,
      });

      expect(result.count).toBe(2);
      expect(result.truncated).toBe(false);
    });

    test("does not count content that looks like a line prefix", async () => {
      fs.writeFileSync(
        path.join(root, "colons.txt"),
        ["needle here", 'const t = "a:12:b";', "needle again"].join("\n") + "\n",
      );

      const result = await runGrep({
        pattern: "needle",
        path: "colons.txt",
        context_lines: 1,
      });
      expect(result.count).toBe(2);
    });
  });

  describe("glob", () => {
    test("finds files by pattern, relative to the project root", async () => {
      const result = await runGlob({ pattern: "**/*.ts" });
      expect(result.files).toContain(path.join("src", "greeter.ts"));
      expect(result.files.every((f) => !path.isAbsolute(f))).toBe(true);
    });

    test("skips node_modules without being asked", async () => {
      const result = await runGlob({ pattern: "**/*.ts" });
      expect(result.files.some((f) => f.includes("node_modules"))).toBe(false);
    });

    test("`exclude` removes matches instead of emptying the result", async () => {
      const all = await runGlob({ pattern: "src/*" });
      const filtered = await runGlob({ pattern: "src/*", exclude: "**/*.js" });

      expect(all.count).toBe(2);
      expect(filtered.files).toEqual([path.join("src", "greeter.ts")]);
    });

    test("treats shell metacharacters in `pattern` as literal glob text", async () => {
      const result = await runGlob({ pattern: injection("PWNED_GLOB_PATTERN") });
      expect(result.files).toEqual([]);
      expect(canaries()).toEqual([]);
    });

    test("treats shell metacharacters in `path` as literal path text", async () => {
      await runGlob({ pattern: "*", path: injection("PWNED_GLOB_PATH") }).catch(() => {});
      expect(canaries()).toEqual([]);
    });

    test("treats shell metacharacters in `exclude` as literal glob text", async () => {
      await runGlob({ pattern: "**/*.ts", exclude: injection("PWNED_GLOB_EXCLUDE") });
      expect(canaries()).toEqual([]);
    });

    test("rejects an absolute path outside the project root", async () => {
      expect(runGlob({ pattern: "*", path: "/etc" })).rejects.toThrow("Access denied");
    });

    test("rejects a traversal path outside the project root", async () => {
      expect(runGlob({ pattern: "*", path: "../.." })).rejects.toThrow("Access denied");
    });

    test("reports a missing base directory instead of returning nothing", async () => {
      expect(runGlob({ pattern: "*", path: "does-not-exist" })).rejects.toThrow(
        "Cannot search",
      );
    });
  });

  describe("shellExecArgv", () => {
    test("passes arguments to the process verbatim", async () => {
      const payload = "a; touch PWNED_ARGV; echo b";
      const result = await shellExecArgv(["echo", payload]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe(payload);
      expect(canaries()).toEqual([]);
    });

    test("reports a missing binary as exit 127 rather than throwing", async () => {
      const result = await shellExecArgv(["codemon-no-such-binary"]);
      expect(result.exitCode).toBe(127);
    });

    test("rejects an empty argv", () => {
      expect(shellExecArgv([])).rejects.toThrow("at least the program name");
    });

    test("stops capturing at the output cap instead of buffering it all", async () => {
      // 3 MB from a command whose output nobody will read past the first few
      // thousand characters. The read stops at 1 MB and the writer gets EPIPE.
      const result = await shellExecArgv(["bash", "-c", "yes 0123456789 | head -c 3000000"]);

      expect(result.truncated).toBe(true);
      expect(result.stdout.length).toBeGreaterThan(0);
      expect(result.stdout.length).toBeLessThanOrEqual(1024 * 1024);
    });

    test("leaves ordinary output untruncated", async () => {
      const result = await shellExecArgv(["echo", "small"]);
      expect(result.truncated).toBe(false);
      expect(result.stdout.trim()).toBe("small");
    });
  });
});
