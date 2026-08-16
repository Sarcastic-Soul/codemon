import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { loadConfig, DEFAULTS } from "./defaults.ts";
import { setDefaultModel, setApiKey } from "./user-config.ts";

/**
 * Every tier of the precedence chain is a file, so each test gets a throwaway
 * home (via CODEMON_CONFIG_DIR) and project root, never the real ~/.codemon.
 */
let userDir: string;
let projectRoot: string;
let savedConfigDir: string | undefined;
let savedModelEnv: string | undefined;

function writeJson(file: string, data: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

const userConfig = () => path.join(userDir, "config.json");
const rootConfig = () => path.join(projectRoot, "codemon.json");
const localConfig = () => path.join(projectRoot, ".codemon", "config.json");

beforeEach(() => {
  savedConfigDir = process.env.CODEMON_CONFIG_DIR;
  savedModelEnv = process.env.CODEMON_MODEL;
  delete process.env.CODEMON_MODEL;

  userDir = fs.mkdtempSync(path.join(os.tmpdir(), "codemon-home-"));
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codemon-proj-"));
  process.env.CODEMON_CONFIG_DIR = userDir;
});

afterEach(() => {
  fs.rmSync(userDir, { recursive: true, force: true });
  fs.rmSync(projectRoot, { recursive: true, force: true });

  if (savedConfigDir === undefined) delete process.env.CODEMON_CONFIG_DIR;
  else process.env.CODEMON_CONFIG_DIR = savedConfigDir;
  if (savedModelEnv === undefined) delete process.env.CODEMON_MODEL;
  else process.env.CODEMON_MODEL = savedModelEnv;
});

describe("model persistence (issue 19)", () => {
  test("the key /connector writes is the key loadConfig reads", () => {
    // This is the whole bug: setDefaultModel wrote `defaultModel`, loadConfig
    // read `model`, and the choice evaporated on the next launch.
    setDefaultModel("anthropic:claude-sonnet-4-5");

    expect(JSON.parse(fs.readFileSync(userConfig(), "utf8")).defaultModel).toBe(
      "anthropic:claude-sonnet-4-5",
    );
    expect(loadConfig({}, { projectRoot }).model).toBe("anthropic:claude-sonnet-4-5");
  });

  test("an explicit `model` key in the same file still wins over the alias", () => {
    writeJson(userConfig(), { model: "openai:gpt-4o", defaultModel: "mistral:mistral-large-latest" });

    expect(loadConfig({}, { projectRoot }).model).toBe("openai:gpt-4o");
  });

  test("--model and CODEMON_MODEL both outrank the stored choice", () => {
    setDefaultModel("anthropic:claude-sonnet-4-5");

    process.env.CODEMON_MODEL = "openai:gpt-4o";
    expect(loadConfig({}, { projectRoot }).model).toBe("openai:gpt-4o");

    expect(loadConfig({ model: "mistral:mistral-large-latest" }, { projectRoot }).model).toBe(
      "mistral:mistral-large-latest",
    );
  });

  test("no config anywhere falls back to the built-in default", () => {
    expect(loadConfig({}, { projectRoot }).model).toBe(DEFAULTS.model);
  });
});

describe("credentials stay out of the runtime config (issue 20)", () => {
  test("apiKeys and endpoints are not copied into CodemonConfig", () => {
    setApiKey("anthropic", "sk-secret-1234");
    writeJson(userConfig(), {
      ...JSON.parse(fs.readFileSync(userConfig(), "utf8")),
      endpoints: { custom: "http://localhost:11434" },
    });

    const config = loadConfig({}, { projectRoot }) as unknown as Record<string, unknown>;

    expect(config.apiKeys).toBeUndefined();
    expect(config.endpoints).toBeUndefined();
    expect(JSON.stringify(config)).not.toContain("sk-secret-1234");
  });

  test("unknown keys and wrong-typed values are ignored rather than passed through", () => {
    writeJson(userConfig(), { maxTokens: "8192", nonsense: true, repoIndex: false });

    const config = loadConfig({}, { projectRoot }) as unknown as Record<string, unknown>;

    expect(config.maxTokens).toBe(DEFAULTS.maxTokens); // string rejected
    expect(config.nonsense).toBeUndefined();
    expect(config.repoIndex).toBe(false); // correctly typed key still applies
  });

  test("a malformed config file does not take the process down", () => {
    fs.mkdirSync(path.dirname(userConfig()), { recursive: true });
    fs.writeFileSync(userConfig(), "{ not json");

    expect(loadConfig({}, { projectRoot }).model).toBe(DEFAULTS.model);
  });
});

describe("project-root codemon.json (issue 22)", () => {
  test("is read, and outranks the user-level config", () => {
    writeJson(userConfig(), { maxTokens: 1000, timeout: 111 });
    writeJson(rootConfig(), { maxTokens: 2000 });

    const config = loadConfig({}, { projectRoot });

    expect(config.maxTokens).toBe(2000);
    expect(config.timeout).toBe(111); // untouched keys still come from below
  });

  test(".codemon/config.json outranks codemon.json, and flags outrank both", () => {
    writeJson(rootConfig(), { maxTokens: 2000, permissionMode: "safe" });
    writeJson(localConfig(), { maxTokens: 3000 });

    expect(loadConfig({}, { projectRoot }).maxTokens).toBe(3000);
    expect(loadConfig({}, { projectRoot }).permissionMode).toBe("safe");
    expect(loadConfig({ maxTokens: 4000 }, { projectRoot }).maxTokens).toBe(4000);
  });

  test("project config is read from the region, not the launch directory", () => {
    // `--region` moves the project; loading from cwd read the wrong one.
    writeJson(rootConfig(), { maxTokens: 2000 });
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "codemon-cwd-"));
    const previousCwd = process.cwd();

    try {
      process.chdir(elsewhere);
      expect(loadConfig({}, { projectRoot }).maxTokens).toBe(2000);
    } finally {
      process.chdir(previousCwd);
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  test("an explicitly undefined override does not clobber a configured value", () => {
    writeJson(rootConfig(), { model: "openai:gpt-4o" });

    expect(loadConfig({ model: undefined }, { projectRoot }).model).toBe("openai:gpt-4o");
  });
});
