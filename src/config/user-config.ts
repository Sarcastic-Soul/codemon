import * as fs from "fs";
import { getUserConfigDir, getUserConfigPath } from "./paths.ts";
import { getProviderEnvVars } from "../providers/catalog.ts";

// Re-exported so existing importers of `user-config.ts` keep working now that
// the path helpers live in their own module (see paths.ts for why).
export { getUserConfigDir, getUserConfigPath };

/**
 * A provider the catalog does not know about, declared by hand under
 * `providers.<id>` — the escape hatch for anything local or private, since
 * models.dev only catalogues hosted services.
 */
export interface CustomProviderData {
  name?: string;
  /** Base URL. Required — it is the whole point of a custom entry. */
  api: string;
  /** Defaults to `@ai-sdk/openai-compatible`. */
  npm?: string;
  /** Extra env vars to read the key from. */
  env?: string[];
  /** Model ids to offer in the picker. */
  models?: string[];
}

/**
 * The half of `~/.codemon/config.json` that belongs to the user rather than to a
 * run: credentials, custom providers, and the model `/connector` last selected.
 * `loadConfig` reads only `defaultModel` out of it, so keys never leave this
 * module.
 */
export interface UserConfigData {
  /** Model chosen in `/connector`. Read back by `loadConfig` as the `model` tier. */
  defaultModel?: string;
  apiKeys?: Record<string, string>; // e.g. { google: "key...", anthropic: "key..." }
  /** Base URL overrides for catalogued providers, keyed by provider id. */
  endpoints?: Record<string, string>; // e.g. { deepseek: "http://localhost:8000/v1" }
  /** Providers the catalog does not carry, keyed by provider id. */
  providers?: Record<string, CustomProviderData>;
}

export function loadUserConfig(): UserConfigData {
  const file = getUserConfigPath();
  try {
    if (fs.existsSync(file)) {
      const content = fs.readFileSync(file, "utf8");
      return JSON.parse(content) as UserConfigData;
    }
  } catch {}
  return {};
}

export function saveUserConfig(data: UserConfigData): void {
  const dir = getUserConfigDir();
  const file = getUserConfigPath();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const serialized = JSON.stringify(data, null, 2);
  fs.writeFileSync(file, serialized, { encoding: "utf8", mode: 0o600 });
  // Ensure mode permissions are set strictly to 0600 even if file pre-existed
  try {
    fs.chmodSync(file, 0o600);
  } catch {}
}

export function setApiKey(provider: string, apiKey: string): void {
  const config = loadUserConfig();
  const apiKeys = config.apiKeys || {};
  apiKeys[provider.toLowerCase()] = apiKey.trim();
  saveUserConfig({ ...config, apiKeys });
}

export function removeApiKey(provider: string): void {
  const config = loadUserConfig();
  if (config.apiKeys) {
    delete config.apiKeys[provider.toLowerCase()];
    saveUserConfig(config);
  }
}

export function setDefaultModel(model: string): void {
  const config = loadUserConfig();
  saveUserConfig({ ...config, defaultModel: model.trim() });
}

export function maskApiKey(apiKey: string | undefined): string {
  if (!apiKey) return "";
  const trimmed = apiKey.trim();
  if (trimmed.length <= 4) return "••••";
  const last4 = trimmed.slice(-4);
  return `••••••••${last4}`;
}

/** Base URL override for a provider, if the user declared one. */
export function getEndpointOverride(provider: string): string | undefined {
  const norm = provider.toLowerCase();
  const config = loadUserConfig();
  return config.endpoints?.[norm] ?? config.providers?.[norm]?.api;
}

/**
 * Resolve a provider's API key, env var first and stored config second. Env var
 * names come from the catalog, plus a derived `<PROVIDER>_API_KEY` fallback.
 */
export function getEffectiveApiKey(provider: string): string | undefined {
  const norm = provider.toLowerCase();

  // Precedence 1: Environment Variable
  for (const name of getProviderEnvVars(norm)) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }

  // Precedence 2: Stored User Config (~/.codemon/config.json)
  const stored = loadUserConfig().apiKeys?.[norm]?.trim();
  if (stored) return stored;

  return undefined;
}
