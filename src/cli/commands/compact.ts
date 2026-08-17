import type { CommandContext, SlashCommand } from "./index.ts";
import { ContextManager } from "../../core/context-manager.ts";
import { maybeCompact } from "../../core/compaction.ts";
import { globalSessionStore } from "../../core/agent-loop.ts";
import { effectiveContextTokens } from "../../config/defaults.ts";
import { formatTokenCount } from "../../utils/tokenizer.ts";

export const compactCommand: SlashCommand = {
  names: ["/compact"],
  description: "Summarise the earlier conversation to free up context",
  hint: "compact",
  async execute(ctx: CommandContext, args: string) {
    if (!ctx.provider) {
      return { notice: "Compaction needs a model. Run **/connector** to configure one first." };
    }

    const budget = effectiveContextTokens(ctx.config);
    const manager = new ContextManager(budget);
    const systemPrompt = ""; // The prompt is rebuilt per turn; the boundary
                             // barely moves for it and this command only needs
                             // the turn boundary, not an exact token count.

    const before = manager.getStats(globalSessionStore.getMessages(), systemPrompt);

    ctx.addMessage({ role: "assistant", content: "Compacting the conversation…" });

    const outcome = await maybeCompact(
      globalSessionStore,
      manager,
      systemPrompt,
      ctx.provider,
      ctx.config,
      // Forced: `/compact` is the user saying "do it now", not "do it if the
      // window is 80% full".
      { force: true, instruction: args || undefined },
    );

    if (!outcome.compacted) {
      return { notice: `Nothing compacted — ${outcome.reason ?? "no earlier turns to summarise"}.` };
    }

    const saved = Math.max(0, before.estimatedTokens - outcome.summaryTokens);

    return {
      notice:
        `Compacted **${outcome.droppedMessages}** earlier messages into a ` +
        `~${formatTokenCount(outcome.summaryTokens)} token summary ` +
        `(~${formatTokenCount(saved)} freed).`,
    };
  },
};
