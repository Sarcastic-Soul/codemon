/**
 * Everything that has to happen before either front end starts.
 *
 * Pulled out of index.tsx because the headless runner and the MCP client need
 * the same startup — config, project root, database, provider — without an Ink
 * render. A pure move: the order here is the order index.tsx used, and it
 * matters (the project root is resolved first because the config files live
 * under it).
 */
import * as fs from "fs";
import * as path from "path";
import { loadConfig, type CodemonConfig } from "../config/load-config.ts";
import { SANDBOX_MODES, isSandboxMode } from "../config/defaults.ts";
import { PERMISSION_MODES, isPermissionMode } from "../permissions/rules.ts";
import { createRegistryProvider, parseModelString, validateApiKey } from "../providers/registry.ts";
import { setProjectRoot } from "../sandbox/path-jail.ts";
import { setCurrentProvider } from "./provider-instance.ts";
import { initDb, closeDb } from "../storage/db.ts";
import { enableDebug } from "../utils/logger.ts";
import type { Provider } from "../providers/types.ts";
import type { FlagValue } from "../cli/parse-args.ts";

export interface Bootstrapped {
  config: CodemonConfig;
  projectRoot: string;
  /** Undefined when no API key is configured; `keyError` says which. */
  provider?: Provider;
  keyError: string | null;
}

export type BootstrapResult =
  | { ok: true; value: Bootstrapped }
  | { ok: false; error: string };

// ─── Shutdown ─────────────────────────────────────────────────────────────────

const shutdownHooks: Array<() => void> = [];
let hooksInstalled = false;

/**
 * Register something to run on the way out. MCP child processes hang off this:
 * an orphaned `npx` server outliving the TUI is the failure mode users notice.
 */
export function onShutdown(hook: () => void): void {
  shutdownHooks.push(hook);
}

function runShutdownHooks(): void {
  for (const hook of shutdownHooks.splice(0)) {
    try { hook(); } catch {}
  }
}

/**
 * WAL journaling leaves `-wal` and `-shm` beside the database until the last
 * connection closes, so every exit path goes through here.
 */
function installShutdownHandlers(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;

  process.on("exit", () => {
    runShutdownHooks();
    closeDb();
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      runShutdownHooks();
      closeDb();
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
  }
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

/**
 * Ensure `.codemon` is gitignored, creating the file when absent. Skipped
 * outside a repo rather than writing a stray .gitignore into a directory.
 */
function patchGitignore(projectRoot: string): void {
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
}

export interface BootstrapOptions {
  /** Skip `process.chdir` and the signal handlers. Used by tests. */
  isolated?: boolean;
}

export function bootstrap(
  flags: Record<string, FlagValue>,
  options: BootstrapOptions = {},
): BootstrapResult {
  // Resolved before the config is read: the project config files live under the
  // region, so `--region` has to be applied first.
  const projectRoot = path.resolve(typeof flags.region === "string" ? flags.region : process.cwd());

  const overrides: Partial<CodemonConfig> = {};
  if (isPermissionMode(flags.mode)) overrides.permissionMode = flags.mode;
  if (isSandboxMode(flags.sandbox)) overrides.sandbox = flags.sandbox;
  if (typeof flags.model === "string") overrides.model = flags.model;
  if (flags.debug) overrides.debug = true;
  if (flags["no-index"]) overrides.repoIndex = false;
  if (flags.plan) overrides.planMode = true;

  const config = loadConfig(overrides, { projectRoot });

  // The same values can arrive from a config file, which the flag parser never saw.
  if (!isPermissionMode(config.permissionMode)) {
    return {
      ok: false,
      error:
        `Unknown permission mode in config: "${config.permissionMode}"\n` +
        `   Expected one of: ${PERMISSION_MODES.join(" | ")}\n` +
        `   Check ~/.codemon/config.json, codemon.json and .codemon/config.json`,
    };
  }

  if (!isSandboxMode(config.sandbox)) {
    return {
      ok: false,
      error:
        `Unknown sandbox mode in config: "${config.sandbox}"\n` +
        `   Expected one of: ${SANDBOX_MODES.join(" | ")}\n` +
        `   Check ~/.codemon/config.json, codemon.json and .codemon/config.json`,
    };
  }

  if (config.debug) enableDebug();

  setProjectRoot(projectRoot);
  if (!options.isolated) process.chdir(projectRoot);

  initDb(path.join(projectRoot, ".codemon", "sessions.db"));
  if (!options.isolated) installShutdownHandlers();

  patchGitignore(projectRoot);

  const { provider: providerName } = parseModelString(config.model);
  const keyError = validateApiKey(providerName);

  let provider: Provider | undefined;
  if (!keyError) {
    provider = createRegistryProvider({ model: config.model, maxTokens: config.maxTokens });
    setCurrentProvider(provider, config);
  }

  return { ok: true, value: { config, projectRoot, provider, keyError } };
}
