# 🏗️ Codemon Architecture & Design Guide

This document details the internal architecture, component design, data flow, and security boundaries of Codemon.

---

## 📐 System Overview

Codemon is an agentic AI coding partner built on Node/Bun, TypeScript, React Ink TUI, and Vercel AI SDK v7. It maps AI development concepts onto a Pokémon-inspired domain model:

- **Codemon**: The underlying Large Language Model (e.g. Gemini, Claude, GPT-4o, Mistral).
- **Moves**: Tools made available to the LLM (`read_file`, `edit_file`, `bash`, etc.).
- **Poké Ball**: Security permission gate (`safe`, `standard`, `yolo`) controlling move execution.
- **Region**: Project root workspace enforceably jailed by the Safari Zone.
- **Pokédex**: SQLite database for session history, message history, and file modification checkpoints.
- **Party Members**: Isolated sub-agents spawned for delegation tasks.

---

## 📊 Architecture Diagram

```mermaid
flowchart TD
    User(["User / Terminal"]) <--> TUI["Ink React TUI<br/>src/cli/app.tsx"]
    TUI <--> Loop["Agent Loop<br/>src/core/agent-loop.ts"]

    Loop <--> Context["Context Manager<br/>src/core/context-manager.ts"]
    Loop <--> Provider["Provider Registry & AI SDK<br/>src/providers/registry.ts"]
    Provider <--> LLM["LLM Provider API<br/>Gemini / Claude / OpenAI / Mistral"]

    Loop --> Gate["Poké Ball Gate<br/>src/permissions/gate.ts"]
    Gate -- "check rules" --> Rules["Permission Rules<br/>src/permissions/rules.ts"]
    Gate -- "ask user" --> TUI
    Gate -- "record decision" --> Audit["Audit Trail<br/>src/permissions/audit-log.ts"]

    Gate -- "approved" --> Moves["Moves Registry<br/>src/tools/registry.ts"]
    Moves --> Jail["Path Jail<br/>src/sandbox/path-jail.ts"]
    Moves --> Shell["Shell Executor<br/>src/sandbox/shell-executor.ts"]
    Shell --> Docker["Docker Sandbox<br/>src/sandbox/docker-executor.ts"]

    Loop <--> Session["Session State<br/>src/core/session.ts"]
    Session <--> Store["Repositories<br/>src/storage/*.repo.ts"]
    Audit --> Store
    Store <--> DB[("SQLite<br/>.codemon/sessions.db")]

    Moves --> Party["Sub-Agents<br/>src/tools/spawn-subagent.ts"]
    Party -- "isolated loop, depth 1" --> Loop
```

---

## 🧩 Core Subsystems

### 1. Ink TUI Layer (`src/cli/`)
- **[index.tsx](../src/cli/index.tsx)**: Entry point — resolves the region, loads config, initializes the session database, runs the flag subcommands (`--sessions`, `--audit`, `--rewind`, `--eval`), and renders the Ink React app.
- **[parse-args.ts](../src/cli/parse-args.ts)**: The flag table and the usage text, together so they cannot drift. Every flag declares whether it takes a value; a missing value, an unknown flag, or an invalid `--mode`/`--sandbox` is rejected here, before anything starts up.
- **[app.tsx](../src/cli/app.tsx)**: Main React state container managing the message list, tool call UI, diff previews, and permission prompts.
- **[components/](../src/cli/components/)** and **[commands/](../src/cli/commands/)**: Rendered pieces of the interface, and the slash commands (`/connector`, `/help`, `/clear`, …) the input line dispatches against.

### 2. Agent Loop (`src/core/agent-loop.ts`)
The [agent loop](../src/core/agent-loop.ts) drives one user message to completion:
1. Accepts the user prompt plus repository context from [repo-indexer.ts](../src/core/repo-indexer.ts).
2. Sends history + tool definitions to the LLM via `streamText()`, after [context-manager.ts](../src/core/context-manager.ts) decides where the history would be cut, on turn boundaries, if it is near the budget. When it is, [compaction.ts](../src/core/compaction.ts) summarises the turns about to be dropped and sends the summary in their place.
3. Intercepts generated tool calls before execution, and rejects any name outside the caller's tool filter.
4. Routes each requested move through the Poké Ball Gate for permission validation.
5. Saves a file checkpoint before executing a file-modifying move (`edit_file`, `write_file`).
6. Executes approved moves and feeds the results back into the stream.
7. Stops at `maxTurns` (default 25) with a visible message, so a retry spiral cannot run unbounded.

Startup — project root, config, database, gitignore, provider — lives in
[bootstrap.ts](../src/core/bootstrap.ts) rather than in the TUI entry point, so
[headless.ts](../src/cli/headless.ts) gets the same agent without pulling in Ink. The system prompt
both front ends build comes from [system-prompt.ts](../src/core/system-prompt.ts).

Session state — messages, model, cumulative prompt/completion tokens — lives in
[session.ts](../src/core/session.ts); the provider instance the loop streams through lives in
[provider-instance.ts](../src/core/provider-instance.ts).

### 3. Poké Ball Permission Gate (`src/permissions/`)
- **[rules.ts](../src/permissions/rules.ts)**: Defines explicit permission matrices for security modes:
  - **`safe`**: `autoAllow: ["read"]`, `requireConfirm: ["write", "bash", "network"]` — prompts user before modifying any files, executing shell commands, or reaching outside the machine.
  - **`standard`** (default): `autoAllow: ["read", "write"]`, `requireConfirm: ["bash", "network"]` — auto-allows direct file edits/writes within the project root, but prompts before shell commands and remote calls.
  - **`yolo`**: `autoAllow: ["read", "write", "bash", "network"]` — auto-approves all moves without prompts.
  - An unrecognised mode falls through to confirming everything rather than throwing, so a hand-edited config file cannot take the gate down.
  - `network` is its own level rather than a reuse of `write` precisely because `standard` auto-allows `write`: an unclassified remote tool filed there would execute silently in the default mode, which is the opposite of failing closed.
- **[gate.ts](../src/permissions/gate.ts)**: Evaluates requested move operations against mode rules and session-level "Always allow" grants. If authorization is required, it suspends execution and prompts the user via TUI.
- **Plan mode** is checked *before* the "Always allow" set, not after. The grants are consulted first in the normal path, so a plan check placed after them would be walked straight past by any tool the user had previously blanket-approved — which is the one guarantee plan mode is selling.
- **[plan-allowlist.ts](../src/permissions/plan-allowlist.ts)**: The read-only shell commands plan mode still permits. Deliberately blunt — any shell metacharacter denies the whole command, with no attempt to parse a pipeline and allow the safe half. `git log | tee evil.txt` is a write.
- **[audit-log.ts](../src/permissions/audit-log.ts)**: Records every decision — including auto-allows — to the `permission_decisions` table via [audit.repo.ts](../src/storage/audit.repo.ts). Read it back with `codemon --audit [session-id]`.

### 4. Moves System & Decoupled Types (`src/tools/`)
- **[types.ts](../src/tools/types.ts)**: Defines the core tool interface contract (`ToolDefinition`).
- **[registry.ts](../src/tools/registry.ts)**: The live registry, and the conversion to Vercel AI SDK `ToolSet` schema objects (`buildToolSet()`). A mutable Map rather than a const array, because MCP servers register their tools after startup; `buildToolSet()` runs once per agent turn, so a server that comes up late is offered on the next turn without a restart. `registerTool` refuses to shadow a built-in — a remote server that could redefine `bash` would be a permission bypass wearing a familiar name.
- **The ten built-in moves**: [read_file](../src/tools/read-file.ts), [write_file](../src/tools/write-file.ts), [edit_file](../src/tools/edit-file.ts), [list_dir](../src/tools/list-dir.ts), [bash](../src/tools/bash.ts), [grep](../src/tools/grep.ts), [glob](../src/tools/glob.ts), [spawn_subagent](../src/tools/spawn-subagent.ts), [todo_write](../src/tools/todo.ts), [web_fetch](../src/tools/web-fetch.ts).
- **[todo.ts](../src/tools/todo.ts)** takes the whole list on every call and replaces the stored one. Incremental add/complete operations need stable ids the model has to track across turns, and it gets them wrong; replacement is idempotent and self-correcting. State lives in [todo-store.ts](../src/core/todo-store.ts).
- **[web-fetch.ts](../src/tools/web-fetch.ts)** validates the target *after* DNS resolution and again on every redirect hop. A hostname blocklist cannot see `evil.com` resolving to `127.0.0.1`, and `169.254.169.254` is a cloud credential rather than a web page.
- **[diff-apply.ts](../src/utils/diff-apply.ts)**: The matcher behind `edit_file`. Exact match first — refusing when the target appears more than once — then a fuzzy pass that refuses when a second block scores nearly as well, rather than picking one.

### 5. Safari Zone Sandboxing (`src/sandbox/`)
- **Path Jail ([path-jail.ts](../src/sandbox/path-jail.ts))**: Validates path parameters for structured file moves (`read_file`, `write_file`, `edit_file`, `list_dir`, `grep`, `glob`). Resolves symlinks before comparing against the project root, so a link pointing outside the region does not pass on the strength of its in-root name.
- **Default Subprocess Execution ([shell-executor.ts](../src/sandbox/shell-executor.ts))**: `bash` commands run as host OS subprocesses within the working directory. `shellExec` is the `bash -c` path and exists for the `bash` tool alone; every other caller uses `shellExecArgv`, which spawns an argv array with no shell between it and the process. **Security Boundary Note**: `jailPath()` does not parse or sanitize raw shell strings (e.g. `rm -rf ~`, `cd ..`). By default, human approval via the Poké Ball Gate is the boundary between the model and host filesystem.
- **Docker Container Isolation ([docker-executor.ts](../src/sandbox/docker-executor.ts))**: When `--sandbox docker` is specified, `bash` commands run inside an isolated container (`codemon-sandbox:latest`) with:
  - `-v <projectRoot>:/workspace` (workspace mounted at `/workspace`)
  - `--network none` (network disabled by default)
  - `--memory 512m --cpus 1` (resource caps)
  - `--init --rm` (ephemeral container execution)

### 6. Pokédex SQLite Persistence & Checkpoints (`src/storage/`)
- **[db.ts](../src/storage/db.ts)**: Owns the SQLite connection at `.codemon/sessions.db` (gitignored) and the schema: `sessions`, `messages`, `checkpoints`, `permission_decisions`, `compactions`. `CREATE TABLE IF NOT EXISTS` leaves an existing table alone, so columns added after the first release are attached by an explicit migration step at startup.
- **[sessions.repo.ts](../src/storage/sessions.repo.ts)**: Stores session metadata and message logs for `--continue` session restoration and `--sessions` listing.
- **[checkpoints.repo.ts](../src/storage/checkpoints.repo.ts)**: Records the initial state of files before modification via `edit_file` or `write_file` moves, enabling rollback via `--rewind`. Only the first checkpoint per file per session is kept, so a rewind restores the pre-session state rather than the state before the most recent edit.
  - **Checkpoint Scope**: Note that `--rewind` restores files saved via direct file tool modifications. Indirect modifications made via arbitrary shell commands inside `bash` (e.g., `sed`, `rm`, `git`) are not intercepted by file checkpoint hooks.
- **[compactions.repo.ts](../src/storage/compactions.repo.ts)**: Summaries of history no longer sent to the provider. Append-only, and a separate table rather than a rewrite of `messages`, because `--rewind`, `--audit` and the checkpoint foreign keys all read message rows — the transcript has to stay exactly as it happened.
- **[audit.repo.ts](../src/storage/audit.repo.ts)**: The permission decision trail. Deliberately carries no foreign key to `sessions` — evals and sub-agents make decisions without a session row, and a constraint violation there would take down the gate rather than lose a log line.

### 7. Party Members / Sub-Agents (`src/tools/spawn-subagent.ts`)
- **Isolated Context**: `spawn_subagent` delegates sub-tasks to fresh sub-agent instances with clean context windows.
- **Recursion Hard Cap**: A sub-agent is always given a tool filter, computed from the live registry minus `spawn_subagent` and `todo_write`. Read at execute time rather than pinned in a `z.enum` at module load, since a frozen tuple both hid MCP tools from sub-agents and — worse — was what the model saw as the list of legal values. The filter is enforced where tools are executed rather than only in the toolset the model is shown, so a sub-agent that emits the name anyway gets a tool-error. Maximum recursion depth is 1.
- **Inherited Permissions**: The sub-agent runs in the parent's permission mode, not `yolo`. There is no interactive prompt behind it, so anything that would need confirmation is auto-denied — from `safe` mode a sub-agent is effectively read-only.

### 8. Provider Registry (`src/providers/`)
- **[registry.ts](../src/providers/registry.ts)**: The single path to a model. Builds a Vercel AI SDK provider registry over Google, Anthropic, OpenAI and Mistral, addressed as `provider:model-name`, and adapts the SDK's stream into Codemon's own `StreamEvent` shape.
- **[model-fetcher.ts](../src/providers/model-fetcher.ts)**: Lists models live from the selected provider for `/connector`, falling back to a curated list when the call fails.
- **[types.ts](../src/providers/types.ts)**: The `Provider` interface the agent loop consumes, so the loop never imports an SDK directly.

### 9. User Configuration & Credential Security (`src/config/`)
- **[defaults.ts](../src/config/defaults.ts)** assembles the runtime `CodemonConfig` from the chain below; **[user-config.ts](../src/config/user-config.ts)** owns `~/.codemon/config.json`, the credentials in it, and the model `/connector` saves.
- **Interactive Connector**: Manages API key entry and model configuration via the `/connector` TUI slash command.
- **Strict POSIX 0600 Permissions**: Saves credentials to `~/.codemon/config.json` with strict mode `0600` permissions (`-rw-------`), protecting file reads from other system accounts.
- **Masked Key Display**: Formats stored keys as `••••••••1a4f` showing only the last 4 characters in terminal displays.
- **Precedence Hierarchy**: Resolves configuration in strict order, highest first:
  `CLI Flag (--model)` > `Environment ($CODEMON_MODEL, $GEMINI_API_KEY)` >
  `Project-Local Config (<project>/.codemon/config.json)` > `Project Config (<project>/codemon.json)` >
  `User Config (~/.codemon/config.json)` > `Built-in Default`.
  The two project files are read from the region (`--region`), not the launch directory.
- **Credential Isolation**: `loadConfig` copies only the keys `CodemonConfig` declares out of the
  config files, so `apiKeys` never enters the runtime config object that sub-agents and the eval
  runner receive. `defaultModel` — the key `/connector` writes — is read as the user-level `model`.
- **Non-scalar blocks** — `providers`, `mcpServers` — are read directly by the module that owns them
  ([mcp/config.ts](../src/mcp/config.ts) for the latter) rather than through `loadConfig`, which by
  design drops anything that is not a declared `CodemonConfig` key of the right primitive type.

### 10. MCP Client (`src/mcp/`)
- **[client.ts](../src/mcp/client.ts)**: Spawns a stdio server, completes the handshake, lists and
  calls its tools. Wraps `@modelcontextprotocol/sdk` behind an interface of our own so nothing else
  in the tree imports the SDK — the protocol revs, and when it does the change should land in one file.
- **[schema.ts](../src/mcp/schema.ts)**: JSON Schema → Zod. Forgiving on purpose: anything
  unrecognised becomes `z.unknown()` rather than throwing, because a partially-typed tool still
  works and a thrown conversion loses the whole server.
- **[config.ts](../src/mcp/config.ts)**: Reads and validates the `mcpServers` block. `${VAR}` expands
  from the environment at spawn time, so a token never has to be written into a config file.
- **[index.ts](../src/mcp/index.ts)**: Lifecycle. Servers start concurrently in the background and
  never block the front end; one that fails logs a warning and is skipped. Tools register as
  `mcp__<server>__<tool>` at `network` level unless the config opts a specific one down. Shutdown
  hangs off `onShutdown` in bootstrap, alongside `closeDb` — an orphaned `npx` server outliving the
  TUI is the failure mode users notice.
- **Transport**: stdio only. HTTP/SSE brings OAuth, token refresh and a callback listener; that is a
  second project rather than a second branch of this one, and the SDK makes it cheap to add later.

### 11. Evals & Tests (`src/evals/`, `src/**/*.test.ts`)
- **[evals/runner.ts](../src/evals/runner.ts)** and **[evals/benchmarks.ts](../src/evals/benchmarks.ts)**: `codemon --eval` runs each case in a throwaway temp directory against a real model, then checks the outcome — used for behaviour that only shows up end to end, like whether the gate holds under an adversarial prompt.
- **Unit tests** live beside the code as `*.test.ts` and run with `bun test`. No API key or network is needed: the agent-loop tests drive a scripted provider that emits whatever stream events the case calls for, and the tool and storage tests work in temp directories.
- **The MCP tests spawn a real child process** — [fixtures/echo-server.ts](../src/mcp/fixtures/echo-server.ts), a hand-rolled JSON-RPC server rather than one built on the SDK's server half, so a client and server that were wrong in the same way could not pass together.

---

## 🔒 Security Design Principles

1. **Explicit Permission Gates**: Write, shell and network operations are restricted by default in `standard` and `safe` modes. Plan mode denies all three outright, ahead of the session's "always allow" grants.
2. **Jailed File Access**: Path resolution for structured file moves is enforced through `jailPath()` to prevent traversal outside the project root (`../..`).
3. **Containerized Execution Option**: For OS-level container sandboxing, `--sandbox docker` runs shell commands inside network-isolated Docker containers (`--network none`, restricted memory/CPU).
4. **Credential Security**: Credentials saved via `/connector` are stored with POSIX `0600` owner-only permissions (`-rw-------`) and masked in TUI outputs. MCP server secrets stay in the environment and are expanded at spawn time, so a config file committed to a repo carries no token.
5. **SSRF Defence**: `web_fetch` refuses private, loopback and link-local addresses after DNS resolution and on every redirect hop, rather than by hostname — a name that resolves to `127.0.0.1` is the whole attack.

