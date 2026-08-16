import type { Provider, ModelMessage } from "../providers/types.ts";
import { DEFAULTS, effectiveContextTokens, type CodemonConfig } from "../config/defaults.ts";
import { buildToolSet, getTool } from "../tools/registry.ts";
import { checkPermission, rememberAlways, recordUserDecision } from "../permissions/gate.ts";
import { ContextManager } from "./context-manager.ts";
import { addMessage, updateTokenUsage, getMessages } from "./session.ts";
import { logger } from "../utils/logger.ts";

/** Convert a tool execution result to the AI SDK v7 `output` schema. */
function toToolOutput(value: unknown): { type: "text"; value: string } | { type: "json"; value: unknown } {
  if (typeof value === "string") return { type: "text", value };
  return { type: "json", value: value ?? null };
}

export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool-start"; toolName: string; toolCallId: string; args: Record<string, unknown> }
  | { type: "tool-result"; toolCallId: string; toolName: string; result: unknown }
  | { type: "tool-error"; toolCallId: string; toolName: string; error: string }
  | {
      type: "permission-required";
      toolName: string;
      toolCallId: string;
      args: Record<string, unknown>;
      permissionLevel: string;
      resolve: (decision: "allow" | "deny" | "always") => void;
    }
  | {
      // Emitted once per turn, after truncation, so a UI can show how full the
      // window actually is rather than inferring it from cumulative spend.
      type: "context";
      estimatedTokens: number;
      maxTokens: number;
      percentUsed: number;
      messageCount: number;
    }
  | { type: "finish"; reason: string; usage?: { promptTokens: number; completionTokens: number } }
  | { type: "error"; error: Error };

type UserDecision = "allow" | "deny" | "always";

/** Finish reason yielded when the turn budget runs out. */
export const MAX_TURNS_REASON = "max-turns";

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
}

/**
 * MessageStore — abstraction over message history.
 * The main agent uses the global session store; sub-agents use ephemeral stores.
 */
export interface MessageStore {
  getMessages(): ModelMessage[];
  addMessage(msg: ModelMessage): void;
  updateTokenUsage(usage: TokenUsage): void;
}

/** Create a fresh in-memory store (for sub-agents and evals) */
export function createInMemoryStore(initialMessages: ModelMessage[] = []): MessageStore {
  const messages: ModelMessage[] = [...initialMessages];
  return {
    getMessages: () => messages,
    addMessage: (msg) => messages.push(msg),
    updateTokenUsage: (_) => {},
  };
}

/** The global session-backed store (used by the main agent) */
const globalSessionStore: MessageStore = {
  getMessages,
  addMessage,
  updateTokenUsage,
};

// ─── Core agent loop (accepts any MessageStore) ───────────────────────────────

async function* _agentLoop(
  userMessage: string,
  provider: Provider,
  config: CodemonConfig,
  systemPrompt: string,
  store: MessageStore,
  toolNameFilter?: Set<string>, // optional: restrict which tools are available
): AsyncGenerator<AgentEvent> {
  const contextBudget = effectiveContextTokens(config);
  const contextManager = new ContextManager(contextBudget);
  const allTools = buildToolSet();

  // Optionally filter tools for sub-agents
  const tools = toolNameFilter
    ? Object.fromEntries(Object.entries(allTools).filter(([k]) => toolNameFilter.has(k)))
    : allTools;

  // Add the user message to history
  store.addMessage({ role: "user", content: userMessage });

  // A hand-written config.json could disable the ceiling, so a bad value falls
  // back to the default rather than looping forever.
  const maxTurns =
    Number.isFinite(config.maxTurns) && config.maxTurns > 0
      ? Math.floor(config.maxTurns)
      : DEFAULTS.maxTurns;

  let continueLoop = true;
  let turnsUsed = 0;

  while (continueLoop) {
    if (turnsUsed >= maxTurns) {
      // Only reachable when the model keeps asking for tools. Say so out loud:
      // a silent stop looks like the agent deciding it was finished.
      const notice =
        `⚠️ Stopped after ${maxTurns} tool-calling turns without a final answer ` +
        `(max-turns budget). Nothing was rolled back — send another message to continue, ` +
        `or raise \`maxTurns\` in your config.`;
      yield { type: "text", text: notice };
      store.addMessage({ role: "assistant", content: notice });
      yield { type: "finish", reason: MAX_TURNS_REASON };
      break;
    }
    turnsUsed++;

    const rawMessages = store.getMessages();
    const messages = contextManager.maybeTruncate(rawMessages, systemPrompt);

    // Measured on what is actually being sent, so a trim shows up as the number
    // dropping rather than as nothing at all.
    const contextStats = contextManager.getStats(messages, systemPrompt);
    yield {
      type: "context",
      estimatedTokens: contextStats.estimatedTokens,
      maxTokens: contextBudget,
      percentUsed: contextStats.percentUsed,
      messageCount: contextStats.messageCount,
    };

    logger.debug("agent-loop: calling LLM", { messageCount: messages.length });

    let assistantText = "";
    let streamFailed = false;
    const pendingToolCalls: Array<{ toolCallId: string; toolName: string; args: Record<string, unknown> }> = [];

    for await (const event of provider.streamMessage({ messages, tools, system: systemPrompt, maxTokens: config.maxTokens })) {
      switch (event.type) {
        case "text":
          assistantText += event.text ?? "";
          yield { type: "text", text: event.text ?? "" };
          break;

        // Not accumulated into `assistantText`: reasoning is shown live but is
        // not part of the reply, and echoing it back into history would feed
        // the model its own scratchpad next turn.
        case "reasoning":
          yield { type: "reasoning", text: event.text ?? "" };
          break;

        case "tool-call":
          pendingToolCalls.push({
            toolCallId: event.toolCallId!,
            toolName: event.toolName!,
            args: event.toolArgs ?? {},
          });
          yield { type: "tool-start", toolCallId: event.toolCallId!, toolName: event.toolName!, args: event.toolArgs ?? {} };
          break;

        case "finish":
          // Both halves are recorded: prompt tokens dominate spend, since every
          // turn resends the whole history.
          if (event.usage) store.updateTokenUsage(event.usage);
          yield { type: "finish", reason: event.finishReason ?? "end_turn", usage: event.usage };
          break;

        case "error":
          yield { type: "error", error: event.error! };
          streamFailed = true;
          continueLoop = false;
          break;
      }

      // An errored turn is over — don't drain the stream and run side effects
      // for a turn the model never finished.
      if (streamFailed) break;
    }

    if (streamFailed) {
      // Keep whatever text arrived, but drop the tool calls: an assistant
      // message with an unanswered tool-call is the shape providers reject.
      if (assistantText) store.addMessage({ role: "assistant", content: assistantText });
      for (const tc of pendingToolCalls) {
        yield {
          type: "tool-error",
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          error: "Turn aborted by a stream error before this tool ran",
        };
      }
      break;
    }

    // Save assistant message
    if (assistantText || pendingToolCalls.length > 0) {
      const assistantContent: Array<unknown> = [];
      if (assistantText) assistantContent.push({ type: "text", text: assistantText });
      for (const tc of pendingToolCalls) {
        assistantContent.push({ type: "tool-call", toolCallId: tc.toolCallId, toolName: tc.toolName, input: tc.args });
      }
      store.addMessage({ role: "assistant", content: assistantContent } as unknown as ModelMessage);
    }

    if (pendingToolCalls.length === 0) { continueLoop = false; break; }

    // Execute each tool call
    // AI SDK v7 schema: tool-result parts must use `output: {type, value}` not `result`
    const toolResults: Array<{
      type: "tool-result";
      toolCallId: string;
      toolName: string;
      output: { type: "text"; value: string } | { type: "json"; value: unknown };
    }> = [];

    for (const tc of pendingToolCalls) {
      // Filtering the toolset only shapes what the model is *offered*, and
      // `getTool` reads the global registry — so enforce the filter here too.
      if (toolNameFilter && !toolNameFilter.has(tc.toolName)) {
        const error = `Tool "${tc.toolName}" is not available to this agent`;
        toolResults.push({ type: "tool-result", toolCallId: tc.toolCallId, toolName: tc.toolName, output: { type: "json", value: { error } } });
        yield { type: "tool-error", toolCallId: tc.toolCallId, toolName: tc.toolName, error };
        continue;
      }

      const toolDef = getTool(tc.toolName);
      if (!toolDef) {
        toolResults.push({ type: "tool-result", toolCallId: tc.toolCallId, toolName: tc.toolName, output: { type: "json", value: { error: `Unknown tool: ${tc.toolName}` } } });
        yield { type: "tool-error", toolCallId: tc.toolCallId, toolName: tc.toolName, error: `Unknown tool: ${tc.toolName}` };
        continue;
      }

      const decision = checkPermission(tc.toolName, toolDef.permissionLevel, config.permissionMode, tc.args);

      if (decision === "deny") {
        toolResults.push({ type: "tool-result", toolCallId: tc.toolCallId, toolName: tc.toolName, output: { type: "json", value: { error: "Blocked by permission gate (permission denied)" } } });
        yield { type: "tool-error", toolCallId: tc.toolCallId, toolName: tc.toolName, error: "Blocked by permission gate" };
        continue;
      }

      if (decision === "ask") {
        const decisionHolder = { value: "deny" as UserDecision };
        let permResolve!: () => void;
        const permPromise = new Promise<void>((res) => { permResolve = res; });
        yield {
          type: "permission-required",
          toolName: tc.toolName,
          toolCallId: tc.toolCallId,
          args: tc.args,
          permissionLevel: toolDef.permissionLevel,
          resolve: (d: UserDecision) => { decisionHolder.value = d; permResolve(); },
        };
        await permPromise;
        const userDecision = decisionHolder.value;
        if (userDecision === "always") rememberAlways(tc.toolName, toolDef.permissionLevel);
        recordUserDecision(tc.toolName, toolDef.permissionLevel, userDecision !== "deny", tc.args);
        if (userDecision === "deny") {
          toolResults.push({ type: "tool-result", toolCallId: tc.toolCallId, toolName: tc.toolName, output: { type: "json", value: { error: "User denied" } } });
          yield { type: "tool-error", toolCallId: tc.toolCallId, toolName: tc.toolName, error: "User denied" };
          continue;
        }
      }

      try {
        logger.info("executing tool", { name: tc.toolName, args: tc.args });
        const rawResult = await toolDef.execute(tc.args as never);
        const output = toToolOutput(rawResult);
        toolResults.push({ type: "tool-result", toolCallId: tc.toolCallId, toolName: tc.toolName, output });
        yield { type: "tool-result", toolCallId: tc.toolCallId, toolName: tc.toolName, result: rawResult };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        toolResults.push({ type: "tool-result", toolCallId: tc.toolCallId, toolName: tc.toolName, output: { type: "json", value: { error: errMsg } } });
        yield { type: "tool-error", toolCallId: tc.toolCallId, toolName: tc.toolName, error: errMsg };
      }
    }

    store.addMessage({ role: "tool", content: toolResults } as unknown as ModelMessage);
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Main agent loop — uses the global session store (persisted to SQLite) */
export async function* runAgent(
  userMessage: string,
  provider: Provider,
  config: CodemonConfig,
  systemPrompt: string,
): AsyncGenerator<AgentEvent> {
  yield* _agentLoop(userMessage, provider, config, systemPrompt, globalSessionStore);
}

/** Sub-agent / eval loop — uses an ephemeral in-memory store */
export async function* runAgentWithStore(
  userMessage: string,
  provider: Provider,
  config: CodemonConfig,
  systemPrompt: string,
  store: MessageStore,
  toolFilter?: Set<string>,
): AsyncGenerator<AgentEvent> {
  yield* _agentLoop(userMessage, provider, config, systemPrompt, store, toolFilter);
}

/** Run an agent to full completion (non-streaming), for sub-agents and evals. */
export async function runToCompletion(
  userMessage: string,
  provider: Provider,
  config: CodemonConfig,
  systemPrompt: string,
  store?: MessageStore,
  toolFilter?: Set<string>,
): Promise<{ output: string; toolsUsed: string[]; errors: string[] }> {
  const s = store ?? createInMemoryStore();
  let output = "";
  const toolsUsed: string[] = [];
  const errors: string[] = [];

  for await (const event of _agentLoop(userMessage, provider, config, systemPrompt, s, toolFilter)) {
    if (event.type === "text") output += event.text;
    if (event.type === "tool-start") toolsUsed.push(event.toolName);
    if (event.type === "tool-error") errors.push(`${event.toolName}: ${event.error}`);
    if (event.type === "error") errors.push(event.error.message);

    // The notice also lands in `output`, but a caller checking whether the run
    // finished shouldn't have to grep prose for it.
    if (event.type === "finish" && event.reason === MAX_TURNS_REASON) {
      errors.push(`Turn budget exhausted after ${config.maxTurns} turns — the task may be incomplete`);
    }

    // A headless run has no UI to answer a prompt. Deny and carry on: leaving
    // the promise unsettled hangs the run with no timeout.
    if (event.type === "permission-required") {
      errors.push(
        `${event.toolName}: denied — ${event.permissionLevel}-level tools need confirmation in "${config.permissionMode}" mode, and a sub-agent has no way to ask`,
      );
      event.resolve("deny");
    }
  }

  return { output, toolsUsed, errors };
}
