import * as os from "os";
import * as path from "path";

/**
 * Where user-level state lives: credentials, the model `/connector` last chose,
 * and the cached model catalog. Kept apart from `user-config.ts` so the catalog
 * can find this directory without forming an import cycle. `CODEMON_CONFIG_DIR`
 * overrides it, resolved per call so a later override still applies.
 */
export function getUserConfigDir(): string {
  const override = process.env.CODEMON_CONFIG_DIR?.trim();
  return override ? path.resolve(override) : path.join(os.homedir(), ".codemon");
}

export function getUserConfigPath(): string {
  return path.join(getUserConfigDir(), "config.json");
}

/** Cache written by `refreshCatalog()`; seeded from the bundled snapshot. */
export function getCatalogCachePath(): string {
  return path.join(getUserConfigDir(), "model-catalog.json");
}
