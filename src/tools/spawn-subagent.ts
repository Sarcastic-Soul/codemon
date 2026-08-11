import { z } from "zod";
import { runToCompletion, createInMemoryStore } from "../core/agent-loop.ts";
import { getCurrentProvider, getCurrentConfig } from "../core/provider-instance.ts";
import { getProjectRoot } from "../sandbox/path-jail.ts";
import type { ToolDefinition } from "./types.ts";

const AVAILABLE_TOOLS = ["read_file", "list_dir", "grep", "glob", "bash", "edit_file", "write_file"] as const;

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
    .array(z.enum(AVAILABLE_TOOLS))
    .optional()
    .describe(
      "Restrict which tools the sub-agent can use. Defaults to all tools. Example: ['read_file', 'grep'] for a read-only search task.",
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

The sub-agent has access to all standard tools (read_file, grep, bash, etc.) and runs in auto-approve mode. It returns a concise summary of what it found/did.`,
  parameters: schema,
  permissionLevel: "bash", // Treat as bash-level since it can run anything
  async execute({ task, context, allowed_tools, max_tokens = 4096 }) {
    const provider = getCurrentProvider();
    const parentConfig = getCurrentConfig();
    const projectRoot = getProjectRoot();

    // Sub-agent config: yolo mode (already approved by parent), reduced max_tokens
    const subConfig = {
      ...parentConfig,
      permissionMode: "yolo" as const,
      maxTokens: max_tokens,
      maxContextTokens: 50000,
    };

    const systemPrompt = [
      `You are a sub-agent — a focused agent instance delegated a specific task by the main Codemon agent.`,
      `Complete the task efficiently and return a concise, structured summary of your findings or actions.`,
      `Do not ask for clarification — make your best effort with the information given.`,
      `Project root: ${projectRoot}`,
      context ? `\n## Additional Context\n${context}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    const toolFilter = allowed_tools ? new Set<string>(allowed_tools) : undefined;
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
