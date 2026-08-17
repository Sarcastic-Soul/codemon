import type { CommandContext, SlashCommand } from "./index.ts";
import { ALL_COMMANDS, BUILTIN_NAMES } from "./index.ts";

export const helpCommand: SlashCommand = {
  names: ["/help", "/?"],
  description: "List all available slash commands",
  hint: "help",
  execute(ctx: CommandContext): void {
    // Split so a project's own commands are visibly its own, rather than
    // reading as things Codemon shipped with.
    const custom = ALL_COMMANDS.filter((c) => !BUILTIN_NAMES.has(c.names[0]!.toLowerCase()));
    const builtin = ALL_COMMANDS.filter((c) => BUILTIN_NAMES.has(c.names[0]!.toLowerCase()));

    const format = (cmd: SlashCommand) =>
      `  ${cmd.names.join(", ").padEnd(20)} — ${cmd.description}`;

    const lines = ["**Available slash commands:**", "", ...builtin.map(format)];

    if (custom.length > 0) {
      lines.push("", "**Project commands** (from `.codemon/commands/`):", "", ...custom.map(format));
    }

    lines.push("", "Tip: Ctrl+C also exits.");
    ctx.addMessage({ role: "assistant", content: lines.join("\n") });
  },
};
