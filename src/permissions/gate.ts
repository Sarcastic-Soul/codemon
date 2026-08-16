import { getRuleSet, type PermissionMode } from "./rules.ts";
import { recordDecision } from "./audit-log.ts";
import type { PermissionLevel } from "../tools/types.ts";

export type GateDecision = "allow" | "deny" | "ask";

/** Keys that have been "always allowed" in this session */
const sessionAlways = new Set<string>();

/** Derives a cache key from tool name + level for "always allow" memory. */
function alwaysKey(toolName: string, level: PermissionLevel): string {
  return `${toolName}::${level}`;
}

/** The permission gate: allow, deny, or ask the user about a tool invocation. */
export function checkPermission(
  toolName: string,
  permissionLevel: PermissionLevel,
  mode: PermissionMode,
  args: Record<string, unknown> = {},
): GateDecision {
  // Check session-remembered "always allow"
  const key = alwaysKey(toolName, permissionLevel);
  if (sessionAlways.has(key)) {
    recordDecision({ toolName, permissionLevel, args, decision: "always-allow" });
    return "allow";
  }

  const rules = getRuleSet(mode);

  if (rules.autoDeny.has(permissionLevel)) {
    recordDecision({ toolName, permissionLevel, args, decision: "deny" });
    return "deny";
  }

  if (rules.autoAllow.has(permissionLevel)) {
    recordDecision({ toolName, permissionLevel, args, decision: "allow" });
    return "allow";
  }

  // Needs user confirmation
  return "ask";
}

/** Called when the user responds "always" — remembered for the session. */
export function rememberAlways(toolName: string, permissionLevel: PermissionLevel) {
  sessionAlways.add(alwaysKey(toolName, permissionLevel));
}

/** Record a user decision (ask-allow or ask-deny) for audit purposes. */
export function recordUserDecision(
  toolName: string,
  permissionLevel: PermissionLevel,
  allowed: boolean,
  args: Record<string, unknown> = {},
) {
  recordDecision({
    toolName,
    permissionLevel,
    args,
    decision: allowed ? "ask-allow" : "ask-deny",
  });
}
