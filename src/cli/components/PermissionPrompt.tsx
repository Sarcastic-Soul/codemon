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

  const levelColor =
    permissionLevel === "bash" ? "red"
    : permissionLevel === "network" ? "magenta"
    : "yellow";

  // `network` gets its own wording rather than borrowing "write": the question
  // it is asking is different — not "may this change a file" but "may this
  // leave the machine".
  const levelLabel =
    permissionLevel === "bash" ? "DANGEROUS"
    : permissionLevel === "network" ? "[>] REMOTE — leaves this machine"
    : permissionLevel === "write" ? "[~] WRITE"
    : "[=] READ";

  const shown = promptArgs(args);

  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor={levelColor}
      paddingX={1}
      marginTop={1}
      flexShrink={0}
    >
      <Text bold color={levelColor} wrap="truncate">
        [o] Poké Ball — Permission Required
      </Text>

      <Text wrap="truncate">
        A wild{" "}
        <Text bold color="yellow">
          {toolName}
        </Text>{" "}
        appeared! ({levelLabel})
      </Text>

      {/* Truncated, never wrapped, so `permissionPromptRows` stays exact. */}
      <Box flexDirection="column" paddingLeft={2} marginY={1}>
        {shown.map(([k, v]) => (
          <Text key={k} dimColor wrap="truncate">
            {k}: {v}
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

/** The arguments worth showing: the first five, one line each. */
function promptArgs(args: Record<string, unknown>): Array<[string, string]> {
  return Object.entries(args)
    .slice(0, MAX_ARGS)
    .map(([k, v]) => [k, (typeof v === "string" ? v : JSON.stringify(v) ?? String(v)).split("\n")[0]!]);
}

const MAX_ARGS = 5;

/**
 * Rows the prompt occupies: the top margin, two border rows, the title and the
 * "wild tool" line, the argument block with its margin above and below, and the
 * key row. The layout reserves this, because a prompt it did not plan for got
 * squeezed in over the transcript and drew on top of it.
 */
export function permissionPromptRows(args: Record<string, unknown>): number {
  return 1 + 2 + 2 + 2 + Math.min(Object.keys(args).length, MAX_ARGS) + 1;
}
