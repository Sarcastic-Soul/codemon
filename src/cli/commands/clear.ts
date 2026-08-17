import type { CommandContext, SlashCommand } from "./index.ts";

export const clearCommand: SlashCommand = {
  names: ["/clear", "/cls"],
  description: "Clear the current chat history display",
  hint: "clear chat",
  execute(ctx: CommandContext): void {
    ctx.setMessages([]);
    ctx.addMessage({ role: "assistant", content: "Chat cleared. Session history in the database is preserved." });
  },
};
