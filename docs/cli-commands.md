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
| `--model <string>` | Specifies the provider and model string | `google:gemini-2.0-flash-exp` (default) | `--model anthropic:claude-sonnet-4-5` |
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

---

## 🔑 Environment Variables & `/connector` (BYOK)

Codemon uses **Bring-Your-Own-Key (BYOK)** architecture. You can set keys via environment variables OR interactively inside the TUI using `/connector`.

### Order of Precedence Hierarchy

Codemon resolves provider credentials and models in the following strict order:

| Priority | Source | Description | Example |
| :--- | :--- | :--- | :--- |
| **1 (Highest)** | **CLI Flag** | Explicit startup override | `codemon --model anthropic:claude-sonnet-4-5` |
| **2** | **Environment Variable** | Current shell session export | `export GEMINI_API_KEY="..."` |
| **3** | **Stored User Config** | Saved interactively via `/connector` | `~/.codemon/config.json` (`0600` POSIX mode) |
| **4 (Lowest)** | **Built-in Default** | Default fallback | `google:gemini-2.0-flash-exp` |

### Using the `/connector` Interactive Command

In the running TUI prompt, type `/connector` (or `/config` / `/model`) and press `Enter`:
1. **Select Provider**: Choose from Google Gemini, Anthropic Claude, OpenAI, or Mistral.
2. **Enter API Key**: Paste key securely (stored in `~/.codemon/config.json` with `0600` permissions; masked as `••••••••1a4f`). Press `r` to clear a saved key.
3. **Select Model**: Select pre-populated models or enter a custom model string. Mid-session switches update instantly!

### Provider API Keys

```bash
# Google Gemini
export GEMINI_API_KEY="your-gemini-api-key"
# (or alternative standard variable)
export GOOGLE_GENERATIVE_AI_API_KEY="your-gemini-api-key"

# Anthropic Claude
export ANTHROPIC_API_KEY="your-anthropic-api-key"

# OpenAI
export OPENAI_API_KEY="your-openai-api-key"

# Mistral
export MISTRAL_API_KEY="your-mistral-api-key"
```

### Supported Model Formats

- **Google**: `google:gemini-2.0-flash-exp`, `google:gemini-2.5-pro`, `google:gemini-1.5-pro`
- **Anthropic**: `anthropic:claude-sonnet-4-5`, `anthropic:claude-opus-4-5`, `anthropic:claude-3-5-haiku`
- **OpenAI**: `openai:gpt-4o`, `openai:o3-mini`, `openai:gpt-4o-mini`
- **Mistral**: `mistral:mistral-large-latest`, `mistral:pixtral-large-latest`

---

## 🗡️ Available Moves (Tools) Reference

Codemon uses 8 core moves to interact with your codebase:

| Move Name | Description | Permission Level | Mode Behavior |
| :--- | :--- | :--- | :--- |
| `read_file` | Reads contents of a file within project root | `read` | Auto-allowed in `safe`, `standard`, and `yolo` |
| `list_dir` | Lists directory structure and sub-paths | `read` | Auto-allowed in `safe`, `standard`, and `yolo` |
| `grep` | Performs regex/literal search across files | `read` | Auto-allowed in `safe`, `standard`, and `yolo` |
| `glob` | Finds files matching glob patterns | `read` | Auto-allowed in `safe`, `standard`, and `yolo` |
| `edit_file` | Modifies file content using exact string find-and-replace | `write` | Auto-allowed in `standard` & `yolo`; prompts in `safe` |
| `write_file` | Creates or completely overwrites a file | `write` | Auto-allowed in `standard` & `yolo`; prompts in `safe` |
| `bash` | Executes shell commands in subprocess or Docker container | `bash` | Prompts in `safe` & `standard`; auto-allowed in `yolo` |
| `spawn_party_member` | Spawns a sub-agent to explore or solve a sub-task (max depth: 1) | `bash` | Requires `bash` permission; sub-agent runs isolated |

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
bun run dev -- --mode yolo --model google:gemini-2.0-flash-exp
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
