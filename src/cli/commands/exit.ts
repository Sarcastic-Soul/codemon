import type { CommandContext, SlashCommand } from "./index.ts";

export const exitCommand: SlashCommand = {
  names: ["/exit", "/quit", "/q"],
  description: "Exit Codemon",
  hint: "quit",
  execute(ctx: CommandContext): void {
    ctx.exit();
  },
};
