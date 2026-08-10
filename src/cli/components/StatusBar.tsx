import React from "react";
import { Box, Text } from "ink";
import { formatTokenCount } from "../../utils/tokenizer.ts";

interface StatusBarProps {
  model: string;
  region: string;
  permissionMode: string;
  tokenCount: number;
  isThinking: boolean;
}

export function StatusBar({
  model,
  region,
  permissionMode,
  tokenCount,
  isThinking,
}: StatusBarProps) {
  const modeColors: Record<string, string> = {
    safe: "green",
    standard: "yellow",
    yolo: "red",
  };
  const modeIcons: Record<string, string> = {
    safe: "🛡️",
    standard: "⚾",
    yolo: "🔥",
  };

  const modeColor = modeColors[permissionMode] ?? "white";
  const modeIcon = modeIcons[permissionMode] ?? "⚾";

  // Parse provider:model or provider/model string
  const sep = model.includes(":") ? ":" : model.includes("/") ? "/" : null;
  const [providerPart, modelPart] = sep
    ? [model.slice(0, model.indexOf(sep)), model.slice(model.indexOf(sep) + 1)]
    : ["", model];

  const providerIcons: Record<string, string> = {
    google: "🔵",
    anthropic: "🟠",
    openai: "🟢",
    mistral: "🟣",
  };
  const providerIcon = providerIcons[providerPart] ?? "🤖";

  // Shorten long cwd paths
  const shortRegion =
    region.length > 30 ? "…" + region.slice(region.length - 28) : region;

  return (
    <Box
      borderStyle="single"
      borderColor="gray"
      paddingX={1}
      justifyContent="space-between"
      flexDirection="row"
    >
      <Box gap={1}>
        <Text color="magenta">🐉</Text>
        <Text bold color="magenta">
          CODEMON
        </Text>
        <Text dimColor>│</Text>
        <Text color="cyan">🗺️ {shortRegion}</Text>
      </Box>

      <Box gap={2}>
        {isThinking && <Text color="yellow">⚡ thinking…</Text>}
        <Text color="blue">
          {providerIcon} {modelPart || model}
        </Text>
        <Text dimColor>│</Text>
        <Text color={modeColor}>
          {modeIcon} {permissionMode}
        </Text>
        <Text dimColor>│</Text>
        <Text color="gray">~{formatTokenCount(tokenCount)} tk</Text>
      </Box>
    </Box>
  );
}
