import { z } from "zod";
import { setTodos, todoCounts, type Todo } from "../core/todo-store.ts";
import type { ToolDefinition } from "./types.ts";

const schema = z.object({
  todos: z
    .array(
      z.object({
        content: z.string().min(1).describe("What the step is, in the imperative — 'add the compactions table'"),
        status: z
          .enum(["pending", "in_progress", "completed"])
          .describe("Exactly one item should be in_progress at a time."),
      }),
    )
    .describe(
      "The complete list, every time. This replaces the previous list rather than adding to it, so omitting an item deletes it.",
    ),
});

export const todoTool: ToolDefinition<typeof schema> = {
  name: "todo_write",
  description: `Record the checklist for a multi-step task, so the plan survives a long session and the user can see progress.

Pass the ENTIRE list on every call — it replaces the stored one. There is no add or complete operation, and no read: the result of your last write is already in your context.

Use it for any task with three or more steps. Write the full list before starting, mark exactly one item in_progress at a time, and mark it completed the moment it is done rather than batching updates at the end.`,
  parameters: schema,
  // `read`, despite the name. It touches no file and runs no command, so the
  // only thing prompting for it would achieve is making the feature unusable in
  // safe mode — which is exactly where keeping to a plan matters most. Left
  // explicit here because "a tool called *write* classified as read" invites a
  // later well-meaning correction.
  permissionLevel: "read",
  async execute({ todos }) {
    const stored = setTodos(todos as Todo[]);
    return {
      todos: stored,
      ...todoCounts(stored),
    };
  },
};
