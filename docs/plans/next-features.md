# Next features — implementation plans

Draft plans for the seven items on the roadmap, written against the tree as it
stands. Each section names the files it touches, the design decision that
actually matters, and the tests that prove it. Open questions are collected at
the bottom.

Two prerequisite refactors fall out of several features at once and are worth
doing first — see **Phase 0**.

---

## Phase 0 — prerequisites

### 0a. Slash commands that can be async and can submit a prompt

`SlashCommand.execute(ctx): void` (`src/cli/commands/index.ts`) is synchronous
and returns nothing. Four planned features need more than that:

| Feature | needs |
| --- | --- |
| `/compact` | async (an LLM call), access to the provider + config |
| `/init` | to submit a synthetic user prompt into the agent loop |
| custom commands | to submit an expanded prompt |
| `/plan` | to mutate app-level state (mode flag + system prompt) |

Change the contract to:

```ts
export type CommandResult =
  | void                              // handled entirely by the command
  | { submit: string }                // send this to the agent as a user turn
  | { notice: string };               // print a message, no agent turn

export interface SlashCommand {
  names: string[];
  description: string;
  hint: string;
  execute(ctx: CommandContext, args: string): CommandResult | Promise<CommandResult>;
}
```

`CommandContext` grows `provider`, `config`, `projectRoot`, `submitPrompt`,
`setPlanMode`. `dispatchCommand` becomes async and returns
`{ matched: boolean; result }`; `handleSubmit` in `app.tsx` awaits it and, on
`{ submit }`, re-enters the normal turn path with that text.

`args` is the remainder of the input after the command token — `dispatchCommand`
already splits it out to match `/connector google`, it just discards it today.

Cost: ~60 lines across `commands/index.ts`, the four existing commands, and the
`handleSubmit` branch in `app.tsx:304-314`.

### 0b. Extract startup from the TUI entry point

`src/cli/index.tsx` does flag parsing, project-root resolution, config load, DB
init, gitignore patching, provider construction and session creation inline,
then renders Ink. Headless mode and (later) MCP server startup need all of that
without Ink.

Extract `src/core/bootstrap.ts`:

```ts
export interface Bootstrapped {
  config: CodemonConfig;
  projectRoot: string;
  provider?: Provider;   // undefined when no API key is configured
  keyError: string | null;
}
export function bootstrap(flags: Record<string, FlagValue>): Bootstrapped
```

`index.tsx` keeps only the flag subcommands (`--sessions`, `--audit`,
`--rewind`, `--eval`) and the Ink render. Pure move, no behaviour change —
covered by the existing `cli-args.test.ts` plus one new test that `bootstrap`
returns a usable config for a temp dir.

---

## 1. MCP client

**Goal:** `codemon` can load stdio MCP servers declared in config and expose
their tools to the model under `mcp__<server>__<tool>` names.

### Files

- `src/mcp/client.ts` — spawn, handshake, `tools/list`, `tools/call`, shutdown
- `src/mcp/schema.ts` — JSON Schema → Zod conversion
- `src/mcp/config.ts` — read + validate the `mcpServers` config block
- `src/tools/registry.ts` — make the registry mutable
- `src/permissions/rules.ts` — permission level for remote tools
- `src/cli/index.tsx` / `bootstrap.ts` — lifecycle
- `src/tools/spawn-subagent.ts` — dynamic tool-name validation

### Config shape

Lands in `~/.codemon/config.json` and `<project>/.codemon/config.json`, next to
`providers` (so it belongs to `user-config.ts`, not `defaults.ts` — it is not a
`CodemonConfig` scalar and must not go through `pickConfigKeys`):

```jsonc
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" },
      "enabled": true,
      "timeout": 30000,
      // optional per-tool override of the fail-closed default
      "permissions": { "get_file_contents": "read" }
    }
  }
}
```

`${VAR}` expands from `process.env` at spawn time so tokens are not written to
disk in the config file.

### Transport

Start with **stdio only**. It is the transport every server ships, and it needs
no auth story. HTTP/SSE brings OAuth, token refresh and a callback listener —
that is a second project, not a second branch of the same one.

Protocol wire format is JSON-RPC 2.0 over newline-delimited stdout/stdin.
Writing ~200 lines by hand avoids the dependency, but `@modelcontextprotocol/sdk`
is the reference implementation and tracks spec revisions. Recommend the SDK.

### Registration flow

1. `bootstrap()` reads `mcpServers`, spawns each enabled one.
2. Handshake (`initialize` → `initialized`), then `tools/list`.
3. For each tool: convert `inputSchema` (JSON Schema) → Zod, build a
   `ToolDefinition` whose `execute` calls `tools/call` and normalises the
   MCP content array into a string or JSON value.
4. `registerTool(def)` into the registry.

`src/tools/registry.ts` currently builds `toolRegistry` from a static array at
module load, and `buildToolSet()` re-reads that array on every agent-loop entry.
Add:

```ts
export function registerTool(def: ToolDefinition): void
export function unregisterToolsByPrefix(prefix: string): void
```

and have `buildToolSet()` iterate `toolRegistry.values()` rather than the const
array. `buildToolSet()` is called per turn (`agent-loop.ts:90`), so a server
that finishes its handshake after startup still shows up on the next turn —
no restart needed.

**Startup must not block the TUI.** Server spawn + handshake happens in the
background (same pattern as the repo indexer, `app.tsx:281-292`). A server that
fails to start logs a warning and is skipped; it never prevents a session.

### JSON Schema → Zod

Servers emit draft-07-ish JSON Schema. Support `object`/`string`/`number`/
`integer`/`boolean`/`array`/`enum`/`required`/`description`, nested objects and
arrays, and `anyOf`/`oneOf` → `z.union`. Anything unrecognised becomes
`z.unknown()` rather than throwing — a partially-typed tool still works,
a crashed conversion loses the whole server.

Zod 4 is already a dependency; `zodSchema()` from the AI SDK wraps it in
`buildToolSet()` unchanged.

### Permission classification — the part that matters

The stated requirement is that an unclassified remote tool **fails closed**.
Classifying it as `write` does not achieve that: `standard` mode (the default)
lists `write` in `autoAllow` (`rules.ts:32-37`), so an unclassified remote tool
would execute silently in the default mode.

The three real options:

| Option | safe | standard | yolo |
| --- | --- | --- | --- |
| A. new `network` level | ask | ask | allow |
| B. reuse `bash` | ask | ask | allow |
| C. `write` as originally sketched | ask | **auto-allow** | allow |

Recommend **A**. It gives the permission prompt a truthful label ("this calls
an external server") and keeps the audit log readable, at the cost of touching
`PermissionLevel`, all three `RuleSet`s, the `default` fail-closed branch, and
`PermissionPrompt.tsx`. B is cheaper and equally safe but tells the user "bash"
when nothing shells out.

Either way, a server may declare `permissions: { toolName: "read" }` to opt a
genuinely read-only tool down — explicit, per-tool, in the user's own config.

Also required: `spawn-subagent.ts:10` pins `AVAILABLE_TOOLS` as a const tuple
inside a `z.enum`, so MCP tools are unreachable from sub-agents and, worse, the
enum is what the model sees. Change to `z.array(z.string())` validated at
execute time against the live registry minus `spawn_subagent`.

### Lifecycle

Kill child processes on `exit`/`SIGINT`/`SIGTERM` alongside `closeDb`
(`index.tsx:93-99`). An orphaned `npx` server surviving the TUI is the failure
mode users notice.

### Tests

- schema conversion: a table of JSON Schema fragments → parsed Zod behaviour
- a fake in-process stdio server (a small script echoing JSON-RPC) exercising
  handshake → list → call → shutdown
- gate: an MCP tool with no declared permission is `ask` in `standard`
- registry: `registerTool` then `buildToolSet()` includes the new name

---

## 2. Plan mode

**Goal:** a mode in which the agent can read and investigate but cannot mutate
anything, with a system prompt that tells it to produce a plan.

Orthogonal to `safe`/`standard`/`yolo`, as noted — those say *how much it asks*,
plan says *what it is doing*. Modelled as a separate boolean, not a fourth enum
member.

### Files

- `src/config/defaults.ts` — `planMode: boolean` (default `false`)
- `src/permissions/gate.ts` — deny branch
- `src/cli/parse-args.ts` — `--plan` boolean flag
- `src/cli/commands/plan.ts` — `/plan` toggle
- `src/cli/app.tsx` — state, system prompt, side-panel indicator
- `src/cli/components/SidePanel.tsx` — visible badge

### Gate change

`checkPermission` gets the flag. Ordering is the subtle part: the current
function checks `sessionAlways` **first** (`gate.ts:22-27`), so a tool the user
previously "always allowed" would sail straight past a plan-mode deny. The plan
check must precede it.

```ts
export function checkPermission(
  toolName: string,
  permissionLevel: PermissionLevel,
  mode: PermissionMode,
  args: Record<string, unknown> = {},
  planMode = false,
): GateDecision {
  if (planMode && MUTATING_LEVELS.has(permissionLevel)) {
    recordDecision({ toolName, permissionLevel, args, decision: "deny" });
    return "deny";
  }
  // …existing sessionAlways / autoDeny / autoAllow …
}
```

The denial message the model gets back matters — it should say *why*, so the
model writes the plan instead of retrying:

> Blocked: plan mode is active. Investigate and propose a plan; do not modify
> anything. The user will exit plan mode to execute.

That string goes in the `tool-result` output in `agent-loop.ts:242-246`, which
today hardcodes one message for every deny.

### `bash` in plan mode

`bash` is the level in question. A plan is much better when the agent can run
`git log`, `rg`, `ls`, `cat`. Three options, decision below in Open questions:
deny all bash / allow a read-only allowlist / prompt for each.

### System prompt

`buildBaseSystemPrompt` (`app.tsx:653`) becomes a function of `planMode`,
appending a plan-mode section and dropping the "Run tests after making changes"
guideline. It is already rebuilt into state, so a `/plan` toggle re-renders it
via the same `setSystemPrompt` path the repo indexer uses.

### Exiting

`/plan` toggles off. History is untouched — the plan the agent just wrote stays
in context, which is the whole point. The TUI shows a clear badge while it is
on, and the input border colour changes, so the state is never ambiguous.

### Tests

- `gate.test.ts`: `write`/`bash` denied in plan mode across all three modes,
  `read` still allowed
- plan mode beats a session `always` grant
- `/plan` toggles the flag and the system prompt contains the plan section

---

## 3. Summarizing compaction

**Goal:** replace wholesale dropping of old turns with an LLM-written summary,
plus a manual `/compact`.

`ContextManager.maybeTruncate` (`context-manager.ts:38-67`) drops the oldest
turns above 80% until it fits in 60%. Correct in shape — it cuts on turn
boundaries so tool calls are never orphaned — but the dropped content is gone.

### Design constraint that shapes everything

`ContextManager` is constructed fresh inside `_agentLoop` on **every user
message** (`agent-loop.ts:89`), and again in `app.tsx` for the meter. It holds
no state across turns. So the summary cannot live in the manager — it must live
in the session, and it must survive `--continue`.

Also: truncation today is non-destructive. `store.getMessages()` keeps
everything; only the slice sent to the provider is trimmed. Keep that property.
The database stays append-only, so `--rewind` and `--audit` are unaffected.

### Storage

New table, migrated in `src/storage/db.ts`:

```sql
CREATE TABLE IF NOT EXISTS compactions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  through_seq INTEGER NOT NULL,   -- summarises messages[0 .. through_seq]
  summary     TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
```

`src/storage/compactions.repo.ts` with `dbSaveCompaction` /
`dbGetLatestCompaction`. `session.ts` loads the latest on resume into
`session.compaction`.

The `messages` table already carries `seq`, so `through_seq` addresses the
history exactly.

### Flow

```
src/core/compaction.ts

  export async function compactHistory(
    messages: ModelMessage[],
    keepFrom: number,          // boundary chosen by ContextManager
    provider: Provider,
    config: CodemonConfig,
  ): Promise<{ summary: string; throughSeq: number } | null>
```

- Takes `messages.slice(0, keepFrom)` — exactly the turns that would have been
  dropped, plus the previous summary if one exists (summaries compose).
- Single non-streaming provider call with a fixed prompt asking for: the user's
  goal, decisions made and why, files read/modified with paths, commands run and
  their outcomes, and what is still outstanding. Explicitly: preserve file paths
  and identifiers verbatim; no prose padding.
- No tools, low `maxTokens` (~1500).
- Returns `null` on any failure.

The agent loop, before calling the provider for the turn:

1. `contextManager.plan(messages, systemPrompt)` returns
   `{ keepFrom, needsCompaction }` — the boundary logic already in
   `maybeTruncate`, split out so the loop can act on it.
2. If `needsCompaction`, `await compactHistory(...)`. On success, persist and
   prepend a synthetic message to the sent slice:
   `{ role: "user", content: "[Summary of earlier conversation]\n\n" + summary }`
   — user role rather than system, because the system slot is already occupied
   and some providers permit only one.
3. On `null`, fall back to today's behaviour — drop the turns. **A failed
   summariser must never fail the turn.**

Emit a new `AgentEvent`:
`{ type: "compaction", droppedMessages, summaryTokens }` so the TUI can print
"Compacted 34 earlier messages" rather than silently shrinking the meter.

### `/compact`

A command (needs Phase 0a) that forces compaction at the current boundary
regardless of the 80% threshold, prints the resulting token delta, and takes an
optional argument used as extra instruction to the summariser
(`/compact focus on the auth refactor`).

### Which model summarises

Same provider and model as the session by default. A cheap-model override
(`compactionModel` in config) is a nice-to-have; it needs a second provider
instance and a second key check, so it is not in the first cut.

### Tests

- an oversized history compacts, and the returned slice starts with the summary
  message
- a summariser that throws falls back to plain truncation and the turn still
  completes
- summaries compose: compact twice, the second summary's input contains the
  first
- resume loads the stored compaction and does not re-summarise
- the existing `context-manager.test.ts` invariant (never split a turn) still
  holds

---

## 4. Todo tool

**Goal:** the agent keeps an explicit checklist for multi-step work, and the
user can see it.

### Files

- `src/tools/todo.ts` — the tool
- `src/core/todo-store.ts` — in-memory state for the session
- `src/tools/registry.ts` — register
- `src/cli/components/SidePanel.tsx` — render
- `src/cli/app.tsx` — subscribe
- system prompt — when to use it

### Shape

One tool, `todo_write`, taking the **entire** list every call:

```ts
z.object({
  todos: z.array(z.object({
    content: z.string(),
    status: z.enum(["pending", "in_progress", "completed"]),
  })),
})
```

Whole-list replacement rather than add/complete/remove operations: incremental
ops need stable ids the model has to track, and it gets them wrong. Replacement
is idempotent and self-correcting.

Returns the new list so the model sees its own state echoed back.

A read tool is unnecessary — the result of the last write is already in context.

### Permission level

`read`. It touches no file and runs no command; prompting for it in `safe` mode
would make the feature unusable exactly where planning matters most. Worth
stating in the code comment, since "a tool named *write* classified as read"
invites a later 'fix'.

### State and display

Module-level array in `todo-store.ts` with a change listener, mirroring how
`session.ts` holds the current session. Not persisted in the first cut —
per-session ephemeral state. (Persisting it is a `todos` table and a load on
resume; cheap to add later if it proves worth resuming.)

The `SidePanel` gets a compact block: `▸ in progress`, `✓ done`, `○ pending`,
truncated to fit — the panel is ~15 columns wide for labels, so items are
elided hard. The layout arithmetic in `layout.ts` must account for the extra
rows, and its existing "frame never exceeds the terminal" test covers the risk.

### System prompt

The tool is worthless if the model does not reach for it. Add to Guidelines:

> Use `todo_write` for any task with three or more steps: write the full list
> before starting, mark exactly one item `in_progress` at a time, and mark it
> `completed` immediately when done.

### Tests

- whole-list replace overwrites prior state
- the store notifies listeners
- gate: `todo_write` is auto-allowed in `safe` mode

---

## 5. Custom commands and `/init`

### Custom commands

Markdown files in `<project>/.codemon/commands/*.md` and
`~/.codemon/commands/*.md` that expand into prompts. Requires Phase 0a.

```markdown
---
description: Review the current diff for bugs
hint: review diff
---
Run `git diff` and review every change for correctness bugs.
Focus on: $ARGUMENTS
```

- Filename (minus `.md`) is the command name: `review.md` → `/review`.
- Frontmatter is optional; `description` falls back to the first line.
- `$ARGUMENTS` is replaced by everything after the command token. Absent from
  the body, the arguments are appended on a new line so they are never lost.
- Body becomes `{ submit: expanded }` — a normal user turn.
- Project commands override user commands; **built-ins always win** and a
  shadowing file is logged and skipped, so no one can redefine `/exit`.

`src/cli/commands/custom.ts` exports `loadCustomCommands(projectRoot)`.
Discovery happens once at startup and results merge into the list
`commandSuggestions()` reads, so `/` completion picks them up for free.

One constraint: `parse-args.ts` imports `ALL_COMMANDS` at module load to build
`USAGE`, and that happens *before* `--region` is resolved. `codemon --help`
therefore lists built-ins only, with a line pointing at
`.codemon/commands/`. In-TUI `/help` lists everything.

### `/init`

A built-in that submits a fixed prompt:

> Explore this repository and write a `codemon.md` at the project root
> documenting: what the project does, the tech stack, how to build/test/run it,
> the directory layout, and any conventions a new contributor must follow. Keep
> it under 100 lines. If `codemon.md` already exists, read it first and update
> it rather than replacing it.

`loadAgentRules` (`src/config/load-agent-rules.ts`) already picks the file up
on the next start. Note it needs `write` permission, so in `safe` mode it will
prompt — correct, and worth saying in the notice `/init` prints first.

### Tests

- frontmatter parsing incl. no-frontmatter and malformed-frontmatter files
- `$ARGUMENTS` substituted, and appended when the placeholder is absent
- a custom `exit.md` does not shadow `/exit`
- project overrides user for the same name

---

## 6. Headless run

**Goal:** `codemon run "prompt"` for CI, git hooks and scripting.

Requires Phase 0b.

### Interface

```
codemon run "fix the failing test in src/foo.test.ts"
echo "summarise the diff" | codemon run          # prompt from stdin
codemon run --json "…"                           # JSONL AgentEvent stream
codemon run --mode yolo "…"                      # non-interactive approval
```

`parse-args.ts` gains subcommand handling: `positional[0] === "run"` selects the
headless path, remaining positionals join into the prompt. All existing flags
(`--model`, `--mode`, `--region`, `--sandbox`, `--debug`) apply unchanged; add
`--json` and `--max-turns`.

### Implementation

`src/cli/headless.ts`, ~120 lines:

1. `bootstrap(flags)`; exit 1 with the key error if no provider.
2. `createSession(projectRoot, config.model)` — sessions persist, so
   `--audit` and `--rewind` work on headless runs too. That matters most in CI.
3. Iterate `runAgent(...)` directly. No Ink.
4. Default output: assistant text to stdout as it streams; tool activity to
   stderr as one line per call (`⚙ read_file src/foo.ts`); nothing else, so
   `codemon run … > out.txt` yields just the answer.
5. `--json`: one `AgentEvent` per line on stdout, `permission-required`
   included, so a wrapper can decide policy.

### Permissions without a UI

`permission-required` has no answer in headless mode. Deny it, print a clear
line to stderr naming the tool and the mode that would have allowed it, and
continue — the same contract `runToCompletion` already implements
(`agent-loop.ts:340-345`). Do **not** silently auto-allow: a git hook that
starts running `rm` because nobody was watching is the failure this avoids.
`--mode yolo` is the explicit opt-in, and CI is where it belongs.

### Exit codes

`0` completed · `1` provider/config error or stream error · `2` hit `maxTurns`
without finishing (`MAX_TURNS_REASON` is already distinguishable) · `3` a tool
was denied for want of a permission prompt.

Distinct codes are what make this usable in a hook.

### Tests

- arg parsing: `run` with a quoted prompt, with `--json`, with flags after
- a stub provider that emits text → stdout content and exit 0
- a stub that requests a `bash` call in `standard` mode → exit 3, denial on
  stderr, no execution
- `--json` output is one valid JSON object per line

---

## 7. webfetch

Deferred, as agreed — an MCP fetch server covers it. If MCP slips, the fallback
is a `web_fetch` tool taking `{ url, max_bytes }`, HTTPS-only, redirect cap,
size cap, timeout from `config.timeout`, HTML→text stripped, and a permission
level shared with the MCP decision above (it is the same trust question:
content from outside the region entering the context). SSRF is the real hazard
— block private/loopback/link-local address ranges after DNS resolution, not
just by hostname.

---

## Suggested order

Dependency-ordered rather than value-ordered:

| Order | Item | Why here |
| --- | --- | --- |
| 1 | Phase 0a + 0b | four features need them |
| 2 | Summarizing compaction | correctness bug, and independent of 0a except `/compact` |
| 3 | Todo tool | smallest, no dependencies, largest per-line effect on completion |
| 4 | Plan mode | needs 0a for `/plan` |
| 5 | Custom commands + `/init` | needs 0a |
| 6 | Headless run | needs 0b |
| 7 | MCP | largest; benefits from the dynamic-registry work being unhurried |

Compaction sits above MCP because a silently amnesiac agent corrupts every long
session, including the ones being used to build the rest of this list.

---

## Open decisions

1. **MCP permission level** — new `network` level (recommended), reuse `bash`,
   or accept `write` and its auto-allow in `standard`.
2. **Plan mode and bash** — deny outright, allow a read-only allowlist, or
   prompt per call.
3. **Compaction persistence** — new `compactions` table (recommended),
   in-memory only, or rewrite `messages` in place.
4. **MCP transport** — stdio only in the first cut (recommended), or stdio +
   HTTP/SSE with the OAuth work that implies.
5. **MCP protocol layer** — `@modelcontextprotocol/sdk` (recommended) or a
   hand-rolled ~200-line JSON-RPC client to keep the dependency list short.
