import { Box, Text } from "ink";
import { GLYPH } from "../theme.ts";
import { PokeballSpinner } from "./PokeballSpinner.tsx";

export type ToolCallStatus = "running" | "success" | "error";

export interface ToolCallEntry {
  id: string;
  toolName: string;
  args: Record<string, unknown>;
  status: ToolCallStatus;
  result?: unknown;
  error?: string;
}

interface ToolCallViewProps {
  calls: ToolCallEntry[];
}

/**
 * Rows one entry draws: its own line, plus the `└ …` line that a finished call
 * adds for its result or its error.
 *
 * Counting one row per call — which both the layout and the transcript estimate
 * used to do — is right only while the call is still running. The moment it
 * finishes it becomes two, so every completed tool call was a row of unbudgeted
 * overflow.
 */
export function toolCallRows(call: ToolCallEntry): number {
  const hasDetail =
    (call.status === "error" && Boolean(call.error)) ||
    (call.status === "success" && call.result != null);
  return 1 + (hasDetail ? 1 : 0);
}

/** Rows the whole list draws, including its own vertical margins. */
export function toolCallViewRows(calls: ToolCallEntry[]): number {
  if (calls.length === 0) return 0;
  return calls.reduce((n, c) => n + toolCallRows(c), 0) + TOOL_CALL_MARGIN_ROWS;
}

/** `marginY={1}` on the list: one row above, one below. */
const TOOL_CALL_MARGIN_ROWS = 2;

export function ToolCallView({ calls }: ToolCallViewProps) {
  if (calls.length === 0) return null;

  return (
    <Box flexDirection="column" marginY={1} flexShrink={0}>
      {calls.map((call) => (
        <ToolCallItem key={call.id} call={call} />
      ))}
    </Box>
  );
}

function ToolCallItem({ call }: { call: ToolCallEntry }) {
  const icon = call.status === "success" ? GLYPH.ok : GLYPH.fail;
  const iconColor = call.status === "success" ? "green" : "red";

  const argSummary = summarizeArgs(call.toolName, call.args);

  return (
    <Box flexDirection="column" paddingLeft={2} marginBottom={0}>
      {/* One `Text` for the whole row, not a `Box` of three.
          A row of separate Texts is laid out by Yoga at each child's natural
          width, so a long argument summary pushes the row past the pane and Ink
          breaks it across two lines — with the pieces out of order. Truncation
          set on the individual children cannot prevent that, because each one is
          measured before the overflow is known. Composed as a single truncating
          Text the whole line is measured and cut once, and stays one row at any
          width, which is what `toolCallRows` promises the layout. */}
      <Text wrap="truncate">
        {call.status === "running" ? (
          <PokeballSpinner />
        ) : (
          <Text color={iconColor} bold>
            {icon}
          </Text>
        )}
        <Text color="yellow" bold>
          {" "}
          {toolLabel(call.toolName)}
        </Text>
        <Text color="gray"> {argSummary}</Text>
      </Text>
      {call.status === "error" && call.error && (
        <Box paddingLeft={4}>
          <Text color="red" wrap="truncate">{GLYPH.branch} {call.error}</Text>
        </Box>
      )}
      {call.status === "success" && call.result != null && (
        <Box paddingLeft={4}>
          <Text color="green" dimColor wrap="truncate">
            {GLYPH.branch} {resultSummary(call.toolName, call.result as Record<string, unknown>)}
          </Text>
        </Box>
      )}
    </Box>
  );
}

function toolLabel(toolName: string): string {
  const labels: Record<string, string> = {
    read_file: "READ FILE",
    write_file: "WRITE FILE",
    edit_file: "EDIT FILE",
    list_dir: "LIST DIR",
    bash: "BASH",
    grep: "GREP",
    glob: "GLOB",
    spawn_subagent: "SPAWN SUBAGENT",
  };
  return labels[toolName] ?? toolName.toUpperCase();
}

function summarizeArgs(toolName: string, args: Record<string, unknown>): string {
  if (toolName === "bash") return `$ ${String(args.command ?? "").slice(0, 60)}`;
  if (toolName === "read_file" || toolName === "write_file" || toolName === "edit_file") {
    return String(args.path ?? "");
  }
  if (toolName === "grep") return `"${String(args.pattern ?? "")}" in ${String(args.path ?? ".")}`;
  if (toolName === "glob") return String(args.pattern ?? "");
  if (toolName === "list_dir") return String(args.path ?? ".");
  return JSON.stringify(args).slice(0, 60);
}

function resultSummary(toolName: string, result: Record<string, unknown>): string {
  const r = result;
  if (r.error) return `Error: ${String(r.error).slice(0, 80)}`;
  if (toolName === "bash") {
    const stdout = String(r.stdout ?? "").trim();
    return stdout ? stdout.split("\n")[0]?.slice(0, 80) ?? "" : `exit ${r.exit_code}`;
  }
  if (toolName === "read_file") {
    const lines = String(r.content ?? "").split("\n").length;
    return `${lines} lines`;
  }
  if (toolName === "grep") {
    return `${r.count} matches${r.truncated ? " (output truncated)" : ""}`;
  }
  if (toolName === "glob") {
    const files = r.files as string[];
    return `${files.length} files`;
  }
  return "done";
}
