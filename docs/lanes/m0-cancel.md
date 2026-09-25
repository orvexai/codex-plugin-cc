# Lane `m0-cancel`: Verified cancel state machine and worker control channel (BUG-2)

- **Beads:** `codex-plugin-cc-1mh.5`
- **Report items:** BUG-2
- **Wave:** 3. **Depends on:** `m0-liveness`. **Runs concurrently with:** none (runs alone).

## Goal

`cancel` always writes `cancelled` whatever happened. It can interrupt the wrong app-server (it may even spawn a fresh one), it never escalates to SIGKILL, and it never verifies. Build the durable **control channel** that the worker polls, record each job's transport, and implement the verified cancel sequence with truthful statuses (`cancelled` only when the stop is verified, otherwise `cancel-failed` and exit 2). The control channel is reused by SessionEnd (BUG-3), ownership (BUG-1), `interrupt --then` (FR-9) and timeouts (FR-17), so build it to the API below.

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

- `plugins/codex/scripts/lib/control-channel.mjs (new)`
- `plugins/codex/scripts/lib/codex.mjs`
- `plugins/codex/scripts/lib/app-server.mjs`
- `plugins/codex/scripts/lib/process.mjs`
- `plugins/codex/scripts/lib/tracked-jobs.mjs`
- `plugins/codex/scripts/lib/job-control.mjs`
- `plugins/codex/scripts/lib/job-liveness.mjs`
- `plugins/codex/scripts/lib/render.mjs`
- `plugins/codex/scripts/codex-companion.mjs`
- `tests/fake-codex-fixture.mjs`
- `tests/helpers.mjs`
- `tests/cancel.test.mjs`
- `tests/runtime.test.mjs (only the cancel tests, currently around lines 1542-1803: "cancel stops an active background job…", "cancel without a job id…", "cancel with a job id…", "cancel sends turn interrupt…")`

## Do not touch

- No concurrent lane. Still, do **not** edit `app-server-broker.mjs`, `lib/broker-lifecycle.mjs`, `session-lifecycle-hook.mjs`, `stop-review-gate-hook.mjs`, `commands/**`, `agents/**`, `skills/**` (Wave 4-5 lanes own them).
- `tests/runtime.test.mjs` outside the cancel tests named above; any other existing test file.

## Design decisions binding on this lane

Binding decisions (plan D3, D4, D5):

- **`lib/control-channel.mjs`**: `resolveControlFile(workspaceRoot, jobId)` → `jobs/<id>.control.jsonl`; `appendControlOp(workspaceRoot, jobId, {op, reason, then})` appends `{id:"ctl-<random>", op:"interrupt"|"cancel", reason, then, at}` and returns `{id}`; `readControlOps(file, offset)` → `[{op, end}]` (same partial-line-safe reading as `readInboxEntries` in `lib/codex.mjs`); `ackControlOp(workspaceRoot, jobId, id, result)` appends to `jobs/<id>.control.acks.jsonl`; `readControlAck(workspaceRoot, jobId, id)`; `waitForControlAck(workspaceRoot, jobId, id, timeoutMs, pollMs=100)`. The control file is **never** renamed or closed (unlike the inbox), so a cancel works at any time.
- **Transport recording (step 1):** `runAppServerTurn` accepts `onTransport({transport, brokerEndpoint, appServerPid})`, called once the client is connected (and again if `withAppServer` falls back to direct). `SpawnedCodexAppServerClient` exposes its child pid (`client.pid`), and for broker transport `brokerEndpoint` is the client's endpoint. The worker persists `transport`, `brokerEndpoint`, `appServerPid` in the job file (merge write). `transportFallbackReason` is recorded when the busy fallback happens.
- **Worker control loop (step 2):** `runAppServerTurn` accepts `controlFile` and polls it on the same timer as `startInboxSteering` (generalise it; keep the inbox semantics exactly). On `interrupt`/`cancel` the worker calls `turn/interrupt` on **its own client** for the current `{threadId, turnId}`, waits up to the grace period for `turn/completed`, and acks `{interruptDelivered, turnConfirmedStopped}`. Before a turn exists, `handleTaskWorker` and `runAppServerTurn` check the control file at each phase boundary (before connect, before `thread/start`/`resume`, before `turn/start`). If a `cancel` op is present, stop without starting a turn and ack `{turnConfirmedStopped:true, noTurn:true}`.
- **Worker finalisation:** when a turn ends because of a control op, `runTrackedJob` writes `status:"cancelled"`, `phase:"cancelled"`, `cancelReason` = the op's `reason` (default `"user"`), and a `cancel` block (below). **Later lanes rely on `cancelReason` coming from `op.reason`** (e.g. `"session-ended"`, `"owner-lost"`).
- **Worker SIGTERM handler (step 5):** `handleTaskWorker` installs `SIGTERM`/`SIGINT`/`SIGHUP` handlers that append a `cancel` control op to its own job (`reason:"worker-signal"`) and let the loop interrupt the turn. A hard `process.exit` follows after `CODEX_COMPANION_CANCEL_GRACE_MS` (default 10000).
- **`handleCancel` state machine (steps 3-4):** resolve and reconcile the job, then: (a) `appendControlOp(cancel, reason:"user")`; (b) if the worker is alive, wait up to 3s (`CODEX_COMPANION_CONTROL_ACK_MS`) for the ack; (c) if there is no ack or the worker is dead and the job has a turn: send `turn/interrupt` **only** to the *recorded* `brokerEndpoint` (connect with a new `CodexAppServerClient.connect(cwd, {brokerEndpoint, noSpawn:true})` style option you add to `lib/app-server.mjs`; if the endpoint is gone, report `broker-not-found`. **Never spawn a fresh direct app-server for an interrupt**); if `turnId` is missing but `threadId` exists, resolve it with `thread/read` on the same endpoint; (d) wait up to `--grace-ms` (default 10000; `--force` = 0) for the turn to stop (ack, a terminal job status written by the worker, or `thread/read` idle); (e) SIGTERM the worker (process group only when `worker.processGroup` is true, which background workers set in `spawnTaskWorker`; a foreground companion's pid only, step 6); wait 5s (`CODEX_COMPANION_KILL_WAIT_MS`); SIGKILL; (f) verify with `isSameProcess` that the worker and a direct `appServerPid` are gone. Put the escalation in `lib/process.mjs` as `terminateProcessTreeVerified(pid, {group, graceMs, killWaitMs})` → `{delivered, exited, escalated, residualPids}`, and keep `terminateProcessTree` unchanged for existing callers.
- **Persist** `cancel: {requestedAt, reason, interruptDelivered, turnConfirmedStopped, workerExited, appServerExited, residualPids, detail}`. Status is `cancelled` only if `turnConfirmedStopped && workerExited` (and `appServerExited` for a direct transport). Otherwise it is `cancel-failed`, and the command exits 2 (`EXIT.USAGE` from `lib/exit-codes.mjs`; the JSON gets `error.code:"cancel-failed"`). A job that is already terminal: report it and exit 0 without changes.
- **`renderCancelReport` (step 7)** shows the interrupt outcome, the process outcome and the verification result. The `cancel --json` payload includes the `cancel` block.
- **Deep reconcile (carried over from BUG-6):** add async `reconcileJobDeep(workspaceRoot, job)` in `lib/job-liveness.mjs`. For a `lost` (or dead-active) job with a `threadId` and a recorded **broker** endpoint that still answers, call `thread/read` (3s timeout). If a turn is still running, mark it `orphaned` (and suggest `cancel`); if the last turn has finished, mark it `completed`/`failed` with `reconciled:true` and recover the final message when the response includes it. Call it only from `status <id>` (single job) and `wait`. If the `thread/read` shape is unverified (see `docs/app-server-probe.md` from lane `m0-spike` if it exists), keep `lost`.
- **Out of scope here:** `cancel --all`/`--workspace`/`--everywhere` (moves to WISH-2, lane `m6-rails`). `--force` and `--grace-ms` **are** in scope.

## Implementation guide

- `lib/control-channel.mjs` (new); `lib/codex.mjs`: `runAppServerTurn`, `startInboxSteering` (generalise into a combined poller or add a sibling `startControlChannel`), `withAppServer` (fallback reason), `interruptAppServerTurn` (take an explicit endpoint; never spawn); `lib/app-server.mjs`: `CodexAppServerClient.connect` (explicit-endpoint no-spawn option), `SpawnedCodexAppServerClient` (expose pid); `lib/process.mjs`: `terminateProcessTreeVerified`; `lib/tracked-jobs.mjs`: `runTrackedJob` (control-driven finalisation), `spawnTaskWorker` (`processGroup:true`); `lib/job-liveness.mjs`: `reconcileJobDeep`; `lib/render.mjs`: `renderCancelReport`; `codex-companion.mjs`: `handleCancel`, `handleTaskWorker` (signals, pre-turn control check), `executeTaskRun` (pass `controlFile`, `onTransport`), `handleStatus`/`handleWait` (deep reconcile).
- Existing cancel tests in `tests/runtime.test.mjs` may assert the old unconditional behaviour. Update them only where the new, correct semantics differ, and explain each change in your report.

## Fake-Codex fixture API (from lane `m0-fixture`)

The fixture API from lane `m0-fixture` (see `docs/IMPLEMENTATION-PLAN.md` D2), in short: `installFakeCodex(binDir, behavior, options)`; `setFakeCodexOptions(binDir, patch)`; `options.turnScript` steps (`command`, `fileChange`, `agentMessage`, `reasoning`, `plan`, `diff`, `usage`, `delay`, `silence`, `serverRequest`); `options.interrupt: "cooperate"|"ignore"|"ack-only"`; `options.ignoreSigterm`; `options.delays.{initialize,threadStart,turnStart}`; `options.models`, `options.config`, `options.forceActiveWriter`; `readFakeRpcLog(binDir, {method, conn})`, `fakeConnections(binDir)`; `occupyBroker(endpoint, {holdMs})`; helpers `spawnStubborn()`, `waitFor()`, `isPidAlive()`, `makeCompanionWorkspace()`, `startFakeAppServer()`. Read the fixture source for the exact signatures before writing tests. If you need a fixture capability that is missing, add it **additively** (this lane owns the fixture files in this wave) and keep every existing behaviour string working.

## Tests to write first

`tests/cancel.test.mjs` (fixture options: a scripted slow turn with a few `command` steps and `delay`s; `interrupt` mode; `ignoreSigterm`; `delays.threadStart`; `occupyBroker`; `readFakeRpcLog`). Use short `CODEX_COMPANION_CANCEL_GRACE_MS`/`KILL_WAIT_MS`/`CONTROL_ACK_MS` values:
1. Cooperative: status `cancelled`, `cancel.turnConfirmedStopped === true`, and no new `Running command` lines in the job log after the cancel returns (wait 1s and compare).
2. Non-cooperative: `interrupt:"ignore"` + `ignoreSigterm` on the fake. The SIGKILL path runs and the job ends verified, **or** the command exits 2 with `cancel-failed` and a non-empty `residualPids`. Assert that one of the two outcomes happens, with consistent fields.
3. Direct transport: hold the broker with `occupyBroker`, launch a job (it falls back to direct, `transport:"direct"` recorded), cancel. The RPC log shows `turn/interrupt` on the **worker's own** connection (the conn that received that job's `turn/start`).
4. Queued job with no turnId: `delays.threadStart: 3000`, cancel immediately. Status `cancelled`, and the RPC log has **no** `turn/start` for that thread.
5. Rendered report (text mode) contains the interrupt outcome and the verification line.
6. Cancel never spawns an app-server: with the broker gone (kill it) and the worker dead, `cancel` reports `broker-not-found` and the fake's app-server start count does not increase.
7. `cancelReason` comes from the op: append `{op:"cancel", reason:"session-ended"}` directly with `appendControlOp`; the job ends `cancelled` with `cancelReason:"session-ended"`.
8. Deep reconcile: SIGKILL the worker of a broker-hosted slow turn → `status <id> --json` shows `orphaned` (turn still active at the fake), and after the fake completes, `completed` with `reconciled:true` (skip with a clear message if the fixture's `thread/read` lacks turn status).

## Requirements from the report (verbatim)

The text below is copied verbatim from `docs/IMPROVEMENT-REPORT.md`. You do not need to read the rest of the report.

### BUG-2: `cancel` reports "cancelled" without verifying; the interrupt can reach the wrong app-server; no SIGKILL escalation
- **Priority:** P0
- **Problem:** `handleCancel` always writes `status:'cancelled', pid:null`, whatever the outcome of the interrupt or the kill. It can fail in five ways:
  1. There is no `turnId` yet (queued or starting job), so the interrupt is skipped.
  2. `interruptAppServerTurn` connects with `reuseExistingBroker`. When no `broker.json` exists, `CodexAppServerClient.connect` spawns a **fresh direct app-server**, which cannot see the turn.
  3. A worker that fell back to a direct app-server (broker busy) owns its turn in its own child process, which a broker-routed interrupt cannot reach.
  4. `terminateProcessTree` sends one SIGTERM, with no exit check and no SIGKILL.
  5. For a broker-hosted turn, killing the worker does nothing to the turn (BUG-1).

  The payload does have `turnInterruptAttempted` and `turnInterrupted` fields, but they are not persisted in the job file, `renderCancelReport` ignores them, and the exit code is always 0. Cancelling a *foreground* job targets `pid=process.pid` of that companion, whose process group may be the caller's shell (it is not detached).
- **Evidence:** E1. `codex-companion.mjs` `handleCancel` ~1441-1500. `lib/codex.mjs` `interruptAppServerTurn` 1109-1149 and `withAppServer` 762-791 (direct fallback). `lib/app-server.mjs` 338-351. `lib/process.mjs` `terminateProcessTree` 57-117 (POSIX branch 100-117: one `kill(-pid,'SIGTERM')`, then return). `lib/tracked-jobs.mjs` 161 (foreground pid). `lib/render.mjs` `renderCancelReport` 508-525. Existing tests: `tests/runtime.test.mjs` 1542 and 1740, `tests/orvex.test.mjs` ~202 (happy path only).
- **Proposal:** Implement a verified cancel state machine.
  1. At turn start, the worker records `transport: 'broker'|'direct'`, `brokerEndpoint`, `appServerPid` and `workerStartTime` in the job file.
  2. **Control channel.** Add `jobs/<id>.control.jsonl`, polled by the worker alongside the inbox (reuse the `startInboxSteering` loop) and carrying ops `{op:'interrupt'|'cancel', id, reason}`. The worker calls `turn/interrupt` on **its own** client connection, so the right app-server always receives it.
  3. Cancel then proceeds in order: write the control op; if the worker is dead or does not ack within 3s, send `turn/interrupt` to the *recorded* broker endpoint (never spawn a fresh direct app-server for an interrupt; report `broker-not-found` instead); if `turnId` is missing, resolve it with `thread/read`; wait up to `--grace-ms` (default 10s) for `turn/completed` or an idle thread; SIGTERM the worker process group; wait 5s; SIGKILL; confirm with `kill(pid,0)` that the worker and `appServerPid` are gone.
  4. Persist `cancel: {requestedAt, reason, interruptDelivered, turnConfirmedStopped, workerExited, appServerExited, residualPids, detail}`. Status becomes `cancelled` only when the stop is verified. Otherwise it is `cancel-failed`, and the command exits 2.
  5. The worker gets a SIGTERM handler that interrupts its own turn before exiting.
  6. Do not SIGTERM the process group of a non-detached foreground companion. Signal its pid only, and rely on its signal handler (BUG-1).
  7. `renderCancelReport` shows the interrupt, process and verification outcomes.
  8. Add `cancel --all [--workspace|--everywhere]` and `--force` (skip the grace period). See WISH-2.
- **Acceptance criteria:**
  - Cooperative fake: `status` is `cancelled`, `cancel.turnConfirmedStopped` is true, and no new `Running command` lines appear in the log after cancel.
  - A fake that ignores `turn/interrupt`, plus a worker that ignores SIGTERM: the SIGKILL path runs and ends verified, or the command exits 2 with `cancel-failed` and a non-empty `residualPids`.
  - A worker on a direct transport (broker forced busy): the fake records `turn/interrupt` on the worker's own connection.
  - A queued job with no turnId is cancelled cleanly: the worker never starts a turn.
  - The rendered cancel report contains the interrupt outcome.

### 8.2 Key JSON shapes

```jsonc
// job record additions (jobs/<id>.json)
{
  "schemaVersion": 2,
  "status": "queued|running|completed|failed|cancelled|cancel-pending|cancel-failed|interrupted|timed-out|lost|orphaned",
  "owner": {"kind":"attach|foreground|pid|detached","pid":123,"startTime":"...","heartbeatAt":"...","ttlMs":30000},
  "worker": {"pid":456,"startTime":"...","heartbeatAt":"...","stderrFile":"jobs/<id>.worker.err"},
  "transport": "broker|direct", "transportFallbackReason": null, "brokerEndpoint": "unix:...", "appServerPid": 789,
  "runtime": {"requested":{...}, "effective":{"model":"...","effort":"...","sandbox":"...","network":"unrestricted|on|off|blocked","approvalPolicy":"never"}, "sources":{"model":"codex-config",...}, "profile":"bypass", "config":{...}},
  "threadId":"...", "forkedFromThreadId":null, "resumedFromJobId":null, "turns":[{"turnId":"...","status":"...","startedAt":"...","endedAt":"..."}],
  "worktree": {"path":"...","branch":"codex/<id>","baseRef":"..."} ,
  "cancel": {"requestedAt":"...","reason":"user|owner-lost|session-ended|max-runtime","interruptDelivered":true,"turnConfirmedStopped":true,"workerExited":true,"appServerExited":true,"residualPids":[]},
  "rolloutPath": "...", "usage": {...}, "plan": {...}, "overlapsWith": [], "groupId": null,
  "notifiedAt": null, "resultReadAt": null, "warnings": []
}

// result payload (result --json → storedJob.result)
{
  "schemaVersion": 2, "status": "completed", "threadId": "...", "turnIds": ["..."],
  "rawOutput": "...", "reasoningSummary": "...", "undeliveredMessages": [],
  "report": {
    "filesChanged": [{"path":"a.ts","kind":"modify","additions":3,"deletions":1}],
    "commands": [{"command":"npm test","cwd":"...","exitCode":1,"durationMs":5400,"status":"completed","outputTail":"..."}],
    "validation": {"ran":true,"allPassed":false,"failing":["npm test"]},
    "git": {"headBefore":"...","headAfter":"...","newCommits":[],"changedByJob":["a.ts"],"changedConcurrently":[],"untrackedAdded":[],"patchFile":"jobs/<id>.patch"},
    "usage": {...}, "elapsedMs": 61234, "rolloutPath": "...", "effectiveRuntime": {...}, "warnings": []
  },
  "structured": {"ok":true,"data":{...},"validationErrors":[]}   // only with --output-schema
}
```

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

- [ ] Cooperative fake: `status` is `cancelled`, `cancel.turnConfirmedStopped` is true, and no new `Running command` lines appear in the log after cancel
- [ ] A fake that ignores `turn/interrupt`, plus a worker that ignores SIGTERM: the SIGKILL path runs and ends verified, or the command exits 2 with `cancel-failed` and a non-empty `residualPids`
- [ ] A worker on a direct transport (broker forced busy): the fake records `turn/interrupt` on the worker's own connection
- [ ] A queued job with no turnId is cancelled cleanly: the worker never starts a turn
- [ ] The rendered cancel report contains the interrupt outcome
- [ ] Cancel never spawns a fresh app-server; `broker-not-found` is reported instead
- [ ] The worker writes `cancelReason` from the control op's `reason`
- [ ] `transport`, `brokerEndpoint`, `appServerPid` persisted on every task job
- [ ] `npm test` green (existing cancel tests updated only where the semantics changed, each change explained)

## Required final report (your last message; use exactly these sections)

```
## Lane m0-cancel report
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
