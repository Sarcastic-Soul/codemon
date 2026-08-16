#!/usr/bin/env bun
import React from "react";
import { render } from "ink";
import { App } from "./app.tsx";
import { SessionPicker } from "./components/SessionPicker.tsx";
import { loadConfig } from "../config/load-config.ts";
import type { CodemonConfig } from "../config/load-config.ts";
import { SANDBOX_MODES, isSandboxMode } from "../config/defaults.ts";
import { parseArgs, USAGE } from "./parse-args.ts";
import { createRegistryProvider, parseModelString, validateApiKey } from "../providers/registry.ts";
import { setProjectRoot } from "../sandbox/path-jail.ts";
import { PERMISSION_MODES, isPermissionMode } from "../permissions/rules.ts";
import { createSession, resumeLastSession, resumeSpecificSession } from "../core/session.ts";
import { setCurrentProvider } from "../core/provider-instance.ts";
import { initDb, closeDb } from "../storage/db.ts";
import {
  dbGetLastSessionForRegion,
  dbListSessions,
} from "../storage/sessions.repo.ts";
import type { StoredSession } from "../storage/sessions.repo.ts";
import { dbGetCheckpoints, dbRestoreCheckpoints } from "../storage/checkpoints.repo.ts";
import { dbListDecisions } from "../storage/audit.repo.ts";
import { runEvalSuite } from "../evals/runner.ts";
import { enableDebug } from "../utils/logger.ts";
import * as path from "path";
import * as fs from "fs";

// ─── Parse CLI args ───────────────────────────────────────────────────────────
// parse-args.ts declares every flag and rejects malformed ones, so nothing below
// sees a bad value.
const parsed = parseArgs(process.argv.slice(2));
if (!parsed.ok) {
  console.error(`${parsed.error}`);
  console.error(USAGE);
  process.exit(1);
}

const { flags } = parsed.args;

if (flags.help || flags.h) {
  console.log(USAGE);
  process.exit(0);
}

// ─── Project root ─────────────────────────────────────────────────────────────
// Resolved before the config is read: the project config files live under the
// region, so `--region` has to be applied first.
const projectRoot = path.resolve(typeof flags.region === "string" ? flags.region : process.cwd());

// ─── Build config ─────────────────────────────────────────────────────────────
const MODE_LIST = PERMISSION_MODES.join(" | ");
const SANDBOX_LIST = SANDBOX_MODES.join(" | ");

const configOverrides: Partial<CodemonConfig> = {};
if (isPermissionMode(flags.mode)) configOverrides.permissionMode = flags.mode;
if (isSandboxMode(flags.sandbox)) configOverrides.sandbox = flags.sandbox;
if (typeof flags.model === "string") configOverrides.model = flags.model;
if (flags.debug) configOverrides.debug = true;
if (flags["no-index"]) configOverrides.repoIndex = false;

const config = loadConfig(configOverrides, { projectRoot });

// The same values can arrive from a config file, which the flag parser never saw.
if (!isPermissionMode(config.permissionMode)) {
  console.error(
    `Unknown permission mode in config: "${config.permissionMode}"\n` +
      `   Expected one of: ${MODE_LIST}\n` +
      `   Check ~/.codemon/config.json, codemon.json and .codemon/config.json`,
  );
  process.exit(1);
}

if (!isSandboxMode(config.sandbox)) {
  console.error(
    `Unknown sandbox mode in config: "${config.sandbox}"\n` +
      `   Expected one of: ${SANDBOX_LIST}\n` +
      `   Check ~/.codemon/config.json, codemon.json and .codemon/config.json`,
  );
  process.exit(1);
}

if (config.debug) enableDebug();

setProjectRoot(projectRoot);
process.chdir(projectRoot);

// ─── Init DB ──────────────────────────────────────────────────────────────────
const dbPath = path.join(projectRoot, ".codemon", "sessions.db");
initDb(dbPath);

// WAL journaling leaves `-wal` and `-shm` beside the database until the last
// connection closes, so every exit path goes through here.
process.on("exit", closeDb);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    closeDb();
    process.exit(signal === "SIGINT" ? 130 : 143);
  });
}

// Ensure .codemon is in .gitignore, creating the file when absent. Skipped
// outside a repo rather than writing a stray .gitignore into a directory.
try {
  const gitignorePath = path.join(projectRoot, ".gitignore");
  const existing = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, "utf8") : null;
  const insideRepo = existing !== null || fs.existsSync(path.join(projectRoot, ".git"));

  if (insideRepo && !(existing ?? "").includes(".codemon/")) {
    const needsNewline = existing !== null && existing !== "" && !existing.endsWith("\n");
    fs.appendFileSync(gitignorePath, `${needsNewline ? "\n" : ""}# Codemon session data\n.codemon/\n`);
  }
} catch {
  // A read-only project root is not a reason to refuse to start.
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
    console.log(`\nSessions for ${path.basename(projectRoot)}/\n`);
    for (const s of sessions) {
      const age = new Date(s.lastActive).toLocaleString();
      console.log(`  ${s.id.slice(0, 8)}… | ${age} | ${s.model} | ${s.totalTokens} tokens`);
    }
  }
  process.exit(0);
}

// --audit: show what the permission gate decided, and why
if (flags.audit) {
  const wanted = typeof flags.audit === "string" ? flags.audit : undefined;
  const candidates = dbListSessions(projectRoot, 50);
  const target = wanted
    ? candidates.find((s) => s.id.startsWith(wanted))
    : candidates[0];

  if (!target) {
    console.log(
      wanted
        ? `No session in this region starts with "${wanted}".`
        : "No sessions found for this region.",
    );
    process.exit(wanted ? 1 : 0);
  }

  const decisions = dbListDecisions(target.id);
  console.log(`\nPermission decisions for session ${target.id.slice(0, 8)}…\n`);

  if (decisions.length === 0) {
    console.log("  No decisions recorded. Sessions started before --audit existed have none.");
  } else {
    const icons: Record<string, string> = {
      allow: "+", "always-allow": "++", "ask-allow": "?", deny: "x", "ask-deny": "x?",
    };
    for (const d of decisions) {
      const when = new Date(d.createdAt).toLocaleTimeString();
      const icon = icons[d.decision] ?? "•";
      console.log(`  ${icon} ${when}  ${d.decision.padEnd(12)} ${d.toolName} (${d.permissionLevel})`);
      console.log(`      ${d.args.slice(0, 120)}`);
    }
    console.log(`\n${decisions.length} decisions.`);
  }
  process.exit(0);
}

// --rewind: restore checkpoints from last session
if (flags.rewind) {
  const lastSession = dbGetLastSessionForRegion(projectRoot);
  if (!lastSession) {
    console.log("No previous session found. Nothing to rewind.");
    process.exit(1);
  }

  const checkpoints = dbGetCheckpoints(lastSession.id);
  if (checkpoints.length === 0) {
    console.log("No file checkpoints found for the last session.");
    process.exit(0);
  }

  console.log(`\nRewinding session ${lastSession.id.slice(0, 8)}… (${checkpoints.length} files)\n`);
  const results = dbRestoreCheckpoints(lastSession.id);
  for (const r of results) {
    const icon = r.success ? "+" : "x";
    console.log(`  ${icon} ${r.filePath}${r.error ? ` — ${r.error}` : ""}`);
  }
  console.log(`\nDone. ${results.filter((r) => r.success).length}/${results.length} files restored.`);
  process.exit(0);
}

// ─── Validate API key ─────────────────────────────────────────────────────────
const { provider: providerName } = parseModelString(config.model);
const keyError = validateApiKey(providerName);

let provider: ReturnType<typeof createRegistryProvider> | undefined;
let initialShowConnector = false;

if (keyError) {
  initialShowConnector = true;
} else {
  provider = createRegistryProvider({ model: config.model, maxTokens: config.maxTokens });
  setCurrentProvider(provider, config);
}

// ─── Session / Session Picker ─────────────────────────────────────────────────
let resumed = false;

if (flags.continue) {
  // --continue: always resume the most recent session, no picker
  const session = resumeLastSession(projectRoot);
  if (session) {
    resumed = true;
    console.log(`\nResuming session ${session.id.slice(0, 8)}… (${session.messages.length} messages)\n`);
  } else {
    console.log("No previous session found, starting fresh.\n");
    createSession(projectRoot, config.model);
  }

  // ─── Render TUI directly (--continue skips picker) ────────────────────────
  const { waitUntilExit } = render(
    <App
      provider={provider}
      config={config}
      projectRoot={projectRoot}
      resumed={resumed}
      initialShowConnector={initialShowConnector}
    />,
    { exitOnCtrlC: false },
  );
  await waitUntilExit();
  closeDb();

} else {
  // Check for prior sessions in this directory
  const pastSessions: StoredSession[] = dbListSessions(projectRoot, 10);

  if (pastSessions.length > 0) {
    // ─── Phase 1: Session Picker ─────────────────────────────────────────────
    let pickedSession: StoredSession | null = null;
    let startNew = false;

    await new Promise<void>((resolve) => {
      const { unmount } = render(
        <SessionPicker
          sessions={pastSessions}
          projectRoot={projectRoot}
          onResume={(s) => {
            pickedSession = s;
            unmount();
            resolve();
          }}
          onNew={() => {
            startNew = true;
            unmount();
            resolve();
          }}
        />,
        { exitOnCtrlC: true },
      );
    });

    if (pickedSession) {
      const s = pickedSession as StoredSession;
      resumeSpecificSession(s.id, projectRoot, s.model);
      resumed = true;
    } else {
      createSession(projectRoot, config.model);
    }
  } else {
    // No prior sessions — go straight in
    createSession(projectRoot, config.model);
  }

  // ─── Phase 2: Main TUI ───────────────────────────────────────────────────
  // The picker is a separate Ink root, so its frame is still on screen when it
  // unmounts. The app then paints a full-height frame underneath it, the two
  // together overflow the terminal, and Ink drops out of in-place updates —
  // which is what tiled the side panel down the window. Wipe the screen and
  // scrollback first so the app starts from a clean, exactly-one-screen frame.
  if (process.stdout.isTTY) process.stdout.write("\x1b[2J\x1b[3J\x1b[H");

  const { waitUntilExit } = render(
    <App
      provider={provider}
      config={config}
      projectRoot={projectRoot}
      resumed={resumed}
      initialShowConnector={initialShowConnector}
    />,
    { exitOnCtrlC: false },
  );
  await waitUntilExit();
  closeDb();
}
