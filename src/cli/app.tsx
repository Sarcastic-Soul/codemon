import React, { useState, useCallback, useEffect } from "react";
import { Box, Text, useInput, useApp } from "ink";
import TextInput from "ink-text-input";
import { ChatView } from "./components/ChatView.tsx";
import { ToolCallView, type ToolCallEntry } from "./components/ToolCallView.tsx";
import { DiffView } from "./components/DiffView.tsx";
import { PermissionPrompt } from "./components/PermissionPrompt.tsx";
import { StatusBar } from "./components/StatusBar.tsx";
import { runBattleEngine } from "../core/battle-engine.ts";
import { getSession, getMessages } from "../core/session.ts";
import { loadTrainerGuide } from "../config/load-trainer-guide.ts";
import { buildRepoIndex, formatRepoIndex } from "../core/repo-indexer.ts";
import type { Provider } from "../providers/types.ts";
import type { CodemonConfig } from "../config/defaults.ts";

interface ChatMessage {
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
  provider: Provider;
  config: CodemonConfig;
  projectRoot: string;
  resumed?: boolean;
}

export function App({ provider, config, projectRoot, resumed = false }: AppProps) {
  const { exit } = useApp();
  
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

  const [systemPrompt, setSystemPrompt] = useState<string>(() =>
    buildBaseSystemPrompt(config, projectRoot)
  );

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
      if (!userText.trim() || isThinking) return;
      setInput("");
      setIsThinking(true);
      setStreamingText("");
      setToolCalls([]);
      setLastDiff(null);

      const userMsg: ChatMessage = { role: "user", content: userText };
      setMessages((prev) => [...prev, userMsg]);

      let assistantBuffer = "";
      const engine = runBattleEngine(userText, provider, config, systemPrompt);

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
            setMessages((prev) => [
              ...prev,
              { role: "assistant", content: `❌ Error: ${event.error.message}` },
            ]);
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
    [isThinking, provider, config, systemPrompt],
  );

  useInput((input, key) => {
    if (key.ctrl && input === "c") exit();
  });

  return (
    <Box flexDirection="column" height="100%">
      {/* Header */}
      <Box borderStyle="double" borderColor="magenta" paddingX={2} marginBottom={1}>
        <Text bold color="magenta">
          🐉 CODEMON — Your AI Coding Partner
        </Text>
        <Text dimColor>  Region: {projectRoot.split("/").pop()}</Text>
        {resumed && <Text color="yellow">  [Resumed Session]</Text>}
      </Box>

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
      </Box>

      {/* Input area */}
      {!pendingPermission && (
        <Box borderStyle="single" borderColor={isThinking ? "yellow" : "cyan"} paddingX={1} marginTop={1}>
          <Text color={isThinking ? "yellow" : "cyan"}>
            {isThinking ? "⚡ " : "❯ "}
          </Text>
          <TextInput
            value={input}
            onChange={setInput}
            onSubmit={handleSubmit}
            placeholder={isThinking ? "Codemon is thinking…" : "Talk to your Codemon…"}
          />
        </Box>
      )}

      {/* Status bar */}
      <StatusBar
        model={config.model}
        region={projectRoot}
        permissionMode={config.permissionMode}
        tokenCount={tokenCount}
        isThinking={isThinking}
      />
    </Box>
  );
}

function buildBaseSystemPrompt(config: CodemonConfig, projectRoot: string): string {
  const trainerGuide = loadTrainerGuide(projectRoot);

  const parts = [
    `You are Codemon, an expert AI coding assistant. You are paired with a developer working in the "${projectRoot.split("/").pop()}" project.`,
    "",
    "## Capabilities",
    "You have the following moves (tools) available:",
    "- **read_file**: Read any file in the project",
    "- **write_file**: Create or overwrite a file",
    "- **edit_file**: Make targeted edits to a file (preferred over write_file for existing files)",
    "- **list_dir**: Explore the project directory tree",
    "- **bash**: Run shell commands (git, npm, bun, tests, etc.)",
    "- **grep**: Search for patterns across the codebase",
    "- **glob**: Find files by pattern",
    "- **spawn_party_member**: Delegate focused sub-tasks to fresh sub-agent instances",
    "",
    "## Guidelines",
    "- Always read files before editing them",
    "- Prefer edit_file over write_file for existing files",
    "- Run tests after making changes when possible",
    "- Use spawn_party_member for large codebase exploration or clean sub-tasks",
    "- Be concise in your responses — let the tools do the showing",
    "- When you're unsure about something, ask rather than guess",
    "",
    `## Current Region`,
    `Project root: ${projectRoot}`,
  ];

  if (trainerGuide) {
    parts.push("", trainerGuide);
  }

  if (config.systemPromptAppend) {
    parts.push("", config.systemPromptAppend);
  }

  return parts.join("\n");
}
