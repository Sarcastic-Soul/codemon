import { z } from "zod";
import * as dns from "dns/promises";
import * as net from "net";
import { getCurrentConfig } from "../core/provider-instance.ts";
import { logger } from "../utils/logger.ts";
import type { ToolDefinition } from "./types.ts";

/**
 * Fetch a URL and hand the model its text.
 *
 * The hazard here is SSRF, not bandwidth. A model can be talked into fetching
 * `http://169.254.169.254/latest/meta-data/` by anything it has read — a issue
 * comment, a README, a page fetched a moment earlier — and on a cloud box that
 * is a credential. So the address is checked after DNS resolution rather than
 * by hostname: `evil.com` resolving to 127.0.0.1 is the whole attack, and a
 * hostname blocklist does not see it.
 */

/** Redirect hops before giving up. Each hop is re-validated. */
const MAX_REDIRECTS = 5;

/** Bytes read before the body is truncated. */
const DEFAULT_MAX_BYTES = 200_000;
const HARD_MAX_BYTES = 2_000_000;

/**
 * Address ranges that are never a legitimate fetch target: loopback, the RFC
 * 1918 private space, link-local (which is where cloud metadata lives), CGNAT,
 * and their IPv6 equivalents.
 */
export function isBlockedAddress(address: string): boolean {
  const version = net.isIP(address);
  if (version === 0) return true; // Not an address at all — refuse it.

  if (version === 4) {
    const parts = address.split(".").map(Number);
    const [a, b] = parts as [number, number, number, number];
    if (a === 0) return true;                       // "this network"
    if (a === 10) return true;                      // private
    if (a === 127) return true;                     // loopback
    if (a === 169 && b === 254) return true;        // link-local, incl. cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true;        // private
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true;                      // multicast and reserved
    return false;
  }

  const lower = address.toLowerCase();
  if (lower === "::" || lower === "::1") return true;

  // An IPv4-mapped address is an IPv4 address wearing a costume.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return isBlockedAddress(mapped[1]!);

  if (lower.startsWith("fe8") || lower.startsWith("fe9") ||
      lower.startsWith("fea") || lower.startsWith("feb")) return true; // fe80::/10
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;   // fc00::/7 unique-local
  if (lower.startsWith("ff")) return true;                             // multicast

  return false;
}

export interface UrlCheck {
  ok: boolean;
  reason?: string;
}

/**
 * Validate a URL and every address its host resolves to.
 *
 * Called before the first request and again for every redirect target — a
 * redirect to `http://127.0.0.1` is the same attack with an extra step.
 */
export async function checkUrl(raw: string): Promise<UrlCheck> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: `not a valid URL: ${raw}` };
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, reason: `only http and https are supported, got "${url.protocol}"` };
  }

  const host = url.hostname.replace(/^\[|\]$/g, "");

  // A literal address skips DNS, so check it directly.
  if (net.isIP(host) !== 0) {
    return isBlockedAddress(host)
      ? { ok: false, reason: `${host} is a private or loopback address` }
      : { ok: true };
  }

  let addresses: Array<{ address: string }>;
  try {
    addresses = await dns.lookup(host, { all: true });
  } catch (err) {
    return { ok: false, reason: `could not resolve ${host}: ${String(err)}` };
  }

  if (addresses.length === 0) return { ok: false, reason: `${host} resolved to nothing` };

  // Every address, not just the first: a host that resolves to both a public
  // and a private address is a host that can be made to serve either.
  for (const { address } of addresses) {
    if (isBlockedAddress(address)) {
      return { ok: false, reason: `${host} resolves to ${address}, a private or loopback address` };
    }
  }

  return { ok: true };
}

/** Strip markup down to something worth spending context on. */
export function htmlToText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    // Block-level tags become newlines so the structure survives the strip.
    .replace(/<\/(p|div|section|article|h[1-6]|li|tr|blockquote)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    // Opening tags leave a space behind, so a newline from the closing tag
    // arrives padded on both sides.
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Read at most `maxBytes` from a response body. */
async function readCapped(response: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) return { text: "", truncated: false };

  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      total += value.byteLength;
      if (total > maxBytes) {
        chunks.push(value.slice(0, value.byteLength - (total - maxBytes)));
        truncated = true;
        break;
      }
      chunks.push(value);
    }
  } finally {
    // Cancelling releases the socket; leaving it open leaks a connection per
    // oversized page.
    await reader.cancel().catch(() => {});
  }

  const merged = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return { text: new TextDecoder("utf-8", { fatal: false }).decode(merged), truncated };
}

const schema = z.object({
  url: z.string().describe("The absolute http(s) URL to fetch."),
  max_bytes: z
    .number()
    .int()
    .positive()
    .max(HARD_MAX_BYTES)
    .optional()
    .describe(`Stop reading the body after this many bytes. Defaults to ${DEFAULT_MAX_BYTES}.`),
  raw: z
    .boolean()
    .optional()
    .describe("Return the body as-is instead of stripping HTML down to text."),
});

export const webFetchTool: ToolDefinition<typeof schema> = {
  name: "web_fetch",
  description: `Fetch a URL over http(s) and return its content as text, with HTML stripped to readable text by default.

Private, loopback and link-local addresses are refused — including hosts that resolve to them and redirects that lead to them — so this cannot reach services on the developer's machine or a cloud metadata endpoint.

The body is truncated rather than read whole. Redirects are followed up to ${MAX_REDIRECTS} hops.`,
  parameters: schema,
  // `network`, the same level MCP tools get: the trust question is identical —
  // content from outside the region is entering the context, and it may be
  // written by whoever controls the page.
  permissionLevel: "network",
  async execute({ url, max_bytes, raw = false }) {
    const maxBytes = Math.min(max_bytes ?? DEFAULT_MAX_BYTES, HARD_MAX_BYTES);

    let timeout = 30_000;
    try { timeout = getCurrentConfig().timeout; } catch { /* no config in tests */ }

    let current = url;
    const visited: string[] = [];

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const check = await checkUrl(current);
      if (!check.ok) return { error: `Refused to fetch: ${check.reason}` };

      visited.push(current);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);

      let response: Response;
      try {
        response = await fetch(current, {
          // Manual, so every hop goes back through checkUrl. Letting fetch
          // follow them would skip the check on the one that matters.
          redirect: "manual",
          signal: controller.signal,
          headers: { "user-agent": "codemon/1.0 (+https://github.com/Sarcastic-Soul/codemon)" },
        });
      } catch (err) {
        clearTimeout(timer);
        const message = err instanceof Error ? err.message : String(err);
        return { error: `Fetch failed: ${message}`, url: current };
      }
      clearTimeout(timer);

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) return { error: `Redirect with no Location header`, url: current, status: response.status };
        current = new URL(location, current).toString();
        logger.debug("web_fetch: following redirect", { to: current });
        continue;
      }

      const contentType = response.headers.get("content-type") ?? "";
      const { text, truncated } = await readCapped(response, maxBytes);
      const isHtml = contentType.includes("html") || /^\s*<(!doctype|html)/i.test(text);

      return {
        url: current,
        status: response.status,
        content_type: contentType,
        content: raw || !isHtml ? text : htmlToText(text),
        truncated,
        ...(visited.length > 1 ? { redirects: visited.slice(0, -1) } : {}),
      };
    }

    return { error: `Too many redirects (more than ${MAX_REDIRECTS})`, url: visited[0], redirects: visited };
  },
};
