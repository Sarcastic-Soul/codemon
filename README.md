# 🐉 Codemon — Your AI Coding Partner

> Tools are **moves**, the LLM is your **Codemon**, permission rules are the **Poké Ball**, sessions get saved to your **Pokédex**, project root is your **Region**, and sub-agents are **Party Members**.

Built with **Bun**, **TypeScript**, **Ink (React TUI)**, and **Vercel AI SDK v7**.

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

---

## 📖 Documentation

For detailed guides, architecture overviews, and troubleshooting help:
- 💻 **[CLI Commands & Usage Reference](docs/cli-commands.md)**: Full options, flags, and environment variables.
- 🏗️ **[Architecture Guide](docs/architecture.md)**: Battle Engine, Poké Ball permission gate, Moves system, Pokédex DB, and sub-agents.
- 🛠️ **[Troubleshooting & FAQ](docs/troubleshooting.md)**: Solutions for API key errors, Docker issues, and database recovery.

---

## Installation & Setup

```bash
cd /path/to/codemon
bun install
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
bun run dev

# Use Claude Sonnet
bun run dev -- --model anthropic:claude-sonnet-4-5

# Start in YOLO mode (auto-approve all tool calls)
bun run dev -- --mode yolo

# Resume last session
bun run dev -- --continue

# Restore files modified during last session
bun run dev -- --rewind

# List past sessions
bun run dev -- --sessions

# Run in Docker sandbox mode
bun run dev -- --sandbox docker

# Run in another target directory
bun run dev -- --region /path/to/project

# Enable debug logging to ~/.codemon/debug.log
bun run dev -- --debug

# Run automated eval benchmark suite
bun run dev -- --eval
```

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
- [ ] Stage 10: Distribution (single binary compilation via `bun build --compile`)

---

## License

MIT
