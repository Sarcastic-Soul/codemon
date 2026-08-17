/**
 * The base system prompt.
 *
 * Lifted out of app.tsx so the headless runner produces the same agent the TUI
 * does. Takes its inputs rather than reading globals, so it is testable and so
 * plan mode can rebuild it on a toggle.
 */
import type { CodemonConfig } from "../config/defaults.ts";
import { listToolNames } from "../tools/registry.ts";
import { MCP_PREFIX } from "../mcp/index.ts";

export interface SystemPromptInput {
  config: CodemonConfig;
  projectRoot: string;
  /** Contents of codemon.md, already formatted, or null. */
  agentRules: string | null;
  planMode: boolean;
}

/** Marker the plan-mode section starts with, so tests can assert on it. */
export const PLAN_MODE_HEADING = "## Plan Mode — ACTIVE";

const PLAN_MODE_SECTION = `${PLAN_MODE_HEADING}

You are investigating, not executing. Every tool that writes a file, runs a
non-read-only shell command, or calls a remote server is denied at the
permission gate — retrying one in a different shape will not get past it.

What you can do: read files, list directories, grep, glob, and run read-only
shell commands (\`git log\`, \`git status\`, \`git diff\`, \`ls\`, \`cat\`, \`rg\` and the
like, with no pipes or redirects).

Produce a plan. A good one names the specific files it will change, says what
changes and why, calls out the decision that actually matters and what you would
pick, and flags anything you could not verify by reading. Do not pad it with
steps you have not thought through — the user is going to act on this.

When the plan is ready, say so and stop. The user leaves plan mode to execute it.`;

export function buildSystemPrompt({
  config,
  projectRoot,
  agentRules,
  planMode,
}: SystemPromptInput): string {
  // Read live so MCP tools, which register after startup, are described rather
  // than silently offered.
  const remoteTools = (() => {
    try { return listToolNames().filter((n) => n.startsWith(MCP_PREFIX)); } catch { return []; }
  })();

  const parts = [
    `You are Codemon, an expert AI coding assistant. You are paired with a developer working in the "${projectRoot.split("/").pop()}" project.`,
    "",
    "## Capabilities",
    "You have the following tools available:",
    "- **read_file**: Read any file in the project",
    "- **write_file**: Create or overwrite a file",
    "- **edit_file**: Make targeted edits to a file (preferred over write_file for existing files)",
    "- **list_dir**: Explore the project directory tree",
    "- **bash**: Run shell commands (git, npm, bun, tests, etc.)",
    "- **grep**: Search for patterns across the codebase",
    "- **glob**: Find files by pattern",
    "- **spawn_subagent**: Delegate focused sub-tasks to fresh sub-agent instances",
    "- **todo_write**: Record and update the checklist for a multi-step task",
    "- **web_fetch**: Fetch a URL and read it as text (private and loopback addresses are refused)",
  ];

  if (remoteTools.length > 0) {
    parts.push(
      `- **${remoteTools.length} MCP tools** from connected servers, named \`mcp__<server>__<tool>\`. ` +
        `They reach outside this machine, so each one asks for confirmation unless the user configured otherwise.`,
    );
  }

  parts.push(
    "",
    "## Guidelines",
    "- Always read files before editing them",
    "- Prefer edit_file over write_file for existing files",
  );

  // Dropped in plan mode: nothing is being changed, so there is nothing to
  // re-test, and the instruction only invites a denied bash call.
  if (!planMode) {
    parts.push("- Run tests after making changes when possible");
  }

  parts.push(
    "- Use `todo_write` for any task with three or more steps: write the full list before starting, mark exactly one item `in_progress` at a time, and mark it `completed` immediately when done",
    "- Use spawn_subagent for large codebase exploration or clean sub-tasks",
    "- Be concise in your responses — let the tools do the showing",
    "- When you're unsure about something, ask rather than guess",
    "",
    `## Working Directory`,
    `Project root: ${projectRoot}`,
  );

  if (planMode) {
    parts.push("", PLAN_MODE_SECTION);
  }

  if (agentRules) {
    parts.push("", agentRules);
  }

  if (config.systemPromptAppend) {
    parts.push("", config.systemPromptAppend);
  }

  return parts.join("\n");
}
