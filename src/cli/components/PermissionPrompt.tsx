import React, { useEffect } from "react";
import { Box, Text, useInput } from "ink";

interface PermissionPromptProps {
  toolName: string;
  args: Record<string, unknown>;
  permissionLevel: string;
  onDecide: (decision: "allow" | "deny" | "always") => void;
}

export function PermissionPrompt({
  toolName,
  args,
  permissionLevel,
  onDecide,
}: PermissionPromptProps) {
  useInput((input, key) => {
    if (input === "y" || input === "Y") onDecide("allow");
    else if (input === "n" || input === "N" || key.escape) onDecide("deny");
    else if (input === "a" || input === "A") onDecide("always");
  });

  const levelColor = permissionLevel === "bash" ? "red" : "yellow";
  const levelLabel =
    permissionLevel === "bash"
      ? "🔴 DANGEROUS"
      : permissionLevel === "write"
      ? "🟡 WRITE"
      : "🟢 READ";

  return (
    <Box flexDirection="column" borderStyle="double" borderColor={levelColor} padding={1} marginY={1}>
      <Box marginBottom={1}>
        <Text bold color={levelColor}>
          ⚾ Poké Ball — Permission Required
        </Text>
      </Box>

      <Box marginBottom={1}>
        <Text>
          A wild{" "}
          <Text bold color="yellow">
            {toolName}
          </Text>{" "}
          appeared! ({levelLabel})
        </Text>
      </Box>

      <Box flexDirection="column" paddingLeft={2} marginBottom={1}>
        {Object.entries(args)
          .slice(0, 5)
          .map(([k, v]) => (
            <Text key={k} dimColor>
              {k}: {String(v).slice(0, 80)}
            </Text>
          ))}
      </Box>

      <Box gap={2}>
        <Text>
          [<Text color="green" bold>Y</Text>]es
        </Text>
        <Text>
          [<Text color="red" bold>N</Text>]o
        </Text>
        <Text>
          [<Text color="cyan" bold>A</Text>]lways allow this session
        </Text>
      </Box>
    </Box>
  );
}
