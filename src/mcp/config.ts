/**
 * The `mcpServers` config block.
 *
 * Read straight from the config files rather than through `loadConfig`: it is
 * not a `CodemonConfig` scalar and must not pass through `pickConfigKeys`,
 * which drops anything that is not a known key of the right primitive type.
 */
import * as fs from "fs";
import * as path from "path";
import { getUserConfigDir } from "../config/paths.ts";
import { logger } from "../utils/logger.ts";
import type { PermissionLevel } from "../tools/types.ts";

export interface McpServerConfig {
  /** Executable to spawn. Required — this is a stdio transport. */
  command: string;
  args?: string[];
  /** Extra environment. `${VAR}` expands from process.env at spawn time. */
  env?: Record<string, string>;
  /** Default true; set false to keep a declaration without running it. */
  enabled?: boolean;
  /** Milliseconds to wait for the handshake and for each call. */
  timeout?: number;
  /**
   * Per-tool permission overrides. Without one a tool is `network`, which
   * prompts in every mode but yolo. This is how a genuinely read-only tool
   * gets opted down — explicitly, per tool, in the user's own config.
   */
  permissions?: Record<string, PermissionLevel>;
}

export type McpServers = Record<string, McpServerConfig>;

/** Default per-call timeout, matching the config default for shell commands. */
export const DEFAULT_MCP_TIMEOUT = 30_000;

const VALID_LEVELS = new Set<string>(["read", "write", "bash", "network"]);

/**
 * Expand `${VAR}` against the environment.
 *
 * The reason the config format has this at all: a token belongs in the
 * environment, and writing it into a config file is how it ends up in a repo.
 * An unset variable expands to empty rather than to the literal `${VAR}`, so a
 * server fails to authenticate rather than authenticating as the string.
 */
export function expandEnvVars(value: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => {
    return process.env[name] ?? "";
  });
}

function validateServer(name: string, raw: unknown): McpServerConfig | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    logger.warn("mcp: server entry is not an object — ignored", { server: name });
    return null;
  }

  const record = raw as Record<string, unknown>;
  if (typeof record.command !== "string" || record.command.trim() === "") {
    logger.warn("mcp: server has no command — ignored", { server: name });
    return null;
  }

  const args = Array.isArray(record.args)
    ? record.args.filter((a): a is string => typeof a === "string")
    : undefined;

  let env: Record<string, string> | undefined;
  if (typeof record.env === "object" && record.env !== null) {
    env = {};
    for (const [key, value] of Object.entries(record.env as Record<string, unknown>)) {
      if (typeof value === "string") env[key] = value;
    }
  }

  let permissions: Record<string, PermissionLevel> | undefined;
  if (typeof record.permissions === "object" && record.permissions !== null) {
    permissions = {};
    for (const [tool, level] of Object.entries(record.permissions as Record<string, unknown>)) {
      if (typeof level === "string" && VALID_LEVELS.has(level)) {
        permissions[tool] = level as PermissionLevel;
      } else {
        logger.warn("mcp: unknown permission level — ignored", { server: name, tool, level: String(level) });
      }
    }
  }

  return {
    command: record.command,
    ...(args ? { args } : {}),
    ...(env ? { env } : {}),
    enabled: record.enabled !== false,
    timeout:
      typeof record.timeout === "number" && record.timeout > 0
        ? record.timeout
        : DEFAULT_MCP_TIMEOUT,
    ...(permissions ? { permissions } : {}),
  };
}

function readServersFrom(filePath: string): McpServers {
  if (!fs.existsSync(filePath)) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    logger.warn("mcp: config file could not be parsed — ignored", {
      source: filePath,
      error: String(err),
    });
    return {};
  }

  if (typeof parsed !== "object" || parsed === null) return {};
  const block = (parsed as Record<string, unknown>).mcpServers;
  if (typeof block !== "object" || block === null || Array.isArray(block)) return {};

  const servers: McpServers = {};
  for (const [name, raw] of Object.entries(block as Record<string, unknown>)) {
    const validated = validateServer(name, raw);
    if (validated) servers[name] = validated;
  }
  return servers;
}

/**
 * Every declared server, project config overriding the user's by name — the
 * same precedence `loadConfig` uses.
 */
export function loadMcpServers(projectRoot: string): McpServers {
  return {
    ...readServersFrom(path.join(getUserConfigDir(), "config.json")),
    ...readServersFrom(path.join(projectRoot, "codemon.json")),
    ...readServersFrom(path.join(projectRoot, ".codemon", "config.json")),
  };
}

/** Only those actually meant to run. */
export function enabledServers(servers: McpServers): Array<[string, McpServerConfig]> {
  return Object.entries(servers).filter(([, cfg]) => cfg.enabled !== false);
}
