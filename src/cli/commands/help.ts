import type { CommandContext } from "./index.ts";
import { ALL_COMMANDS } from "./index.ts";

export const helpCommand = {
  names: ["/help", "/?"],
  description: "List all available slash commands",
  execute(ctx: CommandContext): void {
    const lines = [
      "📖 **Available slash commands:**",
      "",
      ...ALL_COMMANDS.map((cmd) => {
        const name = cmd.names[0] ?? "/unknown";
        return `  ${name.padEnd(14)} — ${cmd.description}`;
      }),
      "",
      "Tip: Ctrl+C also exits.",
    ];
    ctx.addMessage({ role: "assistant", content: lines.join("\n") });
  },
};
