/**
 * Provider singleton — allows tools to access the current LLM provider
 * without it being threaded through every function call.
 * Set once at startup in index.tsx.
 */
import type { Provider } from "../providers/types.ts";
import type { CodemonConfig } from "../config/defaults.ts";

let _provider: Provider | null = null;
let _config: CodemonConfig | null = null;

export function setCurrentProvider(provider: Provider, config: CodemonConfig): void {
  _provider = provider;
  _config = config;
}

export function getCurrentProvider(): Provider {
  if (!_provider) throw new Error("Provider not initialized. Call setCurrentProvider first.");
  return _provider;
}

export function getCurrentConfig(): CodemonConfig {
  if (!_config) throw new Error("Config not initialized. Call setCurrentProvider first.");
  return _config;
}
