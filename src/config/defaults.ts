import * as fs from "fs";
import * as path from "path";
import { logger } from "../utils/logger.ts";
import { getUserConfigDir } from "./user-config.ts";

export const SANDBOX_MODES = ["subprocess", "docker"] as const;

export type SandboxMode = (typeof SANDBOX_MODES)[number];

export function isSandboxMode(value: unknown): value is SandboxMode {
  return typeof value === "string" && (SANDBOX_MODES as readonly string[]).includes(value);
}

export interface CodemonConfig {
  /**
   * Model string in `provider:model-name` format.
   * Examples: "google:gemini-2.0-flash-exp", "anthropic:claude-sonnet-4-5", "openai:gpt-4o"
   * Slash format also accepted: "google/gemini-2.0-flash-exp"
   */
  model: string;
  permissionMode: "safe" | "standard" | "yolo";
  maxTokens: number;
  maxContextTokens: number;
  /**
   * How many tool-calling turns one user message may take before the loop
   * stops on its own. Without a ceiling, a model stuck in a retry spiral runs
   * until the process is killed, burning tokens the whole way.
   */
  maxTurns: number;
  timeout: number;
  debug: boolean;
  systemPromptAppend: string;
  /** Sandbox mode for bash commands: subprocess (default) or docker */
  sandbox: SandboxMode;
  /** Whether to build a repo index and inject it into the system prompt */
  repoIndex: boolean;
}

export const DEFAULTS: CodemonConfig = {
  model: "google:gemini-2.0-flash-exp",
  permissionMode: "standard",
  maxTokens: 8192,
  maxContextTokens: 100000,
  maxTurns: 25,
  timeout: 30000,
  debug: false,
  systemPromptAppend: "",
  sandbox: "subprocess",
  repoIndex: true,
};

/**
 * Keys a config file is allowed to set. Anything else in the file is ignored —
 * `~/.codemon/config.json` also holds `apiKeys`, and this object is handed to
 * sub-agents and the eval runner, so credentials must not ride along inside it.
 */
const CONFIG_KEYS = Object.keys(DEFAULTS) as (keyof CodemonConfig)[];

export interface LoadConfigOptions {
  /**
   * Root the two project-level config files are read from. Defaults to the
   * current directory, but `--region` moves the project and the config has to
   * follow it — so the CLI resolves the region before it loads the config.
   */
  projectRoot?: string;
}

function pickConfigKeys(raw: unknown, source: string): Partial<CodemonConfig> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    logger.warn("config file is not a JSON object — ignored", { source });
    return {};
  }

  const record = raw as Record<string, unknown>;
  const picked: Record<string, unknown> = {};

  for (const key of CONFIG_KEYS) {
    const value = record[key];
    if (value === undefined) continue;
    if (typeof value !== typeof DEFAULTS[key]) {
      logger.warn("config key has the wrong type — ignored", {
        source,
        key,
        expected: typeof DEFAULTS[key],
        got: typeof value,
      });
      continue;
    }
    picked[key] = value;
  }

  // `/connector` persists the selected model under `defaultModel` (see
  // user-config.ts). It writes the same file this reads, so honour the alias —
  // otherwise choosing a model in the TUI persists nothing anybody reads back.
  if (picked.model === undefined && typeof record.defaultModel === "string") {
    picked.model = record.defaultModel;
  }

  return picked as Partial<CodemonConfig>;
}

function readConfigFile(filePath: string): Partial<CodemonConfig> {
  if (!fs.existsSync(filePath)) return {};
  try {
    return pickConfigKeys(JSON.parse(fs.readFileSync(filePath, "utf8")), filePath);
  } catch (err) {
    logger.warn("config file could not be parsed — ignored", {
      source: filePath,
      error: String(err),
    });
    return {};
  }
}

function envOverrides(): Partial<CodemonConfig> {
  const overrides: Partial<CodemonConfig> = {};
  const model = process.env.CODEMON_MODEL?.trim();
  if (model) overrides.model = model;
  return overrides;
}

/** Spreading `{ model: undefined }` would beat DEFAULTS, so drop those first. */
function definedOnly(overrides: Partial<CodemonConfig>): Partial<CodemonConfig> {
  return Object.fromEntries(
    Object.entries(overrides).filter(([, value]) => value !== undefined),
  ) as Partial<CodemonConfig>;
}

/**
 * Assemble the runtime config, lowest precedence first:
 *
 *   1. built-in DEFAULTS
 *   2. ~/.codemon/config.json          user-level, and where /connector writes
 *   3. <project>/codemon.json          committed with the repo
 *   4. <project>/.codemon/config.json  project-local, gitignored
 *   5. CODEMON_MODEL                   environment
 *   6. `overrides`                     CLI flags
 */
export function loadConfig(
  overrides: Partial<CodemonConfig> = {},
  options: LoadConfigOptions = {},
): CodemonConfig {
  const projectRoot = options.projectRoot ?? process.cwd();

  const config: Partial<CodemonConfig> = {
    ...readConfigFile(path.join(getUserConfigDir(), "config.json")),
    ...readConfigFile(path.join(projectRoot, "codemon.json")),
    ...readConfigFile(path.join(projectRoot, ".codemon", "config.json")),
    ...envOverrides(),
    ...definedOnly(overrides),
  };

  return { ...DEFAULTS, ...config };
}
