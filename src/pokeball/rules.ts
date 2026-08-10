import type { PermissionLevel } from "../moves/types.ts";
import type { CodemonConfig } from "../config/defaults.ts";

export type PermissionMode = "safe" | "standard" | "yolo";

export interface RuleSet {
  autoAllow: Set<PermissionLevel>;
  autoDeny: Set<PermissionLevel>;
  requireConfirm: Set<PermissionLevel>;
}

/**
 * Defines which permission levels are auto-allowed, auto-denied, or need confirmation
 * for each Poké Ball mode.
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
  }
}

export function getRuleSetFromConfig(config: CodemonConfig): RuleSet {
  return getRuleSet(config.permissionMode);
}
