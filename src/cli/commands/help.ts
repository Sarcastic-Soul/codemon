import type { CommandContext } from "./index.ts";
import { ALL_COMMANDS } from "./index.ts";

export const helpCommand = {
  names: ["/help", "/?"],
  description: "List all available slash commands",
  hint: "help",
  execute(ctx: CommandContext): void {
    const lines = [
      "**Available slash commands:**",
      "",
      ...ALL_COMMANDS.map((cmd) => `  ${cmd.names.join(", ").padEnd(20)} — ${cmd.description}`),
      "",
      "Tip: Ctrl+C also exits.",
    ];
    ctx.addMessage({ role: "assistant", content: lines.join("\n") });
  },
};
