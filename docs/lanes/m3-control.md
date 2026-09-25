# Lane `m3-control`: `interrupt --then` on the same job, and per-job wall-clock and idle budgets (FR-9, FR-17)

- **Beads:** `codex-plugin-cc-e8s.4`, `codex-plugin-cc-e8s.7`
- **Report items:** FR-9, FR-17. **Scope in this lane:** the worker and CLI for FR-9 (including the `/codex:interrupt` command and the FR-1 criterion deferred to FR-9 by plan D8) and all of FR-17.
- **Milestone / wave:** M3, wave 2. **Depends on:** wave 1 (`m3-resume`, `m3-session-start`, `m3-control-lib` merged). **Runs concurrently with:** `m3-reattach-lib`.

## Goal

When plans change mid-task, Claude can only steer (which Codex may absorb late) or cancel (which kills the job). Add an interrupt that stops the current turn and immediately starts a new one on the same thread inside the same job. And give every job an optional wall-clock budget and idle timeout, enforced by the worker with a wrap-up warning and a truthful `timed-out` status.

## Ground rules (non-negotiable)

- **Worktree:** you work in your **own git worktree**, created by the orchestrator from branch `orvex/improvement-report` after the previous wave was merged (normally `/home/crew/workspace/codex-plugin-cc-lanes/m3-control` on branch `lane/m3-control`; use the path you were given). Paths below are relative to your worktree root, and `plugins/codex/scripts/` holds the runtime. The other lanes of your wave run at the same time in their own worktrees, and the orchestrator merges every lane of the wave afterwards. **File ownership is what keeps those merges conflict-free**, so respect it exactly.
- **Beads:** run `bd` from the main checkout: `cd /home/crew/workspace/codex-plugin-cc && bd update <id> --claim` for each bead listed above. If a bead is already claimed (another lane of the same item claimed it), skip the claim and still add your note. At the end, run `bd note <id> "<one paragraph: lane m3-control; what changed, tests added, npm test result, open risks>"` for each bead. **Never** run `bd close`: the orchestrator closes beads after review.
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

- `plugins/codex/scripts/codex-companion.mjs`
- `plugins/codex/scripts/lib/codex.mjs`
- `plugins/codex/scripts/lib/tracked-jobs.mjs`
- `plugins/codex/scripts/lib/control-channel.mjs`
- `plugins/codex/scripts/lib/job-budget.mjs`
- `plugins/codex/scripts/lib/render.mjs`
- `plugins/codex/commands/interrupt.md` (new)
- `plugins/codex/skills/codex-drive/SKILL.md`
- `tests/commands.test.mjs` (only the command-file list and new assertions for `interrupt.md`)
- `tests/fake-codex-fixture.mjs`
- `tests/helpers.mjs`
- `tests/interrupt.test.mjs` (new)
- `tests/budget.test.mjs` (new)

## Do not touch

- Lane `m3-reattach-lib` runs at the same time and owns: `plugins/codex/scripts/lib/job-control.mjs`, `plugins/codex/scripts/lib/job-adopt.mjs`, `tests/reattach-lib.test.mjs`.
- Any existing test file not listed under "Files you own" (add your tests in your own new test files).

## Design decisions binding on this lane

- **`interrupt <job-id> [--then <message> | --prompt-file <f>] [--json]`**, alias `send <job-id> --interrupt <message>`: reconcile the job; if it is not active, say so and exit 0 (or 3 for lost/orphaned, per §8.1). Append `appendInterruptOp`, wait for the worker's ack (`CODEX_COMPANION_CONTROL_ACK_MS`), report `{jobId, turnInterrupted, newTurnId}` (the latter when `--then` was given). If the worker is dead, fall back to the verified cancel path's recorded-endpoint interrupt (never spawn an app-server) and report that no follow-up turn could be started.
- **Worker (`lib/codex.mjs` control loop from `m0-cancel`):** on `{op:"interrupt", then}`: `turn/interrupt` on its own client, wait for `turn/completed` (grace `CODEX_COMPANION_CANCEL_GRACE_MS`), emit `turn.interrupted`, then, if `then` is present, `turn/start` on the **same threadId** with the same runtime (model, effort, outputSchema) and `then.text` as input, restart inbox steering for the new turnId, and continue capturing inside the same job. Without `then`, the job ends with status **`interrupted`** (terminal; resumable later with `task --resume <id>`), `phase:"interrupted"`.
- **`job.turns[]`:** `{turnId, startedAt, endedAt, status, promptExcerpt (≤200 chars), endedBy: null|"interrupt"|"budget"}` appended per turn; the stored result gets `turnIds` for every turn and a `turns` summary; `renderTaskResult` (or the companion's composition) shows each turn (`Turn 1 (interrupted) … Turn 2 (completed)`). `turnId` on the job stays the latest turn.
- **Events/attach interplay:** a `turn.completed` for the interrupted turn must not end `events --follow` or an attach watcher (they wait for a terminal job status; verify with a test).
- **FR-17 flags:** `task --max-runtime <dur> --idle-timeout <dur>` (and on `send` follow-ups), `setup --default-max-runtime <dur|none>` and `setup --default-idle-timeout <dur|none>` `[--global]` (config keys `defaultMaxRuntime`, `defaultIdleTimeout`, stored as the original strings and parsed with `parseDuration`). Invalid durations → exit 2 before any job record.
- **FR-17 worker:** a 1s budget tick (`CODEX_COMPANION_BUDGET_TICK_MS`, add to `LEAKY_ENV`) calls `evaluateBudget` with `lastEventAt` (from `m2-worker-idle`). `wrap-up` → append the wrap-up text to the job's **inbox** as a normal steer message with id `budget-<n>` (so it is delivered by the existing steering path, recorded in the inbox and as `steer.delivered`), plus a `budget.wrap-up` event. `interrupt` → append a control op `{op:"cancel", reason:"max-runtime"|"idle-timeout"}` to its own job (one stop path, as ownership does); the control-driven finalisation maps these two reasons to status **`timed-out`** (not `cancelled`), `cancelReason` = the reason, and keeps the `cancel` block. If the turn does not stop within the grace period, the worker escalates like the verified cancel does for its own direct app-server (terminate the child, verified) and records the outcome.
- **Exit codes:** `wait` and `attach` exit **4** for `timed-out` (already in `exitCodeForJob`; verify); a waiter timeout is still 124.
- **Docs:** `commands/interrupt.md` (model-invocable; FR-1's deferred criterion), the `redirect` row (`interrupt --then`) in the drive skill alongside the `cancel` + `send <id>` fallback, and `--max-runtime`/`--idle-timeout` in the launch row. Update the command-list assertion in `tests/commands.test.mjs` and assert `interrupt.md` does not disable model invocation.

## Implementation guide

- `codex-companion.mjs`: `main` (`interrupt` case), `handleSend` (`--interrupt`), `handleTask`/`buildTaskRequest`, `handleSetup`, `printUsage`, the cancel internals (`cancelJob`) for the dead-worker fallback.
- `lib/codex.mjs`: the control loop added by `m0-cancel`, `runAppServerTurn`, `captureTurn`, `startInboxSteering`. `lib/tracked-jobs.mjs`: `runTrackedJob` finalisation (status mapping), `createJobProgressUpdater` (`turns[]`).
- `lib/control-channel.mjs`, `lib/job-budget.mjs`: owned this wave for integration fixes.

## Fake-Codex fixture

The fixture API from lane `m0-fixture` (plan D2), in short: `installFakeCodex(binDir, behavior, options)`; `setFakeCodexOptions(binDir, patch)`; `options.turnScript` steps (`command`, `fileChange` with `writeFiles`, `agentMessage`, `reasoning`, `plan`, `diff`, `usage`, `delay`, `silence`, `serverRequest`); `options.interrupt: "cooperate"|"ignore"|"ack-only"`; `options.ignoreSigterm`; `options.delays.{initialize,threadStart,turnStart}`; `options.models`, `options.config`, `options.writeRollout`, `options.forceActiveWriter`, `options.turnStatus`; methods `model/list`, `config/read`, `thread/read`; `readFakeRpcLog(binDir, {method, conn, dir})`, `fakeConnections(binDir)`; `occupyBroker(endpoint, {holdMs})`; `startFakeAppServer(binDir)`; helpers `spawnStubborn()`, `waitFor()`, `isPidAlive()`, `makeCompanionWorkspace()`. M0/M1 lanes extended it further, so **read the fixture source for the exact signatures** before writing tests. Note: the fixture answers `thread/unload`, but the real codex-cli 0.157 app-server does **not** have it (probe §6), so plugin code must never call it.

**You own the fixture files in this wave.** If you need a capability that is missing, add it **additively** (new options, new turnScript step types, new helpers) and keep every existing behaviour string and option working. Where the fixture's shapes differ from `docs/app-server-probe.md` ("Fixture shapes"), make the fixture match the probe for the methods you touch.

Make sure a scripted turn that is interrupted in `cooperate` mode ends with `turn/completed` `status:"interrupted"` and that a **second** `turn/start` on the same thread plays `options.turnScript2` (or the same `turnScript` again when unset), so the follow-up turn can be scripted separately.

## Tests to write first

`tests/interrupt.test.mjs`:
1. On a long scripted turn, `interrupt <id> --then 'service already restarted; skip step 3'` → RPC log shows `turn/interrupt` followed by `turn/start` on the same threadId, with that exact input text; one job id; `turns.length == 2`; `result <id>` shows both turns.
2. Without `--then`: status `interrupted`; `wait <id>` exits 1 and `task --attach`-style exit is 130 (use `exitCodeForJob` or an attach run); `task --resume <id> 'continue'` resumes the thread.
3. `send <id> --interrupt 'msg'` is equivalent to `interrupt --then`.
4. An `events --follow` started before the interrupt keeps running through the first `turn.completed` and exits after the second turn completes.
5. `interrupt` on a finished job reports it and exits 0; on a dead worker (SIGKILL) it reports that no follow-up could be started.
`tests/budget.test.mjs`:
6. `--max-runtime 5s` on a long turn ends `timed-out` within ~7s; the fixture received `turn/interrupt`; `wait <id>` exits 4; `cancelReason:"max-runtime"`.
7. The 80% wrap-up message is recorded in the inbox and as a `budget.wrap-up` event (and delivered as a steer).
8. `--idle-timeout 1s` fires when the fixture goes `silence`; `cancelReason:"idle-timeout"`.
9. `wait <other-running-id> --timeout-ms 1000` exits 124 and that job is still running.
10. `setup --default-max-runtime 5s` applies to a bare task; `--max-runtime none` overrides it; an invalid duration exits 2 with no job.

## Requirements from the report (verbatim)

The text below is copied verbatim from `docs/IMPROVEMENT-REPORT.md`. Line numbers in it predate M0/M1. The "Probe adjustments" and "Design decisions" sections of this brief override it where they differ.

### FR-9: Interrupt and redirect on the same thread and the same job
- **Priority:** P1
- **Problem:** When plans change mid-task (E6), Claude can steer with `send`, which Codex may absorb late, or cancel, which kills the worker. There is no primitive that interrupts the current turn and immediately starts a new turn on the same thread. The multi-step fallback (`cancel`, then `send <jobId> msg` on the now-finished job) works but is undocumented, creates a new job id, and may fork (BUG-11).
- **Evidence:** E6. `codex-companion.mjs` `handleCancel` ~1441-1501 and `handleSend` ~1146-1195. `lib/codex.mjs` 1109-1149 and 150-232.
- **Proposal:** Add `interrupt <job-id> [--then <message>|--prompt-file f] [--json]`, with the alias `send <job-id> --interrupt <message>`. It uses the BUG-2 control channel (`{op:'interrupt', then}`). The worker calls `turn/interrupt`, waits for the turn to end, and if a message was given, issues `turn/start` on the same threadId with the same runtime, inside the same job. The job gains `turns[]` (`turnId`, `startedAt`, `endedAt`, `status`, `prompt excerpt`), and the result shows every turn. Without `--then` the job ends as `interrupted`, which is a terminal status that can be resumed by id. Expose it as the model-invocable `/codex:interrupt`, and document it in `codex:drive` alongside the `cancel` + `send <id>` fallback. Also generalize the worker so the same job can accept a `{op:'continue', text}` after natural completion, if that is cheap. Otherwise keep follow-up jobs.
- **Acceptance criteria:** On a long fake turn, `interrupt <id> --then 'service already restarted; skip step 3'` produces `turn/interrupt` followed by `turn/start` on the same threadId, under one job id with `turns.length==2`, and `result <id>` shows both. Without `--then`, status is `interrupted`, and `task --resume <id>` resumes the thread.

### FR-17: Per-job wall-clock budget and idle timeout with automatic interrupt
- **Priority:** P2
- **Problem:** A runaway job can run indefinitely against a live system. The only timeouts are on the caller side (wait at 1h, status `--wait`, steer and import requests).
- **Evidence:** E1. `codex-companion.mjs` ~99-101. `lib/tracked-jobs.mjs` `runTrackedJob` 139-207 (no deadline). `lib/codex.mjs` ~52, ~119 and 532-542.
- **Proposal:** Add `task --max-runtime <dur>` and `--idle-timeout <dur>` (no events for that long), plus `setup --default-max-runtime`. The worker enforces them: at 80% of the budget it delivers a steer through the inbox ("wrap up; N minutes left"). At the limit it interrupts, then runs the BUG-2 escalation, and records `status:'timed-out'` with `cancelReason:'max-runtime'` or `'idle-timeout'`. `wait` and attach exit **4** for a timed-out job, so Claude can tell "the job hit its budget" (4) apart from "the waiter gave up while the job still runs" (124). See the exit-code table in §8.1.
- **Acceptance criteria:** `--max-runtime 5s` on a long fake turn ends as `timed-out` within about 7s, the fixture received `turn/interrupt`, and `wait <id>` exits 4. `wait <other-running-id> --timeout-ms 1000` exits 124 and the job is still running. `--idle-timeout` fires when the fixture goes silent. The 80% wrap-up steer is recorded in the inbox and events.

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

- `turn/interrupt` on a turn that already ended returns `no active turn to interrupt` (probe §9): treat that error as "already stopped", not as a failure.
- `turn/steer` requires `expectedTurnId` (probe §7): the wrap-up steer must target the current turn id.
- **Scope narrowing:** `{op:"continue"}` after natural completion is not implemented (see `m3-control-lib`); follow-up jobs remain.

## Acceptance checklist (report PASS/FAIL per line)

- [ ] FR-9: on a long fake turn, `interrupt <id> --then 'service already restarted; skip step 3'` produces `turn/interrupt` followed by `turn/start` on the same threadId, under one job id with `turns.length==2`, and `result <id>` shows both
- [ ] FR-9: without `--then`, status is `interrupted`, and `task --resume <id>` resumes the thread
- [ ] FR-9: `send <id> --interrupt <msg>` alias works; `/codex:interrupt` exists and is model-invocable (FR-1's deferred criterion); the drive skill documents it with the `cancel` + `send <id>` fallback
- [ ] FR-17: `--max-runtime 5s` on a long fake turn ends as `timed-out` within about 7s, the fixture received `turn/interrupt`, and `wait <id>` exits 4
- [ ] FR-17: `wait <other-running-id> --timeout-ms 1000` exits 124 and the job is still running
- [ ] FR-17: `--idle-timeout` fires when the fixture goes silent
- [ ] FR-17: the 80% wrap-up steer is recorded in the inbox and events
- [ ] FR-17: `setup --default-max-runtime` (and `--default-idle-timeout`) work
- [ ] `npm test` green in your worktree; no existing test edited except where this brief allows it

## Required final report (your last message; use exactly these sections)

```
## Lane m3-control report
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
