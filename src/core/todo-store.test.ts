import { describe, test, expect, beforeEach } from "bun:test";
import { clearTodos, getTodos, onTodosChanged, setTodos, todoCounts } from "./todo-store.ts";
import { todoTool } from "../tools/todo.ts";
import { checkPermission } from "../permissions/gate.ts";

beforeEach(() => clearTodos());

describe("todo store", () => {
  test("a write replaces the whole list rather than appending", () => {
    setTodos([{ content: "a", status: "pending" }, { content: "b", status: "pending" }]);
    setTodos([{ content: "c", status: "in_progress" }]);

    expect(getTodos()).toEqual([{ content: "c", status: "in_progress" }]);
  });

  test("listeners hear about changes", () => {
    const seen: number[] = [];
    const off = onTodosChanged((todos) => seen.push(todos.length));

    setTodos([{ content: "a", status: "pending" }]);
    setTodos([{ content: "a", status: "completed" }, { content: "b", status: "pending" }]);
    off();
    setTodos([]);

    expect(seen).toEqual([1, 2]);
  });

  test("a throwing listener does not stop the others", () => {
    let reached = false;
    const offBad = onTodosChanged(() => { throw new Error("boom"); });
    const offGood = onTodosChanged(() => { reached = true; });

    expect(() => setTodos([{ content: "a", status: "pending" }])).not.toThrow();
    expect(reached).toBe(true);

    offBad();
    offGood();
  });

  test("counts split by status", () => {
    setTodos([
      { content: "a", status: "completed" },
      { content: "b", status: "in_progress" },
      { content: "c", status: "pending" },
      { content: "d", status: "pending" },
    ]);

    expect(todoCounts()).toEqual({ total: 4, completed: 1, inProgress: 1, pending: 2 });
  });

  test("the stored list is a copy, so a caller cannot mutate it behind the store", () => {
    const mine = [{ content: "a", status: "pending" as const }];
    setTodos(mine);
    mine.push({ content: "b", status: "pending" });

    expect(getTodos()).toHaveLength(1);
  });
});

describe("todo_write tool", () => {
  test("it stores the list and echoes it back with counts", async () => {
    const result = (await todoTool.execute({
      todos: [
        { content: "read the gate", status: "completed" },
        { content: "add the deny branch", status: "in_progress" },
      ],
    })) as { total: number; completed: number };

    expect(result.total).toBe(2);
    expect(result.completed).toBe(1);
    expect(getTodos()).toHaveLength(2);
  });

  test("it is usable in safe mode", () => {
    // Classified `read` on purpose: it touches no file and runs no command, and
    // prompting for it would make planning unusable exactly where it matters.
    expect(todoTool.permissionLevel).toBe("read");
    expect(checkPermission("todo_write", todoTool.permissionLevel, "safe")).toBe("allow");
  });

  test("an empty list is a legal write — that is how the model clears it", async () => {
    setTodos([{ content: "a", status: "pending" }]);
    await todoTool.execute({ todos: [] });
    expect(getTodos()).toEqual([]);
  });

  test("the schema rejects an unknown status", () => {
    const parsed = todoTool.parameters.safeParse({
      todos: [{ content: "a", status: "blocked" }],
    });
    expect(parsed.success).toBe(false);
  });
});
