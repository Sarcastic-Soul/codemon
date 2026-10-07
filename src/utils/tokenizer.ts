/** Fast token estimation without API calls — ~4 chars per token for code/prose. */
const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function estimateMessagesTokens(messages: Array<{ content: string | unknown }>): number {
  return messages.reduce((total, msg) => {
    const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
    return total + estimateTokens(content) + 4; // ~4 overhead per message
  }, 0);
}

export function formatTokenCount(count: number): string {
  // A million-token window read as "1040.4k", which takes a second look to parse.
  if (count >= 1_000_000) return `${trimZero((count / 1_000_000).toFixed(2))}M`;
  if (count >= 1000) return `${trimZero((count / 1000).toFixed(1))}k`;
  return String(count);
}

/** "2.0" → "2", "1.50" → "1.5": a trailing zero is noise in a meter. */
function trimZero(n: string): string {
  return n.includes(".") ? n.replace(/\.?0+$/, "") : n;
}
