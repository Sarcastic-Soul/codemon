import { getRuleSet, type PermissionMode } from "./rules.ts";
import { recordDecision } from "./audit-log.ts";
import { isReadOnlyCommand } from "./plan-allowlist.ts";
import type { PermissionLevel } from "../tools/types.ts";

export type GateDecision = "allow" | "deny" | "ask";

/** Keys that have been "always allowed" in this session */
const sessionAlways = new Set<string>();

/** Levels that change something. Plan mode refuses all of them. */
const MUTATING_LEVELS: ReadonlySet<PermissionLevel> = new Set(["write", "bash", "network"]);

/**
 * What the model is told when plan mode blocks a call. It has to say *why*,
 * or the model retries the same call in a different shape instead of writing
 * the plan it was asked for.
 */
export const PLAN_MODE_DENIAL =
  "Blocked: plan mode is active. Investigate and propose a plan; do not modify anything. " +
  "The user will exit plan mode to execute.";

/** Derives a cache key from tool name + level for "always allow" memory. */
function alwaysKey(toolName: string, level: PermissionLevel): string {
  return `${toolName}::${level}`;
}

export interface PermissionOptions {
  args?: Record<string, unknown>;
  /** True while the agent is investigating rather than executing. */
  planMode?: boolean;
}

/**
 * Whether plan mode blocks this call outright.
 *
 * Exported so the agent loop can produce the explanatory denial without asking
 * the gate twice. Read-only bash falls through to the ordinary rules rather
 * than being waved past them: plan mode may only ever narrow what is allowed,
 * so `git log` in safe mode still prompts exactly as it would otherwise.
 */
export function planModeBlocks(
  permissionLevel: PermissionLevel,
  args: Record<string, unknown>,
): { blocked: boolean; reason?: string } {
  if (!MUTATING_LEVELS.has(permissionLevel)) return { blocked: false };

  if (permissionLevel === "bash") {
    const command = typeof args.command === "string" ? args.command : "";
    const verdict = isReadOnlyCommand(command);
    return verdict.allowed ? { blocked: false } : { blocked: true, reason: verdict.reason };
  }

  return { blocked: true };
}

/** The permission gate: allow, deny, or ask the user about a tool invocation. */
export function checkPermission(
  toolName: string,
  permissionLevel: PermissionLevel,
  mode: PermissionMode,
  args: Record<string, unknown> = {},
  options: PermissionOptions = {},
): GateDecision {
  // Ahead of the "always allow" check on purpose. A tool the user blanket-
  // approved earlier in the session would otherwise sail straight past plan
  // mode, which is precisely the guarantee plan mode is selling.
  if (options.planMode && planModeBlocks(permissionLevel, args).blocked) {
    recordDecision({ toolName, permissionLevel, args, decision: "deny" });
    return "deny";
  }

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

/** Drop every session "always allow" grant. Exposed for tests. */
export function clearSessionGrants(): void {
  sessionAlways.clear();
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
