import * as fs from "fs";
import * as path from "path";
import type { CommandContext, SlashCommand } from "./index.ts";

/**
 * The prompt `/init` submits. Fixed text rather than something assembled from
 * flags: the value of `/init` is that every project gets the same shape of
 * file, and `loadAgentRules` picks it up on the next start with no further
 * configuration.
 */
export const INIT_PROMPT = `Explore this repository and write a \`codemon.md\` at the project root documenting:

- What the project does, in two or three sentences.
- The tech stack and runtime.
- How to build, test and run it — the exact commands.
- The directory layout, one line per top-level directory.
- Conventions a new contributor must follow that are not obvious from the code.

Keep it under 100 lines and write it for someone who has never seen the repo. Prefer facts you verified by reading files over anything you inferred from names.

If \`codemon.md\` already exists, read it first and update it in place rather than replacing it — preserve anything still accurate.`;

export const initCommand: SlashCommand = {
  names: ["/init"],
  description: "Explore the project and write a codemon.md for it",
  hint: "init rules",
  execute(ctx: CommandContext) {
    if (ctx.planMode) {
      return { notice: "`/init` writes a file, which plan mode denies. Run `/plan off` first." };
    }

    const existing = ["codemon.md", "CODEMON.md"].find((f) =>
      fs.existsSync(path.join(ctx.projectRoot, f)),
    );

    // Said up front because in safe mode the write will stop for a prompt, and
    // an unexplained Poké Ball halfway through an exploration reads as a bug.
    ctx.addMessage({
      role: "assistant",
      content:
        (existing ? `Updating \`${existing}\`. ` : "Writing a new `codemon.md`. ") +
        (ctx.config.permissionMode === "safe"
          ? "Safe mode will ask before the file is written."
          : "It is picked up automatically on the next start."),
    });

    return { submit: INIT_PROMPT };
  },
};
