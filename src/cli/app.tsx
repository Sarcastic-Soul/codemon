import React, { useState, useCallback, useEffect } from "react";
import { Box, Text, useInput, useApp } from "ink";
import TextInput from "ink-text-input";
import { ChatView } from "./components/ChatView.tsx";
import { ToolCallView, type ToolCallEntry } from "./components/ToolCallView.tsx";
import { DiffView } from "./components/DiffView.tsx";
import { PermissionPrompt } from "./components/PermissionPrompt.tsx";
import { SidePanel } from "./components/SidePanel.tsx";
import { ConnectorModal, type ConnectorResult } from "./components/ConnectorModal.tsx";
import { runAgent } from "../core/agent-loop.ts";
import { getSession, getMessages, updateSessionModel } from "../core/session.ts";
import { loadAgentRules } from "../config/load-agent-rules.ts";
import { buildRepoIndex, formatRepoIndex } from "../core/repo-indexer.ts";
import { createRegistryProvider, validateApiKey } from "../providers/registry.ts";
import { dispatchCommand } from "./commands/index.ts";
import type { Provider } from "../providers/types.ts";
import type { CodemonConfig } from "../config/defaults.ts";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
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
  const [toolCalls, setToolCalls] = useState<ToolCallEntry[]>([]);
  const [lastDiff, setLastDiff] = useState<{ unified: string; path: string } | null>(null);
  const [pendingPermission, setPendingPermission] = useState<PendingPermission | null>(null);
  const [tokenCount, setTokenCount] = useState(() => {
    try { return getSession().totalTokensUsed; } catch { return 0; }
  });
  const [sessionId] = useState(() => {
    try { return getSession().id; } catch { return undefined; }
  });

  const [systemPrompt, setSystemPrompt] = useState<string>(() =>
    buildBaseSystemPrompt(config, projectRoot)
  );

  // Build command context for the slash-command dispatcher
  const addMessage = useCallback((msg: ChatMessage) => {
    setMessages((prev) => [...prev, msg]);
  }, []);

  const commandContext = {
    exit,
    addMessage,
    setMessages,
    setShowConnectorModal,
  };

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
      setToolCalls([]);
      setLastDiff(null);

      const userMsg: ChatMessage = { role: "user", content: userText };
      setMessages((prev) => [...prev, userMsg]);

      let assistantBuffer = "";
      const engine = runAgent(userText, activeProvider, { ...config, model: activeModel }, systemPrompt);

      for await (const event of engine) {
        switch (event.type) {
          case "text":
            assistantBuffer += event.text;
            setStreamingText(assistantBuffer);
            break;

          case "tool-start":
            setToolCalls((prev) => [
              ...prev,
              {
                id: event.toolCallId,
                toolName: event.toolName,
                args: event.args,
                status: "running",
              },
            ]);
            break;

          case "tool-result": {
            const result = event.result as Record<string, unknown>;
            if (result?.diff && typeof result.diff === "string" && result.path) {
              setLastDiff({ unified: result.diff, path: String(result.path) });
            }
            setToolCalls((prev) =>
              prev.map((tc) =>
                tc.id === event.toolCallId
                  ? { ...tc, status: "success", result: event.result }
                  : tc,
              ),
            );
            break;
          }

          case "tool-error":
            setToolCalls((prev) =>
              prev.map((tc) =>
                tc.id === event.toolCallId
                  ? { ...tc, status: "error", error: event.error }
                  : tc,
              ),
            );
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
              setTokenCount((t) => t + event.usage!.completionTokens);
            }
            break;

          case "error":
            addMessage({ role: "assistant", content: `❌ Error: ${event.error.message}` });
            break;
        }
      }

      if (assistantBuffer) {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: assistantBuffer },
        ]);
      }
      setStreamingText("");
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

          {/* Active tool calls */}
          {toolCalls.length > 0 && <ToolCallView calls={toolCalls} />}

          {/* Diff preview */}
          {lastDiff && <DiffView unified={lastDiff.unified} filePath={lastDiff.path} />}

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
              currentModel={activeModel}
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
          tokenCount={tokenCount}
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
