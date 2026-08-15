import React, { useState, useCallback, useEffect, useMemo } from "react";
import { Box, Text, useInput, useApp } from "ink";
import TextInput from "ink-text-input";
import { ChatView } from "./components/ChatView.tsx";
import { ToolCallView, type ToolCallEntry } from "./components/ToolCallView.tsx";
import { DiffView, type DiffEntry } from "./components/DiffView.tsx";
import { PermissionPrompt } from "./components/PermissionPrompt.tsx";
import { SidePanel } from "./components/SidePanel.tsx";
import { ConnectorModal, type ConnectorResult } from "./components/ConnectorModal.tsx";
import { runAgent } from "../core/agent-loop.ts";
import { getSession, getMessages, updateSessionModel } from "../core/session.ts";
import { ContextManager } from "../core/context-manager.ts";
import { loadAgentRules } from "../config/load-agent-rules.ts";
import { buildRepoIndex, formatRepoIndex } from "../core/repo-indexer.ts";
import { createRegistryProvider, validateApiKey } from "../providers/registry.ts";
import { dispatchCommand } from "./commands/index.ts";
import type { Provider } from "../providers/types.ts";
import type { CodemonConfig } from "../config/defaults.ts";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  /** Tool calls made while producing this message, kept with it rather than
   *  floating beneath the transcript until the next submit wipes them. */
  toolCalls?: ToolCallEntry[];
  /** File edits from the same turn. */
  diffs?: DiffEntry[];
}

/**
 * Reads a tool result for a diff to display.
 *
 * `edit_file` and `write_file` both come back with `{ path, diff }`; `edit_file`
 * adds `strategy` so a block placed by similarity rather than an exact match
 * can be flagged as such.
 */
export function diffFromResult(result: unknown): DiffEntry | null {
  if (typeof result !== "object" || result === null) return null;
  const r = result as Record<string, unknown>;
  if (typeof r.diff !== "string" || r.diff === "" || r.path === undefined) return null;

  return {
    unified: r.diff,
    path: String(r.path),
    ...(r.strategy === "fuzzy"
      ? { fuzzy: { similarity: Number(r.similarity ?? 0) } }
      : {}),
  };
}

/**
 * Folds a finished turn into the message that goes in the transcript.
 *
 * Tool calls and diffs used to live in floating state beneath the chat, reset
 * at the top of every submit — so the record of what the agent just did
 * disappeared the moment you replied to it. Attaching them to the message keeps
 * them for as long as the message is on screen. A turn that ran tools without
 * saying anything still gets a message, or its record would go with the reset.
 */
export function messageForTurn(
  text: string,
  toolCalls: ToolCallEntry[],
  diffs: DiffEntry[],
): ChatMessage | null {
  if (!text && toolCalls.length === 0 && diffs.length === 0) return null;

  return {
    role: "assistant",
    content: text,
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    ...(diffs.length > 0 ? { diffs } : {}),
  };
}

interface PendingPermission {
  toolName: string;
  toolCallId: string;
  args: Record<string, unknown>;
  permissionLevel: string;
  resolve: (d: "allow" | "deny" | "always") => void;
}

interface AppProps {
  provider?: Provider;
  config: CodemonConfig;
  projectRoot: string;
  resumed?: boolean;
  initialShowConnector?: boolean;
}

export function App({ provider, config, projectRoot, resumed = false, initialShowConnector = false }: AppProps) {
  const { exit } = useApp();
  const [activeProvider, setActiveProvider] = useState<Provider | undefined>(provider);
  const [activeModel, setActiveModel] = useState<string>(config.model);
  const [showConnectorModal, setShowConnectorModal] = useState(initialShowConnector || !provider);

  // Initialize messages from existing session if resumed
  const [messages, setMessages] = useState<ChatMessage[]>(() => {
    if (resumed) {
      try {
        const stored = getMessages();
        const chatMsgs: ChatMessage[] = [];
        for (const m of stored) {
          if (m.role === "user") {
            const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
            chatMsgs.push({ role: "user", content });
          } else if (m.role === "assistant") {
            let text = "";
            if (typeof m.content === "string") text = m.content;
            else if (Array.isArray(m.content)) {
              for (const p of m.content) {
                if (typeof p === "object" && p !== null && "type" in p && p.type === "text" && "text" in p) {
                  text += String(p.text);
                }
              }
            }
            if (text) chatMsgs.push({ role: "assistant", content: text });
          }
        }
        return chatMsgs;
      } catch {}
    }
    return [];
  });

  const [streamingText, setStreamingText] = useState("");
  const [input, setInput] = useState("");
  const [isThinking, setIsThinking] = useState(false);
  // Live state for the turn in flight only. Once the turn ends both are folded
  // into the assistant message they belong to, so the record survives the reply.
  const [liveToolCalls, setLiveToolCalls] = useState<ToolCallEntry[]>([]);
  const [liveDiffs, setLiveDiffs] = useState<DiffEntry[]>([]);
  const [pendingPermission, setPendingPermission] = useState<PendingPermission | null>(null);
  const [spentTokens, setSpentTokens] = useState(() => {
    try { return getSession().totalTokensUsed; } catch { return 0; }
  });
  const [sessionId] = useState(() => {
    try { return getSession().id; } catch { return undefined; }
  });

  const [systemPrompt, setSystemPrompt] = useState<string>(() =>
    buildBaseSystemPrompt(config, projectRoot)
  );

  // Context occupancy, as the agent loop measures it. Seeded here so a resumed
  // session shows its real load before the first turn reports one.
  const [contextTokens, setContextTokens] = useState(() => {
    try {
      const manager = new ContextManager(config.maxContextTokens);
      return manager.getStats(getMessages(), buildBaseSystemPrompt(config, projectRoot))
        .estimatedTokens;
    } catch {
      return 0;
    }
  });

  // Build command context for the slash-command dispatcher
  const addMessage = useCallback((msg: ChatMessage) => {
    setMessages((prev) => [...prev, msg]);
  }, []);

  // Memoized because `handleSubmit` depends on it: rebuilt every render, it
  // gave the callback a new identity on every keystroke and memoized nothing.
  const commandContext = useMemo(
    () => ({ exit, addMessage, setMessages, setShowConnectorModal }),
    [exit, addMessage],
  );

  // Handle provider/model selection from ConnectorModal
  const handleConnectorSelect = useCallback((result: ConnectorResult) => {
    const err = validateApiKey(result.provider);
    if (err) {
      addMessage({ role: "assistant", content: err });
      setShowConnectorModal(false);
      return;
    }

    try {
      const newProvider = createRegistryProvider({ model: result.model });
      setActiveProvider(newProvider);
      setActiveModel(result.model);
      updateSessionModel(result.model);
      setShowConnectorModal(false);
      addMessage({ role: "assistant", content: `🔌 Switched active provider to **${result.model}**` });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      addMessage({ role: "assistant", content: `❌ Failed to switch provider: ${msg}` });
      setShowConnectorModal(false);
    }
  }, [addMessage]);

  // Build repo index asynchronously if enabled
  useEffect(() => {
    if (!config.repoIndex) return;
    let isMounted = true;
    buildRepoIndex(projectRoot)
      .then((index) => {
        if (!isMounted) return;
        const formattedIndex = formatRepoIndex(index);
        setSystemPrompt((base) => `${base}\n\n${formattedIndex}`);
      })
      .catch(() => {});
    return () => { isMounted = false; };
  }, [config.repoIndex, projectRoot]);

  const handleSubmit = useCallback(
    async (userText: string) => {
      const trimmed = userText.trim();
      if (!trimmed || isThinking) return;

      // Try slash command dispatch first
      if (trimmed.startsWith("/")) {
        setInput("");
        const matched = dispatchCommand(trimmed, commandContext);
        if (matched) return;
        // Unknown slash command — show hint
        addMessage({
          role: "assistant",
          content: `❓ Unknown command: \`${trimmed.split(" ")[0]}\`. Type **/help** to see all commands.`,
        });
        return;
      }

      if (!activeProvider) {
        setInput("");
        addMessage({ role: "assistant", content: "❌ No API key configured. Opening Provider & Model Connector..." });
        setShowConnectorModal(true);
        return;
      }

      setInput("");
      setIsThinking(true);
      setStreamingText("");
      setLiveToolCalls([]);
      setLiveDiffs([]);

      const userMsg: ChatMessage = { role: "user", content: userText };
      setMessages((prev) => [...prev, userMsg]);

      let assistantBuffer = "";
      // Held locally as well as in state: the state value read inside this loop
      // would be the one captured when the turn started.
      let turnToolCalls: ToolCallEntry[] = [];
      let turnDiffs: DiffEntry[] = [];
      const putToolCalls = (next: ToolCallEntry[]) => {
        turnToolCalls = next;
        setLiveToolCalls(next);
      };

      const engine = runAgent(userText, activeProvider, { ...config, model: activeModel }, systemPrompt);

      for await (const event of engine) {
        switch (event.type) {
          case "text":
            assistantBuffer += event.text;
            setStreamingText(assistantBuffer);
            break;

          case "tool-start":
            putToolCalls([
              ...turnToolCalls,
              {
                id: event.toolCallId,
                toolName: event.toolName,
                args: event.args,
                status: "running",
              },
            ]);
            break;

          case "tool-result": {
            const diff = diffFromResult(event.result);
            if (diff) {
              turnDiffs = [...turnDiffs, diff];
              setLiveDiffs(turnDiffs);
            }
            putToolCalls(
              turnToolCalls.map((tc) =>
                tc.id === event.toolCallId
                  ? { ...tc, status: "success", result: event.result }
                  : tc,
              ),
            );
            break;
          }

          case "tool-error":
            putToolCalls(
              turnToolCalls.map((tc) =>
                tc.id === event.toolCallId
                  ? { ...tc, status: "error", error: event.error }
                  : tc,
              ),
            );
            break;

          case "context":
            setContextTokens(event.estimatedTokens);
            break;

          case "permission-required":
            await new Promise<void>((resolve) => {
              setPendingPermission({
                toolName: event.toolName,
                toolCallId: event.toolCallId,
                args: event.args,
                permissionLevel: event.permissionLevel,
                resolve: (d) => {
                  event.resolve(d);
                  setPendingPermission(null);
                  resolve();
                },
              });
            });
            break;

          case "finish":
            if (event.usage) {
              // Both halves, to match what the session row stores. Prompt
              // tokens are most of the spend on an agentic loop.
              setSpentTokens((t) => t + event.usage!.promptTokens + event.usage!.completionTokens);
            }
            break;

          case "error":
            addMessage({ role: "assistant", content: `❌ Error: ${event.error.message}` });
            break;
        }
      }

      const turnMessage = messageForTurn(assistantBuffer, turnToolCalls, turnDiffs);
      if (turnMessage) setMessages((prev) => [...prev, turnMessage]);
      setStreamingText("");
      setLiveToolCalls([]);
      setLiveDiffs([]);
      setIsThinking(false);
    },
    [isThinking, activeProvider, activeModel, config, systemPrompt, commandContext, addMessage],
  );

  useInput((_input, key) => {
    if (key.ctrl && _input === "c") exit();
  });

  return (
    <Box flexDirection="row" width="100%" height="100%">
      {/* Left: Chat column (flexGrow=1 fills available space) */}
      <Box flexDirection="column" flexGrow={1} overflow="hidden" paddingRight={1}>
        {/* Chat history */}
        <Box flexDirection="column" flexGrow={1} overflow="hidden">
          <ChatView messages={messages} streamingText={streamingText} />

          {/* The turn in flight. Finished turns render inside the transcript,
              attached to their own message. */}
          {liveToolCalls.length > 0 && <ToolCallView calls={liveToolCalls} />}

          {liveDiffs.map((diff, i) => (
            <DiffView
              key={i}
              unified={diff.unified}
              filePath={diff.path}
              fuzzy={diff.fuzzy}
            />
          ))}

          {/* Permission prompt */}
          {pendingPermission && (
            <PermissionPrompt
              toolName={pendingPermission.toolName}
              args={pendingPermission.args}
              permissionLevel={pendingPermission.permissionLevel}
              onDecide={pendingPermission.resolve}
            />
          )}

          {/* Connector Modal */}
          {showConnectorModal && (
            <ConnectorModal
              onClose={() => setShowConnectorModal(false)}
              onSelectProviderModel={handleConnectorSelect}
            />
          )}
        </Box>

        {/* Input area */}
        {!pendingPermission && !showConnectorModal && (
          <Box borderStyle="single" borderColor={isThinking ? "yellow" : "cyan"} paddingX={1} marginTop={1}>
            <Text color={isThinking ? "yellow" : "cyan"}>
              {isThinking ? "⚡ " : "❯ "}
            </Text>
            <TextInput
              value={input}
              onChange={setInput}
              onSubmit={handleSubmit}
              placeholder={isThinking ? "thinking…" : "message Codemon  (/ for commands)"}
            />
          </Box>
        )}
      </Box>

      {/* Right: Side panel (fixed 34 cols, flush right) */}
      <Box width={34} flexShrink={0}>
        <SidePanel
          model={activeModel}
          region={projectRoot}
          permissionMode={config.permissionMode}
          contextTokens={contextTokens}
          maxContextTokens={config.maxContextTokens}
          spentTokens={spentTokens}
          isThinking={isThinking}
          resumed={resumed}
          sessionId={sessionId}
        />
      </Box>
    </Box>
  );
}

function buildBaseSystemPrompt(config: CodemonConfig, projectRoot: string): string {
  const agentRules = loadAgentRules(projectRoot);

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
    "",
    "## Guidelines",
    "- Always read files before editing them",
    "- Prefer edit_file over write_file for existing files",
    "- Run tests after making changes when possible",
    "- Use spawn_subagent for large codebase exploration or clean sub-tasks",
    "- Be concise in your responses — let the tools do the showing",
    "- When you're unsure about something, ask rather than guess",
    "",
    `## Working Directory`,
    `Project root: ${projectRoot}`,
  ];

  if (agentRules) {
    parts.push("", agentRules);
  }

  if (config.systemPromptAppend) {
    parts.push("", config.systemPromptAppend);
  }

  return parts.join("\n");
}
