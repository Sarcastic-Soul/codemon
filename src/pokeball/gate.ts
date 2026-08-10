import { getRuleSet, type PermissionMode } from "./rules.ts";
import { recordDecision } from "./audit-log.ts";
import type { PermissionLevel } from "../moves/types.ts";

export type GateDecision = "allow" | "deny" | "ask";

/** Keys that have been "always allowed" in this session */
const sessionAlways = new Set<string>();

/**
 * Derives a cache key from tool name + args for "always allow" memory.
 */
function alwaysKey(toolName: string, level: PermissionLevel): string {
  return `${toolName}::${level}`;
}

/**
 * The Poké Ball gate. Given a tool invocation, returns whether to allow, deny, or ask the user.
 */
export function checkPermission(
  toolName: string,
  permissionLevel: PermissionLevel,
  mode: PermissionMode,
): GateDecision {
  // Check session-remembered "always allow"
  const key = alwaysKey(toolName, permissionLevel);
  if (sessionAlways.has(key)) {
    recordDecision({ toolName, permissionLevel, args: {}, decision: "always-allow" });
    return "allow";
  }

  const rules = getRuleSet(mode);

  if (rules.autoDeny.has(permissionLevel)) {
    recordDecision({ toolName, permissionLevel, args: {}, decision: "deny" });
    return "deny";
  }

  if (rules.autoAllow.has(permissionLevel)) {
    recordDecision({ toolName, permissionLevel, args: {}, decision: "allow" });
    return "allow";
  }

  // Needs user confirmation
  return "ask";
}

/**
 * Called when the user responds "always" — remembers this for the rest of the session.
 */
export function rememberAlways(toolName: string, permissionLevel: PermissionLevel) {
  sessionAlways.add(alwaysKey(toolName, permissionLevel));
}

/**
 * Record a user decision (ask-allow or ask-deny) for audit purposes.
 */
export function recordUserDecision(
  toolName: string,
  permissionLevel: PermissionLevel,
  allowed: boolean,
) {
  recordDecision({
    toolName,
    permissionLevel,
    args: {},
    decision: allowed ? "ask-allow" : "ask-deny",
  });
}
