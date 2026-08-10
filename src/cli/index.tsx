#!/usr/bin/env bun
import React from "react";
import { render } from "ink";
import { App } from "./app.tsx";
import { loadConfig } from "../config/load-config.ts";
import { createRegistryProvider, parseModelString, validateApiKey } from "../providers/registry.ts";
import { setProjectRoot } from "../safari-zone/path-jail.ts";
import { createSession, resumeLastSession } from "../core/session.ts";
import { setCurrentProvider } from "../core/provider-instance.ts";
import { initDb } from "../pokedex/db.ts";
import {
  dbGetLastSessionForRegion,
  dbListSessions,
} from "../pokedex/sessions.repo.ts";
import { dbGetCheckpoints, dbRestoreCheckpoints } from "../pokedex/checkpoints.repo.ts";
import { runEvalSuite } from "../evals/runner.ts";
import { enableDebug } from "../utils/logger.ts";
import * as path from "path";
import * as fs from "fs";

// ─── Parse CLI args ───────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flags: Record<string, string | boolean> = {};
const positional: string[] = [];

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg?.startsWith("--")) {
    const key = arg.slice(2);
    const next = args[i + 1];
    if (next && !next.startsWith("--")) { flags[key] = next; i++; }
    else flags[key] = true;
  } else if (arg) {
    positional.push(arg);
  }
}

if (flags.help || flags.h) {
  console.log(`
🐉 CODEMON — Your AI Coding Partner

Usage: codemon [options]

Options:
  --region <path>       Project root directory (default: cwd)
  --mode <mode>         Permission mode: safe | standard | yolo (default: standard)
  --model <model>       Model: provider:model-name  (e.g. google:gemini-2.0-flash-exp)
  --sandbox <mode>      Sandbox mode: subprocess | docker  (default: subprocess)
  --no-index            Skip repo indexing on startup
  --continue            Resume the most recent session for this region
  --rewind              Restore all files to their state before the last session
  --sessions            List recent sessions for this region
  --eval                Run the automated Codemon Battle Eval suite
  --debug               Enable debug logging to ~/.codemon/debug.log
  --help                Show this help

Supported Providers (BYOK):
  google     GEMINI_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY
             e.g. google:gemini-2.0-flash-exp | google:gemini-2.5-pro
  anthropic  ANTHROPIC_API_KEY
             e.g. anthropic:claude-sonnet-4-5 | anthropic:claude-opus-4-5
  openai     OPENAI_API_KEY
             e.g. openai:gpt-4o | openai:o3-mini
  mistral    MISTRAL_API_KEY
             e.g. mistral:mistral-large-latest

Examples:
  codemon                                        # Start with default model
  codemon --model anthropic:claude-sonnet-4-5    # Use Claude
  codemon --continue                             # Resume last session
  codemon --rewind                               # Restore files from last session
  codemon --sandbox docker --mode yolo           # Docker sandbox, auto-approve all
  codemon --eval                                 # Run benchmark eval suite
  `);
  process.exit(0);
}

// ─── Build config ─────────────────────────────────────────────────────────────
const configOverrides: Record<string, unknown> = {};
if (flags.mode) configOverrides.permissionMode = flags.mode;
if (flags.model) configOverrides.model = flags.model;
if (flags.sandbox) configOverrides.sandbox = flags.sandbox;
if (flags.debug) configOverrides.debug = true;
if (flags["no-index"]) configOverrides.repoIndex = false;

const config = loadConfig(configOverrides as never);
if (config.debug) enableDebug();

// ─── Project root ─────────────────────────────────────────────────────────────
const projectRoot = path.resolve(flags.region as string ?? process.cwd());
setProjectRoot(projectRoot);
process.chdir(projectRoot);

// ─── Init Pokédex DB ──────────────────────────────────────────────────────────
const dbPath = path.join(projectRoot, ".codemon", "pokedex.db");
initDb(dbPath);

// Ensure .codemon is in .gitignore
const gitignorePath = path.join(projectRoot, ".gitignore");
if (fs.existsSync(gitignorePath)) {
  const gi = fs.readFileSync(gitignorePath, "utf8");
  if (!gi.includes(".codemon/")) {
    fs.appendFileSync(gitignorePath, "\n# Codemon session data\n.codemon/\n");
  }
}

// ─── Subcommands ──────────────────────────────────────────────────────────────

// --eval: run evaluation benchmark suite
if (flags.eval) {
  const { provider: pName } = parseModelString(config.model);
  const kErr = validateApiKey(pName);
  if (kErr) { console.error(kErr); process.exit(1); }

  await runEvalSuite({ model: config.model });
  process.exit(0);
}

// --sessions: list recent sessions
if (flags.sessions) {
  const sessions = dbListSessions(projectRoot);
  if (sessions.length === 0) {
    console.log("No sessions found for this region.");
  } else {
    console.log(`\n🗂️  Sessions for ${path.basename(projectRoot)}/\n`);
    for (const s of sessions) {
      const age = new Date(s.lastActive).toLocaleString();
      console.log(`  ${s.id.slice(0, 8)}… | ${age} | ${s.model} | ${s.totalTokens} tokens`);
    }
  }
  process.exit(0);
}

// --rewind: restore checkpoints from last session
if (flags.rewind) {
  const lastSession = dbGetLastSessionForRegion(projectRoot);
  if (!lastSession) {
    console.log("❌ No previous session found. Nothing to rewind.");
    process.exit(1);
  }

  const checkpoints = dbGetCheckpoints(lastSession.id);
  if (checkpoints.length === 0) {
    console.log("ℹ️  No file checkpoints found for the last session.");
    process.exit(0);
  }

  console.log(`\n⏪ Rewinding session ${lastSession.id.slice(0, 8)}… (${checkpoints.length} files)\n`);
  const results = dbRestoreCheckpoints(lastSession.id);
  for (const r of results) {
    const icon = r.success ? "✅" : "❌";
    console.log(`  ${icon} ${r.filePath}${r.error ? ` — ${r.error}` : ""}`);
  }
  console.log(`\nDone. ${results.filter((r) => r.success).length}/${results.length} files restored.`);
  process.exit(0);
}

// ─── Validate API key ─────────────────────────────────────────────────────────
const { provider: providerName } = parseModelString(config.model);
const keyError = validateApiKey(providerName);
if (keyError) { console.error(keyError); process.exit(1); }

// ─── Build provider ───────────────────────────────────────────────────────────
const provider = createRegistryProvider({ model: config.model, maxTokens: config.maxTokens });
setCurrentProvider(provider, config);

// ─── Session ──────────────────────────────────────────────────────────────────
let resumed = false;
if (flags.continue) {
  const session = resumeLastSession(projectRoot);
  if (session) {
    resumed = true;
    console.log(`\n📖 Resuming session ${session.id.slice(0, 8)}… (${session.messages.length} messages)\n`);
  } else {
    console.log("ℹ️  No previous session found, starting fresh.\n");
    createSession(projectRoot, config.model);
  }
} else {
  createSession(projectRoot, config.model);
}

// ─── Render TUI ───────────────────────────────────────────────────────────────
const { waitUntilExit } = render(
  <App
    provider={provider}
    config={config}
    projectRoot={projectRoot}
    resumed={resumed}
  />,
  { exitOnCtrlC: false },
);

await waitUntilExit();
