import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export interface CodemonConfig {
  /**
   * Model string in `provider:model-name` format.
   * Examples: "google:gemini-2.0-flash-exp", "anthropic:claude-sonnet-4-5", "openai:gpt-4o"
   * Slash format also accepted: "google/gemini-2.0-flash-exp"
   */
  model: string;
  permissionMode: "safe" | "standard" | "yolo";
  maxTokens: number;
  maxContextTokens: number;
  timeout: number;
  debug: boolean;
  systemPromptAppend: string;
  apiKey?: string;
  /** Sandbox mode for bash commands: subprocess (default) or docker */
  sandbox: "subprocess" | "docker";
  /** Whether to build a repo index and inject it into the system prompt */
  repoIndex: boolean;
}

export const DEFAULTS: CodemonConfig = {
  model: "google:gemini-2.0-flash-exp",
  permissionMode: "standard",
  maxTokens: 8192,
  maxContextTokens: 100000,
  timeout: 30000,
  debug: false,
  systemPromptAppend: "",
  sandbox: "subprocess",
  repoIndex: true,
};

export function loadConfig(overrides: Partial<CodemonConfig> = {}): CodemonConfig {
  let config: Partial<CodemonConfig> = {};

  // 1. Global config (~/.codemon/config.json or project root codemon.json)
  const globalConfigPath = path.join(os.homedir(), ".codemon", "config.json");
  if (fs.existsSync(globalConfigPath)) {
    try {
      config = { ...config, ...JSON.parse(fs.readFileSync(globalConfigPath, "utf8")) };
    } catch {}
  }

  // 2. Project config (.codemon/config.json in cwd)
  const projectConfigPath = path.join(process.cwd(), ".codemon", "config.json");
  if (fs.existsSync(projectConfigPath)) {
    try {
      config = { ...config, ...JSON.parse(fs.readFileSync(projectConfigPath, "utf8")) };
    } catch {}
  }

  // 3. CLI overrides win
  config = { ...config, ...overrides };

  return { ...DEFAULTS, ...config };
}
