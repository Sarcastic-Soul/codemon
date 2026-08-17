import * as fs from "fs";
import * as path from "path";
import { logger } from "../utils/logger.ts";
import { getUserConfigDir } from "./paths.ts";
import { resolveContextWindow } from "../providers/catalog.ts";

export const SANDBOX_MODES = ["subprocess", "docker"] as const;

export type SandboxMode = (typeof SANDBOX_MODES)[number];

export function isSandboxMode(value: unknown): value is SandboxMode {
  return typeof value === "string" && (SANDBOX_MODES as readonly string[]).includes(value);
}

export interface CodemonConfig {
  /** Model string in `provider:model-name` form, e.g. "openai:gpt-4o". Slash
   *  format is also accepted. */
  model: string;
  permissionMode: "safe" | "standard" | "yolo";
  maxTokens: number;
  /**
   * History budget in tokens, or `0` for "size it to whatever model is in use".
   * Read through `effectiveContextTokens()` rather than directly — a set value
   * is a deliberate override and has to survive a mid-session model switch.
   */
  maxContextTokens: number;
  /** How many tool-calling turns one user message may take before the loop
   *  stops on its own, so a retry spiral can't burn tokens indefinitely. */
  maxTurns: number;
  timeout: number;
  debug: boolean;
  systemPromptAppend: string;
  /** Sandbox mode for bash commands: subprocess (default) or docker */
  sandbox: SandboxMode;
  /** Whether to build a repo index and inject it into the system prompt */
  repoIndex: boolean;
  /**
   * Investigate-only mode: every mutating tool is denied at the gate and the
   * system prompt asks for a plan instead.
   *
   * Orthogonal to `permissionMode`, not a fourth value of it — those say how
   * much the agent asks, this says what the agent is doing. A `safe` session
   * and a `yolo` one can both be in plan mode, and plan mode narrows both.
   */
  planMode: boolean;
}

export const DEFAULTS: CodemonConfig = {
  model: "google:gemini-flash-latest",
  permissionMode: "standard",
  maxTokens: 8192,
  maxContextTokens: 0, // auto — see effectiveContextTokens()
  maxTurns: 25,
  timeout: 30000,
  debug: false,
  systemPromptAppend: "",
  sandbox: "subprocess",
  repoIndex: true,
  planMode: false,
};

/**
 * Keys a config file is allowed to set. Anything else is ignored — the same
 * file holds `apiKeys`, and credentials must not ride along in this object.
 */
const CONFIG_KEYS = Object.keys(DEFAULTS) as (keyof CodemonConfig)[];

export interface LoadConfigOptions {
  /** Root the project-level config files are read from. Defaults to cwd, but
   *  `--region` moves the project and the config follows it. */
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

  // `/connector` persists the selected model under `defaultModel` into this
  // same file, so honour the alias.
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
 * Assemble the runtime config, lowest precedence first: DEFAULTS,
 * ~/.codemon/config.json, <project>/codemon.json, <project>/.codemon/config.json,
 * CODEMON_MODEL, then CLI `overrides`.
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

/** Used when neither the config nor the catalog has anything better to say. */
export const FALLBACK_CONTEXT_TOKENS = 100_000;

/**
 * The history budget to actually use, for `model` if given or the configured one.
 *
 * A flat ceiling trimmed a million-token model at a tenth of its window and blew
 * straight past a 32k one — the first wastes context, the second 400s mid-session
 * — so the default is to take the window from the catalog. A non-zero
 * `maxContextTokens` is a deliberate override and always wins, including after
 * `/connector` switches models, which is the whole reason this is a function of
 * the model rather than a value baked in at load time.
 */
export function effectiveContextTokens(config: CodemonConfig, model?: string): number {
  if (config.maxContextTokens > 0) return config.maxContextTokens;
  return resolveContextWindow(model ?? config.model, config.maxTokens, FALLBACK_CONTEXT_TOKENS);
}
