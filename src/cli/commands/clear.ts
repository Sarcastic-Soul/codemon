import type { CommandContext } from "./index.ts";

export const clearCommand = {
  names: ["/clear", "/cls"],
  description: "Clear the current chat history display",
  execute(ctx: CommandContext): void {
    ctx.setMessages([]);
    ctx.addMessage({ role: "assistant", content: "🧹 Chat cleared. Session history in the database is preserved." });
  },
};
