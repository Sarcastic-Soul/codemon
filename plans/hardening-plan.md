# Codemon Hardening Plan

Forty issues found across the agent loop, permission gate, tool sandbox, persistence layer,
and TUI — grouped into eight stages ordered so each one stands on the last.

| | |
|---|---|
| **Scope** | `src/` · 4,429 lines · 63 files |
| **Baseline** | typecheck clean · 15 tests pass |
| **Branch** | `main`, with uncommitted connector work |

**Severity tally:** 2 critical · 8 high · 18 medium · 16 low

**Progress:** 36 of 44 done.
Stage 1 — 01, 02, 03 fixed, plus 25 and 27 from the same rewrite.
Stage 2 — 04, 05, 06, 07, 08 fixed, plus 12 pulled forward from Stage 3 (fixing 06 without it
would have shipped a hang).
Stage 3 — 09, 10, 11, 13 fixed; 12 had already landed with Stage 2.
Stage 4 — 14, 15, 16, 17, 18 fixed.
Stage 5 — 19, 20, 21, 22 fixed. Taken out of order on the plan's own advice: 19 is a bug in the
connector work still uncommitted in the tree.
Stage 6 — 23, 24, 26, 28, 29, 41 fixed; 25 and 27 had already landed with Stage 1.
Stage 8 — 36, 37, 38, 39, 40 fixed, plus 44, which the coverage work in 36 turned up: `--rewind`
had never restored a file.
Tests: 15 → 224. Four new issues found along the way: 41, 42, 43, 44.

Nine findings were reproduced by running the code — they are marked **[reproduced]** and carry
their actual output. The rest are confirmed by reading, and each names the line that shows it.

> [!CAUTION]
> **Fix Stage 1 before anything else.** `grep` and `glob` build shell command strings by
> interpolating their arguments, and both are registered at `permissionLevel: "read"` — the one
> level every mode auto-allows, including `safe`. A model that puts shell metacharacters in a
> `path` argument gets arbitrary command execution on the host without the permission prompt ever
> appearing. The gate exists to put a human between the model and the shell, and there is a
> read-level path straight through it.
>
> **Resolved.** Neither tool builds a command string any more — `grep` spawns an argv array and
> `glob` never leaves the process. Kept here as the record of what the fix was for.

---

## Stage 1 — Close the read-level shell hole ✅

Stop the search tools from reaching the shell, and put them inside the path jail they currently
ignore entirely.

**Files:** [src/tools/grep.ts](../src/tools/grep.ts) ·
[src/tools/glob.ts](../src/tools/glob.ts) ·
[src/sandbox/shell-executor.ts](../src/sandbox/shell-executor.ts) ·
[src/sandbox/path-jail.ts](../src/sandbox/path-jail.ts)

- [x] **01 · CRITICAL · Unescaped interpolation into `bash -c` at read permission** **[reproduced]**

  [grep.ts:43-45](../src/tools/grep.ts#L43-L45) interpolates `path` and `include` directly into a
  shell string; only `pattern` is escaped. [glob.ts:31](../src/tools/glob.ts#L31) interpolates
  `pattern`, `path` and `exclude`, none of them escaped. Both hand that string to `shellExec`,
  which runs `bash -c`.

  Because both declare `permissionLevel: "read"`, `checkPermission` auto-allows them in `safe`,
  `standard` and `yolo` alike. The `bash` permission level is never consulted.

  ```
  grep({ pattern: "x", path: ".' ; touch $SCRATCH/INJECTED ; echo '" })
    → file created by injection?  true
  ```

  **Fix:** Drop the shell entirely for these two. Spawn `rg` / `find` through `Bun.spawn` with an
  argv array so every argument stays a literal, and pass patterns as positional arguments rather
  than splicing them into a command.

  **Fixed.** `shellExecArgv` in [shell-executor.ts](../src/sandbox/shell-executor.ts) spawns an
  argv array with no shell; `shellExec` keeps the `bash -c` path for the `bash` tool alone and now
  says so in its doc comment. `grep` builds an argv array for `rg`/`grep`, using `-e` for the
  pattern and `--` before the path so neither can be read as a flag. `glob` dropped the subprocess
  altogether for `Bun.Glob`, which matches in-process — `find -name` never handled `**` anyway,
  which is what the bash-globstar fallback was papering over.

- [x] **02 · CRITICAL · Neither search tool calls `jailPath()`** **[reproduced]**

  Every other file tool routes its path through the jail. `grep` and `glob` take a `path` argument
  and pass it through untouched, so the project root is not a boundary for either of them.

  ```
  grep({ pattern: "root", path: "/etc/passwd" })
    → "1:root:x:0:0:root:/root:/bin/bash…"
  ```

  **Fix:** Route `path` through `jailPath()` in both tools, and resolve results back to
  project-relative paths before returning them.

  **Fixed.** Both jail `path` up front, then express the target relative to the root so results
  come back project-relative. `glob` scans with `followSymlinks: false` and drops any result that
  lands outside the jail, which covers a `..` segment inside the pattern itself.

- [x] **03 · MEDIUM · Docker command assembly has the same shape**

  [docker-executor.ts:74-91](../src/sandbox/docker-executor.ts#L74-L91) single-quote-escapes the
  command, then builds one long `docker run …` string that `shellExec` parses through `bash -c` a
  second time. The escaping happens to hold, but the double-parse is fragile in exactly the way
  this stage is about.

  **Fix:** Build the `docker run` invocation as an argv array too, once `shellExec` grows an
  array-taking sibling.

  **Fixed.** All four `shellExec` calls in `docker-executor.ts` are argv arrays now, so the host
  shell is out of the picture entirely. The user's command is still `bash -c` *inside* the
  container — that is the tool's contract — but it travels as a single argv element, so it is
  parsed once, in the sandbox, rather than twice with the host getting first look.

> **Done when:** a test asserts that shell metacharacters in `path` / `include` / `exclude` are
> treated as literal path text, and that an absolute path outside the root throws from both tools.

**Done.** [src/tools/search-tools.test.ts](../src/tools/search-tools.test.ts) — 19 tests covering
injection payloads in every model-supplied argument of both tools, jail escapes via absolute and
traversal paths, and `shellExecArgv` argument handling. The payloads were checked against the old
command construction first: replayed through `bash -c`, each one creates its sentinel file, so the
tests fail on the code they replaced rather than passing vacuously.

---

## Stage 2 — Make the permission gate mean what it says ✅

Three separate places where the gate's documented guarantees are not the guarantees the code
actually provides.

**Files:** [src/core/agent-loop.ts](../src/core/agent-loop.ts) ·
[src/permissions/rules.ts](../src/permissions/rules.ts) ·
[src/permissions/gate.ts](../src/permissions/gate.ts) ·
[src/tools/spawn-subagent.ts](../src/tools/spawn-subagent.ts) ·
[src/sandbox/path-jail.ts](../src/sandbox/path-jail.ts)

- [x] **04 · HIGH · Tool filter is advisory — execution ignores it**

  [agent-loop.ts:78-80](../src/core/agent-loop.ts#L78-L80) filters the toolset sent to the model.
  Execution at [agent-loop.ts:146](../src/core/agent-loop.ts#L146) then calls
  `getTool(tc.toolName)` against the *global* registry with no filter check. Whatever name the
  model emits runs.

  The consequence is that the depth-1 sub-agent cap described in the architecture doc is not
  enforced. `spawn_subagent` is excluded from a sub-agent's toolset, but a sub-agent that emits
  the name anyway gets it — and each nesting level is another `yolo` agent.

  **Fix:** Check `toolNameFilter` at the execution site and return a tool-error for anything
  outside it, so the filter is enforced where it matters rather than only suggested to the model.

  **Fixed.** The filter is checked before `getTool`, returning a tool-error for anything outside
  it. A second half turned out to be needed: `spawn_subagent` only passed a filter when the caller
  supplied `allowed_tools`, so the *default* sub-agent got the unfiltered registry — including
  `spawn_subagent`. It now always passes one, defaulting to `AVAILABLE_TOOLS`, which is what makes
  the depth-1 cap real rather than nominal.

- [x] **05 · HIGH · An unknown permission mode crashes the gate** **[reproduced]**

  [rules.ts:16](../src/permissions/rules.ts#L16) switches on three modes with no `default` branch,
  so any other string returns `undefined` and `checkPermission` throws on `rules.autoDeny`.
  Nothing validates `--mode` at parse time.

  ```
  getRuleSet("bogus")        → undefined
  checkPermission(…,"bogus") → TypeError: undefined is not an object (evaluating 'rules.autoDeny')
  ```

  **Fix:** Validate the flag against the three modes at startup with a clear error, and give
  `getRuleSet` a `default` that falls back to the most restrictive ruleset rather than throwing.

  **Fixed.** `getRuleSet` has a `default` that confirms everything and auto-allows nothing, so an
  unrecognised mode degrades to "ask" instead of taking the gate down. `--mode` is validated at
  startup against `PERMISSION_MODES`, and so is the resolved `config.permissionMode`, since the
  same value can arrive from either config file.

- [x] **06 · MEDIUM · Sub-agents silently escalate to yolo**

  [spawn-subagent.ts:54-59](../src/tools/spawn-subagent.ts#L54-L59) hardcodes
  `permissionMode: "yolo"` for the child regardless of the parent's mode. In `safe`, approving one
  delegation buys the sub-agent unrestricted write and bash for the whole task — and its
  `AVAILABLE_TOOLS` includes both.

  **Fix:** Either inherit the parent's mode and forward permission events up to the parent's UI,
  or keep the escalation but state it plainly in the permission prompt so the human approving it
  knows what they are approving.

  **Fixed** by inheriting, which meant taking issue 12 with it — see below. Forwarding permission
  events to the parent UI was the other option and was rejected: a tool's `execute` returns a
  promise and has no channel to yield events through, so it would have meant restructuring the
  tool interface. Instead the sub-agent inherits the parent's mode and anything that would need
  confirmation is auto-denied, since there is genuinely nobody to ask. From safe mode a sub-agent
  is now effectively read-only. Its description and system prompt say so, rather than continuing
  to advertise "auto-approve mode".

- [x] **07 · MEDIUM · Path jail does not resolve symlinks**

  [path-jail.ts:22-32](../src/sandbox/path-jail.ts#L22-L32) compares `path.resolve()` output
  against the root by string prefix. A symlink inside the project pointing outside it resolves to
  an in-root string and passes.

  **Fix:** Use `fs.realpathSync` on the resolved path (and on the root) before the prefix
  comparison, handling the not-yet-created-file case for writes.

  **Fixed.** `resolveThroughSymlinks` realpaths the deepest ancestor that exists and re-attaches
  the rest, so a file about to be created is judged against the real location of the directory it
  would land in — otherwise writes would slip through where reads could not. The comparison runs
  on real paths; the value returned stays the plain resolved path, which is what callers hand to
  `fs`. Links that stay inside the root still work.

- [x] **08 · LOW · Audit log is written and never read**

  [audit-log.ts](../src/permissions/audit-log.ts) accumulates every gate decision in a
  module-level array. `getAuditLog()` has no callers, nothing persists it, and its own header
  comment still says it will be moved to SQLite in stage 5 — which shipped.

  **Fix:** Persist decisions to the existing database alongside checkpoints and surface them, or
  delete the module. Growing an unbounded array nobody reads is the worst of both.

  **Fixed** by persisting. A `permission_decisions` table lands beside sessions and checkpoints,
  and `codemon --audit [id]` prints a session's decisions. The in-memory array is gone rather than
  bounded — SQLite is the single source of truth, and `getAuditLog`/`clearAuditLog` had no callers
  to keep. Two things fell out of doing it: every call site passed `args: {}`, so the log recorded
  no arguments at all — real args now thread through `checkPermission` and `recordUserDecision` —
  and they are truncated at 2,000 characters, since `write_file` carries a whole file body. The
  table deliberately has no foreign key to `sessions`: decisions are recorded on every tool call
  including from evals and sub-agents that run without a session row, and a constraint violation
  would take down the gate rather than lose a log line.

> **Done when:** a sub-agent that emits `spawn_subagent` gets a tool-error, and `--mode nonsense`
> exits with a readable message instead of a stack trace.

**Done.** Both, plus the rest of the stage:
[agent-loop.test.ts](../src/core/agent-loop.test.ts) and
[spawn-subagent.test.ts](../src/tools/spawn-subagent.test.ts) drive a scripted provider that
emits whatever tool call the test needs — including `spawn_subagent` from inside a sub-agent;
[cli-args.test.ts](../src/cli/cli-args.test.ts) runs the real binary and asserts the exit code and
message, and that nothing was written to disk before it bailed;
[gate.test.ts](../src/permissions/gate.test.ts) covers the unknown-mode path and the audit trail;
[path-jail.test.ts](../src/sandbox/path-jail.test.ts) builds real symlinks in a temp tree. The
symlink case was checked against the old prefix-only comparison first, which allowed the escape
and read the file outside the root.

### Follow-ups found while fixing this stage

- [ ] **42 · MEDIUM · "Always allow" is coarser than its own comment claims**

  [gate.ts:13](../src/permissions/gate.ts#L13) says it "derives a cache key from tool name + args",
  but `alwaysKey` uses only `${toolName}::${level}`. So answering **[A]lways** to `bash: ls` grants
  every future `bash` call in the session — `curl … | sh` included. The prompt offers "Always allow
  this session" next to the specific command it is showing, which is a fair reading of a promise
  the key does not keep.

  Not fixed here because the right granularity is a product decision rather than a bug fix: exact
  argument match is safest but almost never hits twice; a path prefix for file tools and an
  argv-head for `bash` is more useful and needs deciding on. Flagging it rather than picking.

  **Fix:** Decide the granularity, key on it, and make the prompt say what the grant covers.

- [ ] **43 · LOW · `requireConfirm` is documented but never consulted**

  `checkPermission` tests `autoDeny`, then `autoAllow`, then falls through to `"ask"`. Nothing
  reads `RuleSet.requireConfirm` outside the tests. It reads like the third arm of the decision
  and is really just a comment — a level absent from all three sets still gets "ask".

  **Fix:** Either check it and treat a level in none of the three sets as an error, or drop the
  field and let the fallthrough be the rule.

---

## Stage 3 — Agent loop correctness ✅

The loop is well-shaped, but it has no upper bound, and its context trimming produces message
histories that providers reject.

**Files:** [src/core/agent-loop.ts](../src/core/agent-loop.ts) ·
[src/core/context-manager.ts](../src/core/context-manager.ts)

- [x] **09 · HIGH · No cap on loop iterations**

  [agent-loop.ts:87](../src/core/agent-loop.ts#L87) runs `while (continueLoop)` and only exits
  when a turn produces zero tool calls or errors. A model that keeps calling tools — a retry
  spiral on a failing edit, say — runs until the process is killed, burning tokens the whole way.

  **Fix:** Add a max-turns budget (config-backed, ~25 default). On exhaustion, end the turn with a
  visible assistant message rather than a silent stop, so the user knows why it halted.

  **Fixed.** `maxTurns` is a config key defaulting to 25, so it travels the whole precedence chain
  and a sub-agent inherits the parent's. The check sits at the top of the loop and is only
  reachable when the model asked for tools again — a turn ending in text still exits below it. On
  exhaustion the notice is yielded as text *and* written to history, so it survives into the next
  request rather than only appearing on screen. `runToCompletion` also pushes it to `errors`: the
  finish reason is `max-turns`, and a headless caller shouldn't have to grep prose to find out the
  run was cut short. A `maxTurns` of `0` or a negative in a hand-written config falls back to the
  default rather than meaning "forever".

- [x] **10 · HIGH · Truncation orphans tool calls from their results**

  [context-manager.ts:40-46](../src/core/context-manager.ts#L40-L46) trims with
  `messages.slice(-20)`. That boundary can land between an assistant message carrying `tool-call`
  parts and the `tool` message carrying their results, leaving either a call with no result or a
  result with no call.

  Anthropic and OpenAI both reject that shape. So the failure mode is: long sessions work fine
  until they cross 80% of the budget, then every request 400s — and the surfaced error will point
  at the provider, not at the truncation.

  **Fix:** Trim on turn boundaries instead of a flat message count: walk back from the newest
  message and cut only where a user message begins, keeping each assistant/tool pair intact.
  Summarizing dropped turns is the natural follow-on.

  **Fixed.** `maybeTruncate` collects the indices of every user message and keeps whole turns,
  walking back from the newest while they fit a 60%-of-budget target — so the trim also leaves
  headroom instead of stopping the moment it drops back under the 80% trigger. Two edges are
  deliberate: the newest turn is kept whole even when it alone busts the budget (dropping it would
  leave the model without the request it is answering), and a history with no user message at all
  is returned untouched, because an oversized history still round-trips where one sliced
  mid-turn does not.

- [x] **11 · MEDIUM · Token accounting counts only completion tokens**

  [agent-loop.ts:113](../src/core/agent-loop.ts#L113) stores `usage.completionTokens` and drops
  `promptTokens`, which on an agentic loop is the overwhelming majority of spend — every turn
  resends the whole history.

  **Fix:** Record both, and keep them separate in the session row so the side panel can show
  context occupancy and cumulative cost as the two different things they are.

  **Fixed.** `MessageStore.updateTokenUsage` now takes the whole usage object rather than a bare
  number, and the session carries `promptTokensUsed` and `completionTokensUsed` alongside a
  `totalTokensUsed` that is their sum. The `sessions` table grew `prompt_tokens` and
  `completion_tokens`; `CREATE TABLE IF NOT EXISTS` leaves an existing table alone, so `initDb`
  runs an `ALTER TABLE` for databases written by an older build. `total_tokens` changes meaning
  from "completion only" to "prompt + completion" — the figure the picker and `--sessions` already
  labelled as the session's cost. The side panel adds both for the same reason: its number and the
  stored one should not be two different quantities. Making the *bar* mean context occupancy is
  still issue 32.

- [x] **12 · MEDIUM · `runToCompletion` deadlocks on a permission event**

  [agent-loop.ts:229-248](../src/core/agent-loop.ts#L229-L248) consumes events without handling
  `permission-required`, while the loop awaits a promise only that event's `resolve` can settle.
  Nothing resolves it, so the iteration hangs forever with no timeout. The acknowledging comment
  sits right there at line 247.

  Latent today only because both callers — sub-agents and evals — pin `yolo`. Issue 06 changing
  that would make this live.

  **Fix:** Handle the event explicitly: auto-deny, record it in `errors`, and continue. A headless
  runner should never be able to block on a UI that isn't there.

  **Fixed in Stage 2, ahead of schedule** — it had to be. The plan sequenced 06 before this one so
  the escalation was gone before the loop started seeing permission events, but that ordering
  ships a hang in between: the moment a sub-agent stops being pinned to `yolo`, the very next
  permission event blocks forever. So both landed together. `runToCompletion` now denies, records
  why in `errors`, and continues.

- [x] **13 · MEDIUM · Stream errors don't stop the current turn**

  [agent-loop.ts:117-120](../src/core/agent-loop.ts#L117-L120) sets `continueLoop = false` but
  keeps draining the stream and still executes any tool calls already collected for that turn. An
  errored turn should not go on to run tools.

  **Fix:** Break out of the stream loop on error and skip execution for that turn.

  **Fixed.** The stream loop breaks on the error event and the turn ends without executing
  anything it had collected. Handling the tool calls it leaves behind turned out to be the
  substance of the fix rather than a detail: saving the assistant message as-is would put a
  tool-call with no matching result into the history — the exact orphan shape issue 10 is about,
  and it would 400 the *next* request rather than this one. So any text that arrived is kept and
  the tool calls are dropped, with a `tool-error` yielded for each so the UI doesn't leave them
  spinning.

> **Done when:** a synthetic 200-turn history round-trips through `maybeTruncate` with every
> tool-call/tool-result pair intact, and a tool-calling loop terminates at the budget.

**Done.** [src/core/context-manager.test.ts](../src/core/context-manager.test.ts) — 8 tests over a
200-turn synthetic history whose turns are deliberately uneven (two tool rounds, one, or none),
because uniform turns divide evenly into `slice(-20)` and would have passed against the code they
replaced. Checked: with the old trim restored, four of them fail, including the pairing assertion.
[src/core/agent-loop.test.ts](../src/core/agent-loop.test.ts) — 7 more covering the turn budget
(stops at 3, announces why, falls back on a `0`) and stream errors (the tool never runs, no
orphaned tool-call reaches the history). Two of the three stream-error tests were confirmed to
fail with the fix reverted; the third — that an errored turn starts no further turn — held before
as well, and is kept as a regression guard.

---

## Stage 4 — Session persistence ✅

Resume works for messages and loses everything else. One confirmed data-loss bug plus the
accumulated debris around it.

**Files:** [src/core/session.ts](../src/core/session.ts) ·
[src/storage/sessions.repo.ts](../src/storage/sessions.repo.ts) ·
[src/cli/index.tsx](../src/cli/index.tsx) ·
[src/cli/components/SessionPicker.tsx](../src/cli/components/SessionPicker.tsx)

- [x] **14 · HIGH · Resuming a session zeroes its stored token total** **[reproduced]**

  [session.ts:57](../src/core/session.ts#L57) and [session.ts:78](../src/core/session.ts#L78) both
  set `totalTokensUsed: 0` on resume without reading the stored value. The next `addMessage`
  writes that zero back through `dbTouchSession`, overwriting the real total permanently.

  ```
  after first run,               DB total_tokens = 5000
  in-memory after resume                         = 0
  after resume + one message,    DB total_tokens = 0
  ```

  The side panel and the session picker both read that column, so a resumed session also displays
  as costing nothing.

  **Fix:** Select `total_tokens` in `dbGetLastSessionForRegion` and its companion query, and seed
  the resumed session with it.

  **Fixed.** Both resume paths go through one `adopt`, which seeds the counters from the stored
  row — `dbGetLastSessionForRegion` returns a full `StoredSession` now, and `resumeSpecificSession`
  reads its own via a new `dbGetSession` rather than trusting the caller to hand the numbers over.

  Rows written before Stage 3 needed deciding on: their `total_tokens` is completion-only and the
  two new columns are zero, so seeding from those columns alone would have dropped the number on
  the very next write — the same bug, one release later. The remainder between the total and the
  two columns is attributed to completion, which is what that column held, so
  `total = prompt + completion` stays true without inventing a split.

  `dbCreateSession` also moved from `INSERT OR REPLACE` to `INSERT OR IGNORE`. REPLACE deletes the
  conflicting row before inserting, and messages and checkpoints cascade off it — with the row now
  written lazily, one stray re-create would have emptied the session and reset its total. Ids are
  UUIDs, so a conflict can only mean "already stored".

- [x] **15 · MEDIUM · Every launch leaves a session row behind**

  `createSession` inserts before the user has typed anything, so starting Codemon and quitting
  still writes a row. The picker then fills with empty sessions, which is precisely the screen
  that has to stay scannable for the picker to be worth having.

  **Fix:** Create the row lazily on the first message, or prune zero-message sessions when listing.

  **Fixed** by doing both, because they cover different sets. Lazily, so new empty sessions are
  never written: `createSession` only builds the in-memory session, and `ensureSessionPersisted`
  writes the row when the first message, the first usage report or the first checkpoint arrives.
  And by filtering, because databases from before this still hold a row per launch — the listings
  drop sessions with no messages, which is also what stops `--continue` resuming into an empty one.

  Two details fell out. The row is written with whatever model is current, so choosing one in
  `/connector` before typing is remembered without the empty session being written on the spot.
  And messages and checkpoints both carry a foreign key to the session, so `edit_file` and
  `write_file` call `ensureSessionPersisted` before checkpointing — a message always comes first in
  practice, but that ordering shouldn't be what holds the foreign key up.

- [x] **16 · MEDIUM · Picker can't show message counts**

  [sessions.repo.ts:63](../src/storage/sessions.repo.ts#L63) hardcodes `messages: []` on every row
  it returns. [SessionPicker.tsx:65](../src/cli/components/SessionPicker.tsx#L65) then computes
  `msgCount` from it — always zero — and never renders the variable at all. The most useful column
  for choosing a session is the one that got dropped.

  **Fix:** Add a `COUNT(*)` join to `dbListSessions` and render it, or remove both the field and
  the dead local.

  **Fixed** by adding the join. `StoredSession` carries `messageCount` instead of the `messages: []`
  that was never populated, and the picker renders it beside the token figure. The same count is
  what issue 15 filters empty sessions on, so it earns its place twice.

- [x] **17 · LOW · `closeDb()` is never called**

  Exported from [db.ts](../src/storage/db.ts) with no callers. With WAL journaling on, the `-wal`
  and `-shm` files are left beside the database on every exit.

  **Fix:** Close on `waitUntilExit()` and on `SIGINT`.

  **Fixed.** Closed after each `waitUntilExit`, and on `SIGINT`/`SIGTERM`. The one that does the
  real work is a `process.on("exit")` handler registered right after `initDb`: `--sessions`,
  `--audit` and `--rewind` all `process.exit` without ever reaching the TUI, and they were leaving
  sidecars too.

- [x] **18 · LOW · gitignore entry only added when the file already exists**

  [index.tsx:107-112](../src/cli/index.tsx#L107-L112) appends `.codemon/` only inside an
  `fs.existsSync` guard. In a repository without a `.gitignore`, the session database is left
  showing up in `git status`.

  **Fix:** Create the file when it's absent.

  **Fixed**, with one narrowing: created when the project root is a repository, left alone when it
  isn't. `.gitignore` exists to keep files out of git, and writing a stray one into a directory
  that has no git to hide from is worse than not having it. Appending also stopped assuming the
  existing file ends in a newline, and the whole block is wrapped — a read-only project root is not
  a reason to refuse to start.

> **Done when:** a test writes tokens, resumes, adds a message, and asserts the stored total still
> includes the pre-resume usage.

**Done.** That exact sequence is the first test in
[src/core/session.test.ts](../src/core/session.test.ts), which covers the stage's storage half in
16 tests: both resume paths, the pre-Stage-3 row, lazy creation against eager, the cascade guard,
and message counts. [cli-args.test.ts](../src/cli/cli-args.test.ts) covers the half that only
happens in a real process — five tests spawning the binary against a temp region to check the
gitignore entry and that no WAL sidecar is left behind.

Checked against the code they replace: with the old resume and eager creation restored, six of the
storage tests fail, and with the old gitignore guard and no `closeDb` call, two of the CLI tests do.
The rest are regression guards.

One thing to know: `session.test.ts` calls a new `endSession()` in its teardown. The current
session is module state and `bun test` shares a process across files, so a session left live makes
the permission gate attribute *other* files' decisions to it instead of to the empty id they
expect. That is a test-isolation hazard rather than a product bug, but it will bite anything else
that creates a session in a test.

---

## Stage 5 — Config precedence and CLI parsing ✅

The documented four-tier precedence chain works for API keys and silently fails for the model.
The arg parser crashes on ordinary typos.

**Files:** [src/config/defaults.ts](../src/config/defaults.ts) ·
[src/config/user-config.ts](../src/config/user-config.ts) ·
[src/cli/parse-args.ts](../src/cli/parse-args.ts) ·
[src/cli/index.tsx](../src/cli/index.tsx)

- [x] **19 · HIGH · The connector's model choice never survives a restart** **[reproduced]**

  [user-config.ts:57](../src/config/user-config.ts#L57) writes the selected model to a
  `defaultModel` key. [defaults.ts:44](../src/config/defaults.ts#L44) reads a `model` key. Same
  file, different keys — so choosing a model in `/connector` persists nothing, and the next launch
  silently returns to `google:gemini-2.0-flash-exp`.

  This lands squarely in the feature currently in progress in the working tree, which is the
  reason to fix it now rather than after the commit.

  ```
  ~/.codemon/config.json = { "defaultModel": "anthropic:claude-sonnet-4-5" }
  loadConfig().model     → "google:gemini-2.0-flash-exp"
  ```

  **Fix:** Read `defaultModel` as the user-config tier of the precedence chain, below `--model`
  and the environment but above the built-in default.

  **Fixed.** `pickConfigKeys` treats `defaultModel` as an alias for `model` when a file sets no
  `model` of its own, so the key `/connector` writes is the key the next launch reads. The chain
  around it is now explicit and ordered — defaults, user config, `codemon.json`,
  `.codemon/config.json`, `CODEMON_MODEL`, flags — and `--model` still wins over all of it. The
  repo's own `codemon.json` dropped its `model` key on the way: it pinned the built-in default,
  which after issue 22 would have shadowed every connector choice made while working on Codemon
  itself.

- [x] **20 · MEDIUM · One file deserialized as two different types** **[reproduced]**

  `~/.codemon/config.json` is read by `loadConfig` as `CodemonConfig` and by `loadUserConfig` as
  `UserConfigData`. The first spreads the whole object, so `apiKeys` and `defaultModel` end up
  inside the runtime config — which means API keys ride along in an object that gets passed to
  sub-agents and eval runners.

  ```
  ~/.codemon/config.json = { "apiKeys": { "anthropic": "sk-secret-1234" } }
  loadConfig().apiKeys   → { anthropic: "sk-secret-1234" }
  ```

  **Fix:** Split credentials into `~/.codemon/credentials.json`, or namespace the two shapes under
  distinct top-level keys and stop spreading blind.

  **Fixed.** Kept one file, stopped spreading it. `loadConfig` copies only the keys `CodemonConfig`
  declares, and only when the JSON type matches the default's — so `apiKeys` and `endpoints` stay
  behind in `user-config.ts`, which is the only module that reads them. `defaultModel` crosses
  deliberately, as issue 19's alias. The dead `apiKey?: string` field came off `CodemonConfig`
  too; nothing read it, and it was one more way for a credential to reach a sub-agent.

- [x] **21 · MEDIUM · A flag without a value crashes before the UI renders** **[reproduced]**

  [index.tsx:28-38](../src/cli/index.tsx#L28-L38) stores `true` for any flag not followed by a
  non-`--` token. A trailing `--model` then reaches `parseModelString(true)` and throws on
  `.replace`; a trailing `--region` throws inside `path.resolve`. The parser also can't accept a
  value that begins with `-`.

  ```
  codemon --model   → TypeError: modelString.replace is not a function
  codemon --region  → TypeError: The "paths[0]" property must be of type string, got boolean
  ```

  **Fix:** Declare which flags take values, error clearly when one is missing, and validate
  `--mode` and `--sandbox` against their allowed sets.

  **Fixed.** Parsing moved to [src/cli/parse-args.ts](../src/cli/parse-args.ts), where each flag is
  declared as taking a value, taking an optional one (`--audit`), or taking none. A missing value,
  a value on a boolean, an unknown mode or sandbox, and an unknown flag are all messages plus the
  usage block plus exit 1 — before the config, the database or the TUI is touched. `--flag=value`
  is accepted, which is also how a value starting with a dash gets through. The usage text lives
  next to the flag table so the two cannot drift, and unknown flags are rejected rather than
  ignored: `--modle` used to be silently discarded, taking the model with it.

- [x] **22 · LOW · Root `codemon.json` is never read**

  The comment at [defaults.ts:40](../src/config/defaults.ts#L40) claims project-root
  `codemon.json` is a config source. `loadConfig` reads only `~/.codemon/config.json` and
  `./.codemon/config.json`. The file committed at the repo root has no effect on anything.

  **Fix:** Support it as documented, or delete the file and the comment.

  **Supported.** It is the tier between the user config and `.codemon/config.json` — the only
  config file that can be committed, since `.codemon/` is gitignored. Both project files are now
  read from the resolved project root rather than `process.cwd()`: with `--region` pointing
  elsewhere they were being read from the launch directory, which would have made this new tier
  wrong from the day it started working.

> **Done when:** picking a model in `/connector`, quitting, and relaunching comes back on that
> model — and `codemon --model` with nothing after it prints usage.

**Done.** [src/config/defaults.test.ts](../src/config/defaults.test.ts) — 11 tests over the
precedence chain, including the `/connector` round trip (`setDefaultModel` → `loadConfig`), the
credential-leak assertion, and each tier overriding the one below.
[src/cli/parse-args.test.ts](../src/cli/parse-args.test.ts) — 15 tests over the flag table, and
five more in [cli-args.test.ts](../src/cli/cli-args.test.ts) that spawn the real binary and check
`--model` and `--region` print usage and exit 1 instead of a stack trace. The three transcripts
quoted above were captured from the code as it stood before the fix, so each assertion is anchored
to behaviour that was actually observed rather than inferred.

Tests reach the config directory through `CODEMON_CONFIG_DIR`, which overrides `~/.codemon` — the
existing `user-config.test.ts` had been writing to the real home directory.

---

## Stage 6 — Tool behavior ✅

With the shell hole closed, the remaining tool issues are about wrong results rather than unsafe
ones — led by an edit path that can silently rewrite the wrong lines.

**Files:** [src/utils/diff-apply.ts](../src/utils/diff-apply.ts) ·
[src/tools/read-file.ts](../src/tools/read-file.ts) ·
[src/tools/glob.ts](../src/tools/glob.ts) ·
[src/tools/grep.ts](../src/tools/grep.ts) ·
[src/tools/list-dir.ts](../src/tools/list-dir.ts) ·
[src/sandbox/shell-executor.ts](../src/sandbox/shell-executor.ts) ·
[src/core/repo-indexer.ts](../src/core/repo-indexer.ts)

- [x] **23 · HIGH · Fuzzy edit matching can rewrite the wrong block**

  [diff-apply.ts:46](../src/utils/diff-apply.ts#L46) accepts any window scoring ≥ 0.7 on
  normalized line equality, then replaces that whole window. At the threshold, three lines in ten
  can be content the model never named — overwritten with no warning, and reported as
  `success: true`.

  The exact-match path has a quieter version of the same problem:
  [diff-apply.ts:56](../src/utils/diff-apply.ts#L56) uses `String.replace`, which takes the first
  of N occurrences without telling anyone there were N.

  **Fix:** Raise the threshold, refuse when the best and second-best windows score close together,
  count occurrences before an exact replace and reject ambiguity, and return which strategy fired
  so the diff view can flag fuzzy applications.

  **Fixed.** The threshold is 0.9, which is the point where normalization is doing the only
  forgiving — below it the lines differ in content the model named wrongly, not in whitespace. A
  disjoint block scoring within 0.05 of the winner now makes the edit ambiguous rather than a coin
  flip; overlapping windows are excluded from that test, since they are the same region seen
  through a shifted frame. The exact path counts occurrences first and refuses when there is more
  than one, and splices by index instead of `String.replace` — which reads `$&` and `` $` `` in
  `new_str` as substitution patterns, and `new_str` is arbitrary code. Empty and no-op `old_str`
  are refused too. `applyEdit` returns `strategy` and, for fuzzy, `similarity`; `edit_file` passes
  both up and `DiffView` marks a fuzzy application in its header.

- [x] **24 · MEDIUM · `read_file` has no size or binary guard**

  [read-file.ts:30](../src/tools/read-file.ts#L30) reads the whole file as UTF-8 with no size
  check. A lockfile, a minified bundle, or a binary goes straight into the message history — and
  Stage 3's truncation is what has to clean it up.

  **Fix:** Cap bytes read, sniff for NUL bytes and refuse binaries with a useful message, and
  suggest the existing `start_line`/`end_line` range in the error.

  **Fixed.** A NUL byte in the first 8 KB refuses the file as binary. A whole-file read over
  256 KB is refused with the file's size and a pointer at `start_line`/`end_line` — and that
  advice is now true, because a ranged read streams 64 KB at a time and stops as soon as the range
  is filled, so pulling ten lines out of a 400 MB log never holds the log. A range that is itself
  over the cap comes back truncated and says so.

- [x] **25 · MEDIUM · `glob`'s `exclude` silently returns nothing** **[reproduced]**

  [glob.ts:29](../src/tools/glob.ts#L29) passes `exclude` to `find` as `--exclude`, which is not a
  `find` predicate. `find` exits non-zero, the fallback branch runs, and the tool returns an empty
  list rather than an error — so the model reads it as "no such files."

  ```
  glob({ pattern: "*.ts" })                             → 1 file
  glob({ pattern: "*.ts", exclude: "node_modules/**" }) → 0 files
  ```

  **Fix:** Implement exclusion in the tool (filter results, or use `-not -path`), and make a
  non-zero exit an error rather than a silent empty result.

  **Fixed in Stage 1**, as a side effect of dropping `find`. Exclusion is a `Bun.Glob.match` over
  each result, `node_modules` and `.git` are always excluded, and an unreadable base directory
  throws with the path in the message instead of returning `[]`. `grep` got the same treatment:
  exit 2+ is now an error, where exit 1 stays "no matches".

- [x] **26 · MEDIUM · `grep` reports output lines as match count**

  [grep.ts:53-54](../src/tools/grep.ts#L53-L54) splits stdout on newlines and calls the length
  `count`. With `context_lines` defaulting to 2, that number includes context lines and `--`
  separators, so it overstates matches by roughly 3–5×. The TUI prints it as "N matches".

  **Fix:** Count matched lines specifically, or rename the field to what it is.

  **Fixed.** `countMatches` counts matched lines. Both tools mark a match as `line:text` and a
  context line as `line-text`, so the delimiter around the line number is the signal — read as
  whichever of the two shapes appears first, so a context line whose *content* holds `:12:` is not
  miscounted. The rg branch now passes `--line-number` explicitly, which ripgrep otherwise omits
  for a single explicit file; `--` separators are dropped from the count either way. The result
  also carries `truncated`, since `count` describes the whole search while `matches` is capped at
  15,000 characters — the TUI says "(output truncated)" when they disagree.

- [x] **27 · LOW · `which rg` spawns on every grep call**

  [grep.ts:31](../src/tools/grep.ts#L31) probes for ripgrep on each invocation — a second
  subprocess for every search, for a fact that cannot change during a run.

  **Fix:** Memoize it the way `docker-executor.ts` already memoizes its availability checks.

  **Fixed in Stage 1.** Memoized in `hasRipgrep()`, and the probe is now `rg --version` rather
  than `which rg` — it tests the thing we actually need (can this be spawned?) in one process
  instead of two.

- [x] **28 · LOW · `shellExec` buffers output without limit**

  [shell-executor.ts:42-46](../src/sandbox/shell-executor.ts#L42-L46) reads the full stream into
  memory; the 20,000-character cap lives in `bash.ts`, after the whole thing has already been
  buffered. A runaway command holds it all in memory first.

  **Fix:** Cap during read and stop consuming past the limit.

  **Fixed.** `readCapped` drains each stream to 1 MB and then cancels it, which closes our end of
  the pipe — a runaway writer gets EPIPE rather than permission to keep going. `ExecResult` grew a
  `truncated` flag so callers can say output was cut instead of quietly showing a prefix; `bash`
  reports it as `output_truncated`.

- [x] **29 · LOW · Dead parameter in `list_dir`**

  `buildTree`'s `rootLen` is threaded through every recursive call and never read.

  **Fix:** Remove it.

  **Fixed.** Removed from the signature and both call sites.

- [x] **41 · LOW · `repo-indexer` interpolates the project root into shell strings**

  Found while doing Stage 1. [repo-indexer.ts:59](../src/core/repo-indexer.ts#L59),
  [:68](../src/core/repo-indexer.ts#L68) and [:81](../src/core/repo-indexer.ts#L81) splice
  `projectRoot` into `bash -c` strings inside single quotes. Same shape as issues 01 and 03, but a
  different severity: `projectRoot` comes from `--region` or `cwd`, not from the model, so this is
  a quoting bug rather than a way in. It still breaks — a project path containing an apostrophe
  (`~/bob's projects/app`) ends the quote and the command fails or does something unintended.

  Left out of Stage 1 deliberately: it is outside that stage's scope, and unlike `grep`/`glob` the
  commands here end in pipelines (`| grep -v | head`, `| sort -rn | head | awk`), so converting
  them means moving the filtering into JS rather than just reshaping an argv array.

  **Fix:** Run `git` through `shellExecArgv` and do the line filtering in JS. Replace the `find`
  fallback with a `Bun.Glob` walk plus `stat`, the way `glob` now works.

  **Fixed.** Both `git` calls are argv arrays and the `grep -v`/`head`/`sort`/`awk` tail of each
  pipeline is a few array operations. The `find` fallback is a hand-written walk rather than a
  `Bun.Glob` one: a glob enumerates `node_modules` and then discards it, where a walk can prune the
  directory outright, which on a project with dependencies installed is the difference between
  reading hundreds of entries and hundreds of thousands. Confirmed against the old form — a root of
  `bob's projects` ends the quoted string and bash exits 2 before git runs.

> **Done when:** `diff-apply` has table-driven tests covering exact, fuzzy, ambiguous and no-match
> cases, and ambiguous input returns an error instead of an edit.

**Done.** [src/utils/diff-apply.test.ts](../src/utils/diff-apply.test.ts) — a twelve-case table
across exact, fuzzy, ambiguous and no-match, including the 70% near-miss the old threshold would
have applied and the `$&` payload the old `String.replace` would have expanded. Plus
[read-file.test.ts](../src/tools/read-file.test.ts) for the size and binary guards,
[repo-indexer.test.ts](../src/core/repo-indexer.test.ts) for the apostrophe path and the pruned
walk, and match-counting and output-cap cases added to
[search-tools.test.ts](../src/tools/search-tools.test.ts). 30 tests added; 143 pass overall.

---

## Stage 7 — TUI rendering and state

The interface is the newest code and the least settled. Everything here is visible to the user,
which is why it comes after correctness rather than before it.

**Files:** [src/cli/app.tsx](../src/cli/app.tsx) ·
[src/cli/components/ChatView.tsx](../src/cli/components/ChatView.tsx) ·
[src/cli/components/SidePanel.tsx](../src/cli/components/SidePanel.tsx) ·
[src/cli/components/ConnectorModal.tsx](../src/cli/components/ConnectorModal.tsx)

- [ ] **30 · MEDIUM · Whole chat history re-renders, with no way to scroll it**

  `ChatView` maps every message in the session, and every message maps every one of its lines to a
  `<Text>` — on each keystroke, since `input` lives in the same component tree. The container is
  `overflow="hidden"` with no scrollback, so once the conversation is taller than the terminal,
  the top is simply unreachable.

  **Fix:** Window to the last N messages with an elision marker, and memoize `MessageBubble` so
  typing doesn't re-render history.

- [ ] **31 · MEDIUM · Tool call and diff history cleared on every submit**

  [app.tsx:169-170](../src/cli/app.tsx#L169-L170) resets `toolCalls` and `lastDiff` at the start
  of each turn, so the record of what the agent just did disappears the moment you reply to it.
  Only the newest diff is ever visible.

  **Fix:** Attach tool calls and diffs to the message they belong to and render them inline in the
  transcript, rather than as floating state beneath it.

- [ ] **32 · MEDIUM · Token meter shows one quantity and measures another**

  [SidePanel.tsx:70](../src/cli/components/SidePanel.tsx#L70) hardcodes `MAX_TOKENS = 100_000`
  instead of reading `config.maxContextTokens`, and fills the bar from cumulative completion
  tokens. Those are different quantities: the bar implies "context remaining" while tracking
  "output spent so far", so it fills up during a long session that is nowhere near its context
  limit — and never reflects the truncation in Stage 3.

  **Fix:** Feed the bar the context estimate from `ContextManager.getStats` against
  `maxContextTokens`, and show cumulative spend as a separate figure.

- [ ] **33 · LOW · Unstable callback identity in `handleSubmit`**

  `commandContext` is rebuilt on every render and sits in `handleSubmit`'s dependency array, so
  the `useCallback` never memoizes anything.

  **Fix:** Wrap it in `useMemo`, or build it inside the callback.

- [ ] **34 · LOW · Two rendered slash commands aren't in the CLI help**

  The side panel and `/help` both list `/clear`, but `--help` at
  [index.tsx:59-62](../src/cli/index.tsx#L59-L62) lists only `/connector`, `/model` and the exit
  aliases. `/config` and `/cls` aren't listed anywhere.

  **Fix:** Generate the help text from `ALL_COMMANDS` so it can't drift again.

- [ ] **35 · LOW · Dead UI code from the side-panel swap**

  [StatusBar.tsx](../src/cli/components/StatusBar.tsx) (83 lines) has had no importer since
  `SidePanel` replaced it. `ConnectorModal` takes a `currentModel` prop it never reads.
  `PermissionPrompt` and `ToolCallView` both import `useEffect` without using it.

  **Fix:** Delete all four.

> **Done when:** a 200-message session stays responsive while typing, and the token meter tracks
> the same number the context manager truncates on.

---

## Stage 8 — Dead code, drifted docs, and the coverage gap ✅

Last because it is bookkeeping — but the coverage gap is what makes every stage above riskier than
it needs to be.

**Files:** [src/providers/](../src/providers/) · [docs/](../docs/) ·
[README.md](../README.md) · `src/**/*.test.ts`

- [x] **36 · MEDIUM · Tests cover four modules; the other fifty-nine are bare**

  The suite covers `path-jail`, `context-manager`, `rules` and `user-config` — 15 tests, all
  passing. Nothing covers the agent loop, `diff-apply`, any tool, or the storage layer.

  Which is to say: every stage in this plan modifies untested code. The "done when" lines above
  are written as test assertions for that reason — work through them and the gap closes as a side
  effect of the fixes.

  **Fix:** Treat each stage's "done when" as its acceptance test, and add a `diff-apply` table and
  a storage round-trip on top.

  **Fixed.** The per-stage acceptance tests landed with their stages; the two named extras are the
  `diff-apply` table (Stage 6) and [storage.test.ts](../src/storage/storage.test.ts) — 24 tests
  against a real SQLite file, covering the session/message/checkpoint/decision round trip, the
  cascade, the reopen, and the `ALTER TABLE` migration from a pre-`prompt_tokens` database.

  It found a bug on the first run, which is the argument for the stage: `--rewind` had never
  restored a file. See 44 below.

- [x] **37 · LOW · Architecture doc still describes the pre-refactor layout**

  [docs/architecture.md](../docs/architecture.md) diagrams and links `src/core/battle-engine.ts`,
  `src/pokeball/gate.ts`, `src/moves/registry.ts` and `src/safari-zone/`. All four were renamed to
  `agent-loop.ts`, `permissions/`, `tools/` and `sandbox/` in commit `050d466`. The mermaid
  diagram is the first thing a new reader hits.

  **Fix:** Redraw the diagram against the current tree and fix the file links.

  **Fixed.** The diagram is redrawn against the real tree — context manager, session state and the
  audit trail were missing from it as well — and every subsystem section now links to files that
  exist. A second problem turned up in the links themselves: they were absolute
  `file:///media/anish-kumar/…` paths that resolved on exactly one machine. All of them, plus two
  more in [distribution.md](../docs/distribution.md), are now repo-relative. Sections 8 (the
  provider registry) and 10 (evals and tests) were missing entirely — the numbering jumped from 7
  to 9 — and the claims that had gone stale with the fixes above are corrected: the symlink-aware
  jail, `shellExecArgv`, the enforced sub-agent tool filter, and mode inheritance.

- [x] **38 · LOW · The database has two names**

  Code writes `.codemon/sessions.db`. The README, architecture doc and troubleshooting guide all
  say `.codemon/pokedex.db` — including the recovery commands in troubleshooting, which therefore
  operate on a file that doesn't exist.

  **Fix:** Pick one. If it's `pokedex.db`, keep a migration for existing databases.

  **Fixed** on the code's name, `sessions.db`, which needs no migration and cannot orphan an
  existing database. The Pokédex stays as the metaphor in prose; it is only the filename that had
  to agree with the code. The troubleshooting recovery commands now name a file that exists, and
  say to move the `-wal`/`-shm` sidecars with it.

- [x] **39 · LOW · README advertises a tool name that doesn't exist**

  The README lists `spawn_party_member` among the eight moves. The registered tool is
  `spawn_subagent` — which is also what the system prompt, the eval suite and the TUI labels use.
  Only the README and parts of the architecture doc carry the old name.

  **Fix:** Rename in the docs, or rename the tool and update the four places that reference it.

  **Fixed** in the docs — renaming the tool would have moved the name away from the three places
  that already agree with the code. The moves table in
  [cli-commands.md](../docs/cli-commands.md) had also gone stale on behaviour: it described the
  sub-agent as "runs isolated" without saying it now inherits the parent's mode, and `edit_file`
  as plain find-and-replace.

- [x] **40 · LOW · Superseded provider modules still in the tree**

  `src/providers/anthropic.ts` and `src/providers/google.ts` — 121 lines between them — have no
  importers. `registry.ts` replaced both. They read as live alternatives to anyone browsing
  `src/providers/`.

  **Fix:** Delete them; the registry is the single path.

  **Deleted**, both. Typecheck confirms nothing referenced them; the `apiKey` field they read off
  `ProviderConfig` was the last consumer of the `CodemonConfig.apiKey` removed in issue 20.

> **Done when:** a new reader can follow `docs/architecture.md` to real files, and `bun test`
> covers each subsystem this plan touched.

**Done.** The first half is a test now rather than a claim:
[docs/doc-links.test.ts](../docs/doc-links.test.ts) walks every markdown link in `README.md` and
`docs/`, fails on one that does not resolve, fails on an absolute `file://` link, and fails on any
page naming a module that was refactored away. It flagged `distribution.md`, which the manual pass
had missed.

The second half is true for every subsystem this plan changed — loop, gate, tools, sandbox,
config, CLI, storage, session state. The one that stays bare is `src/cli/components/`, whose stage
(7) has not been done. 37 tests added here; 224 in the suite.

### Follow-ups found while fixing this stage

- [x] **44 · HIGH · `--rewind` has never restored a file** **[reproduced]**

  [checkpoints.repo.ts](../src/storage/checkpoints.repo.ts) selected `file_path`,
  `original_content` and the rest, then cast the rows straight to `StoredCheckpoint`, whose fields
  are `filePath` and `originalContent`. SQLite returns the column names as written, so the cast
  was a lie the compiler had no way to catch: every field on every checkpoint read back
  `undefined`.

  ```
  dbGetCheckpoints(id)[0]  → { session_id: …, file_path: "/tmp/a.ts", … }
  checkpoint.filePath      → undefined
  dbRestoreCheckpoints(id) → [{ filePath: undefined, success: false,
                                error: "path must be a string or a file descriptor" }]
  ```

  So `--rewind` printed one `❌ undefined` per checkpointed file and restored nothing. The feature
  is in the README, the architecture doc and the CLI reference; it had never worked.

  Not a regression from this plan — the code is unchanged since `6a1e0ad`. It is the answer to
  what the coverage gap in issue 36 was costing.

  **Fixed.** The rows are mapped explicitly, the way `sessions.repo.ts` and `audit.repo.ts` already
  did. The two other row casts in the storage layer were checked and are sound: both name the
  snake_case columns in the cast type rather than the camelCase interface.

---

## Why this order

The stages are sequenced by dependency, not just severity. Four places where the order actually
matters:

1. **Stage 1 before everything.** A read-level path to arbitrary shell execution makes every other
   permission guarantee decorative, and the fix is small and self-contained.
2. **Stage 2 before Stage 3.** ~~Issue 12's deadlock only becomes reachable once issue 06 stops
   pinning sub-agents to `yolo`~~ — which turned out to mean they cannot be separated at all, not
   merely ordered. Fixing 06 alone ships a hang. 12 came forward into Stage 2 and the two landed
   in the same change.
3. **Stage 3 before Stage 7.** The token meter can't be made honest until the loop records prompt
   tokens, and the meter should measure what the context manager truncates on.
4. **Stage 5 alongside the working tree.** ~~Issue 19 is a bug in the connector feature that is
   currently uncommitted~~ — that work landed as `6a1e0ad`, so this no longer buys anything.
   Issue 19 is now an ordinary follow-up: picking a model in `/connector` still does not survive a
   restart.

Stages 6 through 8 are independent of each other and can be reordered or split freely. If you want
to interleave, the natural pairing is one high-severity stage followed by one cleanup stage, so the
diff stays reviewable.
