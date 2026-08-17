# 💻 CLI Commands & Usage Guide

This document provides a complete reference for running Codemon, configuring environment options, using CLI flags, and interacting with the Ink React TUI.

---

## 🚀 Quick Start

```bash
# 1. Clone & Install Dependencies
cd /path/to/codemon
bun install

# 2. Export Provider API Key (e.g. Gemini, Claude, OpenAI, or Mistral)
export GEMINI_API_KEY=your-api-key

# 3. Launch Codemon
bun run dev
```

---

## 🎛️ CLI Flags & Options

Launch Codemon with custom options by appending arguments:

```bash
bun run dev -- [options]
# Or when built / installed as binary:
codemon [options]
```

### Full Flag Reference

| Flag | Description | Options / Default | Example |
| :--- | :--- | :--- | :--- |
| `--model <string>` | Provider and model, as `provider:model` | `google:gemini-flash-latest` (default) | `--model anthropic:claude-sonnet-5` |
| `--mode <mode>` | Permission gate security level | `standard` (default), `safe`, `yolo` | `--mode yolo` |
| `--sandbox <mode>` | Bash execution environment | `subprocess` (default), `docker` | `--sandbox docker` |
| `--plan` | Start in plan mode: investigate only, change nothing | Boolean flag | `--plan` |
| `--region <path>` | Sets working directory (project root) | Current working directory (`cwd`) | `--region /path/to/repo` |
| `--continue` | Resumes the most recent session for region | Boolean flag | `--continue` |
| `--rewind` | Restores all files modified during last session | Boolean flag | `--rewind` |
| `--sessions` | Lists recent sessions saved in Pokédex DB | Boolean flag | `--sessions` |
| `--eval` | Runs the automated Battle Benchmark eval suite | Boolean flag | `--eval` |
| `--no-index` | Disables automatic startup repo indexing | Boolean flag | `--no-index` |
| `--debug` | Enables verbose debug logging to file | Logs saved to `~/.codemon/debug.log` | `--debug` |
| `--help` / `-h` | Displays CLI help message and exits | Boolean flag | `--help` |

A flag that takes a value accepts either `--flag value` or `--flag=value`; use the `=` form for a
value beginning with a dash. A flag left without its value, a value on a boolean flag, an
unrecognised `--mode` or `--sandbox`, and an unknown flag are each rejected with a message and the
usage block before anything starts up.

---

## 🤖 Headless: `codemon run`

One prompt, no TUI — for CI, git hooks and scripting.

```bash
codemon run "fix the failing test in src/foo.test.ts"
echo "summarise the staged diff" | codemon run     # prompt from stdin
codemon run --json "…"                             # one JSON agent event per line
codemon run --mode yolo "…"                        # non-interactive approval
```

Every flag above applies unchanged, plus:

| Flag | Description |
| :--- | :--- |
| `--json` | Emit one JSON `AgentEvent` per line on stdout instead of prose |
| `--max-turns <n>` | Cap tool-calling turns for this run |

The assistant's reply goes to **stdout** and nothing else does, so
`codemon run … > out.txt` yields just the answer. Tool activity and warnings go to **stderr**.

Sessions persist for headless runs, so `--audit` and `--rewind` work against them — which matters
most in CI, where nobody watched it happen.

### Exit codes

| Code | Meaning |
| :--- | :--- |
| `0` | Completed |
| `1` | Provider/config problem, or the stream failed |
| `2` | Hit the turn budget without finishing |
| `3` | A tool needed confirmation and there was no one to ask |

A tool that would need a permission prompt is **denied**, not auto-allowed — a git hook that starts
running `rm` because nobody was watching is exactly what that avoids. `--mode yolo` is the explicit
opt-in.

---

## 📝 Plan Mode

Plan mode is a separate axis from `--mode`, not a fourth value of it: `--mode` says *how much the
agent asks*, plan mode says *what the agent is doing*. A `safe` session and a `yolo` session can
both be in plan mode, and it narrows both.

```bash
codemon --plan          # start in it
# …or /plan inside the TUI to toggle, /plan on and /plan off to be explicit
```

While it is on, every write, remote call and non-read-only shell command is denied at the gate —
**including tools you previously granted "always allow" this session**. The side panel shows
`[~] PLAN — read only` and the prompt border turns magenta, so the state is never ambiguous.

Read-only shell commands still run, because a plan written without being able to check `git log` is
a guess. The allowlist is deliberately blunt: `git log/status/diff/show/branch/blame/ls-files/remote`,
plus `ls`, `cat`, `head`, `tail`, `wc`, `rg`, `grep`, `find`, `pwd`, `which`, `file`, `stat`, `tree`,
`du` and `diff` — and **any** shell metacharacter (`|`, `&`, `;`, `>`, `<`, backtick, `$(`) denies the
whole command. `git log | tee evil.txt` is a write, and a parser clever enough to allow half of it is
a parser that will eventually be wrong.

Leaving plan mode does not touch the history, so the plan the agent just wrote stays in context —
which is the point of having written it there.

---

## 🔌 MCP Servers

Codemon can load [Model Context Protocol](https://modelcontextprotocol.io) servers over stdio and
offer their tools to the model as `mcp__<server>__<tool>`.

Declare them under `mcpServers` in `~/.codemon/config.json`, `<project>/codemon.json` or
`<project>/.codemon/config.json` (project wins, same precedence as everything else):

```jsonc
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" },
      "enabled": true,
      "timeout": 30000,
      // optional: opt a genuinely read-only tool down from the default
      "permissions": { "get_file_contents": "read" }
    }
  }
}
```

`${VAR}` expands from the environment at spawn time, so a token never has to be written into a
config file.

Servers start in the background and never block the prompt. `buildToolSet()` runs once per agent
turn, so a server that finishes its handshake after the first frame is simply offered on the next
turn. A server that fails to start logs a warning and is skipped — it never costs you the session,
or the other servers.

**Remote tools are `network`-level**, a permission level of their own. They ask in `safe` *and* in
`standard`, and only `yolo` auto-allows them. They are deliberately not classified as `write`:
`standard` auto-allows `write`, so filing them there would let an unclassified remote tool execute
silently in the default mode — the opposite of failing closed. `web_fetch` shares the level, since
it asks the same question: content from outside the region is entering the context.

---

## ⚙️ Custom Slash Commands

Markdown files that expand into prompts. Drop them in `<project>/.codemon/commands/*.md` (or
`~/.codemon/commands/*.md` for ones you want everywhere); the filename is the command name, so
`review.md` becomes `/review`.

```markdown
---
description: Review the current diff for bugs
hint: review diff
---
Run `git diff` and review every change for correctness bugs.
Focus on: $ARGUMENTS
```

- Frontmatter is optional; without it the first line becomes the description.
- `$ARGUMENTS` is replaced by everything after the command token. If the body has no placeholder,
  the arguments are appended on a new line rather than dropped.
- Project files override user files of the same name. **Built-ins always win** — a file called
  `exit.md` is logged and skipped, so nothing can redefine `/exit`.

`codemon --help` lists built-ins only: that text is generated before `--region` is resolved, so it
cannot know about project files. `/help` inside the TUI lists everything.

---

## 🔑 Environment Variables & `/connector` (BYOK)

Codemon uses **Bring-Your-Own-Key (BYOK)** architecture. You can set keys via environment variables OR interactively inside the TUI using `/connector`.

### Order of Precedence Hierarchy

Codemon resolves provider credentials and models in the following strict order:

| Priority | Source | Description | Example |
| :--- | :--- | :--- | :--- |
| **1 (Highest)** | **CLI Flag** | Explicit startup override | `codemon --model anthropic:claude-sonnet-5` |
| **2** | **Environment Variable** | Current shell session export | `export CODEMON_MODEL="..."`, `export GEMINI_API_KEY="..."` |
| **3** | **Project-Local Config** | Per-checkout, gitignored | `<project>/.codemon/config.json` |
| **4** | **Project Config** | Committed with the repository | `<project>/codemon.json` |
| **5** | **Stored User Config** | Saved interactively via `/connector` | `~/.codemon/config.json` (`0600` POSIX mode) |
| **6 (Lowest)** | **Built-in Default** | Default fallback | `google:gemini-flash-latest` |

Both project files are read from the region (`--region`), not the directory Codemon was launched
from. The model `/connector` saves lands in the user config as `defaultModel`, so a project file
that pins `model` will keep overriding it — that is the intended direction of the chain.

### Using the `/connector` Interactive Command

In the running TUI prompt, type `/connector` (or `/config` / `/model`) and press `Enter`:

1. **Select Provider**: type to filter the ~185 catalogued providers; ones you already have a
   key for float to the top. `ctrl-R` clears a saved key.
2. **Enter API Key**: pasted keys are stored in `~/.codemon/config.json` with `0600` permissions
   and shown masked as `••••••••1a4f`.
3. **Select Model**: filter the provider's models, each annotated with its context window, or
   enter any model id by hand. Mid-session switches take effect on the next message, and the
   context budget re-sizes with them.

`Esc` steps back a stage rather than closing the whole dialog.

### Where providers and models come from

Codemon does not carry a hardcoded provider list. It reads [models.dev](https://models.dev), an
open catalog of providers and models, which supplies each provider's API key environment
variables, base URL, driving SDK package, and per-model context window, pricing, and capability
flags.

- A **bundled snapshot** ships with the binary, so a fresh or offline install works immediately.
- The full catalog is fetched in the background at most once a day and cached in
  `~/.codemon/model-catalog.json`. Failures are silent and leave the previous catalog in place.
- Regenerate the bundled snapshot with `bun run catalog:update`.

Providers Codemon cannot construct — those needing a vendor SDK it does not bundle, such as
Amazon Bedrock or Vertex AI — are hidden from the picker rather than offered and failing later.

### Provider API Keys

Each provider's environment variables come from the catalog, so the right name is whatever that
provider publishes. `/connector` prints the accepted names for the selected provider, and a
missing key reports them too:

```bash
export GEMINI_API_KEY="…"        # or GOOGLE_GENERATIVE_AI_API_KEY / GOOGLE_API_KEY
export ANTHROPIC_API_KEY="…"
export OPENAI_API_KEY="…"
export OPENROUTER_API_KEY="…"    # one key, hundreds of models
export AI_GATEWAY_API_KEY="…"    # Vercel AI Gateway, same idea
```

A provider with no catalogued variable also accepts a derived `<PROVIDER>_API_KEY`.

### Model Format

`provider:model`, e.g. `anthropic:claude-sonnet-5`. The legacy `provider/model` form still works.
Only the first separator splits, so ids containing their own separators survive intact —
`openrouter:anthropic/claude-sonnet-5` and `ollama:qwen3-coder:30b` both parse correctly.

### Local and private providers

models.dev only catalogues hosted services. Declare anything else — Ollama, vLLM, LM Studio, an
internal gateway — under `providers` in `~/.codemon/config.json`, and it is driven through the
OpenAI-compatible client:

```json
{
  "providers": {
    "ollama": {
      "name": "Ollama (local)",
      "api": "http://127.0.0.1:11434/v1",
      "models": ["qwen3-coder:30b", "llama3.3:70b"]
    }
  }
}
```

To keep a catalogued provider but point it at a proxy, set `endpoints` instead — its model list
and metadata are retained:

```json
{ "endpoints": { "anthropic": "http://localhost:8080/v1" } }
```

---

## 🗡️ Available Moves (Tools) Reference

Codemon ships 10 core moves, plus whatever MCP servers add at runtime:

| Move Name | Description | Permission Level | Mode Behavior |
| :--- | :--- | :--- | :--- |
| `read_file` | Reads contents of a file within project root | `read` | Auto-allowed in `safe`, `standard`, and `yolo` |
| `list_dir` | Lists directory structure and sub-paths | `read` | Auto-allowed in `safe`, `standard`, and `yolo` |
| `grep` | Performs regex/literal search across files | `read` | Auto-allowed in `safe`, `standard`, and `yolo` |
| `glob` | Finds files matching glob patterns | `read` | Auto-allowed in `safe`, `standard`, and `yolo` |
| `edit_file` | Replaces a block of file content; exact match first, fuzzy fallback, refuses ambiguous matches | `write` | Auto-allowed in `standard` & `yolo`; prompts in `safe` |
| `write_file` | Creates or completely overwrites a file | `write` | Auto-allowed in `standard` & `yolo`; prompts in `safe` |
| `bash` | Executes shell commands in subprocess or Docker container | `bash` | Prompts in `safe` & `standard`; auto-allowed in `yolo` |
| `spawn_subagent` | Spawns a sub-agent to explore or solve a sub-task (max depth: 1) | `bash` | Requires `bash` permission; the sub-agent inherits the parent's mode and auto-denies anything that would need a prompt |
| `todo_write` | Records the checklist for a multi-step task; the whole list is passed every call | `read` | Auto-allowed everywhere — it touches no file and runs no command, and prompting for it would make planning unusable in `safe` mode |
| `web_fetch` | Fetches an http(s) URL and returns it as text, HTML stripped | `network` | Prompts in `safe` & `standard`; auto-allowed in `yolo` |
| `mcp__<server>__<tool>` | Anything a connected MCP server offers | `network` | Prompts in `safe` & `standard`; auto-allowed in `yolo`. Overridable per tool in config |

`web_fetch` refuses private, loopback and link-local addresses — **after** DNS resolution, and again
on every redirect hop. A hostname blocklist would not see `evil.com` resolving to `127.0.0.1`, and
`169.254.169.254` is a cloud credential rather than a web page.

In plan mode every `write`, `bash` and `network` move above is denied outright, except the read-only
shell commands on the plan allowlist.

---

## 🖥️ Interactive TUI Controls

When Codemon runs, it presents a rich terminal UI built with Ink (React TUI):

- **Input Prompt**: Type your prompt and press `Enter` to send.
- **Tool Confirmation**: When Codemon requests a `write` or `bash` move (in `safe` or `standard` mode), a interactive Poké Ball permission prompt appears:
  - Select `Allow Once` (`y`) to authorize the current move.
  - Select `Always Allow` (`a`) to approve the move and auto-approve future calls for that move in the current session.
  - Select `Deny` (`n`) to block execution and send denial feedback to Codemon.
- **Session Navigation**:
  - `Ctrl + C`: Exit Codemon gracefully (session state is auto-saved to SQLite Pokédex).

### Built-in slash commands

| Command | What it does |
| :--- | :--- |
| `/help`, `/?` | List every command, built-in and project-local |
| `/exit`, `/quit`, `/q` | Exit |
| `/clear`, `/cls` | Clear the transcript on screen (the session in SQLite is untouched) |
| `/connector`, `/config`, `/model` | Open the provider & API-key configurator |
| `/compact [instruction]` | Summarise the earlier conversation now, freeing context. The optional argument steers the summary — `/compact focus on the auth refactor` |
| `/plan [on\|off]` | Toggle plan mode |
| `/init` | Explore the repo and write a `codemon.md` for it, which is loaded into the system prompt on the next start |

---

## 🗜️ Context Compaction

When the history reaches 80% of the model's window, Codemon summarises the oldest turns instead of
dropping them, and sends that summary in their place. The turns themselves are never deleted —
compaction only changes the slice sent to the provider, so `--rewind` and `--audit` still see the
full transcript.

Summaries are stored per session and reloaded on `--continue`, so resuming does not re-summarise
work you already paid to summarise. They also compose: the second compaction is given the first
summary to fold in rather than starting over.

If the summariser fails for any reason, the turn falls back to plain truncation and carries on.
Compaction is an optimisation, and an optimisation that can take down a turn is a bug.

`/compact` forces it at any time, summarising everything except the turn in flight.

---

## 💡 Practical Usage Workflows

### 1. Refactoring with Confirmation (`standard` mode)
```bash
bun run dev -- --model anthropic:claude-sonnet-4-5
```

### 2. Autonomous Task Execution (`yolo` mode)
```bash
bun run dev -- --mode yolo --model google:gemini-flash-latest
```

### 3. Isolated Shell Testing (`docker` sandbox)
```bash
bun run dev -- --sandbox docker --mode standard
```

### 4. Resume & Rollback Session State
```bash
# Resume where you left off in previous session
bun run dev -- --continue

# Rollback all file changes made in previous session
bun run dev -- --rewind
```

### 5. Running Automated Benchmark Suite
```bash
bun run dev -- --eval
```
