# 📦 Distribution & Release Guide

This document describes how to build, package, and distribute Codemon as a standalone binary.

---

## Overview

Stage 10 ships Codemon as a **self-contained executable** via `bun build --compile`. The binary embeds the Bun runtime + all dependencies — no Node.js, npm, or bun install needed on the target machine.

---

## Quick Build

```bash
# Install dependencies
bun install

# Build for current platform (outputs to dist/codemon)
bun run build

# Install binary to PATH
bash scripts/install.sh
```

---

## How It Works

### `bun build --compile`

Bun's compiler embeds:
- The entire application source (transpiled)
- All `node_modules` dependencies
- The Bun runtime itself

Result: a single ~100MB ELF/Mach-O binary that runs anywhere on the target platform with no prerequisites.

### The `react-devtools-core` Stub

Ink's reconciler conditionally imports `react-devtools-core` only when `process.env.DEV === 'true'`. However Bun's bundler statically resolves all imports in referenced files. To fix this without adding the ~50MB devtools package:

- A stub `node_modules/react-devtools-core/index.js` exports a no-op object.
- `bunfig.toml` defines `process.env.DEV = 'false'` so the devtools code path is dead code.
- The stub is never called at runtime.

---

## Cross-Platform Builds

> [!NOTE]
> Cross-compilation requires Bun's cross-compile support (Bun >= 1.1.0 with target executor). On CI, native runners for each platform are used instead.

Build for all platforms:

```bash
bash scripts/build-all-platforms.sh
```

This produces binaries in `dist/release/v<version>/`:

| Binary | Platform |
|---|---|
| `codemon-linux-x64` | Linux x86_64 |
| `codemon-linux-arm64` | Linux ARM64 |
| `codemon-macos-x64` | macOS Intel |
| `codemon-macos-arm64` | macOS Apple Silicon |

---

## Release Process

### 1. Tag and Push

```bash
git tag v1.0.0
git push origin v1.0.0
```

### 2. GitHub Actions Release Workflow

The [release.yml](file:///media/anish-kumar/01DBC0C115A1D4B0/Projects/codemon/.github/workflows/release.yml) workflow triggers on version tags (`v*`) and:

1. Builds native binaries on `ubuntu-latest` and `macos-latest` runners.
2. Uploads all binaries as release artifacts.
3. Creates a GitHub Release with download links and install instructions.
4. Generates `SHA256SUMS` for integrity verification.

### 3. CI Workflow

The [ci.yml](file:///media/anish-kumar/01DBC0C115A1D4B0/Projects/codemon/.github/workflows/ci.yml) runs on every push/PR and:
- Type-checks with `tsc --noEmit`
- Builds the binary
- Verifies `./dist/codemon --help` exits cleanly

---

## Manual Installation

### From Binary

```bash
# Linux x64
curl -L https://github.com/your-org/codemon/releases/latest/download/codemon-linux-x64 -o codemon
chmod +x codemon
sudo mv codemon /usr/local/bin/
codemon --help
```

### From Source

```bash
git clone https://github.com/your-org/codemon.git
cd codemon
bun install
bun run build
bash scripts/install.sh
```

---

## Binary Size & Performance

| Metric | Value |
|---|---|
| Binary size | ~98 MB |
| Cold start | ~80ms |
| First LLM token | ~500ms (network latency) |

The binary is large because it bundles the Bun runtime. This is expected and a known trade-off of `bun --compile`. Future releases may explore lighter bundling strategies.
