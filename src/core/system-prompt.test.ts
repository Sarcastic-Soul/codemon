import { describe, test, expect } from "bun:test";
import { buildSystemPrompt, PLAN_MODE_HEADING } from "./system-prompt.ts";
import { DEFAULTS } from "../config/defaults.ts";

const build = (planMode: boolean, overrides = {}) =>
  buildSystemPrompt({
    config: { ...DEFAULTS, ...overrides },
    projectRoot: "/tmp/demo",
    agentRules: null,
    planMode,
  });

describe("system prompt", () => {
  test("the todo tool is described, or the model never reaches for it", () => {
    expect(build(false)).toContain("todo_write");
    expect(build(false)).toContain("three or more steps");
  });

  test("plan mode adds its section", () => {
    expect(build(true)).toContain(PLAN_MODE_HEADING);
    expect(build(false)).not.toContain(PLAN_MODE_HEADING);
  });

  test("plan mode drops the instruction to run tests", () => {
    // Nothing is being changed, so there is nothing to re-test — and the line
    // only invites a bash call that the gate will deny.
    expect(build(false)).toContain("Run tests after making changes");
    expect(build(true)).not.toContain("Run tests after making changes");
  });

  test("plan mode says what is still allowed, so the agent does not give up", () => {
    const prompt = build(true);
    expect(prompt).toContain("git log");
    expect(prompt).toContain("read files");
  });

  test("agent rules and the config append are both carried through", () => {
    const prompt = buildSystemPrompt({
      config: { ...DEFAULTS, systemPromptAppend: "APPENDED" },
      projectRoot: "/tmp/demo",
      agentRules: "RULES FROM codemon.md",
      planMode: false,
    });

    expect(prompt).toContain("RULES FROM codemon.md");
    expect(prompt).toContain("APPENDED");
  });

  test("the project root is stated", () => {
    expect(build(false)).toContain("/tmp/demo");
  });
});
