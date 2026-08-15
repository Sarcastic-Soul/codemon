import type { CommandContext } from "./index.ts";

export const connectorCommand = {
  names: ["/connector", "/config", "/model"],
  description: "Open provider & API key configurator",
  execute(ctx: CommandContext): void {
    ctx.setShowConnectorModal(true);
  },
};
