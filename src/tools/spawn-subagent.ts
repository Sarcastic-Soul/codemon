import { z } from "zod";
import { getCurrentProvider, getCurrentConfig } from "../core/provider-instance.ts";
import { getProjectRoot } from "../sandbox/path-jail.ts";
import type { ToolDefinition } from "./types.ts";

/**
 * Built-ins a sub-agent may use. `spawn_subagent` is deliberately absent — that
 * omission is what caps nesting at depth 1.
 *
 * No longer the whole story: MCP tools register at runtime and are available to
 * sub-agents too, so the live set is computed in `subagentToolNames()`. This
 * stays as the fallback for when the registry cannot be read.
 */
export const AVAILABLE_TOOLS = ["read_file", "list_dir", "grep", "glob", "bash", "edit_file", "write_file"] as const;

/** Tools a sub-agent may never have, whatever the registry says. */
const NEVER_DELEGATED = new Set(["spawn_subagent", "todo_write"]);

/**
 * Every tool a sub-agent may use right now.
 *
 * Read from the live registry rather than a const tuple: MCP tools appear after
 * startup, and a `z.enum` frozen at module load both hides them from sub-agents
 * and — worse — is what the model sees as the list of legal values.
 */
async function subagentToolNames(): Promise<string[]> {
  try {
    // Imported lazily to break registry → spawn-subagent → registry.
    const { listToolNames } = await import("./registry.ts");
    return listToolNames().filter((n) => !NEVER_DELEGATED.has(n));
  } catch {
    return [...AVAILABLE_TOOLS];
  }
}

const schema = z.object({
  task: z
    .string()
    .describe(
      "A clear, self-contained description of the task for the sub-agent to complete. Include all necessary context — the sub-agent has no memory of the current conversation.",
    ),
  context: z
    .string()
    .optional()
    .describe(
      "Optional additional context to inject (e.g. file contents, prior search results) so the sub-agent doesn't need to re-fetch them.",
    ),
  allowed_tools: z
    .array(z.string())
    .optional()
    .describe(
      "Restrict which tools the sub-agent can use. Defaults to every tool except spawn_subagent. Unknown names are ignored. Example: ['read_file', 'grep'] for a read-only search task.",
    ),
  max_tokens: z
    .number()
    .int()
    .positive()
    .max(16384)
    .optional()
    .describe("Max tokens for the sub-agent's response. Defaults to 4096."),
});

export const spawnSubagentTool: ToolDefinition<typeof schema> = {
  name: "spawn_subagent",
  description: `Delegate a focused sub-task to a fresh sub-agent — a separate agent instance with its own clean context window.

Use this when:
- A task would pollute the main context with too much output (e.g. searching a large codebase)
- You want to parallelize work (run a search while continuing the main task)
- You need a clean, summarized result from a complex operation

The sub-agent runs under the same permission mode as this session and cannot spawn sub-agents of its own. It has no way to show a confirmation prompt, so any tool that would need one is denied and reported back in \`errors\` — in safe mode that means it is effectively read-only. Pass \`allowed_tools\` to narrow it further. It returns a concise summary of what it found/did.`,
  parameters: schema,
  permissionLevel: "bash", // Treat as bash-level since it can run anything
  async execute({ task, context, allowed_tools, max_tokens = 4096 }) {
    const provider = getCurrentProvider();
    const parentConfig = getCurrentConfig();
    const projectRoot = getProjectRoot();

    // Inherits the parent's permission mode. Anything needing confirmation is
    // denied by runToCompletion, since a sub-agent has no UI to ask through.
    const subConfig = {
      ...parentConfig,
      maxTokens: max_tokens,
      maxContextTokens: 50000,
    };

    const systemPrompt = [
      `You are a sub-agent — a focused agent instance delegated a specific task by the main Codemon agent.`,
      `Complete the task efficiently and return a concise, structured summary of your findings or actions.`,
      `Do not ask for clarification — make your best effort with the information given.`,
      `You are running in "${parentConfig.permissionMode}" permission mode with no interactive prompt available.`,
      `Any tool call that would require user confirmation is denied automatically — report it rather than retrying.`,
      `Project root: ${projectRoot}`,
      context ? `\n## Additional Context\n${context}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    // Validated here rather than in the schema so the list can change at
    // runtime. A requested name that is not currently registered is dropped
    // rather than rejected — a stale name should narrow the sub-agent, not
    // fail the delegation outright.
    const available = await subagentToolNames();
    const requested = allowed_tools?.filter((n) => available.includes(n));

    // Always pass a filter: the agent loop enforces it at execution, and the
    // omission of `spawn_subagent` from `available` is what caps nesting.
    const toolFilter = new Set<string>(
      requested && requested.length > 0 ? requested : available,
    );

    // Imported here, not at the top, to break the import cycle
    // registry → spawn-subagent → agent-loop → registry.
    const { runToCompletion, createInMemoryStore } = await import("../core/agent-loop.ts");
    const store = createInMemoryStore();

    const start = Date.now();
    const result = await runToCompletion(task, provider, subConfig, systemPrompt, store, toolFilter);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);

    return {
      output: result.output,
      tools_used: result.toolsUsed,
      errors: result.errors.length > 0 ? result.errors : undefined,
      elapsed_seconds: parseFloat(elapsed),
      message_count: store.getMessages().length,
    };
  },
};
