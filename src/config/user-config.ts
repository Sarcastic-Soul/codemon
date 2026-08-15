import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export interface UserConfigData {
  defaultModel?: string;
  apiKeys?: Record<string, string>; // e.g. { google: "key...", anthropic: "key..." }
  endpoints?: Record<string, string>; // e.g. { custom: "http://localhost:11434" }
}

const CONFIG_DIR = path.join(os.homedir(), ".codemon");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

export function getUserConfigPath(): string {
  return CONFIG_FILE;
}

export function loadUserConfig(): UserConfigData {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const content = fs.readFileSync(CONFIG_FILE, "utf8");
      return JSON.parse(content) as UserConfigData;
    }
  } catch {}
  return {};
}

export function saveUserConfig(data: UserConfigData): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
  const serialized = JSON.stringify(data, null, 2);
  fs.writeFileSync(CONFIG_FILE, serialized, { encoding: "utf8", mode: 0o600 });
  // Ensure mode permissions are set strictly to 0600 even if file pre-existed
  try {
    fs.chmodSync(CONFIG_FILE, 0o600);
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
