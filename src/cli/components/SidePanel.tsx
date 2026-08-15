import React from "react";
import { Box, Text } from "ink";
import { formatTokenCount } from "../../utils/tokenizer.ts";

interface SidePanelProps {
  model: string;
  region: string;
  permissionMode: string;
  tokenCount: number;
  isThinking: boolean;
  resumed: boolean;
  sessionId?: string;
}

const PROVIDER_ICONS: Record<string, string> = {
  google: "🔵",
  anthropic: "🟠",
  openai: "🟢",
  mistral: "🟣",
};
const MODE_ICONS: Record<string, string> = {
  safe: "🛡️ ",
  standard: "⚾ ",
  yolo: "🔥 ",
};
const MODE_COLORS: Record<string, string> = {
  safe: "green",
  standard: "yellow",
  yolo: "red",
};

const COMMANDS: { name: string; desc: string }[] = [
  { name: "/connector", desc: "set key" },
  { name: "/model",     desc: "model" },
  { name: "/clear",     desc: "clear chat" },
  { name: "/help",      desc: "help" },
  { name: "/exit",      desc: "quit" },
];

function shortPath(p: string, max = 26): string {
  return p.length > max ? "…" + p.slice(p.length - max + 1) : p;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text dimColor>{label}</Text>
      {children}
    </Box>
  );
}

export function SidePanel({
  model,
  region,
  permissionMode,
  tokenCount,
  isThinking,
  resumed,
  sessionId,
}: SidePanelProps) {
  const sep = model.includes(":") ? ":" : model.includes("/") ? "/" : null;
  const sepIdx = sep ? model.indexOf(sep) : -1;
  const providerPart = sepIdx > -1 ? model.slice(0, sepIdx) : "";
  const modelPart = sepIdx > -1 ? model.slice(sepIdx + 1) : model;
  const providerIcon = PROVIDER_ICONS[providerPart] ?? "🤖";
  const modeIcon = MODE_ICONS[permissionMode] ?? "⚾ ";
  const modeColor = MODE_COLORS[permissionMode] ?? "white";

  const MAX_TOKENS = 100_000;
  const barWidth = 16;
  const filled = Math.min(barWidth, Math.round((tokenCount / MAX_TOKENS) * barWidth));
  const barColor = tokenCount > 80_000 ? "red" : tokenCount > 50_000 ? "yellow" : "green";
  const tokenBar = "█".repeat(filled) + "░".repeat(barWidth - filled);

  const divider = "─".repeat(24);

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor="gray"
      paddingX={1}
      height="100%"
    >
      {/* Title */}
      <Box justifyContent="center" marginBottom={1}>
        <Text bold color="magenta">🐉 CODEMON</Text>
      </Box>

      {/* Region */}
      <Row label="📁 region">
        <Text color="cyan" wrap="truncate">{shortPath(region)}</Text>
      </Row>

      <Text dimColor>{divider}</Text>

      {/* Model */}
      <Box flexDirection="column" marginTop={1} marginBottom={1}>
        <Text dimColor>🤖 model</Text>
        <Box gap={1}>
          <Text>{providerIcon}</Text>
          <Text color="blue" bold wrap="truncate">{modelPart}</Text>
        </Box>
        {providerPart ? <Text dimColor color="gray">{providerPart}</Text> : null}
      </Box>

      {/* Mode */}
      <Row label="🔒 mode">
        <Box gap={1}>
          <Text>{modeIcon}</Text>
          <Text color={modeColor} bold>{permissionMode}</Text>
        </Box>
      </Row>

      {/* Tokens */}
      <Row label="📊 tokens">
        <Text color="gray">~{formatTokenCount(tokenCount)} tk</Text>
        <Text color={barColor}>{tokenBar}</Text>
      </Row>

      {/* Status */}
      <Row label="💡 status">
        {isThinking && <Text color="yellow">⚡ thinking…</Text>}
        {!isThinking && resumed && <Text color="cyan">📖 resumed</Text>}
        {!isThinking && !resumed && <Text color="green">● ready</Text>}
        {sessionId && <Text dimColor color="gray">{sessionId.slice(0, 8)}…</Text>}
      </Row>

      <Text dimColor>{divider}</Text>

      {/* Commands cheatsheet */}
      <Box flexDirection="column" marginTop={1}>
        <Text dimColor>⌨️  commands</Text>
        {COMMANDS.map((c) => (
          <Box key={c.name} gap={1}>
            <Text color="cyan">{c.name}</Text>
            <Text dimColor>{c.desc}</Text>
          </Box>
        ))}
      </Box>
    </Box>
  );
}
