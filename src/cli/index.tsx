#!/usr/bin/env bun
import { render } from "ink";
import { App } from "./app.tsx";
import { SessionPicker } from "./components/SessionPicker.tsx";
import { parseArgs, subcommandOf, USAGE } from "./parse-args.ts";
import { bootstrap, onShutdown } from "../core/bootstrap.ts";
import { createSession, resumeLastSession, resumeSpecificSession } from "../core/session.ts";
import { closeDb } from "../storage/db.ts";
import { dbGetLastSessionForRegion, dbListSessions } from "../storage/sessions.repo.ts";
import type { StoredSession } from "../storage/sessions.repo.ts";
import { dbGetCheckpoints, dbRestoreCheckpoints } from "../storage/checkpoints.repo.ts";
import { dbListDecisions } from "../storage/audit.repo.ts";
import { runEvalSuite } from "../evals/runner.ts";
import { loadCustomCommands } from "./commands/custom.ts";
import { headlessFlags, resolvePrompt, runHeadless } from "./headless.ts";
import { startMcpServers, stopMcpServers } from "../mcp/index.ts";
import { installFrameProbe } from "./debug-frames.ts";
import * as path from "path";

// ─── Repaint probe ────────────────────────────────────────────────────────────
// Wraps stdout before any Ink root exists, so every frame either root writes is
// measured. Returns null and costs nothing unless CODEMON_DEBUG_FRAMES is set.
const frameProbe = installFrameProbe();
if (frameProbe) process.on("exit", frameProbe.uninstall);

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

// ─── Bootstrap ────────────────────────────────────────────────────────────────
// Project root, config, database, gitignore patching and provider — everything
// both front ends need. Lives in core/bootstrap.ts so `codemon run` can have it
// without pulling in Ink.
const booted = bootstrap(flags);
if (!booted.ok) {
  console.error(booted.error);
  process.exit(1);
}

const { config, projectRoot, provider, keyError } = booted.value;

// ─── Headless subcommand ──────────────────────────────────────────────────────
// Ahead of the flag subcommands below because `codemon run` is a different
// program: it never renders, and its exit code is the whole interface.
const subcommand = subcommandOf(parsed.args);
if (subcommand?.name === "run") {
  const prompt = await resolvePrompt(subcommand.rest);
  const code = await runHeadless({ boot: booted.value, prompt, ...headlessFlags(flags) });
  closeDb();
  process.exit(code);
}

// ─── Subcommands ──────────────────────────────────────────────────────────────

// --eval: run evaluation benchmark suite
if (flags.eval) {
  if (keyError) { console.error(keyError); process.exit(1); }

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

// ─── Project-local slash commands ─────────────────────────────────────────────
// Before the render, so `/` completion and /help have them on the first keystroke.
loadCustomCommands(projectRoot);

// ─── MCP servers ──────────────────────────────────────────────────────────────
// Deliberately not awaited. `buildToolSet()` runs once per agent turn, so a
// server that finishes its handshake after the first frame is picked up on the
// next turn — and a server that hangs never delays the prompt appearing.
onShutdown(stopMcpServers);
void startMcpServers(projectRoot).catch(() => {});

const initialShowConnector = keyError !== null;

// ─── Session / Session Picker ─────────────────────────────────────────────────
let resumed = false;

// ─── Why every render() below passes incrementalRendering ─────────────────────
// Ink's default write path erases and rewrites the whole previous frame every
// render. Since the root Box is `height={rows}`, that is a full-screen wipe for
// one changed character — measured at 28 of 30 rows, which is the flicker at the
// loading-to-reply hand-off. Incremental mode diffs line by line and repaints
// exactly one, but it is off by default in Ink 7. See repaint.test.tsx.
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
    { exitOnCtrlC: false, incrementalRendering: true },
  );
  await waitUntilExit();
  closeDb();

} else {
  // Check for prior sessions in this directory
  const pastSessions: StoredSession[] = dbListSessions(projectRoot, 10);

  if (pastSessions.length > 0) {
    // ─── Phase 1: Session Picker ─────────────────────────────────────────────
    let pickedSession: StoredSession | null = null;

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
            unmount();
            resolve();
          }}
        />,
        { exitOnCtrlC: true, incrementalRendering: true },
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
    { exitOnCtrlC: false, incrementalRendering: true },
  );
  await waitUntilExit();
  closeDb();
}
