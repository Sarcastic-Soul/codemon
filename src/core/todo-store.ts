/**
 * The agent's checklist for the session.
 *
 * Module-level state with a change listener, mirroring how session.ts holds the
 * current session. Deliberately not persisted in this cut: a todo list is about
 * the task in flight, and a stale one restored on `--continue` would be worse
 * than none. (Persisting it is a table and a load on resume, if it proves worth
 * resuming.)
 */

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface Todo {
  content: string;
  status: TodoStatus;
}

let todos: Todo[] = [];

type Listener = (todos: Todo[]) => void;
const listeners = new Set<Listener>();

export function getTodos(): Todo[] {
  return todos;
}

/**
 * Replace the whole list. Whole-list replacement rather than add/complete/
 * remove operations: incremental ops need stable ids the model has to track
 * across turns, and it gets them wrong. Replacement is idempotent and
 * self-correcting.
 */
export function setTodos(next: Todo[]): Todo[] {
  todos = [...next];
  for (const listener of listeners) {
    // One bad subscriber must not stop the others from hearing about it.
    try { listener(todos); } catch {}
  }
  return todos;
}

export function clearTodos(): void {
  setTodos([]);
}

/** Subscribe to list changes. Returns an unsubscribe function. */
export function onTodosChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export interface TodoCounts {
  total: number;
  completed: number;
  inProgress: number;
  pending: number;
}

export function todoCounts(list: Todo[] = todos): TodoCounts {
  return {
    total: list.length,
    completed: list.filter((t) => t.status === "completed").length,
    inProgress: list.filter((t) => t.status === "in_progress").length,
    pending: list.filter((t) => t.status === "pending").length,
  };
}
