import { describe, test, expect, afterAll } from "bun:test";
import { spawnSubagentTool, AVAILABLE_TOOLS } from "./spawn-subagent.ts";
import { setCurrentProvider } from "../core/provider-instance.ts";
import { DEFAULTS, type CodemonConfig } from "../config/defaults.ts";
import type { Provider, StreamEvent } from "../providers/types.ts";

/** A sub-agent that calls `toolName` once, then answers with plain text. */
function subAgentThatCalls(toolName: string, args: Record<string, unknown> = {}): Provider {
  const turns: StreamEvent[][] = [
    [
      { type: "tool-call", toolCallId: "call-1", toolName, toolArgs: args },
      { type: "finish", finishReason: "tool-calls" },
    ],
    [{ type: "text", text: "finished" }, { type: "finish", finishReason: "stop" }],
  ];
  let turn = 0;
  return {
    streamMessage() {
      const events = turns[turn++] ?? [{ type: "finish", finishReason: "stop" }];
      return (async function* () {
        for (const event of events) yield event;
      })();
    },
  };
}

interface SubagentResult {
  output: string;
  tools_used: string[];
  errors?: string[];
}

function delegate(
  parentMode: CodemonConfig["permissionMode"],
  provider: Provider,
  args: Record<string, unknown> = {},
): Promise<SubagentResult> {
  setCurrentProvider(provider, { ...DEFAULTS, permissionMode: parentMode, repoIndex: false });
  return spawnSubagentTool.execute(
    spawnSubagentTool.parameters.parse({ task: "do the thing", max_tokens: 1024, ...args }),
  ) as Promise<SubagentResult>;
}

const errorsOf = (r: SubagentResult) => (r.errors ?? []).join("\n");

describe("spawn_subagent permission inheritance", () => {
  afterAll(() => {
    setCurrentProvider(subAgentThatCalls("noop"), DEFAULTS);
  });

  test("a safe-mode parent does not hand its sub-agent bash", async () => {
    // The sub-agent used to be pinned to yolo regardless of the parent, so
    // approving one delegation from safe mode bought unrestricted write and
    // bash for the whole sub-task.
    const result = await delegate("safe", subAgentThatCalls("bash", { command: "echo escalated" }));

    expect(errorsOf(result)).toContain("denied");
    expect(errorsOf(result)).toContain("safe");
  });

  test("a safe-mode parent does not hand its sub-agent write access", async () => {
    const result = await delegate(
      "safe",
      subAgentThatCalls("write_file", { path: "escalated.txt", content: "x" }),
    );

    expect(errorsOf(result)).toContain("denied");
  });

  test("a yolo-mode parent still gets an unrestricted sub-agent", async () => {
    const result = await delegate("yolo", subAgentThatCalls("bash", { command: "echo ok" }));

    expect(errorsOf(result)).not.toContain("denied");
    expect(result.tools_used).toContain("bash");
  });

  test("read-level tools stay available to a safe-mode sub-agent", async () => {
    const result = await delegate("safe", subAgentThatCalls("glob", { pattern: "*.json" }));

    expect(errorsOf(result)).not.toContain("denied");
    expect(result.tools_used).toContain("glob");
  });
});

describe("spawn_subagent nesting cap", () => {
  test("a sub-agent cannot spawn a sub-agent of its own", async () => {
    // Enforced by the tool filter now being checked at execution, not just
    // omitted from what the model is offered.
    const result = await delegate("yolo", subAgentThatCalls("spawn_subagent", { task: "recurse" }));

    expect(errorsOf(result)).toContain("not available to this agent");
  });

  test("the cap holds even when allowed_tools is supplied", async () => {
    const result = await delegate(
      "yolo",
      subAgentThatCalls("spawn_subagent", { task: "recurse" }),
      { allowed_tools: ["read_file", "grep"] },
    );

    expect(errorsOf(result)).toContain("not available to this agent");
  });

  test("allowed_tools narrows the sub-agent further", async () => {
    const result = await delegate("yolo", subAgentThatCalls("bash", { command: "echo no" }), {
      allowed_tools: ["read_file", "grep"],
    });

    expect(errorsOf(result)).toContain("not available to this agent");
  });

  test("the default sub-agent toolset is the declared list", () => {
    expect([...AVAILABLE_TOOLS].sort()).toEqual(
      ["bash", "edit_file", "glob", "grep", "list_dir", "read_file", "write_file"],
    );
  });
});
