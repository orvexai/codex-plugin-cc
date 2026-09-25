# Lane `m0-liveness`: Liveness, heartbeats, reconciliation, exit-code table, index truth (BUG-6, BUG-18)

- **Beads:** `codex-plugin-cc-1mh.4`, `codex-plugin-cc-1mh.10`
- **Report items:** BUG-6, BUG-18
- **Wave:** 2. **Depends on:** `m0-fixture`, `m0-prune`, `m0-cli-hygiene` (all Wave 1). **Runs concurrently with:** none (runs alone).

## Goal

Jobs whose worker died stay `queued`/`running` forever, and a running job whose index entry went missing is reported as "No job found" while `wait` exits 0. That fired Claude's completion notification while Codex was still editing. Build the shared liveness primitives (pid + start time, heartbeat side files, `reconcileJob`), the canonical exit-code table module, and job-file-as-source-of-truth lookup. Wire them into every place that trusts a stored status. Later lanes (cancel, ownership, SessionEnd, the hook ledger) reuse these primitives, so keep the APIs exactly as specified.

## Ground rules (non-negotiable)

- **Repository:** `/home/crew/workspace/codex-plugin-cc`, branch `orvex/improvement-report`. The working tree is **shared** with other lanes and Claude sessions. Paths below are relative to the repo root; `plugins/codex/scripts/` holds the runtime.
- **Beads:** at the start, run `bd update <id> --claim` for each bead listed above. At the end, run `bd note <id> "<one paragraph: what changed, tests added, npm test result, open risks>"` for each bead. **Never** run `bd close`: the orchestrator closes beads after review.
- **Git:** do **not** run `git commit`, `git add`, `git stash`, `git push`, `git reset`, `git checkout -- <path>`, `git restore` or `git clean`. The orchestrator commits with explicit pathspecs. Read-only git (`status`, `diff`, `log`, `show`) is fine.
- **File ownership:** edit **only** the files listed under "Files you own". "Do not touch" lists files owned by lanes that run at the same time as you. If you think a change outside your files is needed, do not make it; describe it under "Risks / follow-ups" in your final report. One standing exception: you may append new `CODEX_COMPANION_*` env var names to the `LEAKY_ENV` array in `scripts/run-tests.mjs`.
- **Tools:** use the Serena MCP tools if they are available (`initial_instructions` first, then `get_symbols_overview`, `find_symbol`, `find_referencing_symbols` and the symbolic edit tools). Function names in this brief are authoritative. Line numbers quoted from the report are approximate (±40 lines).
- **Tests first:** start by writing the new tests in your lane's own test file(s), using the fake-Codex fixture (`tests/fake-codex-fixture.mjs`: `installFakeCodex`, `buildEnv`, and the option and RPC-log helpers added by lane `m0-fixture`) and `tests/helpers.mjs`. Run them and confirm they fail, then implement. Only modify an existing test file where this brief explicitly allows it: those tests intentionally lock the old behaviour. If any other existing test starts failing, your code is wrong, not the test.
- **Test hygiene:** in tests, use short intervals set through env vars; avoid real 5s or 30s waits wherever possible. SIGKILL every process your tests spawn, in `t.after`. Never touch the real `~/.codex` or real plugin state; `scripts/run-tests.mjs` already isolates TMPDIR and config.
- **Definition of done:** `npm test` from the repo root is fully green at the end. It had 112 passing tests before M0, and the count only grows. Paste the final summary lines into your report.
- **Scope:** implement exactly the items below. Do not refactor unrelated code, rename files or reformat. Keep the Windows code paths intact (they are not tested here).
- **Plan authority:** `docs/IMPLEMENTATION-PLAN.md` records the cross-lane decisions (D1-D9). Where this brief narrows or changes the report, the brief wins and says so explicitly.

## Files you own

- `plugins/codex/scripts/lib/process.mjs`
- `plugins/codex/scripts/lib/exit-codes.mjs (new)`
- `plugins/codex/scripts/lib/job-liveness.mjs (new)`
- `plugins/codex/scripts/lib/job-control.mjs`
- `plugins/codex/scripts/lib/tracked-jobs.mjs`
- `plugins/codex/scripts/lib/state.mjs`
- `plugins/codex/scripts/codex-companion.mjs`
- `plugins/codex/scripts/stop-review-gate-hook.mjs`
- `tests/fake-codex-fixture.mjs`
- `tests/helpers.mjs`
- `tests/liveness.test.mjs`

## Do not touch

- No lane runs concurrently with you. Still, do **not** edit `plugins/codex/scripts/lib/codex.mjs`, `app-server-broker.mjs`, `lib/app-server.mjs`, `lib/broker-lifecycle.mjs`, `session-lifecycle-hook.mjs`, `commands/**`, `agents/**`, `skills/**`: later lanes own them, and this lane does not need them.
- Existing test files: do not modify any.

## Design decisions binding on this lane

Binding decisions (plan D3, D4, D5, D6):

- **`lib/process.mjs`** add and export: `isProcessAlive(pid)` (moved from `state.mjs`; make `state.mjs` import it and delete the private copy), `readProcessStartTime(pid)` (Linux: field 22 of `/proc/<pid>/stat`; parse after the last `)` because the command name may contain spaces or parens; macOS: `ps -o lstart= -p <pid>`; else `null`. Return an **opaque string**), and `isSameProcess({pid, startTime})` (alive, and if both start times are known they must be equal).
- **`lib/exit-codes.mjs`** (new): `EXIT = {OK:0, JOB_FAILED:1, USAGE:2, LOST:3, TIMED_OUT:4, WAITER_TIMEOUT:124, CANCELLED:130}`; `ACTIVE_STATUSES = new Set(["queued","running","cancel-pending"])`; `TERMINAL_STATUSES = new Set(["completed","failed","cancelled","cancel-failed","interrupted","timed-out","lost","orphaned"])`; `isActiveJobStatus(s)` is true for anything **not** terminal (unknown statuses are active); `exitCodeForJob(status, {mode})`, where `mode` is `"wait"|"attach"|"task"`. For `wait`: completed→0, failed→1, cancelled→1, interrupted→1, lost/orphaned→3, timed-out→4, cancel-failed→2. For `attach`/`task`: the same except cancelled/interrupted→130. Replace the companion's local `isActiveJobStatus` and `state.mjs`'s `TERMINAL_JOB_STATUSES` (from `m0-prune`) with these.
- **`lib/job-liveness.mjs`** (new): `resolveHeartbeatFile(workspaceRoot, jobId, kind = "worker")` → `jobs/<id>.hb` (`kind:"owner"` → `jobs/<id>.owner.hb`); `startHeartbeat(file, {intervalMs})` writes `{pid, startTime, at}` atomically (tmp + rename) immediately and then every `intervalMs` (default `Number(process.env.CODEX_COMPANION_HEARTBEAT_MS) || 5000`), and returns `{stop()}` (stop removes nothing). `readHeartbeat(file)` → object or null. `HEARTBEAT_STALE_MS` = `Number(process.env.CODEX_COMPANION_HEARTBEAT_STALE_MS) || 30000`. `assessJobLiveness(workspaceRoot, job, {now})` → `{alive, reason, heartbeatAgeSec}`. `reconcileJob(workspaceRoot, job, {now})`: **synchronous, file-only**, never calls an app-server. If the job is active and dead (worker pid not alive; or start time mismatch; or for `schemaVersion >= 2`, heartbeat older than stale; or `queued` with no live pid and older than 60s), persist under the state lock: `status:"lost"`, `phase:"worker-exited"`, `errorMessage:"worker exited without completion record"`, `completedAt`, keep `threadId`/`turnId`, `reconciledAt`. Append the log tail and a non-empty `.worker.err` excerpt to the job log. Return the updated job. Otherwise return the job unchanged. **Heartbeats never take `state.lock`.**
- **Job record v2** (plan D4): `createJobRecord` in `lib/tracked-jobs.mjs` stamps `schemaVersion: 2`. `runTrackedJob` records `worker: {pid, startTime, stderrFile}`, starts the worker heartbeat, and stops it in `finally`. v1 records (no `schemaVersion`) use the pid-only check.
- **Worker stderr:** move worker spawning into `lib/tracked-jobs.mjs` as `spawnTaskWorker({scriptPath, cwd, workspaceRoot, jobId, env})`, opening `jobs/<id>.worker.err` for append and passing its fd as stdio[2] (stdin/stdout stay ignored; keep `detached:true` + `unref()`). It returns `{pid, startTime, stderrFile}`. `spawnDetachedTaskWorker` in the companion calls it, and `enqueueBackgroundTask` records `worker` and `pid` in the queued record. Exporting it also lets tests spawn a worker for a hand-written broken job record.
- **Index truth (BUG-18, plan D6):** in `lib/job-control.mjs`, when a reference is not found in the `state.json` index (`matchJobReference` path via `buildSingleJobSnapshot`, `resolveCancelableJob`, `resolveResultJob`), fall back to the workspace's `jobs/<ref>.json` (exact id), then to a unique prefix match over `jobs/*.json` file names, then to `findJobAcrossWorkspaces`. When found, **repair** the index with `upsertJob`. A reference that still cannot be resolved throws an error with `exitCode = 3` and the message `No job found for "<ref>"`.
- **Reconcile call sites (all file-only):** `buildStatusSnapshot`, `buildSingleJobSnapshot`, `handleWait`'s poll loop, `deliverToRunningJob`, `resolveCancelableJob`, `resolveResultJob`, the resume candidate (`findLatestResumableTaskJob` / `resolveLatestTrackedTaskThread`), and the Stop hook's running-job note. The **deep** reconcile (`thread/read` → `orphaned` vs `completed` with `reconciled:true`) is **not** in this lane; lane `m0-cancel` adds it once transport is recorded. `lost` satisfies the BUG-6 acceptance criterion.
- **`wait` exit codes:** use `exitCodeForJob` with `mode:"wait"`, precedence waiter-timeout 124 > any lost/orphaned 3 > any failed/cancelled/interrupted 1 > 0. An unresolvable id exits 3 and **never 0**. `wait`, and `result` for a terminal job, call `markResultRead` (from `m0-prune`).
- **`send` to a dead worker:** `deliverToRunningJob` reconciles first. For a `lost` job, `send` behaves like a finished job: it starts a follow-up on the same `threadId` unless `--no-follow-up`, in which case it returns delivery status `lost`. **Brief deviation:** the report's "`task --resume <jobId>` continues a lost job" needs BUG-7 (M3); here you prove continuity with `send <lostJob> msg` instead.
- **`status --json`** adds `heartbeatAgeSec` and `worker.stderrFile` (only when the file is non-empty). The rendered status mentions the `.worker.err` path for a lost job whose file is non-empty.

## Implementation guide

- `lib/process.mjs`, `lib/exit-codes.mjs` (new), `lib/job-liveness.mjs` (new), `lib/state.mjs` (import `isProcessAlive`; use the `TERMINAL_STATUSES` import in `pruneJobs`).
- `lib/tracked-jobs.mjs`: `createJobRecord`, `runTrackedJob`, new `spawnTaskWorker`.
- `lib/job-control.mjs`: `enrichJob`, `buildStatusSnapshot`, `buildSingleJobSnapshot`, `matchJobReference`, `resolveJobWorkspace`, `resolveCancelableJob`, `resolveResultJob`, `readStoredJob`.
- `codex-companion.mjs`: `spawnDetachedTaskWorker`, `enqueueBackgroundTask`, `handleTaskWorker` (a crash before `runTrackedJob` must write a clear message plus stack to stderr, which now lands in `.worker.err`), `handleWait`, `handleResult`, `deliverToRunningJob`, `handleSend`, `findLatestResumableTaskJob`, `resolveLatestTrackedTaskThread`, `isActiveJobStatus` (delete it; import it instead), `main().catch` (honour `error.exitCode`).
- `stop-review-gate-hook.mjs`: reconcile the session's jobs (file-only) before choosing `runningJob`.
- Fixture: extend additively if you need to (you own it in this wave).

## Fake-Codex fixture API (from lane `m0-fixture`)

The fixture API from lane `m0-fixture` (see `docs/IMPLEMENTATION-PLAN.md` D2), in short: `installFakeCodex(binDir, behavior, options)`; `setFakeCodexOptions(binDir, patch)`; `options.turnScript` steps (`command`, `fileChange`, `agentMessage`, `reasoning`, `plan`, `diff`, `usage`, `delay`, `silence`, `serverRequest`); `options.interrupt: "cooperate"|"ignore"|"ack-only"`; `options.ignoreSigterm`; `options.delays.{initialize,threadStart,turnStart}`; `options.models`, `options.config`, `options.forceActiveWriter`; `readFakeRpcLog(binDir, {method, conn})`, `fakeConnections(binDir)`; `occupyBroker(endpoint, {holdMs})`; helpers `spawnStubborn()`, `waitFor()`, `isPidAlive()`, `makeCompanionWorkspace()`, `startFakeAppServer()`. Read the fixture source for the exact signatures before writing tests. If you need a fixture capability that is missing, add it **additively** (this lane owns the fixture files in this wave) and keep every existing behaviour string working.

## Tests to write first

`tests/liveness.test.mjs` (fake fixture: a slow scripted turn, e.g. `turnScript: [{type:"delay", ms:60000}]` or behaviour `interruptible-slow-task`; set `CODEX_COMPANION_HEARTBEAT_MS=200` and `CODEX_COMPANION_HEARTBEAT_STALE_MS=1500`):
1. Background job, SIGKILL its worker pid (`status --json` → `worker.pid`). The next `status <id> --json` shows `lost` with `threadId` set; `wait <id> --json --poll-interval-ms 200` exits 3 within about 1s.
2. Worker crash before `runTrackedJob`: hand-write a queued job record without `request`, spawn it with `spawnTaskWorker`, and wait for the pid to exit. `.worker.err` is non-empty, and `status <id>` (text and `--json`) references it and shows `lost`.
3. Pid-reuse guard: a running record whose `worker.pid` is a live process (e.g. `spawnStubborn()`) but whose `worker.startTime` is `"bogus"` → reconciled to `lost`.
4. Heartbeat staleness: a v2 running record with a live pid but a heartbeat file older than stale → `lost`. A v1 record (no `schemaVersion`) with a live pid is **not** reconciled.
5. BUG-18: start a background slow job, delete its entry from `state.json` (keep the job file). `status <id>`, `wait <id> --timeout-ms 500` (exits 124, not 0 and not "No job found") and `result <id>` all resolve it, and the index entry is restored. `wait no-such-id` exits 3.
6. Exit-code table unit tests for `exitCodeForJob` (every status × mode).
7. `send <lostJob> "msg"` creates a follow-up job on the same threadId; `send <lostJob> "msg" --no-follow-up` returns `lost`.
8. The Stop hook with a lost job does not report it as running.
9. `result <id>` sets `resultReadAt`.

## Requirements from the report (verbatim)

The text below is copied verbatim from `docs/IMPROVEMENT-REPORT.md`. You do not need to read the rest of the report.

### BUG-6: Jobs whose worker died stay queued or running forever (no liveness check)
- **Priority:** P0 (one reader rated it P1; raised because it is the root of E4's ambiguity and blocks `wait`, `--resume-last` and cancel)
- **Problem:** Workers are detached with stdio ignored. Suppose a worker crashes before `runTrackedJob` writes `running` (for example "No stored job found"), is SIGKILLed or OOM-killed, or dies with the host, or a foreground companion is killed. The record stays `queued` or `running`, and its stderr is lost. `enrichJob`, `buildStatusSnapshot`, `buildSingleJobSnapshot`, `handleWait`, `deliverToRunningJob`, `resolveCancelableJob`, `resolveResultJob` and the resume candidate all trust the stored status. As a result, `wait` blocks until its 1h default. `send` returns `queued` after 20s as though delivery were pending. `--resume-last` refuses ("task still running"). The Stop hook reports ghost jobs. A pid-liveness helper `isProcessAlive` exists in `lib/state.mjs` (~87-98) but is used only for the state lock.
- **Evidence:** E4, E1. `codex-companion.mjs` `spawnDetachedTaskWorker` ~911-922, resume refusal ~545-551, `deliverToRunningJob` ~1082-1105, `handleWait` ~1221-1272, `DEFAULT_WAIT_TIMEOUT_MS` ~99. `lib/job-control.mjs` `enrichJob` ~158-181 and ~225-265. `scripts/stop-review-gate-hook.mjs` ~151-154. `lib/state.mjs` ~87-98.
- **Proposal:**
  1. Move `isProcessAlive` to `lib/process.mjs` and export it. Add a pid-reuse guard: record `workerStartTime` (from `/proc/<pid>/stat` field 22 on Linux, `ps -o lstart=` on macOS) and compare it.
  2. The worker writes `heartbeatAt` every 5s. It can go in the job file under the lock, or in a cheap separate file `jobs/<id>.hb` (preferred, to avoid lock churn).
  3. Add a shared `reconcileJob(job)` called from `buildStatusSnapshot`, `buildSingleJobSnapshot`, `handleWait`'s poll loop, `deliverToRunningJob`, `resolveCancelableJob`, `resolveResultJob` and the resume-candidate lookup. If the job is active and the pid is dead, or the heartbeat is older than 30s:
     - if a threadId exists, call `thread/read`. If the turn is still running on the broker, set `status:'orphaned'` and suggest `cancel`. If the turn has finished, reconcile to `completed` or `failed`, recover the final message, and set `reconciled:true`.
     - otherwise set `status:'lost'`, `phase:'worker-exited'`, `errorMessage:'worker exited without completion record'`, append the log tail, and keep the threadId so the job can still be resumed.
  4. `wait` treats `lost` and `orphaned` as terminal (exit 3). `send` to a dead worker returns `lost` (FR-20).
  5. Redirect worker stderr to `jobs/<id>.worker.err` instead of `'ignore'`. `status` references it when it is non-empty.
  6. Show `heartbeatAgeSec` in `status --json`.
- **Acceptance criteria:**
  - SIGKILL a background worker (fake fixture). The next `status <id> --json` shows `lost` (or `orphaned`, or `completed` with `reconciled:true`, depending on the fake thread's state) with a threadId, and `wait <id>` exits 3 within one poll interval.
  - A worker that throws before `runTrackedJob` leaves a non-empty `.worker.err` that status references.
  - `task --resume <jobId>` (BUG-7) continues a `lost` job's thread.

### BUG-18: `wait` / `result` report "No job found" for a job that is still running
- **Observed:** job `task-mugwj8mj-gnhojx` was started with `task --background` from Bash. While it was still running (its `jobs/<id>.json` said `status: running` and its log was growing), `wait <id>` exited 0 with `No job found for "task-mugwj8mj-gnhojx"`, and `result <id>` returned the same. The job's `.json` and `.log` were present in `state/<workspace>/jobs/`; only the index in `state.json` had lost the entry (suspected pruning or session-scoped filtering, see BUG-3/BUG-14). Because `wait` exited 0, Claude's completion notification fired while Codex was still editing files.
- **Proposal:** resolve job ids from `jobs/<id>.json` when they're missing from the index, and rebuild the index from the files. Never prune a job whose status isn't terminal. `wait` must exit non-zero (e.g. 3) when a job can't be found, never 0.
- **Acceptance:** after deleting a running job's entry from `state.json`, `status <id>`, `wait <id>` and `result <id>` still resolve it from its job file; `wait` on an unknown id exits non-zero.

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

## Acceptance checklist (report PASS/FAIL per line)

- [ ] SIGKILL a background worker (fake fixture): the next `status <id> --json` shows `lost` with a threadId, and `wait <id>` exits 3 within one poll interval
- [ ] A worker that throws before `runTrackedJob` leaves a non-empty `.worker.err` that status references
- [ ] (Brief-adjusted, BUG-7 is M3) `send <lostJob> msg` continues the lost job's thread via a follow-up job
- [ ] Pid-reuse guard: start-time mismatch → lost; `heartbeatAgeSec` in `status --json`
- [ ] After deleting a running job's entry from `state.json`, `status <id>`, `wait <id>` and `result <id>` still resolve it from its job file (index repaired)
- [ ] `wait` on an unknown id exits non-zero (3), never 0
- [ ] `lib/exit-codes.mjs` implements report §8.1 and is the only `isActiveJobStatus` in the codebase
- [ ] Heartbeats never take `state.lock`; reconcile is file-only (no app-server calls)
- [ ] `npm test` green with no existing test modified

## Required final report (your last message; use exactly these sections)

```
## Lane m0-liveness report
### Files changed
- <path>: <one line on what changed>
### Tests added
- <test file>: <test name> (covers <item / criterion>)
### npm test
<paste the final summary lines: tests N, pass N, fail 0, duration>
### Acceptance criteria
- [PASS|FAIL|PARTIAL] <criterion text> (evidence: <test name, command + output, or file:function>)
  ... one line for every criterion in the checklist above ...
### Beads
- <bead id>: claimed, note added (not closed)
### Risks / follow-ups
- <deviations from the brief and why; anything out of scope; any change needed in a file you do not own>
```
