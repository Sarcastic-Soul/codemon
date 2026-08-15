import * as fs from "fs";
import * as path from "path";
import * as os from "os";

/**
 * The half of `~/.codemon/config.json` that belongs to the user rather than to a
 * run: credentials and the model `/connector` last selected. `loadConfig` reads
 * the same file for `CodemonConfig` keys and reads `defaultModel` as its
 * user-level model tier — but it copies nothing else out, so keys never leave
 * this module.
 */
export interface UserConfigData {
  /** Model chosen in `/connector`. Read back by `loadConfig` as the `model` tier. */
  defaultModel?: string;
  apiKeys?: Record<string, string>; // e.g. { google: "key...", anthropic: "key..." }
  endpoints?: Record<string, string>; // e.g. { custom: "http://localhost:11434" }
}

/**
 * Directory holding the user-level config. `CODEMON_CONFIG_DIR` overrides the
 * default, which is how the tests stay out of the real home directory. Resolved
 * per call rather than captured at import time so the override still applies to
 * a process that sets it after this module loads.
 */
export function getUserConfigDir(): string {
  const override = process.env.CODEMON_CONFIG_DIR?.trim();
  return override ? path.resolve(override) : path.join(os.homedir(), ".codemon");
}

export function getUserConfigPath(): string {
  return path.join(getUserConfigDir(), "config.json");
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

export function getEffectiveApiKey(provider: string): string | undefined {
  const norm = provider.toLowerCase();

  // Precedence 2: Environment Variable
  const envMap: Record<string, string | undefined> = {
    google: process.env.GEMINI_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY,
    anthropic: process.env.ANTHROPIC_API_KEY,
    openai: process.env.OPENAI_API_KEY,
    mistral: process.env.MISTRAL_API_KEY,
  };

  if (envMap[norm]) {
    return envMap[norm];
  }

  // Precedence 3: Stored User Config (~/.codemon/config.json)
  const userConfig = loadUserConfig();
  if (userConfig.apiKeys?.[norm]) {
    return userConfig.apiKeys[norm];
  }

  return undefined;
}
