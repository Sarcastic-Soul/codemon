import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { buildRepoIndex } from "./repo-indexer.ts";

/**
 * The indexer must not splice `projectRoot` into a shell string: a path holding
 * an apostrophe silently cost the prompt its recent files and git status.
 */
describe("buildRepoIndex", () => {
  let base: string;

  beforeAll(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "codemon-index-"));
  });

  afterAll(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  /** A project root that the old single-quoted command string could not survive. */
  function awkwardRoot(name: string): string {
    const root = path.join(base, `bob's ${name}`);
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "package.json"), "{}\n");
    return root;
  }

  test("indexes a project whose path contains an apostrophe", async () => {
    const root = awkwardRoot("plain");
    fs.writeFileSync(path.join(root, "src", "older.ts"), "old\n");
    await Bun.sleep(20);
    fs.writeFileSync(path.join(root, "src", "newer.ts"), "new\n");

    const index = await buildRepoIndex(root);

    expect(index.projectName).toBe("bob's plain");
    expect(index.stack).toContain("Node/TypeScript");
    expect(index.fileTree).toContain("src/");
    // No git here, so this is the mtime walk that replaced the `find` pipeline.
    expect(index.recentFiles[0]).toBe(path.join("src", "newer.ts"));
    expect(index.recentFiles).toContain(path.join("src", "older.ts"));
  });

  test("reads recent files and status from git when the path is awkward", async () => {
    const root = awkwardRoot("repo");
    await Bun.$`git init -q ${root}`.quiet();
    fs.writeFileSync(path.join(root, "committed.ts"), "committed\n");
    await Bun.$`git -C ${root} add -A`.quiet();
    await Bun.$`git -C ${root} -c user.email=t@example.com -c user.name=t commit -qm init`.quiet();
    fs.writeFileSync(path.join(root, "untracked.ts"), "untracked\n");

    const index = await buildRepoIndex(root);

    expect(index.recentFiles).toContain("committed.ts");
    expect(index.gitStatus).toContain("untracked.ts");
  });

  test("skips node_modules in the mtime walk", async () => {
    const root = awkwardRoot("noisy");
    fs.mkdirSync(path.join(root, "node_modules", "pkg"), { recursive: true });
    fs.writeFileSync(path.join(root, "node_modules", "pkg", "index.js"), "noise\n");
    fs.writeFileSync(path.join(root, "src", "app.ts"), "app\n");

    const index = await buildRepoIndex(root);

    expect(index.recentFiles.some((f) => f.includes("node_modules"))).toBe(false);
    expect(index.recentFiles).toContain(path.join("src", "app.ts"));
  });
});
