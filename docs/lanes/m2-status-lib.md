# Lane `m2-status-lib`: Partial results and fuller status snapshots (library and rendering) (FR-8, BUG-17)

- **Beads:** `codex-plugin-cc-yew.7`, `codex-plugin-cc-yew.8`
- **Report items:** FR-8, BUG-17. **Scope in this lane:** the **library and rendering halves** of FR-8 and BUG-17's status display: `lib/partial-result.mjs`, richer `status` snapshots in `lib/job-control.mjs`, and rendering in `lib/render.mjs` (including `rolloutPath`). CLI flags (`status --lines/--full`, `result --partial`) are lane `m2-inspect` (wave 4).
- **Milestone / wave:** M2, wave 3. **Depends on:** wave 2 (`m2-capture`, `m2-report` merged). **Runs concurrently with:** `m2-worker-idle`.

## Goal

`result` throws "still running", `status` shows 4 truncated lines for a subset of statuses, and nothing tells Claude a job has gone idle. Build the data layer: a partial-result builder that works for running and dead jobs from `events.jsonl` (falling back to the log), and status snapshots that carry the last message, the full last command, the current plan, counts, idleness, a runtime badge and the rollout path, for every status.

## Ground rules (non-negotiable)

- **Worktree:** you work in your **own git worktree**, created by the orchestrator from branch `orvex/improvement-report` after the previous wave was merged (normally `/home/crew/workspace/codex-plugin-cc-lanes/m2-status-lib` on branch `lane/m2-status-lib`; use the path you were given). Paths below are relative to your worktree root, and `plugins/codex/scripts/` holds the runtime. The other lanes of your wave run at the same time in their own worktrees, and the orchestrator merges every lane of the wave afterwards. **File ownership is what keeps those merges conflict-free**, so respect it exactly.
- **Beads:** run `bd` from the main checkout: `cd /home/crew/workspace/codex-plugin-cc && bd update <id> --claim` for each bead listed above. If a bead is already claimed (another lane of the same item claimed it), skip the claim and still add your note. At the end, run `bd note <id> "<one paragraph: lane m2-status-lib; what changed, tests added, npm test result, open risks>"` for each bead. **Never** run `bd close`: the orchestrator closes beads after review.
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

- `plugins/codex/scripts/lib/partial-result.mjs` (new)
- `plugins/codex/scripts/lib/job-control.mjs`
- `plugins/codex/scripts/lib/render.mjs`
- `tests/status-lib.test.mjs` (new)

## Do not touch

- Lane `m2-worker-idle` runs at the same time and owns: `plugins/codex/scripts/lib/codex.mjs`, `plugins/codex/scripts/lib/tracked-jobs.mjs`, `plugins/codex/scripts/lib/job-liveness.mjs`, `tests/fake-codex-fixture.mjs`, `tests/helpers.mjs`, `tests/idle.test.mjs`.
- Any existing test file not listed under "Files you own" (add your tests in your own new test files).

## Design decisions binding on this lane

- **`lib/partial-result.mjs`: `buildPartialResult(workspaceRoot, job)`** → `{schemaVersion:2, jobId, status, partial:true, lastAgentMessage, reasoningSummary, filesChanged:[{path, kind}], commands:[{command, exitCode, status, durationMs}], counts:{commands, failedCommands, filesChanged}, lastEventAt, rolloutPath, source:"events"|"log"}` from `readEvents` (`lib/events.mjs`): `counts.commands` = number of `command.completed` events; `failedCommands` = those with non-zero exit; `filesChanged` = distinct paths of `file.changed`. Without an events file, parse the text log (best effort) and set `source:"log"`. Must be cheap (read the file once).
- **Snapshots (`lib/job-control.mjs`):** `buildSingleJobSnapshot(cwd, ref, {maxProgressLines = 4, full = false})` returns progress lines for **every** status (completed, failed, cancelled included), keeps agent-message blocks when `full` is true, and adds `lastMessage`, `lastCommand` (full text), `currentPlan` (`job.plan`), `counts`, `idleSec` (active jobs only: now − `readHeartbeat(worker hb).lastEventAt`, falling back to `job.lastEventAt`/`updatedAt`), `rolloutPath`, and `schemaVersion: 2`. `buildStatusSnapshot` adds `schemaVersion: 2` and a `badge` per row. Keep all existing fields.
- **Rendering (`lib/render.mjs`):** export `formatRuntimeBadge(runtime)` → e.g. `[FULL-ACCESS+NET]`, `[WRITE]`, `[WRITE+NET]`, `[READ-ONLY]` from the **effective** sandbox and network (WISH-2 reuses it later). Status rows show the badge; an active job idle for more than `CODEX_COMPANION_IDLE_DISPLAY_SEC` (default 30; add to `LEAKY_ENV`) shows `idle for <N>s`; single-job details show `lastMessage` (first 3 lines), `lastCommand`, the plan, counts, and `Rollout: <path>` when `job.rolloutPath` is set (contract with `m2-worker-idle`, which records it concurrently; test with a hand-written job record).

## Implementation guide

- `lib/job-control.mjs`: `buildSingleJobSnapshot`, `buildStatusSnapshot`, `enrichJob`, `readJobProgressPreview`, `DEFAULT_MAX_PROGRESS_LINES`.
- `lib/render.mjs`: `renderStatusReport`, `renderJobStatusReport`, `pushJobDetails`, `formatRuntime`.
- `readHeartbeat`/`resolveHeartbeatFile` from `lib/job-liveness.mjs` (read-only use; the `lastEventAt` field is added concurrently by `m2-worker-idle`, so treat it as optional).

## Fake-Codex fixture

The fixture API from lane `m0-fixture` (plan D2), in short: `installFakeCodex(binDir, behavior, options)`; `setFakeCodexOptions(binDir, patch)`; `options.turnScript` steps (`command`, `fileChange` with `writeFiles`, `agentMessage`, `reasoning`, `plan`, `diff`, `usage`, `delay`, `silence`, `serverRequest`); `options.interrupt: "cooperate"|"ignore"|"ack-only"`; `options.ignoreSigterm`; `options.delays.{initialize,threadStart,turnStart}`; `options.models`, `options.config`, `options.writeRollout`, `options.forceActiveWriter`, `options.turnStatus`; methods `model/list`, `config/read`, `thread/read`; `readFakeRpcLog(binDir, {method, conn, dir})`, `fakeConnections(binDir)`; `occupyBroker(endpoint, {holdMs})`; `startFakeAppServer(binDir)`; helpers `spawnStubborn()`, `waitFor()`, `isPidAlive()`, `makeCompanionWorkspace()`. M0/M1 lanes extended it further, so **read the fixture source for the exact signatures** before writing tests. Note: the fixture answers `thread/unload`, but the real codex-cli 0.157 app-server does **not** have it (probe §6), so plugin code must never call it.

**You do not own the fixture files in this wave** (lane `m2-worker-idle` does). Do not edit `tests/fake-codex-fixture.mjs` or `tests/helpers.mjs`. If you need something the fixture lacks, write a small local helper inside your own test file, or record the gap as a follow-up.

## Tests to write first

`tests/status-lib.test.mjs` (hand-written job records, events and log files in a temp state dir, plus one real fixture run where useful):
1. `buildPartialResult` mid-turn after one `message.agent` event returns it as `lastAgentMessage`; `counts.commands` equals the number of `command.completed` events; the log fallback works without an events file.
2. `buildSingleJobSnapshot(..., {maxProgressLines: 20})` returns up to 20 lines for a **completed** job.
3. A command longer than 96 characters appears intact as `lastCommand` in the snapshot JSON.
4. `idleSec` from a heartbeat with `lastEventAt` 45s ago; the rendered row shows `idle for 45s` (fake `now`).
5. `formatRuntimeBadge` for the four sandbox/network combinations; the badge appears on rendered rows.
6. `rolloutPath` renders in single-job details; `schemaVersion: 2` is present.

## Requirements from the report (verbatim)

The text below is copied verbatim from `docs/IMPROVEMENT-REPORT.md`. Line numbers in it predate M0/M1. The "Probe adjustments" and "Design decisions" sections of this brief override it where they differ.

### FR-8: Partial results and fuller status for running jobs
- **Priority:** P2
- **Problem:** `resolveResultJob` throws "still running". `status` has no `--lines` or `--full`; `maxProgressLines` exists in `buildSingleJobSnapshot` but is never wired to the CLI. There is no preview for completed or cancelled jobs, and agent-message blocks are filtered out of the preview. `/codex:status` says to render a compact table without progress. There is no `schemaVersion`.
- **Evidence:** E3. `lib/job-control.mjs` 9, 165-169 and 280-286. `codex-companion.mjs` `handleStatus` ~1332-1357. `commands/status.md` 10-13.
- **Proposal:** Add `result <id> --partial [--json]`, returning `lastAgentMessage`, the reasoning summary so far, `filesChanged` and `commands`, read from events or the log. Add `status --lines N` and `--full`, both covering all statuses, plus `lastMessage`, `lastCommand` (full text), `currentPlan` and `counts:{commands, failedCommands, filesChanged}`. Add `schemaVersion` to `status --json`. Show a sandbox and network badge on each row (WISH-2).
- **Acceptance criteria:** Mid-turn, after one agent message, `result <id> --partial --json` returns it. `status <id> --lines 20` returns up to 20 lines for a completed job. `counts.commands` equals the number of `command.completed` events. A command longer than 96 characters appears intact in `status <id> --json`.

### BUG-17: Job stays `running` long after Codex's work is done (post-work stall, no final message)
- **Observed:** job `task-mugvt911` finished its edits, restart and validation at 11:37:48, then produced no events for 9+ minutes while status still showed `running` with the same last progress lines; it never emitted its final summary and had to be cancelled. The Claude-side result was therefore lost.
- **Proposal:** covered in part by FR-17 (idle timeout) and FR-8 (partial results). Additionally: record `lastEventAt` in job state and show "idle for Ns" in `status`; after a configurable idle threshold, send an automatic nudge (`send` "Return your final summary now") before interrupting; on cancel/timeout, persist the last agent message and the event log as the job's partial result so `result <id>` still returns something useful.
- **Acceptance:** a fake-codex fixture that goes silent after file changes surfaces `idle` in status, receives one nudge, and on cancel `result <id>` returns the last agent message plus files changed.

## Probe adjustments and scope narrowing (binding; they override the verbatim text above)

- Not protocol-dependent.

## Acceptance checklist (report PASS/FAIL per line)

- [ ] Mid-turn, after one agent message, the partial-result builder returns it (library level; `result --partial --json` CLI is lane `m2-inspect`)
- [ ] The single-job snapshot returns up to N lines (20 in the test) for a completed job
- [ ] `counts.commands` equals the number of `command.completed` events
- [ ] A command longer than 96 characters appears intact in the status JSON
- [ ] `schemaVersion` in the status snapshot JSON; a sandbox and network badge on each row
- [ ] BUG-17: status surfaces `idle` ("idle for Ns") for an active job with no recent events
- [ ] `rolloutPath` is shown in status and result details when recorded
- [ ] `npm test` green in your worktree; no existing test edited except where this brief allows it

## Required final report (your last message; use exactly these sections)

```
## Lane m2-status-lib report
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
