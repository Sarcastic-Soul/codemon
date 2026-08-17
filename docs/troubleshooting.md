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

# OpenRouter — one key, hundreds of models
export OPENROUTER_API_KEY="your-api-key"
```

Each provider's key variable comes from the catalog, not from a list in the
source, so `/connector` is the authoritative answer for any provider not shown
here — it names the exact variable the one you picked expects.

### Error: `Unknown model format` or `Provider not supported`
**Cause**: The `--model` flag string did not follow the required `provider:model-name` format.

**Solution**: Ensure your model flag uses a valid provider prefix:
```bash
bun run dev -- --model google:gemini-flash-latest
bun run dev -- --model anthropic:claude-sonnet-5
bun run dev -- --model openai:gpt-5.1
bun run dev -- --model openrouter:anthropic/claude-sonnet-5
```

### Issue: A model you know exists is not offered by `/connector`
**Cause**: Providers and models come from the [models.dev](https://models.dev)
catalog. A snapshot ships inside the binary so a fresh or offline install works
immediately, and the live catalog refreshes in the background once a day — so a
model released since your snapshot is missing until that refresh lands.

**Solution**: It usually resolves itself on the next launch. `--model` never
validates against the catalog — the string is only split into provider and
model — so naming the model explicitly works in the meantime.

One side effect is worth knowing: the context window also comes from the
catalog, so a model it has not heard of falls back to a conservative default.
Compaction will then trigger earlier than the model actually requires. Set
`maxContextTokens` in your config to override it.

---

## 🔌 2. MCP Server Issues

### Issue: A declared server's tools never appear
**Cause**: Servers start in the background so a slow one cannot delay the
prompt, and a server that fails to start is skipped rather than taking the
session down with it. Both look identical from the chat view: nothing shows up.

**Solution**: Run with `--debug` and check the log for the skip:

```bash
codemon --debug
grep mcp ~/.codemon/debug.log
```

A server that failed logs `mcp: server failed to start — skipped` along with the
reason. The usual causes are a `command` that is not on `PATH`, a missing
argument, or an `env` entry referencing a variable that is not exported.

If the server started but its tools are still absent, remember that
`buildToolSet()` runs once per turn — a server finishing its handshake after the
first frame is offered on the **next** turn, not the current one.

### Issue: `${VAR}` in an MCP `env` block arrives empty
**Cause**: Unset variables expand to the empty string, deliberately. The
alternative is passing the literal `${VAR}` through to the server, which
authenticates as that string instead of failing — a much worse outcome, since it
fails somewhere far from the mistake.

**Solution**: Export the variable before launching, or put the value directly in
the config file. Note that `~/.codemon/config.json` is `0600`; a project
`codemon.json` is committed with the repo, so never put a secret there.

### Issue: An MCP tool prompts for permission every time
**Cause**: Remote tools default to the `network` level, which is confirmed in
every mode including `standard`. This is intentional — `standard` auto-allows
`write`, so filing remote tools there would let an unclassified one run silently
in the default mode.

**Solution**: Give the specific tool a level under that server's `permissions`
map, rather than lowering your whole mode:

```jsonc
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "permissions": { "get_file_contents": "read" }
    }
  }
}
```

### Issue: A server stops responding after a long session
**Cause**: Codemon captures each server's stderr rather than letting it inherit
the terminal, since a server logging mid-frame would paint over the TUI. A
server that writes a very large volume to stderr can fill that buffer.

**Solution**: Quiet the server's own logging if it has a verbosity flag, and
restart the session. This needs roughly 80KB of server stderr to trigger, so
most servers never reach it.

---

## 🤖 3. Headless Run Issues (`codemon run`)

### Issue: The run exits `3` and reports a denied tool
**Cause**: Not a bug — a run that needs confirmation is denied, because nothing
is watching to answer the prompt. A git hook that started running `rm` because
nobody was looking is exactly what this prevents.

**Solution**: If the run genuinely should be allowed to write or execute, opt in
explicitly:

```bash
codemon run "fix the failing test" --mode yolo
```

### Issue: The run exits `2` with a partial answer
**Cause**: It hit the `--max-turns` budget mid-task.

**Solution**: Raise the cap. Exit `2` is deliberately distinct from success so a
CI step can tell "finished" from "ran out of room".

### Issue: Parsing the output is picking up tool noise
**Cause**: Prose tool activity goes to stderr and the reply to stdout, but a
shell that merges them (`2>&1`) loses that separation.

**Solution**: Redirect only stdout, or use the event stream:

```bash
codemon run "summarise the diff" > answer.md      # reply only
codemon run "summarise the diff" --json | jq -c   # one JSON event per line
```

### Issue: A run with `--plan` exits `0` even though everything was blocked
**Cause**: Plan mode denials surface as tool errors, not permission requests, so
they do not set the denied exit code. The run genuinely completed — it just
could not change anything, which is what plan mode is for.

**Solution**: Do not use `--plan` in a CI step whose purpose is to make changes.
Use it for review and analysis jobs, where reading the answer is the point.

---

## 📦 4. TypeScript & Build Issues

### Error: `bun install` and `npm install` disagree, or a lockfile conflict appears
**Cause**: Bun is the package manager here and `bun.lock` is the lockfile. An
`npm install` writes a `package-lock.json` that can resolve different versions
than the ones CI installs, so the build stops matching what was tested.

**Solution**: `package-lock.json`, `yarn.lock` and `pnpm-lock.yaml` are
gitignored. If one appeared locally, delete it and re-run `bun install`.

### Error: `Could not resolve: "react-devtools-core"` during `bun run build`
**Cause**: Missing optional development dependency required by `ink` when building standalone compiled binaries with Bun.

**Solution**: Install missing dev dependency or run in development mode with `bun run dev`:
```bash
bun add -d react-devtools-core
```

---

## 🐳 5. Docker Sandbox Issues (`--sandbox docker`)

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

## 💾 6. Pokédex SQLite Database & Session Issues

### Issue: Want to undo file edits from a previous session
**Solution**: Use the `--rewind` flag to restore files to their pre-session state recorded in SQLite checkpoints:
```bash
bun run dev -- --rewind
```

### Issue: Database file locked or corrupted
**Cause**: Unexpected crash or multi-process lock on `.codemon/sessions.db`.

**Solution**:
1. Check if another Codemon process is running:
   ```bash
   ps aux | grep codemon
   ```
2. Run an integrity check to verify if the SQLite database is recoverable:
   ```bash
   sqlite3 .codemon/sessions.db "PRAGMA integrity_check;"
   ```
3. If SQLite reports unrecoverable corruption, back up and reset the database:
   ```bash
   mv .codemon/sessions.db .codemon/sessions.db.bak
   ```
   The next launch recreates it. Journalling is WAL, so `.codemon/sessions.db-wal`
   and `-shm` may sit beside it while Codemon is running; move those too.

---

## 🐞 7. Enabling Debug Logs

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
