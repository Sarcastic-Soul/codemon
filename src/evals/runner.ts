import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { EVAL_CASES } from "./benchmarks.ts";
import { runToCompletion, createInMemoryStore } from "../core/agent-loop.ts";
import { getCurrentProvider, getCurrentConfig, setCurrentProvider } from "../core/provider-instance.ts";
import { createRegistryProvider } from "../providers/registry.ts";
import { loadConfig } from "../config/defaults.ts";

export interface EvalResult {
  id: string;
  name: string;
  pass: boolean;
  reason: string;
  toolsUsed: string[];
  elapsedSeconds: number;
}

export async function runEvalSuite(options: { model?: string } = {}): Promise<EvalResult[]> {
  const tmpBase = path.join(os.tmpdir(), "codemon_evals");
  if (!fs.existsSync(tmpBase)) fs.mkdirSync(tmpBase, { recursive: true });

  const config = loadConfig({
    model: options.model ?? "google:gemini-2.0-flash-exp",
    permissionMode: "yolo",
    repoIndex: false,
  });

  const provider = createRegistryProvider({ model: config.model, maxTokens: config.maxTokens });
  setCurrentProvider(provider, config);

  const results: EvalResult[] = [];

  console.log(`\n🧪 Running Eval Suite (${config.model})\n`);

  for (const c of EVAL_CASES) {
    const testDir = fs.mkdtempSync(path.join(tmpBase, `eval_${c.id}_`));
    process.chdir(testDir);

    await c.setup(testDir);

    const systemPrompt = `You are Codemon participating in an automated evaluation. Project root: ${testDir}`;
    const toolFilter = c.allowedTools ? new Set(c.allowedTools) : undefined;
    const store = createInMemoryStore();

    const start = Date.now();
    try {
      const outcome = await runToCompletion(c.prompt, provider, config, systemPrompt, store, toolFilter);
      const elapsed = (Date.now() - start) / 1000;

      const verification = await c.verify(testDir, outcome.output, outcome.toolsUsed);
      results.push({
        id: c.id,
        name: c.name,
        pass: verification.pass,
        reason: verification.reason,
        toolsUsed: outcome.toolsUsed,
        elapsedSeconds: elapsed,
      });

      const statusIcon = verification.pass ? "✅ PASS" : "❌ FAIL";
      console.log(`  ${statusIcon} | ${c.name} (${elapsed.toFixed(1)}s)`);
      console.log(`         Reason: ${verification.reason}`);
      console.log(`         Tools: [${outcome.toolsUsed.join(", ")}]\n`);
    } catch (err) {
      const elapsed = (Date.now() - start) / 1000;
      results.push({
        id: c.id,
        name: c.name,
        pass: false,
        reason: `Runner exception: ${err instanceof Error ? err.message : String(err)}`,
        toolsUsed: [],
        elapsedSeconds: elapsed,
      });
      console.log(`  ❌ FAIL | ${c.name} (${elapsed.toFixed(1)}s) — Error: ${err}\n`);
    } finally {
      // Clean up test directory
      try { fs.rmSync(testDir, { recursive: true, force: true }); } catch {}
    }
  }

  const passed = results.filter((r) => r.pass).length;
  console.log(`📊 Eval Report: ${passed}/${results.length} evals passed.\n`);

  return results;
}
