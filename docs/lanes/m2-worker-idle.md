# Lane `m2-worker-idle`: Worker-side idle detection, final-summary nudge, partial results on stop, and the recorded rollout path (BUG-17, FR-7)

- **Beads:** `codex-plugin-cc-yew.8`, `codex-plugin-cc-yew.6`
- **Report items:** BUG-17, FR-7. **Scope in this lane:** the **worker halves**: BUG-17 (`lastEventAt`, the automatic nudge, persisting a partial result on cancel/timeout) and FR-7's `job.rolloutPath` recording. Status display of idleness is lane `m2-status-lib` (concurrent); the idle-timeout **interrupt** is FR-17 (M3).
- **Milestone / wave:** M2, wave 3. **Depends on:** wave 2 (`m2-capture`, `m2-report` merged). **Runs concurrently with:** `m2-status-lib`.

## Goal

A job once finished its work, went silent for 9+ minutes, never produced its final summary, and still showed `running`; its result was lost. Make the worker track when it last heard from Codex, nudge Codex once for a final summary after an idle threshold, and persist whatever it has (last agent message, files, commands) as a partial result when a turn is cancelled or times out. Also record each job's rollout path as soon as the thread exists.

## Ground rules (non-negotiable)

- **Worktree:** you work in your **own git worktree**, created by the orchestrator from branch `orvex/improvement-report` after the previous wave was merged (normally `/home/crew/workspace/codex-plugin-cc-lanes/m2-worker-idle` on branch `lane/m2-worker-idle`; use the path you were given). Paths below are relative to your worktree root, and `plugins/codex/scripts/` holds the runtime. The other lanes of your wave run at the same time in their own worktrees, and the orchestrator merges every lane of the wave afterwards. **File ownership is what keeps those merges conflict-free**, so respect it exactly.
- **Beads:** run `bd` from the main checkout: `cd /home/crew/workspace/codex-plugin-cc && bd update <id> --claim` for each bead listed above. If a bead is already claimed (another lane of the same item claimed it), skip the claim and still add your note. At the end, run `bd note <id> "<one paragraph: lane m2-worker-idle; what changed, tests added, npm test result, open risks>"` for each bead. **Never** run `bd close`: the orchestrator closes beads after review.
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

- `plugins/codex/scripts/lib/codex.mjs`
- `plugins/codex/scripts/lib/tracked-jobs.mjs`
- `plugins/codex/scripts/lib/job-liveness.mjs`
- `tests/fake-codex-fixture.mjs`
- `tests/helpers.mjs`
- `tests/idle.test.mjs` (new)

## Do not touch

- Lane `m2-status-lib` runs at the same time and owns: `plugins/codex/scripts/lib/partial-result.mjs`, `plugins/codex/scripts/lib/job-control.mjs`, `plugins/codex/scripts/lib/render.mjs`, `tests/status-lib.test.mjs`.
- `codex-companion.mjs` (lane `m2-inspect`, next wave, adds CLI flags; you need none).
- Any existing test file not listed under "Files you own" (add your tests in your own new test files).

## Design decisions binding on this lane

- **`lastEventAt` (binding contract with `m2-status-lib`):** the worker updates an in-memory `lastEventAt` on every app-server notification for its turn. `startHeartbeat` in `lib/job-liveness.mjs` gains an optional `extra: () => object` whose fields are merged into each heartbeat write, and the worker passes `() => ({lastEventAt})`. `readHeartbeat(file).lastEventAt` is therefore the live value (no `state.lock` churn). The worker also writes `lastEventAt` to the job record when the job ends.
- **Nudge:** in the turn loop (`runAppServerTurn`/`captureTurn`), a timer checks idleness every second. When no notification has arrived for `idleNudgeMs` while the turn is active, send **one** `turn/steer` on the worker's own client with the text `Return your final summary now.` (reuse the steer request path of `startInboxSteering`, including `expectedTurnId`), log `[codex] idle for <N>s; sent final-summary nudge`, emit an `idle.nudge` event `{idleMs, delivered}`, and set `job.idleNudgedAt`. At most one nudge per turn. `idleNudgeMs` = env `CODEX_COMPANION_IDLE_NUDGE_MS` (add to `LEAKY_ENV`), else config `idleNudgeMs` (`getConfig`/`getGlobalConfig`), else 180000; `0` disables. A nudge that is rejected (e.g. the turn is a native review, which cannot be steered) is logged, not retried.
- **Partial result on stop:** when a turn ends `interrupted`/cancelled, or the job is finalised as `cancelled`/`timed-out`/`cancel-failed` by the control channel (read `runTrackedJob`'s control-driven finalisation from `m0-cancel`), persist `result` = `{schemaVersion:2, status, partial:true, threadId, turnIds, rawOutput: <last agent message so far or "">, lastAgentMessage, reasoningSummary, touchedFiles, report:{filesChanged, commands} (via buildTaskReport when data exists), undeliveredMessages}`. `result <id>` then returns it (it already reads `storedJob.result`). A SIGKILLed worker cannot do this; `m2-status-lib`'s `buildPartialResult` covers that case from events.
- **Rollout path (FR-7):** `thread/start`, `thread/resume` and `thread/fork` responses carry `thread.path` (probe §4/§5/§6; null for ephemeral threads). `runAppServerTurn` emits it in the "Thread ready" progress payload (`rolloutPath`) and returns it; `createJobProgressUpdater` persists `job.rolloutPath` immediately. If it is null for a persistent thread, call `thread/read {threadId}` once after the turn and use `thread.path`; do not pass `includeTurns:true` (it errors before a turn exists).

## Implementation guide

- `lib/codex.mjs`: `captureTurn`, `runAppServerTurn`, `startInboxSteering` (reuse its steer call), `startThread`/`resumeThread`/fork call (read `thread.path`).
- `lib/tracked-jobs.mjs`: `runTrackedJob` (finalisation paths from `m0-cancel`), `createJobProgressUpdater`.
- `lib/job-liveness.mjs`: `startHeartbeat` (`extra`), `readHeartbeat`.

## Fake-Codex fixture

The fixture API from lane `m0-fixture` (plan D2), in short: `installFakeCodex(binDir, behavior, options)`; `setFakeCodexOptions(binDir, patch)`; `options.turnScript` steps (`command`, `fileChange` with `writeFiles`, `agentMessage`, `reasoning`, `plan`, `diff`, `usage`, `delay`, `silence`, `serverRequest`); `options.interrupt: "cooperate"|"ignore"|"ack-only"`; `options.ignoreSigterm`; `options.delays.{initialize,threadStart,turnStart}`; `options.models`, `options.config`, `options.writeRollout`, `options.forceActiveWriter`, `options.turnStatus`; methods `model/list`, `config/read`, `thread/read`; `readFakeRpcLog(binDir, {method, conn, dir})`, `fakeConnections(binDir)`; `occupyBroker(endpoint, {holdMs})`; `startFakeAppServer(binDir)`; helpers `spawnStubborn()`, `waitFor()`, `isPidAlive()`, `makeCompanionWorkspace()`. M0/M1 lanes extended it further, so **read the fixture source for the exact signatures** before writing tests. Note: the fixture answers `thread/unload`, but the real codex-cli 0.157 app-server does **not** have it (probe §6), so plugin code must never call it.

**You own the fixture files in this wave.** If you need a capability that is missing, add it **additively** (new options, new turnScript step types, new helpers) and keep every existing behaviour string and option working. Where the fixture's shapes differ from `docs/app-server-probe.md` ("Fixture shapes"), make the fixture match the probe for the methods you touch.

Make `thread/start`/`resume`/`fork` responses include `thread.path` (a real rollout file under `$CODEX_HOME/sessions/...` when `options.writeRollout` is true, otherwise null), matching the probe's `ThreadStartResponse`. A turnScript `silence` step must still accept `turn/steer` and, with a new option `steerEndsSilence: {text}`, respond to the first steer by emitting that agent message and completing the turn (so the nudge test can observe a final summary).

## Tests to write first

`tests/idle.test.mjs` (`CODEX_COMPANION_IDLE_NUDGE_MS=600`, short heartbeat):
1. A turn that does a `fileChange` then `silence` receives exactly one `turn/steer` with the nudge text (RPC log), an `idle.nudge` event is written, and with `steerEndsSilence` the job completes with that summary as its result.
2. `readHeartbeat(...).lastEventAt` advances while events flow and stops advancing during silence.
3. Cancel a job during `silence` (no nudge configured, `0`): `result <id> --json` returns `partial:true`, the last agent message emitted before the silence, and the files changed.
4. `job.rolloutPath` is set as soon as the thread is ready (poll the job file during a `delay`), with `writeRollout:true`, and equals the fixture's rollout file.
5. Nudge disabled with `0`: no steer is sent.

## Requirements from the report (verbatim)

The text below is copied verbatim from `docs/IMPROVEMENT-REPORT.md`. Line numbers in it predate M0/M1. The "Probe adjustments" and "Design decisions" sections of this brief override it where they differ.

### BUG-17: Job stays `running` long after Codex's work is done (post-work stall, no final message)
- **Observed:** job `task-mugvt911` finished its edits, restart and validation at 11:37:48, then produced no events for 9+ minutes while status still showed `running` with the same last progress lines; it never emitted its final summary and had to be cancelled. The Claude-side result was therefore lost.
- **Proposal:** covered in part by FR-17 (idle timeout) and FR-8 (partial results). Additionally: record `lastEventAt` in job state and show "idle for Ns" in `status`; after a configurable idle threshold, send an automatic nudge (`send` "Return your final summary now") before interrupting; on cancel/timeout, persist the last agent message and the event log as the job's partial result so `result <id>` still returns something useful.
- **Acceptance:** a fake-codex fixture that goes silent after file changes surfaces `idle` in status, receives one nudge, and on cancel `result <id>` returns the last agent message plus files changed.

### FR-7: Expose the Codex rollout path and add a `transcript` subcommand
- **Priority:** P1
- **Problem:** The job record keeps `threadId`, and status and result print `codex resume <threadId>`, but no rollout path is stored and nothing renders the conversation. After a cancel, a restart or (today) a SessionEnd purge, Claude cannot reconstruct what Codex did. Task threads *are* persistent (`persistThread:true` → `ephemeral:false`); only reviews and the stop gate are ephemeral. So rollouts should exist.
- **Evidence:** E3, E4. `codex-companion.mjs` ~720. `lib/codex.mjs` 1162, 1260, 1281, 1291 and 803 (`CODEX_HOME` used only for transfer). `lib/render.mjs` 103-106, 165-166 and 449-490.
- **Proposal:** After the thread starts, resolve the rollout via `thread/read` if it returns a path. Otherwise glob `$CODEX_HOME/sessions/**/rollout-*-<threadId>.jsonl`, with `CODEX_HOME` defaulting to `~/.codex`. Store it as `rolloutPath` and show it in status and result. Add `transcript <jobId|threadId> [--format md|jsonl] [--items messages,commands,reasoning,files,steers] [--last N] [--max-bytes N]`. It renders the prompt, steer messages, agent messages, reasoning summaries, commands with exit codes and file paths. It prefers the rollout, falls back to `events.jsonl`, and works while the job is still running. Make review persistence configurable (`reviewPersist`).
- **Acceptance criteria:** A fixture task with a temp `CODEX_HOME` sets `job.rolloutPath`. `transcript <id> --format md` includes the prompt, every steer message and each command with its exit code. `--max-bytes 4000` gives at most 4000 bytes, ending with a truncation marker. It works mid-turn.

## Probe adjustments and scope narrowing (binding; they override the verbatim text above)

- Probe §7: native **review** turns reject `turn/steer` (`cannot steer a review turn`). The nudge therefore applies to task turns only; skip it for review jobs.
- Probe §5/§6: the rollout path comes from `thread.path` in the start/resume/fork/read responses; `includeTurns:true` must not be used before the first turn.
- `codex queue` only schedules a later turn (native surfaces §2); it is not a nudge mechanism. Use `turn/steer`.

## Acceptance checklist (report PASS/FAIL per line)

- [ ] BUG-17: a fake-codex fixture that goes silent after file changes receives one nudge (and the nudge is logged and evented)
- [ ] BUG-17: on cancel, `result <id>` returns the last agent message plus files changed (`partial:true`)
- [ ] `lastEventAt` is recorded (heartbeat side file while running, job record at the end) without taking `state.lock` on every event
- [ ] FR-7: a fixture task with a temp `CODEX_HOME` sets `job.rolloutPath` (from `thread.path`), as soon as the thread is ready
- [ ] The nudge is configurable (`CODEX_COMPANION_IDLE_NUDGE_MS`, config `idleNudgeMs`) and `0` disables it
- [ ] `npm test` green in your worktree; no existing test edited except where this brief allows it

## Required final report (your last message; use exactly these sections)

```
## Lane m2-worker-idle report
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
