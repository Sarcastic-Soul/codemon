import type { CommandContext, SlashCommand } from "./index.ts";

export const connectorCommand: SlashCommand = {
  names: ["/connector", "/config", "/model"],
  description: "Open provider & API key configurator",
  hint: "model / key",
  execute(ctx: CommandContext): void {
    ctx.setShowConnectorModal(true);
  },
};
