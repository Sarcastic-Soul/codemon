<div align="center">

# 🐉 Codemon

**Your AI coding partner in the terminal.**

Tools are **moves**, the LLM is your **Codemon**, permission rules are the **Poké Ball**,
sessions live in your **Pokédex**, the project root is your **Region**, and sub-agents are **Party Members**.

[![CI](https://github.com/Sarcastic-Soul/codemon/actions/workflows/ci.yml/badge.svg)](https://github.com/Sarcastic-Soul/codemon/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Sarcastic-Soul/codemon?display_name=tag&sort=semver)](https://github.com/Sarcastic-Soul/codemon/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Bun](https://img.shields.io/badge/Bun-1.0%2B-000000?logo=bun&logoColor=white)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Platform](https://img.shields.io/badge/platform-linux%20x64%20%7C%20arm64%20%C2%B7%20macOS%20x64%20%7C%20arm64-lightgrey)](https://github.com/Sarcastic-Soul/codemon/releases/latest)

</div>

---

Codemon is a bring-your-own-key coding agent that runs entirely in your terminal. It streams
responses live, previews every file edit as a diff before touching disk, asks before it runs
anything dangerous, and remembers your sessions so you can pick up — or roll back — where you
left off.

Built with **Bun**, **TypeScript**, **Ink (React TUI)**, and the **Vercel AI SDK v7**.
Ships as a single self-contained binary — no Node, no npm, no `node_modules`.

## Quick Start

```bash
# 1. Install (Linux x64)
curl -L https://github.com/Sarcastic-Soul/codemon/releases/latest/download/codemon-linux-x64 -o codemon
chmod +x codemon && sudo mv codemon /usr/local/bin/

# 2. Point it at a provider
export GEMINI_API_KEY=your-api-key

# 3. Battle
cd your-project && codemon
```

No key handy? Launch `codemon` and run `/connector` to paste one in and pick a model
interactively — it's saved to `~/.codemon/config.json` with `0600` permissions.

## Features

| | |
|---|---|
| ⚡ **Streaming TUI** | Real-time token streaming, live tool progress, inline diff previews, and permission prompts — all in an Ink-powered React terminal UI. |
| 🔑 **BYOK, ~185 providers** | Providers and models come from the live [models.dev](https://models.dev) catalog rather than a hardcoded list, so a new model works the day it ships. Swap provider or model mid-session with `/connector`; keys never leave your machine. |
| 🔴 **Poké Ball permission gate** | Every move is classified `read` / `write` / `bash` / `network` and checked against your mode before it runs. "Always allow" is remembered for the session, and every decision is written to an audit log. |
| 🧰 **10 moves** | `read_file`, `write_file`, `edit_file` (fuzzy diff matching), `list_dir`, `bash`, `grep`, `glob`, `spawn_subagent`, `todo_write`, `web_fetch` — plus anything your MCP servers add. |
| 📝 **Plan mode** | `--plan` or `/plan`: the agent reads, greps and runs read-only shell commands, but every write and remote call is denied at the gate — including tools you already granted "always allow". Orthogonal to your permission mode, so it narrows `safe` and `yolo` alike. |
| 🔌 **MCP servers** | Declare stdio servers under `mcpServers` in your config; their tools show up as `mcp__<server>__<tool>`. They start in the background and never block the prompt, and a server that fails to come up costs you that server and nothing else. |
| 🗜️ **Summarising compaction** | At 80% of the context window the oldest turns are summarised rather than dropped, so a long session stops forgetting what it was doing. `/compact` forces it. The transcript in SQLite stays whole either way. |
| ✅ **Todo tracking** | `todo_write` keeps the checklist for a multi-step task, rendered live in the side panel — agents that do not track a plan drift off it around step four. |
| 🤖 **Headless runs** | `codemon run "<prompt>"` for CI, git hooks and scripting. Answer on stdout, tool activity on stderr, `--json` for a machine-readable event stream, and distinct exit codes for done / error / turn-budget / denied. |
| ⚙️ **Custom commands** | Markdown files in `.codemon/commands/` become slash commands; `$ARGUMENTS` is substituted. `/init` writes a `codemon.md` describing your project, which is loaded into the system prompt from then on. |
| 📕 **Pokédex persistence** | Sessions and messages are saved to SQLite at `.codemon/sessions.db`. Resume with `--continue`, list with `--sessions`, undo a whole session's file changes with `--rewind`. |
| 🗺️ **Repo indexer** | On startup Codemon scans stack markers, git status, recently modified files, and the file tree, so it knows your project before you type a word. |
| 👥 **Party members** | `spawn_subagent` hands heavy exploration to an isolated sub-agent with a clean context window. Sub-agents inherit the parent's permission mode and cannot spawn their own. |
| 🏕️ **Safari Zone sandboxing** | A path jail keeps file access inside your region, and `--sandbox docker` runs bash inside a throwaway container. |
| 🏆 **Battle eval suite** | `--eval` benchmarks the agent across security boundaries, file edits, code search, and sub-agent delegation. |
| 📦 **Single binary** | `bun build --compile` produces one executable per platform, released automatically by CI. |

## Usage

```bash
codemon                                     # start in the current directory
codemon --model anthropic:claude-sonnet-5   # pick a provider:model
codemon --mode yolo                         # auto-approve every move
codemon --plan                              # investigate only, change nothing
codemon --region /path/to/project           # work in another directory
codemon --continue                          # resume the most recent session
codemon --rewind                            # restore files from the last session
codemon --sessions                          # list recent sessions
codemon --audit                             # show permission decisions
codemon --sandbox docker                    # run bash inside a container
codemon --no-index                          # skip repo indexing on startup
codemon --eval                              # run the benchmark suite
codemon --debug                             # log to ~/.codemon/debug.log
```

### Headless runs

```bash
codemon run "summarise what changed on this branch"   # answer on stdout
codemon run "fix the failing test" --max-turns 20     # cap the tool budget
codemon run "review the diff" --json                  # one JSON event per line
echo "explain this error" | codemon run               # prompt from stdin
```

Only the assistant's reply goes to stdout, so `codemon run … > out.md` captures
the answer and nothing else; tool activity goes to stderr. The exit code says
what happened without anyone having to grep prose for it:

| Code | Meaning |
|---|---|
| `0` | Finished |
| `1` | Config or stream error |
| `2` | Hit the `--max-turns` budget |
| `3` | A tool needed permission and was denied |

A run that needs confirmation is **denied**, never auto-approved — nothing is
watching to answer the prompt. Pass `--mode yolo` to opt in explicitly.

> **Running from source?** Replace `codemon` with `bun run dev --` —
> e.g. `bun run dev -- --model google:gemini-flash-latest`.

### Slash commands

| Command | Aliases | Does |
|---|---|---|
| `/connector` | `/config`, `/model` | Open the provider & API key configurator |
| `/plan` | | Toggle plan mode — investigate and propose, change nothing |
| `/compact` | | Summarise the earlier conversation to free up context |
| `/init` | | Explore the project and write a `codemon.md` for it |
| `/help` | `/?` | List every slash command |
| `/clear` | `/cls` | Clear the chat history display |
| `/exit` | `/quit`, `/q` | Leave the battle (so does `Ctrl+C`) |

Any `.codemon/commands/*.md` file joins this list as `/<filename>`, with
`$ARGUMENTS` substituted from the rest of the line. A custom command may not
shadow a built-in — the file is skipped rather than silently winning.

### Permission modes

| Mode | Read | Write | Bash |
|---|---|---|---|
| `safe` | auto-allow | ask | ask |
| `standard` *(default)* | auto-allow | auto-allow | ask |
| `yolo` | auto-allow | auto-allow | auto-allow |

An unrecognised mode fails closed — everything gets confirmed.

### Providers

Providers and models come from [models.dev](https://models.dev) — an open catalog of ~185
providers and ~6,500 models — not from a list baked into the source. The catalog supplies each
provider's key environment variables, base URL, driving SDK package, and per-model context
window, pricing, and capability flags. A snapshot ships with the binary so a fresh or offline
install works immediately; the full catalog refreshes in the background once a day.

Run `/connector` to browse and filter them. A few common ones:

| Provider | Environment variable | Example model |
|---|---|---|
| Google | `GEMINI_API_KEY` / `GOOGLE_GENERATIVE_AI_API_KEY` | `google:gemini-flash-latest` |
| Anthropic | `ANTHROPIC_API_KEY` | `anthropic:claude-sonnet-5` |
| OpenAI | `OPENAI_API_KEY` | `openai:gpt-5.1` |
| OpenRouter | `OPENROUTER_API_KEY` | `openrouter:anthropic/claude-sonnet-5` |
| Vercel AI Gateway | `AI_GATEWAY_API_KEY` | `vercel:anthropic/claude-sonnet-5` |

Anything the catalog knows about works without a code change. Local runtimes (Ollama, vLLM, LM
Studio) are declared under `providers` in `~/.codemon/config.json` — see
[docs/cli-commands.md](docs/cli-commands.md#local-and-private-providers).

### Configuration precedence

Highest wins:

1. CLI flags — `--model`, `--mode`, `--sandbox`, …
2. Environment — `CODEMON_MODEL`, provider API keys
3. `<project>/.codemon/config.json` — project-local, gitignored
4. `<project>/codemon.json` — committed with the repo
5. `~/.codemon/config.json` — user-level; where `/connector` writes `defaultModel`
6. Built-in defaults

## Installation

### Pre-built binary (recommended)

Grab the latest build for your platform from the
[Releases page](https://github.com/Sarcastic-Soul/codemon/releases):

```bash
# Linux (x64)
curl -L https://github.com/Sarcastic-Soul/codemon/releases/latest/download/codemon-linux-x64 -o codemon
chmod +x codemon && sudo mv codemon /usr/local/bin/

# macOS (Apple Silicon)
curl -L https://github.com/Sarcastic-Soul/codemon/releases/latest/download/codemon-macos-arm64 -o codemon
chmod +x codemon && sudo mv codemon /usr/local/bin/
```

### From source

```bash
git clone https://github.com/Sarcastic-Soul/codemon.git
cd codemon
bun install
bun run build            # → dist/codemon
bash scripts/install.sh  # → /usr/local/bin or ~/.local/bin
```

## Documentation

| Guide | Contents |
|---|---|
| 💻 [CLI Commands & Usage](docs/cli-commands.md) | Every flag, environment variable, and TUI control |
| 🏗️ [Architecture](docs/architecture.md) | Agent loop, permission gate, moves registry, Pokédex, sub-agents |
| 📦 [Distribution & Release](docs/distribution.md) | Binary compilation, cross-platform builds, CI/CD pipeline |
| 🛠️ [Troubleshooting & FAQ](docs/troubleshooting.md) | API key errors, Docker issues, database recovery |

## Development

```bash
bun install
bun run dev        # run the TUI from source
bun test           # run the test suite
bun run typecheck  # tsc --noEmit
bun run build:all  # cross-platform binaries
```

CI runs typecheck and tests on every push; tagged pushes build and publish
release binaries for all platforms.

## Security

Codemon executes shell commands and holds your API keys, so it ships with a
permission gate, a path jail, an audit log, and `0600` credential storage.
[SECURITY.md](SECURITY.md) documents the threat model — including what those
controls deliberately do *not* cover — and how to report a vulnerability privately.

## License

Released under the [MIT License](LICENSE).
