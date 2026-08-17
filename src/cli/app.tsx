import { useState, useCallback, useEffect, useMemo } from "react";
import { Box, Text, useInput, useApp } from "ink";
import TextInput from "ink-text-input";
import { ChatView, maxScrollOffset } from "./components/ChatView.tsx";
import { ToolCallView, toolCallViewRows, type ToolCallEntry } from "./components/ToolCallView.tsx";
import { DiffView, diffViewRows, DIFF_MAX_LINES, type DiffEntry } from "./components/DiffView.tsx";
import { PermissionPrompt } from "./components/PermissionPrompt.tsx";
import { SidePanel } from "./components/SidePanel.tsx";
import { ConnectorModal, type ConnectorResult } from "./components/ConnectorModal.tsx";
import { runAgent } from "../core/agent-loop.ts";
import { getSession, getMessages, updateSessionModel } from "../core/session.ts";
import { ContextManager } from "../core/context-manager.ts";
import { buildSystemPrompt } from "../core/system-prompt.ts";
import { getTodos, onTodosChanged, type Todo } from "../core/todo-store.ts";
import { loadAgentRules } from "../config/load-agent-rules.ts";
import { buildRepoIndex, formatRepoIndex } from "../core/repo-indexer.ts";
import { createRegistryProvider, validateApiKey } from "../providers/registry.ts";
import { dispatchCommand } from "./commands/index.ts";
import type { Provider } from "../providers/types.ts";
import { effectiveContextTokens, type CodemonConfig } from "../config/defaults.ts";
import { maybeRefreshCatalog } from "../providers/catalog.ts";
import { SuggestionPopup } from "./components/SuggestionPopup.tsx";
import { Banner } from "./components/Banner.tsx";
import { ThinkingIndicator } from "./components/ThinkingIndicator.tsx";
import { ReasoningView } from "./components/ReasoningView.tsx";
import { useTerminalSize } from "./hooks/use-terminal-size.ts";
import { computeLayout, SIDE_PANEL_WIDTH } from "./layout.ts";
import { stampFrame } from "./debug-frames.ts";
import { buildFileIndex } from "./file-index.ts";
import {
  detectCompletion,
  applyCompletion,
  commandSuggestions,
  rankSuggestions,
  expandMentions,
} from "./suggestions.ts";

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
 * Shortest gap between repaints while a reply streams. Around 20 fps: fast
 * enough to read as live typing, slow enough that a burst of tokens does not
 * queue a full re-render per character.
 */
const STREAM_PAINT_MS = 50;

/**
 * Messages moved per PgUp/PgDn. `scrollOffset` counts messages, so scaling this
 * to the terminal height jumped a dozen turns at a time and shot straight past
 * everything to the top of the history.
 */
const SCROLL_STEP_MESSAGES = 3;

/**
 * Reads a tool result for a diff to display. `edit_file` and `write_file` both
 * return `{ path, diff }`; `edit_file` adds `strategy` to flag a fuzzy match.
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
 * Folds a finished turn into the message that goes in the transcript. Attaching
 * tool calls and diffs to the message keeps them on screen past the next submit,
 * so a turn that ran tools without saying anything still gets a message.
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
  const { columns, rows } = useTerminalSize();
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
  /** The model's scratchpad for the turn in flight; cleared when it ends. */
  const [reasoningText, setReasoningText] = useState("");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [input, setInput] = useState("");
  const [isThinking, setIsThinking] = useState(false);
  /** Which completion row is highlighted; reset whenever the query changes. */
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const [suggestionsDismissed, setSuggestionsDismissed] = useState(false);
  /**
   * Messages stepped back from the newest. Pinning the layout to the terminal
   * height took away the terminal's own scrollback, so the transcript has to
   * provide it. 0 sticks to the bottom, which is where a new message resets it.
   */
  const [scrollOffset, setScrollOffset] = useState(0);
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

  // Plan mode is its own axis, not a fourth permission mode: `permissionMode`
  // says how much the agent asks, this says what it is doing. Seeded from the
  // config so `--plan` works, and toggled at runtime by `/plan`.
  const [planMode, setPlanMode] = useState<boolean>(config.planMode);

  /** The agent's checklist, mirrored out of the tool's store for the panel. */
  const [todos, setTodos] = useState<Todo[]>(() => getTodos());

  const [systemPrompt, setSystemPrompt] = useState<string>(() =>
    buildBaseSystemPrompt(config, projectRoot, config.planMode)
  );

  // The repo index is appended to the prompt asynchronously, so a plan-mode
  // toggle has to rebuild from the base and let that effect re-append rather
  // than trying to patch the string in place.
  const [repoIndexText, setRepoIndexText] = useState<string>("");

  useEffect(() => {
    const base = buildBaseSystemPrompt(config, projectRoot, planMode);
    setSystemPrompt(repoIndexText ? `${base}\n\n${repoIndexText}` : base);
  }, [planMode, repoIndexText, config, projectRoot]);

  // The tool writes to a module-level store; this is the only bridge into React.
  useEffect(() => onTodosChanged(setTodos), []);

  // Context occupancy, as the agent loop measures it. Seeded here so a resumed
  // session shows its real load before the first turn reports one.
  const [contextTokens, setContextTokens] = useState(() => {
    try {
      const manager = new ContextManager(effectiveContextTokens(config));
      return manager.getStats(getMessages(), buildBaseSystemPrompt(config, projectRoot, config.planMode))
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
    () => ({
      exit,
      addMessage,
      setMessages,
      setShowConnectorModal,
      provider: activeProvider,
      config,
      projectRoot,
      planMode,
      setPlanMode,
    }),
    [exit, addMessage, activeProvider, config, projectRoot, planMode],
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
      addMessage({ role: "assistant", content: `Switched active provider to **${result.model}**` });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      addMessage({ role: "assistant", content: `Failed to switch provider: ${msg}` });
      setShowConnectorModal(false);
    }
  }, [addMessage]);

  // The history budget follows whichever model is live, so switching to a
  // narrower one through /connector re-sizes the meter and the trim together.
  const contextBudget = useMemo(
    () => effectiveContextTokens(config, activeModel),
    [config, activeModel],
  );

  // ─── Completion ───────────────────────────────────────────────────────────
  const completion = useMemo(
    () => (suggestionsDismissed ? null : detectCompletion(input)),
    [input, suggestionsDismissed],
  );

  const suggestions = useMemo(() => {
    if (!completion || isThinking) return [];
    const pool =
      completion.kind === "command" ? commandSuggestions() : buildFileIndex(projectRoot);
    return rankSuggestions(pool, completion.term);
  }, [completion, isThinking, projectRoot]);

  // A changed query invalidates the highlight — otherwise row 4 of the old list
  // stays selected over a new list that may only have two rows.
  useEffect(() => {
    setSuggestionIndex(0);
  }, [completion?.kind, completion?.term]);

  const acceptSuggestion = useCallback(() => {
    if (!completion || suggestions.length === 0) return false;
    const chosen = suggestions[Math.min(suggestionIndex, suggestions.length - 1)]!;
    setInput(applyCompletion(input, completion, chosen));
    return true;
  }, [completion, suggestions, suggestionIndex, input]);

  const handleInputChange = useCallback((value: string) => {
    setInput(value);
    // Typing again after Esc should bring the list back.
    setSuggestionsDismissed(false);
  }, []);

  // Ticks only while a turn is in flight, so an idle session queues no timers.
  useEffect(() => {
    if (!isThinking) return;
    const timer = setInterval(() => setElapsedSeconds((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [isThinking]);

  // Freshen the model catalog in the background, at most once a day. Nothing
  // waits on it: a failure just leaves the last known catalog in place.
  useEffect(() => {
    maybeRefreshCatalog().catch(() => {});
  }, []);

  // Build repo index asynchronously if enabled. Stored separately from the
  // prompt rather than concatenated into it, so a /plan toggle can rebuild the
  // base without losing the index or duplicating it.
  useEffect(() => {
    if (!config.repoIndex) return;
    let isMounted = true;
    buildRepoIndex(projectRoot)
      .then((index) => {
        if (!isMounted) return;
        setRepoIndexText(formatRepoIndex(index));
      })
      .catch(() => {});
    return () => { isMounted = false; };
  }, [config.repoIndex, projectRoot]);

  /**
   * Run one agent turn.
   *
   * Split out of `handleSubmit` because a slash command can now ask for a turn
   * of its own — `/init` and every custom command return `{ submit }`, and the
   * text they submit is not what the user typed.
   */
  const runTurn = useCallback(
    async (promptText: string, displayText: string) => {
      if (!activeProvider) {
        addMessage({ role: "assistant", content: "No API key configured. Opening Provider & Model Connector..." });
        setShowConnectorModal(true);
        return;
      }

      setIsThinking(true);
      setScrollOffset(0);
      setStreamingText("");
      setReasoningText("");
      setElapsedSeconds(0);
      setLiveToolCalls([]);
      setLiveDiffs([]);

      const userMsg: ChatMessage = { role: "user", content: displayText };
      setMessages((prev) => [...prev, userMsg]);

      let assistantBuffer = "";
      // Repainting on every token is what made fast streams flicker: each delta
      // re-rendered the whole tree. Painting on a short interval keeps the reply
      // visibly live without spending a frame per character.
      let lastPaint = 0;
      let reasoningBuffer = "";
      let lastReasoningPaint = 0;
      // Held locally as well as in state: the state value read inside this loop
      // would be the one captured when the turn started.
      let turnToolCalls: ToolCallEntry[] = [];
      let turnDiffs: DiffEntry[] = [];
      const putToolCalls = (next: ToolCallEntry[]) => {
        turnToolCalls = next;
        setLiveToolCalls(next);
      };

      const engine = runAgent(
        promptText,
        activeProvider,
        { ...config, model: activeModel, maxContextTokens: contextBudget, planMode },
        systemPrompt,
      );

      for await (const event of engine) {
        switch (event.type) {
          case "text": {
            assistantBuffer += event.text;
            const now = Date.now();
            if (now - lastPaint >= STREAM_PAINT_MS) {
              lastPaint = now;
              setStreamingText(assistantBuffer);
            }
            break;
          }

          case "reasoning": {
            reasoningBuffer += event.text;
            const now = Date.now();
            if (now - lastReasoningPaint >= STREAM_PAINT_MS) {
              lastReasoningPaint = now;
              setReasoningText(reasoningBuffer);
            }
            break;
          }

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

          // Said out loud rather than left as a silently shrinking meter, which
          // reads as a bug rather than as the feature it is.
          case "compaction":
            addMessage({
              role: "assistant",
              content:
                `↺ Compacted **${event.droppedMessages}** earlier messages into a summary ` +
                `(~${event.summaryTokens} tokens). Nothing was lost from the session log.`,
            });
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
            addMessage({ role: "assistant", content: `Error: ${event.error.message}` });
            break;
        }
      }

      const turnMessage = messageForTurn(assistantBuffer, turnToolCalls, turnDiffs);
      if (turnMessage) setMessages((prev) => [...prev, turnMessage]);
      setStreamingText("");
      setReasoningText("");
      setLiveToolCalls([]);
      setLiveDiffs([]);
      setIsThinking(false);
    },
    [activeProvider, activeModel, config, contextBudget, systemPrompt, planMode, addMessage],
  );

  const handleSubmit = useCallback(
    async (userText: string) => {
      // Enter belongs to the popup while it is open — completing a path should
      // not also fire the message off half-written.
      if (acceptSuggestion()) return;

      const trimmed = userText.trim();
      if (!trimmed || isThinking) return;

      // Try slash command dispatch first
      if (trimmed.startsWith("/")) {
        setInput("");
        const { matched, result } = await dispatchCommand(trimmed, commandContext);

        if (!matched) {
          addMessage({
            role: "assistant",
            content: `Unknown command: \`${trimmed.split(" ")[0]}\`. Type **/help** to see all commands.`,
          });
          return;
        }

        if (result && "notice" in result) {
          addMessage({ role: "assistant", content: result.notice });
          return;
        }

        // The command expanded into a prompt. The transcript keeps what the
        // user typed; the model gets the expansion.
        if (result && "submit" in result) {
          await runTurn(result.submit, trimmed);
        }
        return;
      }

      setInput("");
      // The transcript keeps the `@path` the user typed; the model gets the
      // path as a plain backticked reference it can hand to the file tools.
      await runTurn(expandMentions(userText), userText);
    },
    [isThinking, commandContext, addMessage, acceptSuggestion, runTurn],
  );

  useInput((_input, key) => {
    if (key.ctrl && _input === "c") {
      exit();
      return;
    }

    // Scrollback. Bound to PgUp/PgDn and ctrl-U/ctrl-D so plain arrows stay with
    // the completion popup and with ordinary cursor movement in the prompt.
    //
    // ink-text-input ignores exactly one chord — ctrl-C — and inserts every
    // other one as literal text, so ctrl-U scrolled *and* typed a "u". Its
    // handler subscribes before this one (child effects run first), so by the
    // time we get here the character is already in `input`; the functional
    // updater below sees that and takes it back off.
    const consumeChordChar = (char: string) =>
      setInput((prev) => (prev.endsWith(char) ? prev.slice(0, -1) : prev));

    const step = SCROLL_STEP_MESSAGES;
    if (key.pageUp || (key.ctrl && _input === "u")) {
      if (key.ctrl) consumeChordChar("u");
      setScrollOffset((prev) => Math.min(prev + step, maxScrollOffset(messages)));
      return;
    }
    if (key.pageDown || (key.ctrl && _input === "d")) {
      if (key.ctrl) consumeChordChar("d");
      setScrollOffset((prev) => Math.max(prev - step, 0));
      return;
    }
    if (key.ctrl && _input === "g") {
      consumeChordChar("g");
      setScrollOffset(0); // jump back to the live end
      return;
    }

    if (suggestions.length === 0) return;

    // Arrows and Tab drive the popup. TextInput leaves both alone, so this can
    // sit alongside it without stealing ordinary typing.
    if (key.upArrow) {
      setSuggestionIndex((prev) => (prev > 0 ? prev - 1 : suggestions.length - 1));
    } else if (key.downArrow) {
      setSuggestionIndex((prev) => (prev < suggestions.length - 1 ? prev + 1 : 0));
    } else if (key.tab) {
      acceptSuggestion();
    } else if (key.escape) {
      setSuggestionsDismissed(true);
    }
  });

  const inputHidden = Boolean(pendingPermission) || showConnectorModal;
  // The banner owns the empty screen; the first message replaces it for good.
  const showBanner = messages.length === 0 && streamingText === "" && !isThinking;

  // When several files change in one turn, share the remaining rows out rather
  // than letting the first diff eat the screen. Computed before the layout so
  // the reservation below is made against the cap the diffs will actually draw
  // at, not against the default.
  const liveDiffMaxLines =
    liveDiffs.length > 0
      ? Math.max(4, Math.min(DIFF_MAX_LINES, Math.floor((rows - 12) / liveDiffs.length) - 4))
      : DIFF_MAX_LINES;

  const liveDiffRows = liveDiffs.reduce((n, d) => n + diffViewRows(d.unified, liveDiffMaxLines), 0);

  // All of the screen arithmetic lives in computeLayout(), which is unit-tested
  // against the invariant that matters: the frame never exceeds the terminal.
  const { showPanel, paneRows, chatRows, popupVisibleRows, contentWidth } = computeLayout({
    rows,
    columns,
    inputHidden,
    suggestionCount: suggestions.length,
    isThinking,
    hasReasoning: reasoningText !== "",
    toolCallRows: toolCallViewRows(liveToolCalls),
    diffRows: liveDiffRows,
  });

  // Debug only, and a no-op unless CODEMON_DEBUG_FRAMES is set: records what the
  // layout believed, so an overflowing frame in the log can be read against the
  // state that produced it.
  stampFrame({
    rows,
    columns,
    paneRows,
    chatRows,
    isThinking,
    streamChars: streamingText.length,
    messages: messages.length,
    toolCallRows: toolCallViewRows(liveToolCalls),
    diffRows: liveDiffRows,
    reasoning: reasoningText !== "",
    suggestions: suggestions.length,
    popupVisibleRows,
    scrollOffset,
  });

  return (
    <Box flexDirection="row" width={columns} height={rows}>
      {/* Left: chat column, sized to the terminal so the prompt stays pinned */}
      <Box flexDirection="column" flexGrow={1} height={rows} overflow="hidden" paddingRight={1}>
        {/* Transcript. Bottom-aligned so a short session sits above the prompt
            instead of stranding it in the middle of the screen. */}
        <Box
          flexDirection="column"
          height={paneRows}
          flexShrink={0}
          overflow="hidden"
          justifyContent="flex-end"
        >
          {showBanner ? (
            <Banner model={activeModel} maxRows={chatRows} width={contentWidth} />
          ) : (
            <ChatView
              messages={messages}
              streamingText={streamingText}
              maxRows={chatRows}
              width={contentWidth}
              scrollOffset={scrollOffset}
            />
          )}

          {/* The turn in flight. Finished turns render inside the transcript,
              attached to their own message. */}
          {reasoningText !== "" && (
            <ReasoningView text={reasoningText} width={contentWidth} />
          )}

          {liveToolCalls.length > 0 && <ToolCallView calls={liveToolCalls} />}

          {/* Diffs land here the moment edit_file returns, so a file rewrite is
              visible while the turn is still running rather than after it. */}
          {liveDiffs.map((diff, i) => (
            <DiffView
              key={i}
              unified={diff.unified}
              filePath={diff.path}
              fuzzy={diff.fuzzy}
              maxLines={liveDiffMaxLines}
            />
          ))}

          {isThinking && <ThinkingIndicator elapsedSeconds={elapsedSeconds} />}

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
        {!inputHidden && (
          <Box flexDirection="column" flexShrink={0} flexGrow={0}>
            <SuggestionPopup
              suggestions={suggestions}
              selectedIndex={suggestionIndex}
              maxVisibleRows={popupVisibleRows}
            />

            {/* The border carries plan mode too, so a read-only session is
                never ambiguous from the prompt the user is typing at. */}
            <Box
              borderStyle="single"
              borderColor={isThinking ? "yellow" : planMode ? "magenta" : "cyan"}
              paddingX={1}
            >
              <Text color={isThinking ? "yellow" : planMode ? "magenta" : "cyan"}>
                {isThinking ? "" : planMode ? "~ " : "❯ "}
              </Text>
              <TextInput
                value={input}
                onChange={handleInputChange}
                onSubmit={handleSubmit}
                placeholder={
                  isThinking
                    ? "thinking…"
                    : planMode
                    ? "plan mode — ask for a plan  (/plan to exit)"
                    : "message Codemon  (/ commands · @ files)"
                }
              />
            </Box>
          </Box>
        )}
      </Box>

      {/* Right: side panel, dropped entirely when the terminal is too narrow */}
      {showPanel && (
      <Box width={SIDE_PANEL_WIDTH} flexShrink={0} height={rows}>
        <SidePanel
          model={activeModel}
          region={projectRoot}
          permissionMode={config.permissionMode}
          planMode={planMode}
          todos={todos}
          contextTokens={contextTokens}
          maxContextTokens={contextBudget}
          spentTokens={spentTokens}
          isThinking={isThinking}
          resumed={resumed}
          sessionId={sessionId}
        />
      </Box>
      )}
    </Box>
  );
}

/**
 * Thin wrapper over `buildSystemPrompt`, which lives in core/ so the headless
 * runner produces the same agent this one does.
 */
function buildBaseSystemPrompt(
  config: CodemonConfig,
  projectRoot: string,
  planMode = false,
): string {
  return buildSystemPrompt({
    config,
    projectRoot,
    agentRules: loadAgentRules(projectRoot),
    planMode,
  });
}
