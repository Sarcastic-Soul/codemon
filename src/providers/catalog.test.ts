import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  trimCatalog,
  seedCatalog,
  loadCatalog,
  resetCatalogCache,
  getProviderEnvVars,
  parseModelString,
  resolveContextWindow,
  listCatalogProviders,
  type Catalog,
} from "./catalog.ts";
import { isProviderSupported, FACTORIES, KNOWN_BASE_URLS } from "./factories.ts";
import { listAvailableProviders, resolveProviderEntry, listModelsFor } from "./resolve.ts";
import { getEffectiveApiKey, getEndpointOverride, saveUserConfig } from "../config/user-config.ts";
import { DEFAULTS, loadConfig, effectiveContextTokens, FALLBACK_CONTEXT_TOKENS } from "../config/defaults.ts";

let userDir: string;
let projectRoot: string;
let savedConfigDir: string | undefined;

beforeEach(() => {
  savedConfigDir = process.env.CODEMON_CONFIG_DIR;
  userDir = fs.mkdtempSync(path.join(os.tmpdir(), "codemon-catalog-"));
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codemon-catproj-"));
  process.env.CODEMON_CONFIG_DIR = userDir;
  resetCatalogCache();
});

afterEach(() => {
  fs.rmSync(userDir, { recursive: true, force: true });
  fs.rmSync(projectRoot, { recursive: true, force: true });
  if (savedConfigDir === undefined) delete process.env.CODEMON_CONFIG_DIR;
  else process.env.CODEMON_CONFIG_DIR = savedConfigDir;
  resetCatalogCache();
});

describe("trimCatalog", () => {
  test("keeps the fields Codemon reads and drops the prose", () => {
    const trimmed = trimCatalog({
      anthropic: {
        id: "anthropic",
        name: "Anthropic",
        env: ["ANTHROPIC_API_KEY"],
        npm: "@ai-sdk/anthropic",
        doc: "https://docs.anthropic.com",
        models: {
          "claude-sonnet-5": {
            id: "claude-sonnet-5",
            name: "Claude Sonnet 5",
            description: "prose we do not need",
            family: "claude-sonnet",
            limit: { context: 1_000_000, output: 128_000 },
            cost: { input: 3, output: 15 },
            tool_call: true,
          },
        },
      },
    });

    const anthropic = trimmed.anthropic!;
    expect(anthropic.env).toEqual(["ANTHROPIC_API_KEY"]);
    expect(anthropic.npm).toBe("@ai-sdk/anthropic");

    const model = anthropic.models["claude-sonnet-5"]!;
    expect(model.limit?.context).toBe(1_000_000);
    expect(model.cost?.input).toBe(3);
    expect(model.tool_call).toBe(true);
    expect(model).not.toHaveProperty("description");
    expect(model).not.toHaveProperty("family");
  });

  test("a reshaped entry is skipped rather than taking the catalog down", () => {
    // The upstream feed is third-party; one bad entry must not cost us the rest.
    const trimmed = trimCatalog({
      broken: null,
      alsobroken: "not an object",
      good: { id: "good", name: "Good", env: [], models: { m: { id: "m", name: "M" } } },
    });

    expect(Object.keys(trimmed)).toEqual(["good"]);
    expect(trimmed.good!.models.m!.id).toBe("m");
  });

  test("missing optional fields stay undefined rather than becoming junk", () => {
    const trimmed = trimCatalog({
      sparse: { id: "sparse", models: { m: { id: "m", limit: {}, cost: {} } } },
    });

    const provider = trimmed.sparse!;
    expect(provider.name).toBe("sparse"); // falls back to the id
    expect(provider.env).toEqual([]);
    expect(provider.api).toBeUndefined();
    expect(provider.models.m!.limit).toBeUndefined();
    expect(provider.models.m!.cost).toBeUndefined();
  });
});

describe("seedCatalog", () => {
  const full: Catalog = {
    anthropic: {
      id: "anthropic",
      name: "Anthropic",
      env: [],
      npm: "@ai-sdk/anthropic",
      models: { a: { id: "a", name: "A" } },
    },
    obscure: {
      id: "obscure",
      name: "Obscure",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      api: "https://obscure.example/v1",
      models: { b: { id: "b", name: "B" } },
    },
  };

  test("every provider keeps its metadata, only bundled ones keep models", () => {
    const seed = seedCatalog(full, new Set(["@ai-sdk/anthropic"]));

    expect(Object.keys(seed).sort()).toEqual(["anthropic", "obscure"]);
    expect(Object.keys(seed.anthropic!.models)).toEqual(["a"]);
    // Still connectable offline — just no browsable list until the first refresh.
    expect(seed.obscure!.models).toEqual({});
    expect(seed.obscure!.api).toBe("https://obscure.example/v1");
  });
});

describe("the bundled snapshot", () => {
  test("carries the whole provider list, not just the ones we have factories for", () => {
    const providers = listCatalogProviders();
    expect(providers.length).toBeGreaterThan(100);

    for (const id of ["google", "anthropic", "openai", "mistral", "openrouter", "deepseek"]) {
      expect(loadCatalog()[id], `${id} missing from snapshot`).toBeDefined();
    }
  });

  test("all but a handful of providers are reachable with what we bundle", () => {
    const providers = listCatalogProviders();
    const reachable = providers.filter((p) => isProviderSupported(p));

    // The rest need a vendor SDK (Bedrock, Vertex, Azure) and say so when picked.
    expect(reachable.length / providers.length).toBeGreaterThan(0.85);
  });

  test("every provider a bundled factory drives has models seeded", () => {
    for (const provider of listCatalogProviders()) {
      if (provider.npm && FACTORIES[provider.npm]) {
        expect(Object.keys(provider.models).length, `${provider.id} has no models`).toBeGreaterThan(0);
      }
    }
  });

  test("the KNOWN_BASE_URLS entries are all providers that actually need one", () => {
    // If upstream adds an `api` for one of these, the hardcoded URL is dead
    // weight and should be dropped rather than left to drift.
    for (const id of Object.keys(KNOWN_BASE_URLS)) {
      const entry = loadCatalog()[id];
      if (!entry) continue;
      expect(entry.api, `${id} now publishes its own api — drop it from KNOWN_BASE_URLS`).toBeUndefined();
    }
  });
});

describe("parseModelString", () => {
  test("splits on the first separator only", () => {
    expect(parseModelString("anthropic:claude-sonnet-5")).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-5",
    });
    // Model ids contain both separators; a naive replace mangled these.
    expect(parseModelString("openrouter:anthropic/claude-sonnet-5")).toEqual({
      provider: "openrouter",
      model: "anthropic/claude-sonnet-5",
    });
    expect(parseModelString("ollama:qwen3-coder:30b")).toEqual({
      provider: "ollama",
      model: "qwen3-coder:30b",
    });
  });

  test("accepts the legacy slash form and a bare model name", () => {
    expect(parseModelString("google/gemini-2.5-pro")).toEqual({
      provider: "google",
      model: "gemini-2.5-pro",
    });
    expect(parseModelString("gemini-2.5-pro")).toEqual({
      provider: "google",
      model: "gemini-2.5-pro",
    });
  });

  test("normalises provider case and surrounding space", () => {
    expect(parseModelString("  OpenAI:gpt-4o  ")).toEqual({ provider: "openai", model: "gpt-4o" });
  });
});

describe("getProviderEnvVars", () => {
  test("comes from the catalog, so all of Google's aliases are honoured", () => {
    const vars = getProviderEnvVars("google");
    expect(vars).toContain("GEMINI_API_KEY");
    expect(vars).toContain("GOOGLE_GENERATIVE_AI_API_KEY");
  });

  test("an unknown provider still gets a derived name to configure it by", () => {
    expect(getProviderEnvVars("my-local-thing")).toEqual(["MY_LOCAL_THING_API_KEY"]);
  });
});

describe("custom providers", () => {
  test("a hand-declared provider is connectable and brings its own models", () => {
    saveUserConfig({
      providers: {
        ollama: {
          name: "Ollama (local)",
          api: "http://127.0.0.1:11434/v1",
          models: ["qwen3-coder:30b"],
        },
      },
    });

    const entry = resolveProviderEntry("ollama")!;
    expect(entry.name).toBe("Ollama (local)");
    expect(entry.npm).toBe("@ai-sdk/openai-compatible");
    expect(isProviderSupported(entry, getEndpointOverride("ollama"))).toBe(true);
    expect(listModelsFor("ollama")).toEqual(["qwen3-coder:30b"]);

    expect(listAvailableProviders().some((p) => p.id === "ollama")).toBe(true);
  });

  test("its key is read from the derived env var without any code change", () => {
    saveUserConfig({ providers: { ollama: { api: "http://127.0.0.1:11434/v1" } } });

    process.env.OLLAMA_API_KEY = "local-key";
    try {
      expect(getEffectiveApiKey("ollama")).toBe("local-key");
    } finally {
      delete process.env.OLLAMA_API_KEY;
    }
  });

  test("pointing a catalogued provider at a proxy keeps its model list", () => {
    saveUserConfig({ endpoints: { anthropic: "http://localhost:8080/v1" } });

    expect(getEndpointOverride("anthropic")).toBe("http://localhost:8080/v1");
    expect(listModelsFor("anthropic").length).toBeGreaterThan(0);
  });
});

describe("context window sizing", () => {
  test("a known model gets its own window, with the reply budget reserved", () => {
    const context = loadCatalog().anthropic?.models["claude-sonnet-5"]?.limit?.context;
    if (!context) return; // snapshot moved on; the fallback test below still covers it

    expect(resolveContextWindow("anthropic:claude-sonnet-5", 8192, 100_000)).toBe(context - 8192);
  });

  test("an unknown model falls back rather than guessing", () => {
    expect(resolveContextWindow("nowhere:no-such-model", 8192, 100_000)).toBe(100_000);
  });

  test("an output budget larger than the window cannot drive it to zero", () => {
    // A hand-written maxTokens bigger than the context would otherwise leave a
    // negative budget and truncate every message away.
    const window = resolveContextWindow("anthropic:claude-sonnet-5", 10_000_000, 100_000);
    expect(window).toBeGreaterThan(0);
  });

  test("loadConfig leaves the budget on auto, and it resolves per model", () => {
    const config = loadConfig({}, { projectRoot });
    expect(config.maxContextTokens).toBe(0); // auto

    const wide = effectiveContextTokens(config, "anthropic:claude-sonnet-5");
    const unknown = effectiveContextTokens(config, "nowhere:no-such-model");

    expect(unknown).toBe(FALLBACK_CONTEXT_TOKENS);
    expect(wide).toBeGreaterThan(FALLBACK_CONTEXT_TOKENS);
  });

  test("an explicit setting wins, including after a model switch", () => {
    // Someone who caps the budget to control spend must not have it silently
    // widened when /connector moves them to a bigger model.
    const config = loadConfig({ maxContextTokens: 50_000 }, { projectRoot });

    expect(effectiveContextTokens(config)).toBe(50_000);
    expect(effectiveContextTokens(config, "anthropic:claude-sonnet-5")).toBe(50_000);
  });

  test("DEFAULTS still declares a usable fallback", () => {
    expect(DEFAULTS.maxContextTokens).toBe(0);
    expect(FALLBACK_CONTEXT_TOKENS).toBeGreaterThan(0);
  });
});
