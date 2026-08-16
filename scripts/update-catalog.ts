#!/usr/bin/env bun
/**
 * Regenerates `src/providers/catalog.snapshot.ts` from models.dev — the offline
 * seed a fresh install reads before the first refresh lands.
 *
 *   bun run catalog:update
 *
 * Keeping only the fields Codemon reads, and model lists only for bundled
 * factories, takes ~3.8 MB down to ~270 KB. Emitted as a `.ts` module holding
 * one JSON string so it survives `bun build --compile` without asset plumbing.
 */
import * as fs from "fs";
import * as path from "path";
import { CATALOG_URL, trimCatalog, seedCatalog, type RawCatalog } from "../src/providers/catalog.ts";
import { BUNDLED_PACKAGES } from "../src/providers/factories.ts";

const OUT = path.join(import.meta.dir, "..", "src", "providers", "catalog.snapshot.ts");

const res = await fetch(CATALOG_URL, { signal: AbortSignal.timeout(30_000) });
if (!res.ok) {
  console.error(`❌ ${CATALOG_URL} responded ${res.status} ${res.statusText}`);
  process.exit(1);
}

const full = trimCatalog((await res.json()) as RawCatalog);

// A truncated or reshaped response would otherwise overwrite a good snapshot
// with one that silently drops most providers.
if (Object.keys(full).length < 50) {
  console.error(`❌ Refusing to write: only ${Object.keys(full).length} providers parsed, expected 50+.`);
  process.exit(1);
}

const seed = seedCatalog(full, BUNDLED_PACKAGES);

const providerCount = Object.keys(seed).length;
const withModels = Object.values(seed).filter((p) => Object.keys(p.models).length > 0);
const modelCount = withModels.reduce((n, p) => n + Object.keys(p.models).length, 0);

const banner = `/**
 * GENERATED FILE — do not edit.
 *
 * Offline seed of the models.dev catalog. Regenerate with:
 *   bun run catalog:update
 *
 * ${providerCount} providers; model lists for the ${withModels.length} driven by a bundled factory.
 * Everything else fills in on the first background refresh.
 */
`;

fs.writeFileSync(
  OUT,
  `${banner}export const SNAPSHOT_JSON: string = ${JSON.stringify(JSON.stringify(seed))};\n`,
  "utf8",
);

const kb = (fs.statSync(OUT).size / 1024).toFixed(0);
console.log(`✅ ${path.relative(process.cwd(), OUT)}`);
console.log(`   ${providerCount} providers, ${modelCount} seeded models, ${kb} KB`);
