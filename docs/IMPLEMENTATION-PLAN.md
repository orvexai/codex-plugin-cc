# Orvex Codex Plugin: Implementation Plan

- Source of requirements: `docs/IMPROVEMENT-REPORT.md` (the "report"). Item ids (BUG-n, FR-n, WISH-n) refer to it.
- Tracker: beads (`bd`). Epics M0 `codex-plugin-cc-1mh`, M1 `-8kj`, M2 `-yew`, M3 `-e8s`, M4 `-wn9`, M5 `-qo4`, M6 `-22z`.
- Executors: Codex worker lanes (gpt-6-luna, danger-full-access) editing the **shared** working tree `/home/crew/workspace/codex-plugin-cc` on branch `orvex/improvement-report`. The orchestrator dispatches from a pinned copy of the plugin, so editing `plugins/codex` is safe. Claude Sonnet reviewers check each lane; fixes return to the same Codex thread. The orchestrator commits and closes beads.
- Lane briefs for M0 and M1: `docs/lanes/<lane-id>.md`. M2-M6 briefs are written when those milestones start, because their details depend on what M0 and M1 actually built.
- Author: Winston (architect), 2026-09-25.

---

## 1. Ground truth that shaped this plan

1. **The FR-26 / PROBE spike did not run.** The probe lane failed before it started (its brief file was missing), so nothing about the native daemon or the app-server protocol has been verified. This plan does **not** wait on that answer for the M0 design. It keeps the plugin broker (decision D1) and runs the spike as a Wave 1 lane, `m0-spike`, alongside the fixture work. The spike's results are needed before `m1-runtime` (BUG-5) starts. The PROBE bead stays open until `m0-spike` delivers.
2. **`codex-companion.mjs` (1557 lines) is the hot spot.** Almost every item touches it, and `lib/codex.mjs` (1411 lines) is next. Two Codex lanes must never edit the same file at once in a shared tree: each lane's half-finished edits would break the other lane's `npm test`. Real parallelism therefore comes from three things only: (a) docs, tests and fixture lanes; (b) **library-first splits**, where a new `lib/*.mjs` module and its unit tests are built in one lane and wired into the companion in a later lane; (c) scripts outside the companion (hooks, broker).
3. **Tests go in new files per lane** (`tests/<lane>.test.mjs`). `scripts/run-tests.mjs` picks up every `tests/*.test.mjs`. A lane edits an existing test file only when the report says that test locks behaviour the item changes (report §9.1 lists them). This keeps concurrent lanes out of each other's test files.
4. Baseline: `npm test` has 112 passing tests. Every lane ends green.

---

## 2. Architecture decisions

### D1. Transport: keep the plugin broker, add worker-side ownership, reserve a `daemon` transport

- **Decision.** M0 builds on the existing per-workspace broker (`app-server-broker.mjs`) plus the direct fallback. The job record gets `transport: "broker" | "direct"`, and the value `"daemon"` is reserved but not implemented.
- **Why.** The spike never ran, so adopting the native 0.157 daemon now would be a bet on an unverified surface. The broker is already tested. More importantly, **most of the safety logic does not depend on the transport**, because it lives in the *worker*: the control channel, owner-liveness checks, the worker's SIGTERM handler and verified cancel. The only broker-specific piece is interrupt-on-disconnect (BUG-1.1), and it is about 30 lines in the broker's socket `close`/`error` handlers.
- **Consequence for the spike.** If `m0-spike` finds that the native daemon supports thread/turn RPCs over its control socket and survives client disconnects, the plan adds a `daemon` transport in M6 (alongside FR-22/BUG-13) as one more `connect()` target. It does **not** retrofit M0. If the daemon offers interrupt-on-disconnect or ownership natively, that lane can drop the broker lease code from BUG-3. The spike document must say which of these applies.
- **Gate.** The orchestrator reads `docs/codex-native-surfaces.md` before dispatching Wave 4 (`m0-ownership`, `m0-session-end`). A "switch to daemon now" finding would be a reason to re-plan Wave 4, and nothing earlier depends on it.

### D2. Fake-Codex fixture: a scripted-turn DSL with runtime options, backward compatible

`tests/fake-codex-fixture.mjs` today bakes one `BEHAVIOR` string into the fake binary, and keeps state in a JSON file that is loaded and saved on every message. That store races when a broker and a direct app-server run at the same time. The upgrade (`m0-fixture`):

- `installFakeCodex(binDir, behavior = "review-ok", options = {})`. Every existing behavior string keeps working unchanged. New capabilities are **options**, written to `binDir/fake-codex-options.json`, which the fake re-reads **on every message**. A test can therefore change behaviour between steps with `setFakeCodexOptions(binDir, patch)`.
- **Scripted turns.** `options.turnScript` is an array of steps the fake plays after `turn/start`, for example: `{type:"command", command, exitCode, output, durationMs}` (emits `item/started`, optional `item/commandExecution/outputDelta` chunks, `item/completed`), `{type:"fileChange", changes:[{path, kind}], writeFiles?: true}` (can really write files under cwd), `{type:"agentMessage", text}`, `{type:"reasoning", text}`, `{type:"plan", steps}` (→ `turn/plan/updated`), `{type:"diff", diff}` (→ `turn/diff/updated`), `{type:"usage", total}` (→ `thread/tokenUsage/updated`), `{type:"delay", ms}`, `{type:"silence"}` (stops emitting and never completes, for BUG-17 and idle timeout), `{type:"serverRequest", method}` (sends a server-initiated request), then `turn/completed`, unless the script ends in `silence`.
- **Interrupt behaviour.** `options.interrupt: "cooperate" (default) | "ignore" | "ack-only"`. `ignore` never answers and never completes the turn, while `ack-only` answers `{}` but keeps the turn running. `options.ignoreSigterm: true` makes the fake app-server process ignore SIGTERM. `options.delays = {initialize, threadStart, turnStart}` delays those responses (to cancel a job before it has a turnId). `options.turnStatus: "failed"` ends a scripted turn as failed.
- **New methods.** `model/list` (from `options.models`), `config/read` (from `options.config`, merged with existing behaviours), `thread/read` (thread + turns with status; `path` set to a real rollout file when `options.rolloutDir`/`CODEX_HOME` is given), and `thread/unload` (records the call). The response **shapes** are best guesses until `m0-spike` records the real ones. Later lanes adjust them to the probe, and the probe document is the authority.
- **Forced modes.** `options.forceActiveWriter: true` makes `thread/resume` fail with "active writer". Broker-busy is done test-side, never with a production test hook: a `occupyBroker(endpoint, {holdMs})` helper connects a raw socket to the broker and starts a slow turn, so other clients get `-32001`.
- **RPC recording.** Each fake app-server process appends every inbound message and every outbound notification to `binDir/fake-codex-rpc.jsonl` as `{ts, conn, pid, dir:"in"|"out", id?, method, params}`, where `conn` is `<pid>-<startMs>`, one per app-server process, so one per connection. Helpers: `readFakeRpcLog(binDir, {method?, conn?})` and `fakeConnections(binDir)`. The recording uses `fs.appendFileSync`, one line per message, so it is safe across processes. The legacy `fake-codex-state.json` keeps working for existing assertions.
- **Process helpers** (`tests/helpers.mjs`): `spawnStubborn()` (a node process that ignores SIGTERM, used to stand in for a hung worker), `waitFor(predicate, {timeoutMs, intervalMs})`, `isPidAlive(pid)`, and `makeCompanionWorkspace(behavior, options)`, the `makeWorkspace` shape from `tests/orvex.test.mjs` generalised so new test files do not copy it.

### D3. Shared primitives (built once, in the lane named, then reused)

| Module | Exports | Built by | Used by |
|---|---|---|---|
| `lib/process.mjs` (extend) | `isProcessAlive(pid)`, `readProcessStartTime(pid)` (Linux `/proc/<pid>/stat` field 22 as an opaque string; macOS `ps -o lstart= -p`; null elsewhere), `isSameProcess({pid, startTime})`, `signalProcessTree(pid, signal, {group})`, `waitForProcessesExit(pids, timeoutMs)`, `terminateProcessTreeVerified(pid, {graceMs, group})` → `{delivered, exited, escalated, residualPids}`. The existing `terminateProcessTree` keeps its signature. | `m0-liveness` (liveness), `m0-cancel` (escalation) | everything |
| `lib/exit-codes.mjs` (new) | `EXIT = {OK:0, JOB_FAILED:1, USAGE:2, LOST:3, TIMED_OUT:4, WAITER_TIMEOUT:124, CANCELLED:130}`; `ACTIVE_STATUSES`, `TERMINAL_STATUSES`, `isActiveJobStatus(status)`; `exitCodeForJob(status, {mode:"wait"|"attach"|"task"})` implementing report §8.1. For `wait`, cancelled or interrupted gives 1 (backward compatible); for `attach` and `task`, cancelled or interrupted gives 130. `lost`/`orphaned` gives 3, `timed-out` gives 4, `cancel-failed` gives 2. | `m0-liveness` | every command that exits with a job-derived code; `isActiveJobStatus` in the companion is replaced by this one |
| `lib/job-liveness.mjs` (new) | `resolveHeartbeatFile(workspaceRoot, jobId, kind="worker"|"owner")` → `jobs/<id>.hb` / `jobs/<id>.owner.hb`; `startHeartbeat(file, {intervalMs=5000})` → `{stop()}` (writes `{pid, startTime, at}` atomically, **never through `state.lock`**); `readHeartbeat(file)`; `reconcileJob(workspaceRoot, job, {now})` (sync, file-only, returns the job unchanged or a reconciled copy **and persists** the transition under the lock); `HEARTBEAT_STALE_MS = 30000`. | `m0-liveness` | status, wait, send, cancel, result, resume-candidate, stop hook, SessionEnd, ledger |
| `lib/control-channel.mjs` (new) | `resolveControlFile(workspaceRoot, jobId)` → `jobs/<id>.control.jsonl`; `appendControlOp(workspaceRoot, jobId, {op:"interrupt"|"cancel", reason, then?})` → `{id}`; `readControlOps(file, offset)`; `ackControlOp(workspaceRoot, jobId, id, result)` (appends to `jobs/<id>.control.acks.jsonl`); `waitForControlAck(workspaceRoot, jobId, id, timeoutMs)`. Same durable-JSONL pattern as the steer inbox (strength #3); the control file is **never** closed by rename, because cancel must work at any time. | `m0-cancel` | BUG-3 (SessionEnd cancel op), FR-9 (`interrupt --then`), FR-17 (timeouts) |
| Worker control loop | In `lib/codex.mjs`, `runAppServerTurn` takes `controlFile` and polls it with the same interval as `startInboxSteering`. An `interrupt`/`cancel` op makes the worker call `turn/interrupt` on **its own** client, wait for `turn/completed`, then ack. Before the turn exists (queued/starting), `handleTaskWorker` checks the control file first and exits `cancelled` without starting a turn. | `m0-cancel` | FR-9 generalises it to `{op:"interrupt", then}` |
| Owner lease | `job.owner = {kind:"attach"|"foreground"|"pid"|"detached", pid, startTime, heartbeatAt, ttlMs:30000}`. The owner writes `jobs/<id>.owner.hb` every 5s. The worker checks owner liveness every 2s: pid plus start time, or heartbeat age > ttl. On owner loss it appends a `cancel` control op to itself with `reason:"owner-lost"`, so there is one cancel path. | `m0-ownership` | FR-10 (`attach`), FR-11 (MCP wait), FR-25 (ownership coupling) |

### D4. Job record `schemaVersion: 2` (additive; v1 records stay readable)

New fields are optional, so readers must treat a missing field as unknown. Writers stamp `schemaVersion: 2` in `createJobRecord` (`lib/tracked-jobs.mjs`). No migration is needed.

```jsonc
{
  "schemaVersion": 2,
  "status": "queued|running|completed|failed|cancelled|cancel-pending|cancel-failed|interrupted|timed-out|lost|orphaned",
  "worker": {"pid": 456, "startTime": "<opaque>", "stderrFile": "jobs/<id>.worker.err"},   // m0-liveness
  "reconciled": false, "reconciledAt": null,                                                 // m0-liveness
  "resultReadAt": null,                                                                       // m0-prune (field) / m0-liveness (setter wiring)
  "transport": "broker|direct", "brokerEndpoint": "unix:...", "appServerPid": 789,           // m0-cancel
  "cancel": {"requestedAt", "reason": "user|owner-lost|session-ended", "interruptDelivered", "turnConfirmedStopped",
             "workerExited", "appServerExited", "residualPids": [], "detail"},               // m0-cancel
  "owner": {"kind", "pid", "startTime", "heartbeatAt", "ttlMs": 30000}, "onOwnerExit": "cancel|continue", "cancelReason": null, // m0-ownership
  "sessionEndedAt": null, "endedWithSession": false                                           // m0-session-end
}
```

Heartbeats live in side files (`.hb`, `.owner.hb`), not in the record, which avoids lock churn (report risk 6). `status --json` surfaces `heartbeatAgeSec`, `ownerAlive` and `orphaned`, computed at read time.

### D5. Statuses, reconciliation and exit codes

- `reconcileJob` runs **file-only** in every hot path (status, wait poll, send, cancel, result, resume candidate, hooks). A job is dead when its status is active and (the worker pid is not alive, or the start time does not match, or the heartbeat is older than 30s for a v2 record). A dead job becomes `lost`, `phase:"worker-exited"`, `errorMessage:"worker exited without completion record"`, keeps its `threadId`, and gets the log tail plus `.worker.err` appended. A v1 record with no heartbeat uses the pid check only. A `queued` record with no live pid that is older than 60s is lost.
- The **deep** reconcile (`orphaned` vs `completed` with `reconciled:true`) needs `thread/read`. It is async and only runs in `status <id>` (single job) and `wait`, with a 3s timeout, and only against the *recorded* broker endpoint. Hooks never make app-server calls. Deep reconcile arrives with `m0-cancel`, which records the transport. Until then, dead jobs are `lost`, which the BUG-6 acceptance criteria allow.
- `cancel-pending` counts as active. `lost`, `orphaned`, `cancel-failed`, `interrupted` and `timed-out` count as terminal.

### D6. Index truth (BUG-18) and pruning (BUG-14)

- `jobs/<id>.json` is the **source of truth**, and `state.json` is an index. Job lookup (`matchJobReference` and its callers) falls back to the job file when the index lacks the id, and repairs the index entry. Pruning never drops an active job, or an unread job younger than 24h. `wait` on an unknown id exits non-zero (3 for not-found, which matches "lost") and never 0.

### D7. SessionEnd and broker leases (BUG-3)

- SessionEnd never deletes files. For each active job of the ending session, it applies `sessionEndPolicy`: `cancel` (the default) for owned jobs, `detach` for `owner.kind:"detached"`. It **appends a `cancel` control op** with `reason:"session-ended"` and writes `cancel-pending`. The worker completes the cancel. If the worker is dead, the next `reconcileJob` finalises it. The hook stays within 5s and makes no app-server calls.
- `broker.json` gains `leases:[{sessionId, pid, startTime, addedAt}]`. SessionStart adds a lease, where `pid` is the hook's `process.ppid`, best effort. SessionEnd removes its own lease, and sends `broker/shutdown` only when no other lease is live (pid and start time alive) **and** no job in the workspace is active. Broker logs move to `<stateDir>/broker.log` and are never deleted by teardown. Rotation: at 5MB, rename to `broker.log.1` (keep one).

### D8. Direct dispatch and completion signal (BUG-4, M1)

- The canonical launch is `node ${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs task --attach …` under Bash `run_in_background: true`. `--attach` (from `m0-ownership`) stays in the foreground, streams compact progress to stderr, and exits with `exitCodeForJob(status, {mode:"attach"})`.
- The first stdout line of every launch is `CODEX_JOB <jobId> status=<queued|running> thread=<id|pending> sandbox=<m> network=<eff> log=<path>`. A pure `--background` launch prints `CODEX_JOB_QUEUED id=<id> status=queued (NOT finished)` and then the exact `wait <id> --json` command. `m0-ownership` implements the attach and background line. `m1-completion-signal` makes it universal and adds `sandbox=`/`network=`/`source=`. FR-25 later appends `approval=never source=…`.
- The Stop hook reports running jobs in JSON on stdout (`systemMessage`), not stderr. The `stopRunningJobs: block|warn|off` config defaults to `warn`.
- **FR-1 scope decision:** the drive skill and the model-invocable commands reference **only subcommands that exist when the lane lands** (status, result, cancel, send, wait, `task --attach`, `task --resume-last`). `interrupt`, `attach`, `logs`, `messages` and `models` are added to the skill and to `commands/` by the lanes that build them (FR-9, FR-10, FR-2, FR-20, FR-12). The FR-1 acceptance item "exposes codex:interrupt" therefore moves to FR-9. This follows the report's own doc-consistency rule (FR-24) and avoids pointing Claude at a command that does not exist.

### D9. Runtime resolution (BUG-5, FR-25) and review read-only (BUG-8)

- `resolveTaskRuntime` returns `{sandbox, network, model, effort, sources:{…}}`. When no plugin tier sets a value, `sandbox` and `model` are **omitted** from thread/start, resume and fork, subject to the probe's answer on "does a missing sandbox fall back to config.toml". The effective value is read through `config/read` and labelled `codex-config`. Reviews and the stop gate always send `read-only`.
- FR-25 then changes the built-in tier to bypass (`danger-full-access`, network on), with the ownership coupling in `handleTask`: an unowned `--background` with no explicit sandbox falls back to `workspace-write` unless `--detach` is given. It lands last in M1 (W7).

---

## 3. File-ownership map (why waves look the way they do)

| File | M0/M1 lanes that edit it (in order) |
|---|---|
| `scripts/codex-companion.mjs` | cli-hygiene (W1) → liveness (W2) → cancel (W3) → ownership (W4) → completion-signal (W5) → runtime (W6) → bypass (W7) |
| `scripts/lib/codex.mjs` | cancel (W3) → ownership (W4) → runtime (W6) |
| `scripts/lib/job-control.mjs` | liveness (W2) → cancel (W3, deep reconcile) → ownership (W4, ownerAlive) |
| `scripts/lib/state.mjs` | prune (W1) → liveness (W2, only if needed for index fallback) |
| `scripts/lib/process.mjs` | liveness (W2) → cancel (W3) |
| `scripts/lib/tracked-jobs.mjs` | liveness (W2) → cancel (W3) → ownership (W4) |
| `scripts/app-server-broker.mjs`, `lib/app-server.mjs` | ownership (W4) |
| `scripts/lib/broker-lifecycle.mjs`, `scripts/session-lifecycle-hook.mjs` | session-end (W4) |
| `scripts/stop-review-gate-hook.mjs` | liveness (W2, reconcile only) → completion-signal (W5) → runtime (W6, `--read-only` argv) |
| `hooks/hooks.json` | ledger (W6) |
| `commands/*.md`, `agents/*.md`, `skills/**` | dispatch-docs (W5) |
| `lib/render.mjs` | cancel (W3) → ownership (W4) → completion-signal (W5) → runtime (W6) → bypass (W7) |
| `lib/args.mjs` | cli-hygiene (W1) |
| `tests/fake-codex-fixture.mjs`, `tests/helpers.mjs` | fixture (W1) → one owner per later wave (named in each brief) |
| `tests/runtime.test.mjs` | cancel (W3, cancel tests only) → session-end (W4, test ~1804) → completion-signal (W5, test ~1982) |
| `tests/commands.test.mjs` | dispatch-docs (W5) |
| `tests/orvex.test.mjs` | runtime (W6, lines 81-83) → bypass (W7) |

---

## 4. Lane DAG: M0 and M1 (briefs exist)

| Wave | Lane | Beads | Items | Files owned | Depends on | Concurrent with |
|---|---|---|---|---|---|---|
| 1 | `m0-fixture` | 1mh.2 | FIXTURE | `tests/fake-codex-fixture.mjs`, `tests/helpers.mjs`, `tests/fixture-smoke.test.mjs` | none | m0-spike, m0-cli-hygiene, m0-prune |
| 1 | `m0-spike` | 1mh.1, 1mh.3 | PROBE, FR-26 | `docs/codex-native-surfaces.md`, `docs/app-server-probe.md`, `scripts/probe-app-server.mjs` (repo root `scripts/`, not the plugin) | none | all W1 lanes |
| 1 | `m0-cli-hygiene` | 1mh.9 | BUG-16 | `plugins/codex/scripts/lib/args.mjs`, `plugins/codex/scripts/codex-companion.mjs`, `tests/cli-hygiene.test.mjs` | none | all W1 lanes |
| 1 | `m0-prune` | 1mh.8 | BUG-14 | `plugins/codex/scripts/lib/state.mjs`, `tests/prune.test.mjs` | none | all W1 lanes |
| 2 | `m0-liveness` | 1mh.4, 1mh.10 | BUG-6, BUG-18 | `lib/process.mjs`, `lib/exit-codes.mjs` (new), `lib/job-liveness.mjs` (new), `lib/job-control.mjs`, `lib/tracked-jobs.mjs`, `lib/state.mjs`, `codex-companion.mjs`, `stop-review-gate-hook.mjs`, `tests/fake-codex-fixture.mjs`, `tests/helpers.mjs`, `tests/liveness.test.mjs` | W1 (fixture, prune, cli-hygiene) | none |
| 3 | `m0-cancel` | 1mh.5 | BUG-2 | `lib/control-channel.mjs` (new), `lib/codex.mjs`, `lib/process.mjs`, `lib/tracked-jobs.mjs`, `lib/job-control.mjs`, `lib/render.mjs`, `codex-companion.mjs`, fixture/helpers, `tests/cancel.test.mjs`, `tests/runtime.test.mjs` (cancel tests 1542-1803 only) | m0-liveness | none |
| 4 | `m0-ownership` | 1mh.6 | BUG-1 | `app-server-broker.mjs`, `lib/app-server.mjs`, `lib/codex.mjs`, `lib/job-liveness.mjs`, `lib/tracked-jobs.mjs`, `lib/job-control.mjs`, `lib/render.mjs`, `lib/control-channel.mjs`, `codex-companion.mjs`, fixture/helpers, `tests/ownership.test.mjs` | m0-cancel, m0-spike (reviewed) | m0-session-end |
| 4 | `m0-session-end` | 1mh.7 | BUG-3 | `session-lifecycle-hook.mjs`, `lib/broker-lifecycle.mjs`, `tests/session-end.test.mjs`, `tests/runtime.test.mjs` (the ~1804 SessionEnd test only) | m0-cancel, m0-spike (reviewed) | m0-ownership |
| 5 | `m1-dispatch-docs` | 8kj.1 (docs half), 8kj.2 | BUG-4 (1, 4, 7-commands), FR-1 | `commands/*.md`, `agents/codex-rescue.md`, `skills/codex-drive/SKILL.md` (new), `skills/codex-cli-runtime/SKILL.md`, `skills/codex-result-handling/SKILL.md`, `tests/commands.test.mjs` | all M0 | m1-completion-signal |
| 5 | `m1-completion-signal` | 8kj.1 (code half) | BUG-4 (2, 3, 5, 7-runtime) | `codex-companion.mjs`, `stop-review-gate-hook.mjs`, `lib/render.mjs`, `lib/state.mjs` (config key only), fixture/helpers, `tests/completion-signal.test.mjs`, `tests/runtime.test.mjs` (Stop-hook tests 1926-2118 only) | all M0 | m1-dispatch-docs |
| 6 | `m1-runtime` | 8kj.3, 8kj.4, 8kj.5 | BUG-5, BUG-8, BUG-12 | `codex-companion.mjs`, `lib/codex.mjs`, `lib/render.mjs`, `stop-review-gate-hook.mjs`, `README.md`, fixture/helpers, `tests/runtime-defaults.test.mjs`, `tests/orvex.test.mjs` (81-83) | W5, m0-spike findings | m1-ledger |
| 6 | `m1-ledger` | 8kj.6 | FR-16 | `scripts/job-ledger-hook.mjs` (new), `hooks/hooks.json`, `tests/ledger.test.mjs` | W5 | m1-runtime |
| 7 | `m1-bypass` | 8kj.7 | FR-25 | `codex-companion.mjs`, `lib/render.mjs`, `README.md`, `CHANGELOG.md`, `tests/bypass.test.mjs`, `tests/orvex.test.mjs` | m1-runtime, m1-ledger, all M0 | none |

Critical path: fixture → liveness → cancel → ownership → completion-signal → runtime → bypass (7 waves). 13 lanes in M0+M1, with at most 4 running at once (W1).

## 5. Lane DAG: M2-M6 (planned; briefs written at milestone start)

The pattern is **library first, wiring second**: a new `lib/*.mjs` module plus its unit tests can run beside a companion-owning lane.

| Wave | Lane | Items (beads) | Files owned (principal) | Depends on | Concurrent with |
|---|---|---|---|---|---|
| M2-a | `m2-events` | FR-2, WISH-1 (yew.1, yew.2) | `lib/events.mjs` (new), `lib/tracked-jobs.mjs`, `lib/codex.mjs` (describe* full text), `codex-companion.mjs` (`events`, `logs`), `tests/events.test.mjs` | M1 | `m2-snapshot-lib` |
| M2-a | `m2-snapshot-lib` | FR-5 library half (yew.4) | `lib/git-snapshot.mjs` (new), `lib/git.mjs`, `tests/git-snapshot.test.mjs` | M1 | `m2-events` |
| M2-b | `m2-capture` | FR-3 (yew.3) | `lib/codex.mjs` (`applyTurnNotification`), `lib/app-server.mjs` (opt-out list), `lib/job-control.mjs`, `tests/capture.test.mjs` | m2-events | `m2-report-lib` |
| M2-b | `m2-report-lib` | FR-4 library half (yew.5) | `lib/task-report.mjs` (new), `schemas/task-report.schema.json`, `schemas/task-result.schema.json`, `tests/task-report.test.mjs` | m2-snapshot-lib | `m2-capture` |
| M2-c | `m2-report` | FR-4 + FR-5 wiring, `diff`, `--output-schema`, `--expect-changes` | `codex-companion.mjs`, `lib/render.mjs`, `tests/report.test.mjs` | m2-capture, m2-report-lib | none |
| M2-d | `m2-transcript` | FR-7 (yew.6) | `lib/transcript.mjs` (new), `codex-companion.mjs`, `tests/transcript.test.mjs` | m2-report, PROBE | none |
| M2-e | `m2-partial` | FR-8, BUG-17 (yew.7, yew.8) | `lib/job-control.mjs`, `codex-companion.mjs`, `lib/codex.mjs` (idle nudge), `tests/partial.test.mjs` | m2-transcript | none |
| M3-a | `m3-resume` | BUG-7, BUG-11, FR-21 (e8s.1-3) | `lib/args.mjs` (optional value), `codex-companion.mjs`, `lib/codex.mjs`, `app-server-broker.mjs` (unload), `tests/resume.test.mjs` | M2 | `m3-reattach-hook` |
| M3-a | `m3-reattach-hook` | FR-10 hook half (e8s.5) | `session-lifecycle-hook.mjs` (SessionStart context), `tests/session-start.test.mjs` | M2 | `m3-resume` |
| M3-b | `m3-interrupt` | FR-9 (e8s.4) + `/codex:interrupt` + drive-skill update | `lib/codex.mjs`, `lib/control-channel.mjs`, `codex-companion.mjs`, `commands/interrupt.md`, `skills/codex-drive/SKILL.md`, `tests/interrupt.test.mjs` | m3-resume | none |
| M3-c | `m3-reattach` | FR-10 CLI half (`attach`, `adopt`, `status --all-sessions`) | `codex-companion.mjs`, `lib/job-control.mjs`, `commands/attach.md`, `tests/reattach.test.mjs` | m3-interrupt | none |
| M3-d | `m3-send-budget` | FR-20, FR-17 (e8s.6, e8s.7) | `codex-companion.mjs`, `lib/codex.mjs`, `tests/send-budget.test.mjs` | m3-reattach | none |
| M4-a | `m4-models` | FR-12, BUG-9, BUG-10 (wn9.1-3) | `lib/models.mjs` (new), `codex-companion.mjs`, `lib/codex.mjs`, `lib/render.mjs`, `commands/models.md`, `tests/models.test.mjs` | M3, PROBE | `m4-lane-lib` |
| M4-a | `m4-lane-lib` | FR-13 library half (wn9.4) | `lib/lane-config.mjs` (new; TOML `-c` parsing, deep-merge, preamble), `prompts/delegated-worker.md`, `tests/lane-config.test.mjs` | PROBE, FR-26 | `m4-models` |
| M4-b | `m4-lane` | FR-13 wiring + `lane-context` | `codex-companion.mjs`, `lib/codex.mjs`, `tests/lane.test.mjs` | m4-models, m4-lane-lib | none |
| M4-c | `m4-config` | FR-14, FR-15 (wn9.5, wn9.6) | `lib/config.mjs` (new layered resolver), `lib/state.mjs`, `codex-companion.mjs`, `commands/rescue.md`, `tests/config.test.mjs` | m4-lane | none |
| M5-a | `m5-mcp` | FR-11 (qo4.1) | `scripts/mcp-server.mjs` (new), `.mcp.json`, `codex-companion.mjs` (`mcp` subcommand only), `tests/mcp.test.mjs` | M4 | `m5-fanout-lib` |
| M5-a | `m5-fanout-lib` | FR-18 scheduler half (qo4.4) | `lib/fanout.mjs` (new), `tests/fanout-lib.test.mjs` | M4 | `m5-mcp` |
| M5-b | `m5-fanout-brief` | FR-18 wiring, FR-23 (qo4.3) | `codex-companion.mjs`, `lib/render.mjs`, `tests/fanout.test.mjs`, `tests/brief.test.mjs` | m5-mcp, m5-fanout-lib | `m5-workflow` |
| M5-b | `m5-workflow` | FR-19 (qo4.2) | `agents/codex-exec.md`, `skills/codex-workflow/**`, `tests/fixtures/workflow/**`, `tests/workflow.test.mjs` | m5-mcp | `m5-fanout-brief` |
| M5-c | `m5-docs` | FR-27 (qo4.5) | `codex-companion.mjs` (`--print-claude-md`, `--install-mcp`), `tests/claude-md.test.mjs` | m5-fanout-brief, m5-workflow | none |
| M6-a | `m6-worktree` | FR-6, BUG-15 (22z.1, 22z.2) | `lib/worktree.mjs` (new), `codex-companion.mjs`, `lib/job-control.mjs`, `tests/worktree.test.mjs` | M5 | `m6-ci` |
| M6-a | `m6-ci` | FR-24 (22z.6) | `.github/workflows/*`, `tests/contract.test.mjs`, `tests/doc-consistency.test.mjs` | FIXTURE, PROBE (can be pulled forward to any wave) | anything |
| M6-b | `m6-ops` | FR-22, BUG-13 (+ optional `daemon` transport per D1) (22z.3, 22z.4) | `app-server-broker.mjs`, `lib/broker-lifecycle.mjs`, `lib/app-server.mjs`, `lib/codex.mjs`, `codex-companion.mjs` (`broker`), `tests/broker-ops.test.mjs` | m6-worktree | `m6-ci` |
| M6-c | `m6-rails` | WISH-2, WISH-7 (22z.5, 22z.11) | `codex-companion.mjs`, `lib/state.mjs`, `lib/render.mjs`, `tests/rails.test.mjs` | m6-ops | `m6-ci` |
| M6-d | `m6-wishes` | WISH-3, WISH-4, WISH-5, WISH-6 (22z.7-10) | split into 2 lanes at the time (reviews vs models/prompting) | m6-rails | — |

`m6-ci` (FR-24) touches only `.github/` and new test files. The orchestrator may run it in **any** wave as a free concurrent lane, and it is a good candidate for W2 or W3, where otherwise only one lane runs.

---

## 6. Process rules every lane follows (repeated in each brief)

1. `bd update <bead> --claim` at the start. `bd note <bead> "<summary>"` at the end. Never `bd close`: the orchestrator closes beads after review.
2. Tests first: write failing tests in the lane's own `tests/<lane>.test.mjs` using the fake-Codex fixture, then implement. The lane ends with a green `npm test` (baseline 112, which grows as lanes land).
3. No `git commit`, `git add`, `git stash`, `git push`, `git checkout -- <file>`, `git reset` or `git clean`. The tree is shared, and the orchestrator commits with explicit pathspecs.
4. Edit only files the brief lists as owned. When a change outside the lane's files seems necessary, stop and report it as a follow-up rather than making it.
5. Use Serena MCP symbolic tools when available. Function names are authoritative, and the report's line numbers are approximate.
6. Final report in the brief's fixed format.

---

## 7. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | Protocol unknowns (report §9.2-1): `thread/read`, `model/list`, missing-sandbox fallback, `ThreadStartResponse` fields. | `m0-spike` in W1. `m1-runtime` is blocked on its findings. The fixture mirrors the real shapes once they are known. |
| R2 | The spike reveals that the native daemon should replace the broker. | D1 isolates the broker-specific code to interrupt-on-disconnect and leases. The orchestrator reviews the spike before W4 and can re-plan W4 without losing W1-W3. |
| R3 | Companion serialisation makes M0+M1 seven waves long. | Library-first splits, docs lanes, and `m6-ci` as a floating filler lane. Keep lanes to 1-3 items so each wave is short. |
| R4 | Behaviour changes break the 112 existing tests. Many were written to lock current behaviour. | Each brief names exactly which existing tests it may update (report §9.1 list). Other failures must be fixed in code, not by editing the test. |
| R5 | Interrupt-on-disconnect breaks users who relied on turns surviving (report §9.2-3). | It is gated on `owner.kind !== "detached"`, and `--detach` jobs are registered with the broker (`broker/markDetached`) *before* the worker can die. |
| R6 | Flaky timing tests (heartbeat 5s, ttl 30s, grace 10s) make `npm test` slow or flaky. | Every interval is configurable through env (`CODEX_COMPANION_HEARTBEAT_MS`, `CODEX_COMPANION_OWNER_TTL_MS`, `CODEX_COMPANION_CANCEL_GRACE_MS`, `CODEX_COMPANION_OWNER_POLL_MS`), and tests use 200-1000ms values. Add every new env var to `LEAKY_ENV` in `scripts/run-tests.mjs`. **Exception to ownership:** any lane may append to that list. |
| R7 | Pid reuse and portability (report §9.2-4). | `readProcessStartTime` returns an opaque string, with null on unsupported platforms. A null start time means pid-only liveness. Keep the Windows `taskkill` path. |
| R8 | Lock contention from heartbeats. | Heartbeats go to side files and never take `state.lock`. `reconcileJob` persists only on a transition. |
| R9 | Test-process leaks (stubborn workers, fakes that ignore SIGTERM). | Tests must SIGKILL what they spawn in `t.after`. The runner's reaper is the backstop, and every spawned test process carries the sandbox path in its argv or env. |
| R10 | Concurrent Codex lanes' `npm test` runs collide on brokers or state roots. | `scripts/run-tests.mjs` already gives each run its own TMPDIR and config, so concurrent runs are isolated. Lanes must not run tests against the real `~/.codex`. |
| R11 | FR-1's command list in the report includes subcommands not built until M3/M4. | Decision D8: the skill references only commands that exist, and each later lane extends it. |
| R12 | A bypass default before safety is in place (report §9.2-13). | FR-25 is the last M1 wave, and its brief requires the ownership coupling test. |

---

## 8. Open items for the orchestrator

- PROBE (`1mh.1`) and FR-26 (`1mh.3`) remain **open**. The probe lane never ran. `m0-spike` is their lane.
- BUG-4 is split across two W5 lanes (`m1-dispatch-docs`, `m1-completion-signal`). Close `8kj.1` only after both pass review.
- FR-1's "exposes `codex:interrupt`" acceptance is deferred to FR-9 (`e8s.4`) per D8. Add a note to `8kj.2` when closing.
