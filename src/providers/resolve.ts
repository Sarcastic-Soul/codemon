/**
 * The provider view the rest of the app sees: the models.dev catalog with the
 * user's own `providers` entries merged over it. Kept out of `catalog.ts` so
 * that module stays free of the config layer, which would be a cycle.
 */
import type { CatalogProvider, CatalogModel } from "./catalog.ts";
import { getCatalogProvider, listCatalogProviders, loadCatalog } from "./catalog.ts";
import { isProviderSupported } from "./factories.ts";
import { loadUserConfig, getEndpointOverride, type CustomProviderData } from "../config/user-config.ts";

const DEFAULT_CUSTOM_PACKAGE = "@ai-sdk/openai-compatible";

function modelsFromIds(ids: string[] | undefined): Record<string, CatalogModel> {
  const out: Record<string, CatalogModel> = {};
  for (const id of ids ?? []) out[id] = { id, name: id };
  return out;
}

/**
 * Fold a hand-declared provider into catalog shape. A custom entry overrides
 * the connection details but *adds* models rather than replacing them.
 */
function mergeCustom(id: string, custom: CustomProviderData, base?: CatalogProvider): CatalogProvider {
  return {
    id,
    name: custom.name ?? base?.name ?? id,
    env: [...new Set([...(custom.env ?? []), ...(base?.env ?? [])])],
    npm: custom.npm ?? base?.npm ?? DEFAULT_CUSTOM_PACKAGE,
    api: custom.api ?? base?.api,
    doc: base?.doc,
    models: { ...(base?.models ?? {}), ...modelsFromIds(custom.models) },
  };
}

/** A provider by id, custom entries included. */
export function resolveProviderEntry(providerId: string): CatalogProvider | undefined {
  const norm = providerId.toLowerCase();
  const base = getCatalogProvider(norm);
  const custom = loadUserConfig().providers?.[norm];
  if (custom) return mergeCustom(norm, custom, base);
  return base;
}

/**
 * Providers Codemon can actually construct, name-sorted. Entries needing a
 * package we do not bundle and offering no base URL are filtered out — they
 * would only fail at first token.
 */
export function listAvailableProviders(): CatalogProvider[] {
  const custom = loadUserConfig().providers ?? {};
  const catalog = loadCatalog();

  const merged = new Map<string, CatalogProvider>();
  for (const entry of listCatalogProviders()) merged.set(entry.id, entry);
  for (const [id, data] of Object.entries(custom)) {
    const norm = id.toLowerCase();
    merged.set(norm, mergeCustom(norm, data, catalog[norm]));
  }

  return [...merged.values()]
    .filter((entry) => isProviderSupported(entry, getEndpointOverride(entry.id)))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Known model ids for a provider, newest release first where dates are known. */
export function listModelsFor(providerId: string): string[] {
  const entry = resolveProviderEntry(providerId);
  if (!entry) return [];

  return Object.values(entry.models)
    .sort((a, b) => {
      const byDate = (b.release_date ?? "").localeCompare(a.release_date ?? "");
      return byDate !== 0 ? byDate : a.id.localeCompare(b.id);
    })
    .map((m) => m.id);
}

export function resolveModel(providerId: string, modelId: string): CatalogModel | undefined {
  return resolveProviderEntry(providerId)?.models[modelId];
}
