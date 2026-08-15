import React from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";

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

export function ToolCallView({ calls }: ToolCallViewProps) {
  if (calls.length === 0) return null;

  return (
    <Box flexDirection="column" marginY={1}>
      {calls.map((call) => (
        <ToolCallItem key={call.id} call={call} />
      ))}
    </Box>
  );
}

function ToolCallItem({ call }: { call: ToolCallEntry }) {
  const icon =
    call.status === "running" ? "⚡" : call.status === "success" ? "✅" : "❌";

  const argSummary = summarizeArgs(call.toolName, call.args);

  return (
    <Box flexDirection="column" paddingLeft={2} marginBottom={0}>
      <Box gap={1}>
        {call.status === "running" ? (
          <Text color="yellow">
            <Spinner type="dots" />
          </Text>
        ) : (
          <Text>{icon}</Text>
        )}
        <Text color="yellow" bold>
          {toolLabel(call.toolName)}
        </Text>
        <Text color="gray">{argSummary}</Text>
      </Box>
      {call.status === "error" && call.error && (
        <Box paddingLeft={4}>
          <Text color="red">↳ {call.error}</Text>
        </Box>
      )}
      {call.status === "success" && call.result != null && (
        <Box paddingLeft={4}>
          <Text color="green" dimColor>
            ↳ {resultSummary(call.toolName, call.result as Record<string, unknown>)}
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
