# Security Policy

Codemon reads and writes files, runs shell commands, and holds provider API keys.
This document describes what protects you, what does not, and how to report a problem.

## Reporting a vulnerability

**Please do not open a public issue for a security vulnerability.**

Report it privately through
[GitHub Security Advisories](https://github.com/Sarcastic-Soul/codemon/security/advisories/new),
or by email to <anishisbusy@gmail.com> with `[codemon security]` in the subject.

Please include:

- what an attacker can do, and what they need in order to do it
- steps to reproduce, ideally with a minimal repo or prompt
- the Codemon version (`codemon --help` header or the release tag) and your OS

You can expect an acknowledgement within **72 hours** and an assessment within
**7 days**. Fixes ship in the next tagged release; you will be credited in the
advisory unless you ask otherwise.

## Supported versions

Codemon is pre-1.x in practice — security fixes land on `main` and in the latest
release only. Please upgrade to the newest release before reporting.

## Threat model

Codemon assumes **you trust yourself and your project directory**, and that the
**model output, the repository contents, and any command output are untrusted**.
An LLM can be steered by text it reads — a malicious `README`, a poisoned
dependency, a crafted issue body pasted into the chat — into proposing a
destructive move. The controls below exist to make sure such a move cannot run
without you seeing it.

### What protects you

**Permission gate.** Every move is classified `read`, `write`, or `bash` and
checked before it executes ([`src/permissions/`](src/permissions/)):

| Mode | read | write | bash |
|---|---|---|---|
| `safe` | allow | ask | ask |
| `standard` *(default)* | allow | allow | ask |
| `yolo` | allow | allow | allow |

An unrecognised mode fails closed — everything is confirmed. Bash commands are
never auto-approved outside `yolo`.

**Path jail.** File moves resolve their target and assert it stays inside the
project root ([`src/sandbox/path-jail.ts`](src/sandbox/path-jail.ts)). Comparison
happens on symlink-resolved paths, so a link inside the project that points
outside it is still rejected rather than followed.

**Audit log.** Every gate decision — allowed, denied, or confirmed — is written to
SQLite with its tool name, permission level, arguments, and timestamp. Review it
with `codemon --audit`.

**Checkpoints.** File changes are recorded per session, so `codemon --rewind`
restores everything a session touched.

**Credential handling.** API keys live in `~/.codemon/config.json`, written with
POSIX mode `0600` and re-`chmod`ed on every save. Keys are masked in the TUI. They
are sent only to the provider you selected, and never to any Codemon-operated
service — there isn't one.

**Sub-agent containment.** A sub-agent inherits its parent's permission mode and
cannot spawn a sub-agent of its own.

### What does **not** protect you

Be explicit about these before deciding how to run Codemon:

- **`--mode yolo` disables the gate.** Every move, including arbitrary bash, runs
  unattended. Use it only in a container or a scratch repo you can throw away.
- **The default sandbox is a subprocess, not isolation.** With
  `--sandbox subprocess` (the default), bash runs as your user with your
  environment and your network. `cwd` is forced to the project root and commands
  time out, but nothing stops a command from reaching outside that directory.
  There is no command allowlist or blocklist. For untrusted work use
  `--sandbox docker`.
- **The path jail covers file moves, not bash.** `read_file` and `write_file`
  cannot escape the region; `cat ../../secrets` is a bash command and is governed
  by the permission prompt instead.
- **Prompt injection is not solved.** Nothing here prevents a model from being
  persuaded to propose a harmful command — the gate only guarantees you get asked
  first. Read the command in the prompt before approving, and be wary of
  "always allow" for `bash`.
- **Your prompts and file contents go to your provider.** Whatever Codemon reads
  in order to answer is sent to the model API you configured, under that
  provider's data policy.

## Recommendations

- Stay on `standard` or `safe` for day-to-day work; reserve `yolo` for disposable
  environments.
- Use `--sandbox docker` when working in a repository you did not write.
- Keep `.codemon/` out of version control — it holds session history and
  checkpoints. It is gitignored by default.
- Use scoped, revocable API keys, and rotate any key you have pasted into a
  shared terminal.
- Review `codemon --audit` after an unattended run.
