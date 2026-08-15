# 🛠️ Troubleshooting & FAQ

This document covers common issues, error messages, and solutions when configuring, building, or using Codemon.

---

## 🔑 1. API Key & Provider Issues

### Error: `Missing API Key for provider <name>`
**Cause**: The requested model provider key environment variable is not exported and no stored key exists in `~/.codemon/config.json`.

**Solution**:
1. **Interactive (Recommended)**: Inside the running TUI, type `/connector` and press Enter. Select your provider and paste your API key. It will be stored securely in `~/.codemon/config.json` with `0600` POSIX mode permissions.
2. **Environment Variable**: Alternatively, export the appropriate key in your terminal session before starting Codemon:

```bash
# Google Gemini
export GEMINI_API_KEY="your-api-key"

# Anthropic Claude
export ANTHROPIC_API_KEY="your-api-key"

# OpenAI
export OPENAI_API_KEY="your-api-key"

# Mistral
export MISTRAL_API_KEY="your-api-key"
```

### Error: `Unknown model format` or `Provider not supported`
**Cause**: The `--model` flag string did not follow the required `provider:model-name` format.

**Solution**: Ensure your model flag uses a valid provider prefix:
```bash
bun run dev -- --model google:gemini-2.0-flash-exp
bun run dev -- --model anthropic:claude-sonnet-4-5
bun run dev -- --model openai:gpt-4o
bun run dev -- --model mistral:mistral-large-latest
```

---

## 📦 2. TypeScript & Build Issues

### Error: `Cannot find module './registry.ts' or its corresponding type declarations`
**Cause**: Circular type dependency resolution loop in TypeScript when loading move definitions.

**Solution**: Move interface definitions out of `registry.ts` into `types.ts`. Import `MoveDefinition` directly from `src/moves/types.ts`. (This is already resolved in recent codebase builds).

### Error: `Could not resolve: "react-devtools-core"` during `bun run build`
**Cause**: Missing optional development dependency required by `ink` when building standalone compiled binaries with Bun.

**Solution**: Install missing dev dependency or run in development mode with `bun run dev`:
```bash
bun add -d react-devtools-core
```

---

## 🐳 3. Docker Sandbox Issues (`--sandbox docker`)

### Error: `Docker daemon is not running` or `Cannot connect to the Docker daemon`
**Cause**: Docker service is stopped or the current user lacks permission to access `/var/run/docker.sock`.

**Solution**:
1. Start the Docker daemon:
   ```bash
   sudo systemctl start docker
   ```
2. Verify current user permissions:
   ```bash
   sudo usermod -aG docker $USER
   # Restart terminal session or run:
   newgrp docker
   ```
3. Fall back to subprocess mode if Docker is unavailable:
   ```bash
   bun run dev -- --sandbox subprocess
   ```

---

## 💾 4. Pokédex SQLite Database & Session Issues

### Issue: Want to undo file edits from a previous session
**Solution**: Use the `--rewind` flag to restore files to their pre-session state recorded in SQLite checkpoints:
```bash
bun run dev -- --rewind
```

### Issue: Database file locked or corrupted
**Cause**: Unexpected crash or multi-process lock on `.codemon/pokedex.db`.

**Solution**:
1. Check if another Codemon process is running:
   ```bash
   ps aux | grep codemon
   ```
2. Run an integrity check to verify if the SQLite database is recoverable:
   ```bash
   sqlite3 .codemon/pokedex.db "PRAGMA integrity_check;"
   ```
3. If SQLite reports unrecoverable corruption, back up and reset the database:
   ```bash
   mv .codemon/pokedex.db .codemon/pokedex.db.bak
   ```

---

## 🐞 5. Enabling Debug Logs

If you encounter unexpected agent behavior or tool call failures, run Codemon with the `--debug` flag:

```bash
bun run dev -- --debug
```

Debug logs will be streamed to:
`~/.codemon/debug.log`

Inspect logs in real-time in another terminal:
```bash
tail -f ~/.codemon/debug.log
```
