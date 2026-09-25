# Lane `m2-events`: Structured event stream, `events`/`logs` subcommands, and a full-detail human log (FR-2, WISH-1)

- **Beads:** `codex-plugin-cc-yew.1`, `codex-plugin-cc-yew.2`
- **Report items:** FR-2, WISH-1. **Scope in this lane:** all of FR-2 and WISH-1. This lane also defines the event schema that every later M2-M6 lane consumes.
- **Milestone / wave:** M2, wave 1. **Depends on:** all of M0 and M1 merged. **Runs concurrently with:** `m2-snapshot-lib`, `m2-report-lib`, `m2-transcript-lib`.

## Goal

The only progress channel today is a human-readable log with 96-character commands and file-change counts. Give every job an append-only, machine-readable event stream (`jobs/<id>.events.jsonl`) that Claude can follow with Monitor, expose it through `events` and `logs` subcommands, and make the human log carry full commands, file paths and failure tails. **The event schema you define here is a cross-lane contract**: M2 capture, reports, transcripts, partial results, M3 attach and M5 MCP all read it. Implement it exactly as specified below.

## Ground rules (non-negotiable)

- **Worktree:** you work in your **own git worktree**, created by the orchestrator from branch `orvex/improvement-report` after the previous wave was merged (normally `/home/crew/workspace/codex-plugin-cc-lanes/m2-events` on branch `lane/m2-events`; use the path you were given). Paths below are relative to your worktree root, and `plugins/codex/scripts/` holds the runtime. The other lanes of your wave run at the same time in their own worktrees, and the orchestrator merges every lane of the wave afterwards. **File ownership is what keeps those merges conflict-free**, so respect it exactly.
- **Beads:** run `bd` from the main checkout: `cd /home/crew/workspace/codex-plugin-cc && bd update <id> --claim` for each bead listed above. If a bead is already claimed (another lane of the same item claimed it), skip the claim and still add your note. At the end, run `bd note <id> "<one paragraph: lane m2-events; what changed, tests added, npm test result, open risks>"` for each bead. **Never** run `bd close`: the orchestrator closes beads after review.
- **Git:** do **not** run `git commit`, `git add`, `git stash`, `git push`, `git reset`, `git checkout -- <path>`, `git restore`, `git clean`, `git mv` or `git rm`, and do not create branches or worktrees. The orchestrator commits with explicit pathspecs. Read-only git (`status`, `diff`, `log`, `show`) is fine. (Tests may of course run git inside their own temp repos.)
- **File ownership:** edit **only** the files listed under "Files you own". "Do not touch" lists files owned by lanes that run at the same time as you. If you think a change outside your files is needed, do not make it; describe it under "Risks / follow-ups" in your final report. One standing exception: you may append new `CODEX_COMPANION_*` env var names to the `LEAKY_ENV` array in `scripts/run-tests.mjs` (append only, at the end of the array, one name per line).
- **Tools:** use the Serena MCP tools if they are available **and** their active project is your worktree (check with `get_current_config` or `activate_project <your worktree path>`); never edit through a Serena instance bound to another checkout. Function names in this brief are authoritative; line numbers quoted from the report are approximate (±40 lines) and predate M0/M1.
- **Read the merged code first:** M0 and M1 are merged before you start. This brief refers to their modules by the names planned in `docs/IMPLEMENTATION-PLAN.md` (D3-D9): `lib/process.mjs` (`isProcessAlive`, `readProcessStartTime`, `isSameProcess`, `terminateProcessTreeVerified`), `lib/exit-codes.mjs` (`EXIT`, `exitCodeForJob`, `isActiveJobStatus`, `TERMINAL_STATUSES`), `lib/job-liveness.mjs` (`startHeartbeat`, `readHeartbeat`, `resolveHeartbeatFile`, `reconcileJob`, `reconcileJobDeep`), `lib/control-channel.mjs` (`appendControlOp`, `readControlOps`, `ackControlOp`, `waitForControlAck`), the owner lease and `task --attach`/`--detach`, broker leases, the `CODEX_JOB` launch line, the codex-config tier and the bypass built-in. Read those modules and the functions this brief names **before** writing tests. Where the merged code differs from a planned name or field, the merged code wins: adapt, and list the difference in your report.
- **Protocol authority:** `docs/app-server-probe.md` and `docs/codex-native-surfaces.md` record what codex-cli 0.157 really does. Where the report guessed differently, the probe wins, and this brief already applies it (section "Probe adjustments"). You may run `codex app-server generate-ts --out <fresh temp dir> --experimental` to read the generated protocol types. **Never** start a real Codex thread or turn, never run `codex queue`, and never touch the real `~/.codex` (reading `~/.codex/models_cache.json` or `codex debug models` output is allowed where this brief says so). Tests use the fake-Codex fixture only.
- **No new dependencies:** the runtime is plain Node (>= 18.18) with no npm runtime dependencies. Do not add packages; write small helpers instead.
- **Tests first:** start by writing the new tests in your lane's own test file(s), using the fake-Codex fixture (`tests/fake-codex-fixture.mjs`) and `tests/helpers.mjs`. Run them and confirm they fail, then implement. Only modify an existing test file where this brief explicitly allows it: those tests intentionally lock the old behaviour. If any other existing test starts failing, your code is wrong, not the test.
- **Test hygiene:** in tests, use short intervals set through env vars (`CODEX_COMPANION_HEARTBEAT_MS`, `CODEX_COMPANION_OWNER_TTL_MS`, `CODEX_COMPANION_CANCEL_GRACE_MS`, and the ones you add); avoid real multi-second waits wherever possible. SIGKILL every process your tests spawn, in `t.after`. Never touch the real `~/.codex` or real plugin state; `scripts/run-tests.mjs` already isolates TMPDIR and config.
- **Definition of done:** `npm test` from your worktree root is fully green at the end. Run it once **before** you change anything and record the pass count; the count at the end must be higher (your new tests) with 0 failures. Paste the final summary lines into your report.
- **Scope:** implement exactly the items below. Do not refactor unrelated code, rename files or reformat. Keep the Windows code paths intact (they are not tested here). Keep every existing `--json` field (add fields, never remove or rename them) and bump nothing in `package.json`/`plugin.json`.
- **Plan authority:** `docs/IMPLEMENTATION-PLAN.md` records the cross-lane decisions. Where this brief narrows or changes the report, the brief wins and says so explicitly.

## Files you own

- `plugins/codex/scripts/lib/events.mjs` (new)
- `plugins/codex/scripts/lib/tracked-jobs.mjs`
- `plugins/codex/scripts/lib/codex.mjs`
- `plugins/codex/scripts/codex-companion.mjs`
- `plugins/codex/commands/logs.md` (new)
- `plugins/codex/skills/codex-drive/SKILL.md`
- `tests/commands.test.mjs` (only the command-file list assertion in "continue is not exposed as a user-facing command", and new assertions for `logs.md`)
- `tests/fake-codex-fixture.mjs`
- `tests/helpers.mjs`
- `tests/events.test.mjs` (new)

## Do not touch

- Lane `m2-snapshot-lib` runs at the same time and owns: `plugins/codex/scripts/lib/git-snapshot.mjs`, `tests/git-snapshot.test.mjs`.
- Lane `m2-report-lib` runs at the same time and owns: `plugins/codex/scripts/lib/task-report.mjs`, `plugins/codex/scripts/lib/json-schema.mjs`, `plugins/codex/schemas/task-report.schema.json`, `plugins/codex/schemas/task-result.schema.json`, `tests/task-report.test.mjs`.
- Lane `m2-transcript-lib` runs at the same time and owns: `plugins/codex/scripts/lib/transcript.mjs`, `tests/transcript-lib.test.mjs`, `tests/fixtures/rollouts/`.
- `lib/job-control.mjs`, `lib/render.mjs`, `lib/state.mjs`, `lib/app-server.mjs`, `app-server-broker.mjs`, hooks, `README.md`.
- Any existing test file not listed under "Files you own" (add your tests in your own new test files).

## Design decisions binding on this lane

- **Event file and record (binding contract).** `resolveEventsFile(workspaceRoot, jobId)` → `<jobsDir>/<jobId>.events.jsonl`. One JSON object per line: `{seq, ts, jobId, threadId, turnId, source, type, phase, data}`. `seq` is an integer that starts at 1 and increases by exactly 1 per line for the life of the job, **including across several turns of the same job** (FR-9 later runs more turns inside one job): a writer that opens an existing file continues from its last `seq`. `ts` is ISO-8601. `source` is `"root"` or `"subagent:<label>"` (use `labelForThread` in `lib/codex.mjs`). `phase` is the job phase at emission time or null. Writes are `fs.appendFileSync` of one full line (so a line is never torn across processes).
- **Event types and `data` shapes (binding; later lanes add types but never change these):**
  - `turn.started` `{turnId}`; `turn.completed` `{turnId, status}`
  - `command.started` `{itemId, command, cwd}`; `command.completed` `{itemId, command, cwd, exitCode, durationMs, status, outputTail}` where `command` is the **full** untruncated command and `outputTail` is the last 8KB (UTF-8 safe) of `aggregatedOutput`
  - `file.changed` `{itemId, changes:[{path, kind}], diffRef}` (`diffRef` null for now; FR-3 fills `live.diff`)
  - `message.agent` `{itemId, text, phase}` (`text` capped at 8KB with a `…[truncated]` suffix)
  - `reasoning.summary` `{text}` (capped at 8KB)
  - `tool.call` `{itemId, kind, server, tool, status}` for `mcpToolCall`, `dynamicToolCall` and collab/other tool items
  - `web.search` `{itemId, query}`
  - `steer.delivered` `{messageId, text}` (text capped at 2KB)
  - Reserved names that later lanes will emit (do not emit them here, but `formatCompactEvent` must render any unknown type generically): `command.output`, `plan.updated`, `usage.updated` (m2-capture), `idle.nudge` (m2-worker-idle), `turn.interrupted`, `budget.wrap-up` (M3), `server-request.rejected` (M6), `job.warning` (M6).
- **`lib/events.mjs` exports (binding):** `resolveEventsFile(workspaceRoot, jobId)`; `createEventWriter(workspaceRoot, jobId)` → `{append(type, data, {threadId, turnId, source, phase}) → seq}`; `readEvents(file, {since = 0, types = null, limit = Infinity})` → `{events, nextSeq}` (partial-last-line safe; skips malformed lines); `followEvents(file, {since, types, pollMs = 250, onEvent, isDone})` → Promise resolved when `isDone()` returns true after a final drain; `formatCompactEvent(event)` → one line, **always under 200 characters** (truncate with `…`); `EVENT_TYPES` (frozen array of the types above).
- **Emission path.** In `lib/codex.mjs`, the item/turn handlers already call `emitProgress` with a short message. Extend the progress payload with an optional `event: {type, data, threadId, turnId, source}` field (built next to `describeStartedItem`/`describeCompletedItem` and in `applyTurnNotification` for `turn/started`/`turn/completed`, and in `startInboxSteering` after a steer is accepted). `normalizeProgressEvent` in `lib/tracked-jobs.mjs` passes `event` through, and `createProgressReporter` gains an `eventWriter` option that appends it. `runTrackedJob` (and the foreground path) creates the writer for the job, so both background workers and foreground tasks write events.
- **WISH-1 (human log).** The log line keeps the short form for stderr and the status preview (`stderrMessage`), but the log gets the full command. A `fileChange` logs up to 10 paths with their kind (`+N more` beyond that). A command that exits non-zero logs its duration and its last 3 output lines. Keep existing message texts where tests assert them (search `tests/` for the strings before changing any).
- **`events <id> [--since <seq>] [--follow] [--types a,b] [--json|--compact]`.** Default output is `--compact` lines; `--json` prints `{schemaVersion:2, jobId, events, nextSeq}` (without `--follow`) or one JSON event per line (with `--follow`). `--follow` streams until the job is **terminal** (reconciled with the file-only `reconcileJob`; a `turn.completed` event triggers an immediate status check), drains the remaining events, and exits with `exitCodeForJob(status, {mode:"wait"})`. It must not stop at a `turn.completed` while the job is still active (FR-9 later runs several turns per job).
- **`logs <id> [--tail N] [--follow] [--json]`.** Prints the text log (`--tail` default 50 lines); `--follow` tails until the job is terminal and exits like `events --follow`; `--json` prints `{schemaVersion:2, jobId, logFile, lines}`.
- **Id resolution:** both resolve ids across sessions and workspaces with the same resolver `status <id>` uses (index, then job file, then `findJobAcrossWorkspaces`; plan D6). Unknown id: exit 3, `No job found for "<ref>"`.
- **Docs (FR-1 follow-through, plan D8):** add model-invocable `commands/logs.md` (`/codex:logs`, documents `logs` and `events`, exact flags from `--help`), add the `observe` rows (`status`, `logs --follow`, `events`) to the verb table in `skills/codex-drive/SKILL.md`, update the `commands/` file-list assertion in `tests/commands.test.mjs`, and add an assertion that `logs.md` does not disable model invocation. Add both subcommands to `printUsage`/`--help`.

## Implementation guide

- `lib/codex.mjs`: `applyTurnNotification`, `describeStartedItem`, `describeCompletedItem`, `recordItem`, `emitProgress`, `emitLogEvent`, `startInboxSteering` (steer accepted), `shorten` (keep for stderr only), `labelForThread`.
- `lib/tracked-jobs.mjs`: `normalizeProgressEvent`, `createProgressReporter`, `createJobProgressUpdater`, `runTrackedJob`, `appendLogLine`/`appendLogBlock`.
- `codex-companion.mjs`: `main` switch, `printUsage`/`USAGE`, the job-reference resolver used by `handleStatus`; add `handleEvents` and `handleLogs`.
- Throughput: never read the whole events file on each append; the writer keeps `seq` in memory after one initial tail read.

## Fake-Codex fixture

The fixture API from lane `m0-fixture` (plan D2), in short: `installFakeCodex(binDir, behavior, options)`; `setFakeCodexOptions(binDir, patch)`; `options.turnScript` steps (`command`, `fileChange` with `writeFiles`, `agentMessage`, `reasoning`, `plan`, `diff`, `usage`, `delay`, `silence`, `serverRequest`); `options.interrupt: "cooperate"|"ignore"|"ack-only"`; `options.ignoreSigterm`; `options.delays.{initialize,threadStart,turnStart}`; `options.models`, `options.config`, `options.writeRollout`, `options.forceActiveWriter`, `options.turnStatus`; methods `model/list`, `config/read`, `thread/read`; `readFakeRpcLog(binDir, {method, conn, dir})`, `fakeConnections(binDir)`; `occupyBroker(endpoint, {holdMs})`; `startFakeAppServer(binDir)`; helpers `spawnStubborn()`, `waitFor()`, `isPidAlive()`, `makeCompanionWorkspace()`. M0/M1 lanes extended it further, so **read the fixture source for the exact signatures** before writing tests. Note: the fixture answers `thread/unload`, but the real codex-cli 0.157 app-server does **not** have it (probe §6), so plugin code must never call it.

**You own the fixture files in this wave.** If you need a capability that is missing, add it **additively** (new options, new turnScript step types, new helpers) and keep every existing behaviour string and option working. Where the fixture's shapes differ from `docs/app-server-probe.md` ("Fixture shapes"), make the fixture match the probe for the methods you touch.

Add two turnScript capabilities that lane `m2-report` (next wave) needs for FR-5 attribution tests, and document them in the fixture header comment: (1) `command` steps accept `writeFiles: [{path, content}]`, written relative to the thread cwd **between** that command's `item/started` and `item/completed` (simulating a shell edit made by the command); (2) a new step `{type:"externalWrite", path, content}` that writes a file relative to the thread cwd **without** emitting any item (simulating an edit by another session while no command runs). Add a smoke test for both in `tests/events.test.mjs` or a small section of your own test file.

## Tests to write first

`tests/events.test.mjs` (use `makeCompanionWorkspace`, a `turnScript` with 2 `command` steps, one with a 200-character command and `exitCode: 1` plus multi-line output, 1 `fileChange` with 3 paths, an `agentMessage` and a `reasoning` step):
1. `seq` is 1..N with no gaps; `command.completed` carries the full 200-character command, `exitCode` and `durationMs`; `file.changed` lists all 3 paths with kinds.
2. `events <id> --since 3 --json` returns only `seq > 3`, and `nextSeq` is correct.
3. `events <id> --follow` on a running job (scripted `delay`s) terminates after the job completes, exit 0; on a `turnStatus:"failed"` job, exit 1.
4. Every `--compact` line is under 200 characters (include a 5KB agent message and a 1KB command).
5. `--types command.completed,file.changed` filters.
6. `logs <id> --tail 5` and `logs <id> --follow` (terminates, right exit code); unknown id exits 3.
7. WISH-1: the log contains the untruncated 200-character command; the 3 file paths; the failing command's duration and last 3 output lines; stderr progress keeps the short form.
8. A job resolved from another session (different `CODEX_COMPANION_SESSION_ID`) still works with `events`/`logs`.
9. Writer continuity: two writers opened one after the other on the same job continue `seq` without gaps (unit test of `createEventWriter`).
10. Fixture smoke: `command.writeFiles` and `externalWrite` really write their files.

## Requirements from the report (verbatim)

The text below is copied verbatim from `docs/IMPROVEMENT-REPORT.md`. Line numbers in it predate M0/M1. The "Probe adjustments" and "Design decisions" sections of this brief override it where they differ.

### FR-2: A structured event stream (`events.jsonl`) with `events`, `logs` and `tail` subcommands that Monitor can follow
- **Priority:** P1
- **Problem:** The only progress channel is a human-readable log (96-char commands, counts instead of paths). The only CLI view is `status`, with 4 lines, and only for queued, running or failed jobs. There is no way to stream a running job.
- **Evidence:** E3. `lib/tracked-jobs.mjs` `createProgressReporter` 117-132. `lib/job-control.mjs` 9 and 56-76 (`DEFAULT_MAX_PROGRESS_LINES=4`) and 165-169. `lib/codex.mjs` 390-449 (`shorten(...,96)`).
- **Proposal:**
  1. `createProgressReporter` also appends each normalized event to `jobs/<id>.events.jsonl` as `{seq, ts, jobId, threadId, turnId, source:'root'|'subagent:<label>', type, phase, data}`. Types include `turn.started`, `command.started`, `command.completed` (full command, cwd, exitCode, durationMs, outputTail ≤ 8KB), `file.changed` (paths, kind, diff or diff-ref), `message.agent`, `reasoning.summary`, `plan.updated`, `tool.call`, `web.search`, `steer.delivered`, `usage.updated` and `turn.completed`. Writes are append-only and flushed per line.
  2. Add `events <id> [--since <seq>] [--follow] [--types a,b] [--json|--compact]`. `--compact` lines are under 200 characters. `--follow` exits after `turn.completed` or a terminal status, with the job's exit code.
  3. Add `logs <id> [--tail N] [--follow] [--json]`, which reads the text log.
  4. Both resolve ids across sessions and workspaces.
- **Acceptance criteria:** A fixture task with 2 commands and 1 file change produces monotonic `seq` values, an untruncated command with exitCode, and `file.changed` with paths. `events --since 3 --json` returns only `seq>3`. `--follow` terminates after `turn.completed` with the right exit code. Every `--compact` line is under 200 characters.

### WISH-1: Log full commands, file paths and failure output tails in the human log
- **Priority:** P3 (a quick win; do it alongside FR-2)
- **Problem:** The same shortened message feeds stderr and the log, so commands appear at 96 characters. File changes are logged as `Applying N file change(s)` with no paths. Failing commands have no duration and no output tail.
- **Evidence:** E3. `lib/codex.mjs` 394-402 and 419-431. `lib/tracked-jobs.mjs` 126-128.
- **Proposal:** Write the full command to the log and keep the short form for stderr and the preview. Log up to 10 paths with their kind (`+N more` beyond that). On a non-zero exit, log the duration and the last 3 output lines.
- **Acceptance criteria:** A 200-character command appears untruncated in the log. A fileChange with 3 paths logs all 3. A failing command's entry includes its output tail.

### 8.1 Companion CLI (`orvex-codex <cmd>` ≡ `node scripts/codex-companion.mjs <cmd>`)

All commands accept `--json`. The JSON output carries `schemaVersion`. Canonical exit codes (every item above defers to this table):

| Code | Meaning |
|---|---|
| 0 | ok, or the job completed |
| 1 | the job failed (`wait` also returns 1 for cancelled, for backward compatibility with today's 0/1/124 contract) |
| 2 | usage or validation error, unknown model, invalid structured output, or `cancel-failed` (the JSON `error.code` tells them apart) |
| 3 | the job is `lost` or `orphaned` |
| 4 | the job itself ended `timed-out` (FR-17) |
| 124 | the *waiter* timed out; the job is still running |
| 130 | the job was cancelled or interrupted (`attach` and foreground `task`) |

```
task [prompt|--prompt-file f|stdin]
     [--attach|--follow | --background [--detach] | (foreground default)] [--timeout-ms N]
     [--profile p] [--sandbox m | --read-only | --write | --full-access] [--network|--no-network]
     [--model m|-m] [--effort e] [--cwd d|-C] [--name n]
     [--resume [last|<jobId>|<threadId>]] [--thread <threadId>] [--resume-last] [--fresh]
     [--worktree[=name]] [--base ref] [--shared-tree]
     [--output-schema file|builtin:task-report] [--expect-changes]
     [--max-runtime dur] [--idle-timeout dur]
     [--on-owner-exit cancel|continue] [--owner-pid pid] [--on-writer-conflict fork|wait|fail]
     [-c key=value]... [--codex-profile p] [--developer-instructions f] [--lane-preamble f|builtin:delegated-worker]
     [--skills off|allow:glob|deny:glob] [--hooks off] [--no-agents-md]
     [--format brief|full|json] [--max-chars N] [--progress-stderr] [--stream]
send <jobId> [msg|--prompt-file|stdin] [--interrupt] [--timeout-ms N] [--wait-delivery] [--no-follow-up] [runtime flags] [--background|--attach]
interrupt <jobId> [--then msg|--prompt-file f]
unsend <jobId> <msgId>
messages <jobId>
cancel [<jobId>|--all [--workspace|--everywhere]|--group g] [--grace-ms N] [--force]
wait [ids...] [--any] [--group g] [--timeout-ms N] [--poll-interval-ms N] [--format brief|json]
attach <jobId> [--follow]     adopt <jobId>
status [<jobId>] [--all] [--all-sessions|--workspace] [--lines N] [--full] [--wait --timeout-ms N]
result [<jobId>] [--partial] [--report-only] [--diff] [--files] [--format brief|full|json] [--output f]
events <jobId> [--since seq] [--follow] [--types a,b] [--compact]
logs <jobId> [--tail N] [--follow]
diff <jobId> [--stat|--name-only]
transcript <jobId|threadId> [--format md|jsonl] [--items ...] [--last N] [--max-bytes N]
fork <jobId|threadId> [prompt] [--background|--attach] [runtime flags]
fanout --spec f|- [--max-parallel N] [--group g] [--worktree] [--output-schema ...] [--attach]
worktree list | merge <jobId> [--ff-only|--squash] | discard <jobId> | pr <jobId>
models [--all] [--refresh]
config show | set <key> <value> [--global|--repo] | unset <key> [...] | doctor
setup [existing flags] [--profile p] [--default-profile p] [--alias name=id|name=none]
      [--default-* for every key in §8.4] [--print-claude-md] [--install-cli]
broker status | logs [--tail N] | restart | stop [--if-idle]
gc [--older-than dur] [--keep N] [--dry-run]     history [--since dur]
lane-context     mcp                               (stdio MCP server)
review / adversarial-review [--background|--attach] [--effort e] [--model m] ...   (existing + WISH-3)
```

The launch line (first line of stdout, text mode): `CODEX_JOB <jobId> status=<queued|running> thread=<id|pending> sandbox=<m> network=<eff> log=<path>`

## Probe adjustments and scope narrowing (binding; they override the verbatim text above)

- The notification shapes for `item/started`/`item/completed` are unchanged by the probe. `item/commandExecution/outputDelta`, `turn/diff/updated`, `turn/plan/updated` and `thread/tokenUsage/updated` are **not** handled in this lane (lane `m2-capture`); only reserve their event names.

## Acceptance checklist (report PASS/FAIL per line)

- [ ] A fixture task with 2 commands and 1 file change produces monotonic `seq` values, an untruncated command with exitCode, and `file.changed` with paths
- [ ] `events --since 3 --json` returns only `seq>3`
- [ ] `--follow` terminates after the job is terminal (not at an intermediate `turn.completed`) with the right exit code
- [ ] Every `--compact` line is under 200 characters
- [ ] `logs <id> [--tail N] [--follow] [--json]` works; both subcommands resolve ids across sessions and workspaces
- [ ] WISH-1: a 200-character command appears untruncated in the log; a fileChange with 3 paths logs all 3; a failing command's entry includes its duration and output tail
- [ ] `commands/logs.md` exists, is model-invocable, and the drive skill lists `logs`/`events`; `tests/commands.test.mjs` updated only as allowed
- [ ] Fixture: `command.writeFiles` and `externalWrite` steps exist and are smoke-tested
- [ ] `npm test` green in your worktree; no existing test edited except where this brief allows it

## Required final report (your last message; use exactly these sections)

```
## Lane m2-events report
### Files changed
- <path>: <one line on what changed>
### Tests added
- <test file>: <test name> (covers <item / criterion>)
### npm test
<paste the final summary lines: tests N, pass N, fail 0, duration; and the count before you started>
### Acceptance criteria
- [PASS|FAIL|PARTIAL] <criterion text> (evidence: <test name, command + output, or file:function>)
  ... one line for every criterion in the checklist above ...
### Contracts for other lanes
- <every exported function, file format, job-record field, CLI flag or event type you added that another lane will use, with its exact signature/shape>
### Differences from the brief
- <planned names or fields that differed in the merged code, and what you did>
### Beads
- <bead id>: claimed (or already claimed), note added (not closed)
### Risks / follow-ups
- <deviations from the brief and why; anything out of scope; any change needed in a file you do not own>
```
