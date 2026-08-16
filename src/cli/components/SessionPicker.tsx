import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { StoredSession } from "../../storage/sessions.repo.ts";

interface SessionPickerProps {
  sessions: StoredSession[];
  projectRoot: string;
  onResume: (session: StoredSession) => void;
  onNew: () => void;
}

function formatAge(isoDate: string): string {
  const diffMs = Date.now() - new Date(isoDate).getTime();
  const mins = Math.floor(diffMs / 60_000);
  const hrs = Math.floor(mins / 60);
  const days = Math.floor(hrs / 24);
  if (days > 0) return `${days}d ago`;
  if (hrs > 0) return `${hrs}h ago`;
  if (mins > 0) return `${mins}m ago`;
  return "just now";
}

function shortPath(p: string, max = 32): string {
  return p.length > max ? "…" + p.slice(p.length - max + 1) : p;
}

export function SessionPicker({ sessions, projectRoot, onResume, onNew }: SessionPickerProps) {
  // Index 0 = first session, sessions.length = "new session" option
  const [selected, setSelected] = useState(0);
  const total = sessions.length + 1; // sessions + new

  useInput((input, key) => {
    if (key.upArrow) setSelected((s) => (s - 1 + total) % total);
    if (key.downArrow) setSelected((s) => (s + 1) % total);
    if (key.return) {
      if (selected === sessions.length) {
        onNew();
      } else {
        onResume(sessions[selected]!);
      }
    }
    if (input === "n") onNew();
  });

  const dirName = projectRoot.split("/").pop() ?? projectRoot;

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Box marginBottom={1}>
        <Text bold color="magenta">CODEMON</Text>
        <Text dimColor>  —  </Text>
        <Text color="cyan">{shortPath(projectRoot)}</Text>
      </Box>

      <Box borderStyle="round" borderColor="magenta" flexDirection="column" paddingX={2} paddingY={1} marginBottom={1}>
        <Box marginBottom={1}>
          <Text bold color="white">Resume a past session in </Text>
          <Text bold color="cyan">{dirName}/</Text>
          <Text bold color="white">?</Text>
        </Box>

        {sessions.map((s, i) => {
          const isActive = i === selected;
          const model = s.model.includes(":") ? s.model.split(":")[1] : s.model;
          return (
            <Box key={s.id} marginBottom={0}>
              <Text color={isActive ? "cyan" : "gray"}>
                {isActive ? "❯ " : "  "}
              </Text>
              <Text color={isActive ? "white" : "gray"} bold={isActive}>
                [{s.id.slice(0, 8)}]
              </Text>
              <Text color={isActive ? "cyan" : "gray"}>
                {" "}{formatAge(s.lastActive)}{" "}
              </Text>
              <Text color={isActive ? "blue" : "gray"}>
                ◓ {model ?? s.model}
              </Text>
              <Text color="gray">
                {" "}· {s.messageCount} msg
              </Text>
              <Text color="gray">
                {" "}· {s.totalTokens.toLocaleString()} tk
              </Text>
            </Box>
          );
        })}

        {/* New session option */}
        <Box marginTop={1}>
          <Text color={selected === sessions.length ? "green" : "gray"}>
            {selected === sessions.length ? "❯ " : "  "}
          </Text>
          <Text color={selected === sessions.length ? "green" : "gray"} bold={selected === sessions.length}>
            Start a new session
          </Text>
        </Box>
      </Box>

      <Box gap={3}>
        <Text dimColor>↑↓ navigate</Text>
        <Text dimColor>Enter to select</Text>
        <Text dimColor>n — new session</Text>
      </Box>
    </Box>
  );
}
