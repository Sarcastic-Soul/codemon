/**
 * Model catalog — what providers and models exist, and how to reach them. Data
 * comes from models.dev, read from three tiers, highest first: the ETag-gated
 * cache at `~/.codemon/model-catalog.json`, the bundled `catalog.snapshot.ts`
 * seed, then `{}`. The seed keeps model lists only for bundled factories, so a
 * fresh install connects immediately and fills in on the first refresh.
 */
import * as fs from "fs";
import { getCatalogCachePath, getUserConfigDir } from "../config/paths.ts";
import { logger } from "../utils/logger.ts";
import { SNAPSHOT_JSON } from "./catalog.snapshot.ts";

export const CATALOG_URL = "https://models.dev/api.json";

/** Refresh at most once a day; the catalog moves in days, not minutes. */
const REFRESH_TTL_MS = 24 * 60 * 60 * 1000;

/** Bumped when the cache shape changes, so old caches are discarded not misread. */
const CACHE_VERSION = 1;

export interface CatalogModelLimit {
  context?: number;
  output?: number;
}

export interface CatalogModelCost {
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
}

export interface CatalogModel {
  id: string;
  name: string;
  limit?: CatalogModelLimit;
  cost?: CatalogModelCost;
  /** False for models that cannot drive the agent loop — filtered in the picker. */
  tool_call?: boolean;
  reasoning?: boolean;
  attachment?: boolean;
  release_date?: string;
}

export interface CatalogProvider {
  id: string;
  name: string;
  /** Env vars holding this provider's key, in precedence order. */
  env: string[];
  /** npm package of the AI SDK provider that drives it. */
  npm?: string;
  /** Base URL — present for OpenAI-compatible providers. */
  api?: string;
  doc?: string;
  models: Record<string, CatalogModel>;
}

export type Catalog = Record<string, CatalogProvider>;

/** The upstream payload, before trimming. Deliberately untyped. */
export type RawCatalog = Record<string, unknown>;

interface CatalogCacheFile {
  version: number;
  etag?: string;
  fetchedAt: number;
  catalog: Catalog;
}

// Trimming

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function bool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function defined<T extends object>(obj: T): T | undefined {
  return Object.values(obj).some((v) => v !== undefined) ? obj : undefined;
}

/**
 * Reduce the upstream payload to the fields Codemon reads. Hand-rolled rather
 * than a schema so a reshaped entry is skipped, not fatal to the whole catalog.
 */
export function trimCatalog(raw: RawCatalog): Catalog {
  const out: Catalog = {};

  for (const [providerId, rawProvider] of Object.entries(raw)) {
    if (typeof rawProvider !== "object" || rawProvider === null) continue;
    const p = rawProvider as Record<string, unknown>;

    const id = str(p.id) ?? providerId;
    const models: Record<string, CatalogModel> = {};

    if (typeof p.models === "object" && p.models !== null) {
      for (const [modelId, rawModel] of Object.entries(p.models as Record<string, unknown>)) {
        if (typeof rawModel !== "object" || rawModel === null) continue;
        const m = rawModel as Record<string, unknown>;
        const limit = (m.limit ?? {}) as Record<string, unknown>;
        const cost = (m.cost ?? {}) as Record<string, unknown>;

        models[modelId] = {
          id: str(m.id) ?? modelId,
          name: str(m.name) ?? modelId,
          limit: defined({ context: num(limit.context), output: num(limit.output) }),
          cost: defined({
            input: num(cost.input),
            output: num(cost.output),
            cache_read: num(cost.cache_read),
            cache_write: num(cost.cache_write),
          }),
          tool_call: bool(m.tool_call),
          reasoning: bool(m.reasoning),
          attachment: bool(m.attachment),
          release_date: str(m.release_date),
        };
      }
    }

    out[providerId] = {
      id,
      name: str(p.name) ?? id,
      env: Array.isArray(p.env) ? p.env.filter((e): e is string => typeof e === "string") : [],
      npm: str(p.npm),
      api: str(p.api),
      doc: str(p.doc),
      models,
    };
  }

  return out;
}

/**
 * Build the bundled seed: every provider's metadata, but model lists only for
 * the packages named in `keepModelsFor`.
 */
export function seedCatalog(full: Catalog, keepModelsFor: ReadonlySet<string>): Catalog {
  const out: Catalog = {};
  for (const [id, provider] of Object.entries(full)) {
    const keep = provider.npm !== undefined && keepModelsFor.has(provider.npm);
    out[id] = keep ? provider : { ...provider, models: {} };
  }
  return out;
}

// Loading

let memoized: Catalog | null = null;

function readCache(): CatalogCacheFile | null {
  try {
    const file = getCatalogCachePath();
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as CatalogCacheFile;
    if (parsed.version !== CACHE_VERSION) return null;
    if (typeof parsed.catalog !== "object" || parsed.catalog === null) return null;
    // An empty cache is worse than no cache — fall through to the snapshot.
    if (Object.keys(parsed.catalog).length === 0) return null;
    return parsed;
  } catch (err) {
    logger.debug("catalog: cache unreadable, using bundled snapshot", { error: String(err) });
    return null;
  }
}

function readSnapshot(): Catalog {
  try {
    return JSON.parse(SNAPSHOT_JSON) as Catalog;
  } catch (err) {
    // Only reachable if the generated module were corrupt; spelling out
    // `provider:model` with the env var set still works.
    logger.warn("catalog: bundled snapshot unreadable", { error: String(err) });
    return {};
  }
}

/**
 * The catalog for this process, parsed at most once. Synchronous because every
 * caller — key lookup, provider construction, context sizing — is.
 */
export function loadCatalog(): Catalog {
  if (memoized) return memoized;
  memoized = readCache()?.catalog ?? readSnapshot();
  return memoized;
}

/** Drops the memo so the next `loadCatalog()` re-reads. For tests and refresh. */
export function resetCatalogCache(): void {
  memoized = null;
}

// Refresh

export type RefreshResult = "updated" | "unchanged" | "failed";

/**
 * Conditional GET against models.dev, writing `~/.codemon/model-catalog.json`.
 * The server sends an ETag, so a no-op refresh costs one 304.
 */
export async function refreshCatalog(timeoutMs = 10_000): Promise<RefreshResult> {
  const cached = readCache();

  try {
    const res = await fetch(CATALOG_URL, {
      headers: cached?.etag ? { "If-None-Match": cached.etag } : {},
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (res.status === 304 && cached) {
      writeCache({ ...cached, fetchedAt: Date.now() });
      return "unchanged";
    }

    if (!res.ok) {
      logger.debug("catalog: refresh failed", { status: res.status });
      return "failed";
    }

    const catalog = trimCatalog((await res.json()) as RawCatalog);

    // A truncated or reshaped response must not replace a working catalog.
    if (Object.keys(catalog).length < 50) {
      logger.warn("catalog: refresh returned too few providers — keeping current", {
        count: Object.keys(catalog).length,
      });
      return "failed";
    }

    writeCache({
      version: CACHE_VERSION,
      etag: res.headers.get("etag") ?? undefined,
      fetchedAt: Date.now(),
      catalog,
    });
    resetCatalogCache();
    return "updated";
  } catch (err) {
    // Offline is the normal case here, not an error worth showing.
    logger.debug("catalog: refresh unavailable", { error: String(err) });
    return "failed";
  }
}

function writeCache(data: CatalogCacheFile): void {
  try {
    const dir = getUserConfigDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(getCatalogCachePath(), JSON.stringify(data), "utf8");
  } catch (err) {
    logger.debug("catalog: cache not writable", { error: String(err) });
  }
}

let refreshInFlight: Promise<RefreshResult> | null = null;

/**
 * Refresh if the cache is older than a day. Fire-and-forget and deduped, so a
 * failure leaves the previous catalog in place and concurrent callers share one.
 */
export function maybeRefreshCatalog(): Promise<RefreshResult> {
  if (refreshInFlight) return refreshInFlight;

  const cached = readCache();
  if (cached && Date.now() - cached.fetchedAt < REFRESH_TTL_MS) {
    return Promise.resolve("unchanged");
  }

  refreshInFlight = refreshCatalog().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

// Lookups

export function getCatalogProvider(providerId: string): CatalogProvider | undefined {
  return loadCatalog()[providerId.toLowerCase()];
}

export function listCatalogProviders(): CatalogProvider[] {
  return Object.values(loadCatalog()).sort((a, b) => a.name.localeCompare(b.name));
}

export function getCatalogModel(providerId: string, modelId: string): CatalogModel | undefined {
  return getCatalogProvider(providerId)?.models[modelId];
}

/**
 * Env vars to read this provider's key from, plus a derived fallback so a
 * provider missing from the catalog is still configurable.
 */
export function getProviderEnvVars(providerId: string): string[] {
  const fromCatalog = getCatalogProvider(providerId)?.env ?? [];
  const derived = `${providerId.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;
  return fromCatalog.includes(derived) ? fromCatalog : [...fromCatalog, derived];
}

/**
 * Parse "anthropic:claude-sonnet-5" into provider + model. The legacy slash
 * format is accepted too.
 *
 * Only the *first* separator splits, because model ids legitimately contain
 * both — `openrouter:anthropic/claude-sonnet-5` and `ollama:qwen3-coder:30b`
 * both have to survive this.
 *
 * Lives here rather than in `registry.ts` so the config layer can size a context
 * window without importing the AI SDK packages that module pulls in.
 */
export function parseModelString(modelString: string): { provider: string; model: string } {
  const trimmed = modelString.trim();

  const colonIdx = trimmed.indexOf(":");
  const slashIdx = trimmed.indexOf("/");
  const splitAt =
    colonIdx === -1 ? slashIdx : slashIdx === -1 ? colonIdx : Math.min(colonIdx, slashIdx);

  // No separator, or a leading one — assume google as the default provider.
  if (splitAt <= 0) return { provider: "google", model: trimmed };

  return {
    provider: trimmed.slice(0, splitAt).toLowerCase(),
    model: trimmed.slice(splitAt + 1),
  };
}

/**
 * The history budget for a model, from the catalog's context window.
 *
 * A provider counts the reply against the same window as the prompt, so the
 * reply budget comes off the top — otherwise a history sized to exactly the
 * window leaves no room to answer. `fallback` covers models the catalog has
 * never heard of, including every hand-declared one.
 */
export function resolveContextWindow(
  modelString: string,
  maxOutputTokens: number,
  fallback: number,
): number {
  const { provider, model } = parseModelString(modelString);
  const context = getCatalogModel(provider, model)?.limit?.context;
  if (!context || context <= 0) return fallback;

  // Guard against a model whose declared output budget eats the whole window.
  const reserved = Math.min(Math.max(maxOutputTokens, 0), Math.floor(context / 2));
  return context - reserved;
}
