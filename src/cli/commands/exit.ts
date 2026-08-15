import type { CommandContext } from "./index.ts";

export const exitCommand = {
  names: ["/exit", "/quit", "/q"],
  description: "Exit Codemon",
  hint: "quit",
  execute(ctx: CommandContext): void {
    ctx.exit();
  },
};
