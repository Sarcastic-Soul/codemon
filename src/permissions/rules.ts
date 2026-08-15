import type { PermissionLevel } from "../tools/types.ts";
import type { CodemonConfig } from "../config/defaults.ts";
import { logger } from "../utils/logger.ts";

export const PERMISSION_MODES = ["safe", "standard", "yolo"] as const;

export type PermissionMode = (typeof PERMISSION_MODES)[number];

export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === "string" && (PERMISSION_MODES as readonly string[]).includes(value);
}

export interface RuleSet {
  autoAllow: Set<PermissionLevel>;
  autoDeny: Set<PermissionLevel>;
  requireConfirm: Set<PermissionLevel>;
}

/**
 * Defines which permission levels are auto-allowed, auto-denied, or need confirmation
 * for each permission mode.
 *
 * The `default` branch is unreachable through the type system, but modes also
 * arrive from config files and CLI flags that TypeScript never sees. It fails
 * closed — nothing is auto-allowed — rather than returning `undefined` and
 * taking the gate down with it.
 */
export function getRuleSet(mode: PermissionMode): RuleSet {
  switch (mode) {
    case "safe":
      return {
        autoAllow: new Set(["read"]),
        autoDeny: new Set(),
        requireConfirm: new Set(["write", "bash"]),
      };

    case "standard":
      return {
        autoAllow: new Set(["read", "write"]),
        autoDeny: new Set(),
        requireConfirm: new Set(["bash"]),
      };

    case "yolo":
      return {
        autoAllow: new Set(["read", "write", "bash"]),
        autoDeny: new Set(),
        requireConfirm: new Set(),
      };

    default:
      logger.warn("unknown permission mode — confirming everything", { mode: String(mode) });
      return {
        autoAllow: new Set(),
        autoDeny: new Set(),
        requireConfirm: new Set(["read", "write", "bash"]),
      };
  }
}

export function getRuleSetFromConfig(config: CodemonConfig): RuleSet {
  return getRuleSet(config.permissionMode);
}
