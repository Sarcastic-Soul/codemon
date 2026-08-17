import type { CommandContext, SlashCommand } from "./index.ts";

export const planCommand: SlashCommand = {
  names: ["/plan"],
  description: "Toggle plan mode — investigate and propose, change nothing",
  hint: "plan mode",
  execute(ctx: CommandContext, args: string) {
    // `/plan on` and `/plan off` are explicit; a bare `/plan` toggles.
    const wanted =
      args.toLowerCase() === "on" ? true
      : args.toLowerCase() === "off" ? false
      : !ctx.planMode;

    if (wanted === ctx.planMode) {
      return { notice: `Plan mode is already **${wanted ? "on" : "off"}**.` };
    }

    ctx.setPlanMode(wanted);

    if (wanted) {
      return {
        notice:
          "**Plan mode on.** Writes, shell commands that are not read-only, and " +
          "remote tools are denied at the gate — regardless of your permission mode " +
          "or any \"always allow\" you granted this session. Ask for a plan, then " +
          "`/plan` again to execute it.",
      };
    }

    // The plan the agent wrote stays in history, which is the entire point of
    // having written it there rather than in a scratch buffer.
    return { notice: "**Plan mode off.** The plan stays in context — say the word to execute it." };
  },
};
