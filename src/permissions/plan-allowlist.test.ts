import { describe, test, expect } from "bun:test";
import { isReadOnlyCommand } from "./plan-allowlist.ts";

const allows = (cmd: string) => isReadOnlyCommand(cmd).allowed;

describe("plan-mode bash allowlist", () => {
  test("read-only commands are allowed", () => {
    for (const cmd of [
      "git log",
      "git log --oneline -20",
      "git status",
      "git diff HEAD~1",
      "git show abc123",
      "ls -la src",
      "cat package.json",
      "rg 'checkPermission' src",
      "find . -name '*.ts'",
      "wc -l src/cli/app.tsx",
      "which bun",
      "tree -L 2",
    ]) {
      expect(allows(cmd)).toBe(true);
    }
  });

  test("a git subcommand that writes is denied", () => {
    for (const cmd of ["git push", "git commit -m x", "git checkout main", "git reset --hard", "git add ."]) {
      expect(allows(cmd)).toBe(false);
    }
  });

  test("commands not on the list are denied", () => {
    for (const cmd of ["rm -rf .", "npm install", "bun test", "mv a b", "curl example.com", "sed -i s/a/b/ f"]) {
      expect(allows(cmd)).toBe(false);
    }
  });

  test("every metacharacter denies on its own", () => {
    // Each of these turns one command into two, and the second one is the
    // problem. Enumerated individually so a dropped entry fails loudly.
    for (const meta of ["|", "&", ";", ">", "<", "`", "$(", "${"]) {
      expect(allows(`git log ${meta} whatever`)).toBe(false);
    }
    expect(allows("git log\nrm -rf .")).toBe(false);
    expect(allows("git log\rrm -rf .")).toBe(false);
  });

  test("a pipeline is denied even when both halves look harmless", () => {
    // `tee` writes. This is the case a cleverer parser gets wrong.
    expect(allows("git log | tee f")).toBe(false);
    expect(allows("cat a && rm b")).toBe(false);
    expect(allows("ls || rm -rf .")).toBe(false);
    expect(allows("cat src/a.ts > src/b.ts")).toBe(false);
  });

  test("a flag that writes a file denies the whole command", () => {
    expect(allows("git diff --output=x")).toBe(false);
    expect(allows("git diff --output x")).toBe(false);
    expect(allows("git log -o out.txt")).toBe(false);
  });

  test("an empty command is denied rather than treated as a no-op", () => {
    expect(allows("")).toBe(false);
    expect(allows("   ")).toBe(false);
  });

  test("a denial explains itself", () => {
    // The message goes back to the model; without a reason it retries variants.
    const verdict = isReadOnlyCommand("git push");
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("git push");
    expect(verdict.reason).toContain("git log");
  });
});
