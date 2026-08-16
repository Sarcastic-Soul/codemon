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

Codemon uses 8 core moves to interact with your codebase:

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
