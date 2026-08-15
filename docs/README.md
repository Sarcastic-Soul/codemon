# 🐉 Codemon Documentation

Welcome to the Codemon documentation. Below you will find comprehensive guides on using Codemon, understanding its architecture, and troubleshooting issues.

---

## 📚 Documentation Index

1. **[CLI Commands & Usage Reference](cli-commands.md)**
   - Installation & Setup
   - Command Line Flags (`--model`, `--mode`, `--sandbox`, `--continue`, `--rewind`, etc.)
   - Environment Variables, `/connector` TUI command, & the configuration precedence chain
   - Interactive TUI Keyboard Controls & Moves Reference
   - Common CLI Usage Workflows

2. **[Architecture & Design Guide](architecture.md)**
   - System Overview & Component Diagram
   - **Agent Loop**: Core streaming execution loop (`src/core/agent-loop.ts`)
   - **Poké Ball Permission Gate**: Security levels (`safe`, `standard`, `yolo`)
   - **Moves Registry**: Tool system architecture & extensibility
   - **Safari Zone**: Path Jail & Docker Container Sandboxing
   - **Pokédex**: SQLite session persistence & checkpoint state management
   - **Party Members**: Sub-agent delegation & context isolation
   - **Provider Registry**: Vercel AI SDK integration behind one `Provider` interface
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
   - Docker Sandbox Troubleshooting
   - Database & Session Checkpoint Recovery
   - Build & TypeScript Module Resolution Help
