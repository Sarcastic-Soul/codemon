import type { Provider, ModelMessage } from "../providers/types.ts";
import type { CodemonConfig } from "../config/defaults.ts";
import { buildToolSet, getMove } from "../moves/registry.ts";
import { checkPermission, rememberAlways, recordUserDecision } from "../pokeball/gate.ts";
import { ContextManager } from "./context-manager.ts";
import { addMessage, updateTokenUsage, getMessages } from "./session.ts";
import { logger } from "../utils/logger.ts";

export type BattleEvent =
  | { type: "text"; text: string }
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
  | { type: "finish"; reason: string; usage?: { promptTokens: number; completionTokens: number } }
  | { type: "error"; error: Error };

type UserDecision = "allow" | "deny" | "always";

/**
 * MessageStore — abstraction over message history.
 * The main agent uses the global session store; sub-agents use ephemeral stores.
 */
export interface MessageStore {
  getMessages(): ModelMessage[];
  addMessage(msg: ModelMessage): void;
  updateTokenUsage(tokens: number): void;
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

// ─── Core engine loop (accepts any MessageStore) ─────────────────────────────

async function* _engineCore(
  userMessage: string,
  provider: Provider,
  config: CodemonConfig,
  systemPrompt: string,
  store: MessageStore,
  toolNameFilter?: Set<string>, // optional: restrict which tools are available
): AsyncGenerator<BattleEvent> {
  const contextManager = new ContextManager(config.maxContextTokens);
  const allTools = buildToolSet();

  // Optionally filter tools for sub-agents
  const tools = toolNameFilter
    ? Object.fromEntries(Object.entries(allTools).filter(([k]) => toolNameFilter.has(k)))
    : allTools;

  // Add the user message to history
  store.addMessage({ role: "user", content: userMessage });

  let continueLoop = true;

  while (continueLoop) {
    const rawMessages = store.getMessages();
    const messages = contextManager.maybeTruncate(rawMessages, systemPrompt);

    logger.debug("battle-engine: calling LLM", { messageCount: messages.length });

    let assistantText = "";
    const pendingToolCalls: Array<{ toolCallId: string; toolName: string; args: Record<string, unknown> }> = [];

    for await (const event of provider.streamMessage({ messages, tools, system: systemPrompt, maxTokens: config.maxTokens })) {
      switch (event.type) {
        case "text":
          assistantText += event.text ?? "";
          yield { type: "text", text: event.text ?? "" };
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
          if (event.usage) store.updateTokenUsage(event.usage.completionTokens);
          yield { type: "finish", reason: event.finishReason ?? "end_turn", usage: event.usage };
          break;

        case "error":
          yield { type: "error", error: event.error! };
          continueLoop = false;
          break;
      }
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
    const toolResults: Array<{ type: "tool-result"; toolCallId: string; result: unknown }> = [];

    for (const tc of pendingToolCalls) {
      const move = getMove(tc.toolName);
      if (!move) {
        const errResult = { error: `Unknown move: ${tc.toolName}` };
        toolResults.push({ type: "tool-result", toolCallId: tc.toolCallId, result: errResult });
        yield { type: "tool-error", toolCallId: tc.toolCallId, toolName: tc.toolName, error: `Unknown move: ${tc.toolName}` };
        continue;
      }

      const decision = checkPermission(tc.toolName, move.permissionLevel, config.permissionMode);

      if (decision === "deny") {
        const errResult = { error: "Blocked by Poké Ball (permission denied)" };
        toolResults.push({ type: "tool-result", toolCallId: tc.toolCallId, result: errResult });
        yield { type: "tool-error", toolCallId: tc.toolCallId, toolName: tc.toolName, error: "Blocked by Poké Ball" };
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
          permissionLevel: move.permissionLevel,
          resolve: (d: UserDecision) => { decisionHolder.value = d; permResolve(); },
        };
        await permPromise;
        const userDecision = decisionHolder.value;
        if (userDecision === "always") rememberAlways(tc.toolName, move.permissionLevel);
        recordUserDecision(tc.toolName, move.permissionLevel, userDecision !== "deny");
        if (userDecision === "deny") {
          toolResults.push({ type: "tool-result", toolCallId: tc.toolCallId, result: { error: "User denied" } });
          yield { type: "tool-error", toolCallId: tc.toolCallId, toolName: tc.toolName, error: "User denied" };
          continue;
        }
      }

      try {
        logger.info("executing move", { name: tc.toolName, args: tc.args });
        const result = await move.execute(tc.args as never);
        toolResults.push({ type: "tool-result", toolCallId: tc.toolCallId, result });
        yield { type: "tool-result", toolCallId: tc.toolCallId, toolName: tc.toolName, result };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        toolResults.push({ type: "tool-result", toolCallId: tc.toolCallId, result: { error: errMsg } });
        yield { type: "tool-error", toolCallId: tc.toolCallId, toolName: tc.toolName, error: errMsg };
      }
    }

    store.addMessage({ role: "tool", content: toolResults } as unknown as ModelMessage);
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/** Main agent loop — uses the global session store (persisted to SQLite) */
export async function* runBattleEngine(
  userMessage: string,
  provider: Provider,
  config: CodemonConfig,
  systemPrompt: string,
): AsyncGenerator<BattleEvent> {
  yield* _engineCore(userMessage, provider, config, systemPrompt, globalSessionStore);
}

/** Sub-agent / eval loop — uses an ephemeral in-memory store */
export async function* runBattleEngineWithStore(
  userMessage: string,
  provider: Provider,
  config: CodemonConfig,
  systemPrompt: string,
  store: MessageStore,
  toolFilter?: Set<string>,
): AsyncGenerator<BattleEvent> {
  yield* _engineCore(userMessage, provider, config, systemPrompt, store, toolFilter);
}

/**
 * Run an agent to full completion (non-streaming).
 * Useful for sub-agents and evals where you need the final output.
 */
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

  for await (const event of _engineCore(userMessage, provider, config, systemPrompt, s, toolFilter)) {
    if (event.type === "text") output += event.text;
    if (event.type === "tool-start") toolsUsed.push(event.toolName);
    if (event.type === "tool-error") errors.push(`${event.toolName}: ${event.error}`);
    if (event.type === "error") errors.push(event.error.message);
    // permission-required: in yolo mode this never fires; in other modes it blocks forever
  }

  return { output, toolsUsed, errors };
}
