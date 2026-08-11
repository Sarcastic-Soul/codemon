# 🐉 Codemon — Your AI Coding Partner

> Tools are **moves**, the LLM is your **Codemon**, permission rules are the **Poké Ball**, sessions get saved to your **Pokédex**, project root is your **Region**, and sub-agents are **Party Members**.

Built with **Bun**, **TypeScript**, **Ink (React TUI)**, and **Vercel AI SDK v7**.

[![CI](https://github.com/Sarcastic-Soul/codemon/actions/workflows/ci.yml/badge.svg)](https://github.com/Sarcastic-Soul/codemon/actions/workflows/ci.yml)

---

## Features

- **Streaming TUI**: Dynamic terminal interface with real-time text streaming, active tool progress, diff previews, and permission prompts.
- **BYOK Architecture**: Connect to Google Gemini, Anthropic Claude, OpenAI GPT, or Mistral using model strings like `google:gemini-2.0-flash-exp` or `openai:gpt-4o`.
- **Poké Ball Permission Gate**: Three security modes: `safe` (ask for write/bash), `standard` (ask for write/bash, allow read), and `yolo` (auto-approve all). Supports "Always allow" per session.
- **8 Moves**: `read_file`, `write_file`, `edit_file` (with fuzzy diff matching), `list_dir`, `bash`, `grep`, `glob`, `spawn_party_member`.
- **Pokédex (SQLite Persistence)**: Sessions and messages automatically saved to `.codemon/pokedex.db`. Supports `--continue` to resume previous sessions and `--rewind` to roll back file changes.
- **Repo Indexer**: Automatically scans stack markers, git status, recently modified files, and ASCII file trees to give Codemon instant project context.
- **Party Members (Sub-Agents)**: `spawn_party_member` move delegates heavy tasks (e.g., codebase exploration) to isolated sub-agents with clean context windows.
- **Battle Eval Suite**: Run `--eval` to evaluate agent performance across security boundaries, file edits, code search, and sub-agent delegation.
- **Safari Zone v2 (Docker Sandbox)**: Run bash commands in isolated Docker containers with `--sandbox docker`.
- **Single Binary Distribution**: Ships as a self-contained executable. No Node, no npm — just download and run.

---

## 📖 Documentation

For detailed guides, architecture overviews, and troubleshooting help:
- 💻 **[CLI Commands & Usage Reference](docs/cli-commands.md)**: Full options, flags, and environment variables.
- 🏗️ **[Architecture Guide](docs/architecture.md)**: Battle Engine, Poké Ball permission gate, Moves system, Pokédex DB, and sub-agents.
- 📦 **[Distribution & Release Guide](docs/distribution.md)**: Standalone binary compilation, CI/CD pipeline, and cross-platform releases.
- 🛠️ **[Troubleshooting & FAQ](docs/troubleshooting.md)**: Solutions for API key errors, Docker issues, and database recovery.

---

## Installation & Setup

### Option A — Pre-built Binary (Recommended)

Download the latest binary for your platform from the [GitHub Releases page](https://github.com/Sarcastic-Soul/codemon/releases):

```bash
# Linux (x64)
curl -L https://github.com/Sarcastic-Soul/codemon/releases/latest/download/codemon-linux-x64 -o codemon
chmod +x codemon
sudo mv codemon /usr/local/bin/

# macOS (Apple Silicon)
curl -L https://github.com/Sarcastic-Soul/codemon/releases/latest/download/codemon-macos-arm64 -o codemon
chmod +x codemon
sudo mv codemon /usr/local/bin/
```

### Option B — Build from Source

```bash
git clone https://github.com/Sarcastic-Soul/codemon.git
cd codemon
bun install
bun run build       # produces dist/codemon
bash scripts/install.sh  # installs to /usr/local/bin or ~/.local/bin
```

Set your provider API key:

```bash
# Google Gemini (default)
export GEMINI_API_KEY=your-api-key

# Anthropic Claude
export ANTHROPIC_API_KEY=your-api-key

# OpenAI
export OPENAI_API_KEY=your-api-key

# Mistral
export MISTRAL_API_KEY=your-api-key
```

---

## Usage

```bash
# Start in current directory with default model (google:gemini-2.0-flash-exp)
codemon

# Use Claude Sonnet
codemon --model anthropic:claude-sonnet-4-5

# Start in YOLO mode (auto-approve all tool calls)
codemon --mode yolo

# Resume last session
codemon --continue

# Restore files modified during last session
codemon --rewind

# List past sessions
codemon --sessions

# Run in Docker sandbox mode
codemon --sandbox docker

# Run in another target directory
codemon --region /path/to/project

# Enable debug logging to ~/.codemon/debug.log
codemon --debug

# Run automated eval benchmark suite
codemon --eval
```

> **Running from source**: Replace `codemon` with `bun run dev --` (e.g. `bun run dev -- --model google:gemini-2.0-flash-exp`)

---

## Implementation Status

- [x] Stage 1: Core loop (streaming agent, battle engine)
- [x] Stage 2: Core moves (read/write/edit/list_dir)
- [x] Stage 3: Bash, grep, glob + Safari Zone path jail
- [x] Stage 4: Ink TUI (streaming chat, tool call view, diff preview, permission prompt, status bar)
- [x] Stage 5: Pokédex (SQLite persistence, `--continue` session resume, `--rewind` checkpoint rollback, `--sessions`)
- [x] Stage 6: Repo Indexer & Trainer's Guide system prompt integration
- [x] Stage 7: Party Members (`spawn_party_member` sub-agents)
- [x] Stage 8: Battle Eval Suite (`--eval` automated benchmarks)
- [x] Stage 9: Safari Zone v2 (Docker sandbox runner via `--sandbox docker`)
- [x] Stage 10: Distribution (single binary via `bun build --compile`, install script, GitHub Actions CI/CD release pipeline)

---

## License

MIT
