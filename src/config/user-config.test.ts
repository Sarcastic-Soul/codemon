import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  loadUserConfig,
  saveUserConfig,
  setApiKey,
  removeApiKey,
  maskApiKey,
  getEffectiveApiKey,
  getUserConfigPath,
} from "./user-config.ts";

/**
 * Every test here writes credentials, and `saveUserConfig` replaces the whole
 * file — so without CODEMON_CONFIG_DIR pointed somewhere disposable, running the
 * suite wipes the real ~/.codemon/config.json and the keys stored in it.
 */
describe("User Config & API Key Security", () => {
  let userDir: string;
  let configPath: string;
  let savedConfigDir: string | undefined;
  let savedEnvKeys: Record<string, string | undefined> = {};

  const GOOGLE_ENV = ["GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "GOOGLE_API_KEY"];

  beforeEach(() => {
    savedConfigDir = process.env.CODEMON_CONFIG_DIR;
    userDir = fs.mkdtempSync(path.join(os.tmpdir(), "codemon-userconfig-"));
    process.env.CODEMON_CONFIG_DIR = userDir;
    configPath = getUserConfigPath();

    savedEnvKeys = {};
    for (const name of GOOGLE_ENV) {
      savedEnvKeys[name] = process.env[name];
      delete process.env[name];
    }
  });

  afterEach(() => {
    fs.rmSync(userDir, { recursive: true, force: true });

    if (savedConfigDir === undefined) delete process.env.CODEMON_CONFIG_DIR;
    else process.env.CODEMON_CONFIG_DIR = savedConfigDir;

    for (const name of GOOGLE_ENV) {
      const value = savedEnvKeys[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  test("maskApiKey formats keys securely showing last 4 chars", () => {
    expect(maskApiKey("AIzaSyD1234567890abcdef1a4f")).toBe("••••••••1a4f");
    expect(maskApiKey("1234")).toBe("••••");
    expect(maskApiKey("")).toBe("");
    expect(maskApiKey(undefined)).toBe("");
  });

  test("saveUserConfig writes file with 0600 permissions", () => {
    saveUserConfig({ defaultModel: "google:gemini-2.0-flash-exp" });
    expect(fs.existsSync(configPath)).toBe(true);

    const stat = fs.statSync(configPath);
    // Mask mode bits to 0o777 (owner, group, others permissions)
    const mode = stat.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("setApiKey and removeApiKey store and delete credentials", () => {
    setApiKey("testprovider", "secretkey12345");
    let loaded = loadUserConfig();
    expect(loaded.apiKeys?.testprovider).toBe("secretkey12345");

    removeApiKey("testprovider");
    loaded = loadUserConfig();
    expect(loaded.apiKeys?.testprovider).toBeUndefined();
  });

  test("getEffectiveApiKey respects precedence hierarchy (Env Var over Config File)", () => {
    setApiKey("google", "config-key-9999");
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;

    // With no env var, returns config key
    expect(getEffectiveApiKey("google")).toBe("config-key-9999");

    // With env var set, env var overrides config key
    process.env.GEMINI_API_KEY = "env-var-key-1111";
    expect(getEffectiveApiKey("google")).toBe("env-var-key-1111");

    // Cleanup
    removeApiKey("google");
  });
});
