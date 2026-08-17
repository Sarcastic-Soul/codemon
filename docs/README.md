# 🐉 Codemon Documentation

Welcome to the Codemon documentation. Below you will find comprehensive guides on using Codemon, understanding its architecture, and troubleshooting issues.

---

## 📚 Documentation Index

1. **[CLI Commands & Usage Reference](cli-commands.md)**
   - Installation & Setup
   - Command Line Flags (`--model`, `--mode`, `--plan`, `--sandbox`, `--continue`, `--rewind`, etc.)
   - Environment Variables, `/connector` TUI command, & the configuration precedence chain
   - Slash commands, including project-local `.codemon/commands/*.md`
   - **Headless runs**: `codemon run`, `--json` event stream, exit codes
   - **MCP servers**: declaring them, naming, and per-tool permission levels
   - Interactive TUI Keyboard Controls & Moves Reference
   - Common CLI Usage Workflows

2. **[Architecture & Design Guide](architecture.md)**
   - System Overview & Component Diagram
   - **Agent Loop**: Core streaming execution loop (`src/core/agent-loop.ts`)
   - **Poké Ball Permission Gate**: Security levels (`safe`, `standard`, `yolo`) and plan mode
   - **Moves Registry**: Tool system architecture & extensibility
   - **MCP**: server lifecycle, schema conversion, and why remote tools default to `network`
   - **Context & Compaction**: summarising the oldest turns instead of dropping them
   - **Safari Zone**: Path Jail & Docker Container Sandboxing
   - **Pokédex**: SQLite session persistence & checkpoint state management
   - **Party Members**: Sub-agent delegation & context isolation
   - **Provider Registry**: the models.dev catalog behind one `Provider` interface
   - **User Config & Credentials**: Interactive `/connector`, `0600` POSIX mode permissions (`~/.codemon/config.json`), key masking
   - **Evals & Tests**: `--eval` benchmarks and the `bun test` suite

3. **[Distribution & Release Guide](distribution.md)**
   - How `bun build --compile` produces the standalone binary
   - `react-devtools-core` stub explanation
   - Cross-platform build script (`scripts/build-all-platforms.sh`)
   - GitHub Actions CI/CD release pipeline
   - Installation from binary vs. source

4. **[Troubleshooting & FAQ](troubleshooting.md)**
   - API Key & Provider Configuration Errors
   - Permission Gate & Security Issues
   - MCP servers that fail to start, or whose tools never appear
   - Headless runs: reading the exit code, and why a run reports "denied"
   - Docker Sandbox Troubleshooting
   - Database & Session Checkpoint Recovery
   - Build & TypeScript Module Resolution Help
