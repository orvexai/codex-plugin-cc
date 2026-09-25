# Orvex Codex Plugin: Implementation Plan

- Source of requirements: `docs/IMPROVEMENT-REPORT.md` (the "report"). Item ids (BUG-n, FR-n, WISH-n) refer to it.
- Tracker: beads (`bd`). Epics M0 `codex-plugin-cc-1mh`, M1 `-8kj`, M2 `-yew`, M3 `-e8s`, M4 `-wn9`, M5 `-qo4`, M6 `-22z`.
- Executors: Codex worker lanes (gpt-6-luna, danger-full-access) editing the **shared** working tree `/home/crew/workspace/codex-plugin-cc` on branch `orvex/improvement-report`. The orchestrator dispatches from a pinned copy of the plugin, so editing `plugins/codex` is safe. Claude Sonnet reviewers check each lane; fixes return to the same Codex thread. The orchestrator commits and closes beads.
- Lane briefs: `docs/lanes/<lane-id>.md` for every lane of M0-M6. The M2-M6 briefs (§5) were written after the M0 spike and fixture landed; they reference M0/M1 modules by their planned names and tell each lane to read the merged code first. From M2 on, each lane runs in its own git worktree (§5).
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

## 5. Lane DAG: M2-M6 (final; briefs exist in `docs/lanes/`)

Revised 2026-09-25 after the M0 spike (`docs/app-server-probe.md`, `docs/codex-native-surfaces.md`) and the M0 fixture landed. 41 lanes in 19 waves. All 37 remaining report items are covered: BUG-7, 9, 10, 11, 13, 15, 17; FR-2 to FR-24 and FR-27 (FR-16 and FR-25 are M1; FR-26 is M0); WISH-1 to WISH-7.

**Execution model.** Each lane runs in its own git worktree (`/home/crew/workspace/codex-plugin-cc-lanes/<lane-id>`, branch `lane/<lane-id>`), created from `orvex/improvement-report` after the previous wave is merged. Lanes of one wave run concurrently and own **disjoint files** (checked mechanically when the briefs were generated), so their merges do not conflict. Exactly one lane per wave owns `tests/fake-codex-fixture.mjs` + `tests/helpers.mjs`; the others write local helpers in their own test files. Waves run strictly in the order below, milestone by milestone; a wave starts only when every lane of the previous wave is merged and `npm test` is green on the work branch.

**Library first, wiring second.** `codex-companion.mjs` is owned by at most one lane per wave. New `lib/*.mjs` modules (and their unit tests) are built in a wave where the companion is busy with something else, and wired in the next wave. From M5 onward every companion-owning lane also owns `lib/job-api.mjs`, the callable API extracted from the companion in `m5-job-api`.

**Decisions taken from the probe (binding on the briefs):**
- P1. No `thread/unload` exists (probe §6). BUG-11 drops "unload the thread"; follow-ups prefer resuming on the broker that holds the thread, and forks are recorded and resolved (`m3-resume`).
- P2. `ThreadStartResponse` carries effective `model`, `reasoningEffort`, `sandbox`, `approvalPolicy`, `cwd` and `thread.path` (probe §4). BUG-10 reads them from the response (`m4-effective`); FR-7 records `thread.path` as `rolloutPath` (`m2-worker-idle`). A resumed thread can report a different sandbox than it started with (probe §6), so follow-ups send the inherited explicit sandbox and record the effective one.
- P3. `developerInstructions` is verified; **no per-thread key disables skills, hooks or AGENTS.md** (probe §8). FR-13's `--skills/--hooks/--no-agents-md` are narrowed to *advisory* (developer-instruction lines + a `lanePolicy` record + `lane-context` reporting); the unverified candidate keys are never sent on the user's behalf (`m4-lane-lib`, `m4-lane`).
- P4. Native `review/start` turns cannot be steered (probe §7): WISH-3 steering applies to adversarial-review jobs only; the BUG-17 nudge skips review turns.
- P5. `codex queue` schedules a later turn and does not steer (native surfaces §2): not used for `send`, nudges or budgets.
- P6. Keep the plugin broker; **no `daemon` transport** (native surfaces, Decision). D1's optional M6 daemon transport is dropped from `m6-broker-lib`.
- P7. `model/list` is cursor-paginated with `supportedReasoningEfforts`/`defaultReasoningEffort`/`isDefault` (probe §1); `config/read` returns `config` + `origins` (probe §2). FR-12, BUG-9 and FR-15 build on these shapes.
- P8. The runtime has no npm dependencies: JSON Schema validation (`lib/json-schema.mjs`) and the MCP stdio server (`lib/mcp-protocol.mjs`) are hand-written.

**Other scope decisions recorded in the briefs:** FR-9's optional `{op:"continue"}` after natural completion is not implemented (follow-up jobs remain); `defaultLaunch` defaults to `foreground` and `defaultResume` to `ask` (today's behaviour; §8.4 lists example values); `defaultIsolation` is stored in M4 and enforced from M6; BUG-15's overlap warning is exercised with `--shared-tree` because FR-6's lease otherwise refuses the second writer; WISH-3's "model invoked the command" cannot be detected in a command body, so model calls must pass a run-mode flag; FR-27's downstream houston change is reported, not made; token-cost criteria (BUG-4, FR-19, FR-23) remain manual measurements.

### 5.1 Wave table

| Wave | Lane | Beads (`codex-plugin-cc-…`) | Items | Files owned (runtime paths relative to `plugins/codex/scripts/`) | Depends on |
|---|---|---|---|---|---|
| M2-W1 | [`m2-events`](lanes/m2-events.md) | yew.1, yew.2 | FR-2, WISH-1 | `lib/events.mjs`, `lib/tracked-jobs.mjs`, `lib/codex.mjs`, `codex-companion.mjs`, `commands/logs.md`, `skills/codex-drive/SKILL.md` + fixture/helpers; tests: `tests/commands.test.mjs`, `tests/events.test.mjs` | all of M0 and M1 merged |
| M2-W1 | [`m2-snapshot-lib`](lanes/m2-snapshot-lib.md) | yew.4 | FR-5 | `lib/git-snapshot.mjs`; tests: `tests/git-snapshot.test.mjs` | all of M0 and M1 merged |
| M2-W1 | [`m2-report-lib`](lanes/m2-report-lib.md) | yew.5 | FR-4 | `lib/task-report.mjs`, `lib/json-schema.mjs`, `schemas/task-report.schema.json`, `schemas/task-result.schema.json`; tests: `tests/task-report.test.mjs` | all of M0 and M1 merged |
| M2-W1 | [`m2-transcript-lib`](lanes/m2-transcript-lib.md) | yew.6 | FR-7 | `lib/transcript.mjs`; tests: `tests/transcript-lib.test.mjs`, `tests/fixtures/rollouts/` | all of M0 and M1 merged; the event schema in brief `docs/lanes/m2-events.md` (read its "Design decisions"; `m2-events` runs concurrently, so code against that schema, not against its implementation) |
| M2-W2 | [`m2-capture`](lanes/m2-capture.md) | yew.3 | FR-3 | `lib/codex.mjs`, `lib/app-server.mjs`, `lib/tracked-jobs.mjs`, `lib/job-control.mjs`, `lib/render.mjs` + fixture/helpers; tests: `tests/capture.test.mjs` | wave 1 (`m2-events` merged: event writer and schema) |
| M2-W2 | [`m2-report`](lanes/m2-report.md) | yew.5, yew.4 | FR-4, FR-5 | `codex-companion.mjs`, `lib/task-report.mjs`, `lib/json-schema.mjs`, `lib/git-snapshot.mjs`, `schemas/task-report.schema.json`, `schemas/task-result.schema.json`; tests: `tests/report.test.mjs` | wave 1 (`m2-events`, `m2-snapshot-lib`, `m2-report-lib` merged) |
| M2-W3 | [`m2-worker-idle`](lanes/m2-worker-idle.md) | yew.8, yew.6 | BUG-17, FR-7 | `lib/codex.mjs`, `lib/tracked-jobs.mjs`, `lib/job-liveness.mjs` + fixture/helpers; tests: `tests/idle.test.mjs` | wave 2 (`m2-capture`, `m2-report` merged) |
| M2-W3 | [`m2-status-lib`](lanes/m2-status-lib.md) | yew.7, yew.8 | FR-8, BUG-17 | `lib/partial-result.mjs`, `lib/job-control.mjs`, `lib/render.mjs`; tests: `tests/status-lib.test.mjs` | wave 2 (`m2-capture`, `m2-report` merged) |
| M2-W4 | [`m2-inspect`](lanes/m2-inspect.md) | yew.6, yew.7, yew.3 | FR-7, FR-8, FR-3 | `codex-companion.mjs`, `lib/codex.mjs`, `lib/transcript.mjs`, `lib/partial-result.mjs`, `lib/render.mjs`, `commands/status.md`, `skills/codex-drive/SKILL.md` + fixture/helpers; tests: `tests/inspect.test.mjs` | wave 3 (`m2-worker-idle`, `m2-status-lib` merged) and wave 1 (`m2-transcript-lib`) |
| M3-W1 | [`m3-resume`](lanes/m3-resume.md) | e8s.1, e8s.2, e8s.3 | BUG-7, BUG-11, FR-21 | `lib/args.mjs`, `codex-companion.mjs`, `lib/codex.mjs`, `lib/thread-forks.mjs`, `lib/render.mjs`, `lib/tracked-jobs.mjs`, `commands/rescue.md`, `skills/codex-drive/SKILL.md`, `skills/codex-cli-runtime/SKILL.md`, `CHANGELOG.md` + fixture/helpers; tests: `tests/resume.test.mjs`, `tests/orvex.test.mjs` | all of M2 merged |
| M3-W1 | [`m3-session-start`](lanes/m3-session-start.md) | e8s.5 | FR-10 | `session-lifecycle-hook.mjs`, `lib/session-context.mjs`; tests: `tests/session-start.test.mjs`, `tests/fixtures/session-start/` | all of M2 merged |
| M3-W1 | [`m3-control-lib`](lanes/m3-control-lib.md) | e8s.4, e8s.7, e8s.6 | FR-9, FR-17, FR-20 | `lib/control-channel.mjs`, `lib/job-budget.mjs`, `lib/message-ledger.mjs`; tests: `tests/control-lib.test.mjs` | all of M2 merged |
| M3-W2 | [`m3-control`](lanes/m3-control.md) | e8s.4, e8s.7 | FR-9, FR-17 | `codex-companion.mjs`, `lib/codex.mjs`, `lib/tracked-jobs.mjs`, `lib/control-channel.mjs`, `lib/job-budget.mjs`, `lib/render.mjs`, `commands/interrupt.md`, `skills/codex-drive/SKILL.md` + fixture/helpers; tests: `tests/commands.test.mjs`, `tests/interrupt.test.mjs`, `tests/budget.test.mjs` | wave 1 (`m3-resume`, `m3-session-start`, `m3-control-lib` merged) |
| M3-W2 | [`m3-reattach-lib`](lanes/m3-reattach-lib.md) | e8s.5 | FR-10 | `lib/job-control.mjs`, `lib/job-adopt.mjs`; tests: `tests/reattach-lib.test.mjs` | wave 1 merged |
| M3-W3 | [`m3-reattach-send`](lanes/m3-reattach-send.md) | e8s.5, e8s.6 | FR-10, FR-20 | `codex-companion.mjs`, `lib/codex.mjs`, `lib/message-ledger.mjs`, `lib/job-adopt.mjs`, `lib/job-control.mjs`, `lib/render.mjs`, `lib/session-context.mjs`, `commands/attach.md`, `commands/messages.md`, `commands/send.md`, `skills/codex-drive/SKILL.md` + fixture/helpers; tests: `tests/commands.test.mjs`, `tests/reattach.test.mjs`, `tests/messages.test.mjs` | wave 2 (`m3-control`, `m3-reattach-lib` merged) |
| M4-W1 | [`m4-models-lib`](lanes/m4-models-lib.md) | wn9.1, wn9.2 | FR-12, BUG-9 | `lib/models.mjs`; tests: `tests/models-lib.test.mjs` | all of M3 merged |
| M4-W1 | [`m4-lane-lib`](lanes/m4-lane-lib.md) | wn9.4 | FR-13 | `lib/lane-config.mjs`, `prompts/delegated-worker.md`; tests: `tests/lane-config.test.mjs` | all of M3 merged |
| M4-W1 | [`m4-config-lib`](lanes/m4-config-lib.md) | wn9.5, wn9.6 | FR-14, FR-15 | `lib/config.mjs`; tests: `tests/config-lib.test.mjs` | all of M3 merged |
| M4-W1 | [`m4-effective`](lanes/m4-effective.md) | wn9.3 | BUG-10 | `lib/codex.mjs`, `lib/tracked-jobs.mjs`, `lib/render.mjs` + fixture/helpers; tests: `tests/effective-runtime.test.mjs` | all of M3 merged |
| M4-W2 | [`m4-models`](lanes/m4-models.md) | wn9.1, wn9.2 | FR-12, BUG-9 | `codex-companion.mjs`, `lib/models.mjs`, `lib/render.mjs`, `commands/models.md`, `commands/rescue.md`, `agents/codex-rescue.md`, `skills/codex-cli-runtime/SKILL.md`, `skills/codex-drive/SKILL.md`, `README.md` + fixture/helpers; tests: `tests/commands.test.mjs`, `tests/models.test.mjs` | wave 1 (`m4-models-lib`, `m4-lane-lib`, `m4-config-lib`, `m4-effective` merged) |
| M4-W3 | [`m4-lane`](lanes/m4-lane.md) | wn9.4 | FR-13 | `codex-companion.mjs`, `lib/codex.mjs`, `lib/args.mjs`, `lib/lane-config.mjs`, `prompts/delegated-worker.md`, `skills/codex-drive/SKILL.md` + fixture/helpers; tests: `tests/lane.test.mjs`, `tests/orvex.test.mjs`, `tests/runtime.test.mjs` | wave 2 (`m4-models` merged) |
| M4-W4 | [`m4-config`](lanes/m4-config.md) | wn9.5, wn9.6 | FR-14, FR-15 | `codex-companion.mjs`, `lib/config.mjs`, `lib/state.mjs`, `lib/render.mjs`, `lib/claude-md.mjs`, `stop-review-gate-hook.mjs`, `commands/rescue.md`, `commands/setup.md`, `skills/codex-drive/SKILL.md`, `README.md` + fixture/helpers; tests: `tests/config.test.mjs`, `tests/claude-md.test.mjs` | wave 3 (`m4-lane` merged) |
| M5-W1 | [`m5-job-api`](lanes/m5-job-api.md) | qo4.1, qo4.2 | FR-11, FR-19 | `codex-companion.mjs`, `lib/job-api.mjs` + fixture/helpers; tests: `tests/job-api.test.mjs` | all of M4 merged |
| M5-W1 | [`m5-fanout-lib`](lanes/m5-fanout-lib.md) | qo4.4 | FR-18 | `lib/fanout.mjs`; tests: `tests/fanout-lib.test.mjs` | all of M4 merged |
| M5-W1 | [`m5-brief-lib`](lanes/m5-brief-lib.md) | qo4.3 | FR-23 | `lib/brief-format.mjs`; tests: `tests/brief-lib.test.mjs` | all of M4 merged |
| M5-W1 | [`m5-mcp-protocol`](lanes/m5-mcp-protocol.md) | qo4.1 | FR-11 | `lib/mcp-protocol.mjs`; tests: `tests/mcp-protocol.test.mjs` | all of M4 merged |
| M5-W2 | [`m5-mcp`](lanes/m5-mcp.md) | qo4.1 | FR-11 | `mcp-server.mjs`, `lib/mcp-tools.mjs`, `lib/mcp-protocol.mjs`, `.mcp.json`; tests: `tests/mcp.test.mjs` | wave 1 (`m5-job-api`, `m5-fanout-lib`, `m5-brief-lib`, `m5-mcp-protocol` merged) |
| M5-W2 | [`m5-fanout-brief`](lanes/m5-fanout-brief.md) | qo4.4, qo4.3 | FR-18, FR-23 | `codex-companion.mjs`, `lib/job-api.mjs`, `lib/fanout.mjs`, `lib/brief-format.mjs`, `lib/codex.mjs`, `lib/tracked-jobs.mjs`, `lib/render.mjs` + fixture/helpers; tests: `tests/fanout.test.mjs`, `tests/brief.test.mjs` | wave 1 merged |
| M5-W2 | [`m5-workflow`](lanes/m5-workflow.md) | qo4.2 | FR-19 | `agents/codex-exec.md`, `skills/codex-workflow/SKILL.md`; tests: `tests/fixtures/workflow/`, `tests/workflow.test.mjs` | wave 1 merged (`--progress-stderr`, the job API) |
| M5-W3 | [`m5-docs`](lanes/m5-docs.md) | qo4.5, qo4.3, qo4.4 | FR-27, FR-23, FR-18 | `codex-companion.mjs`, `lib/job-api.mjs`, `lib/claude-md.mjs`, `lib/config.mjs`, `lib/mcp-tools.mjs`, `commands/rescue.md`, `commands/result.md`, `skills/codex-result-handling/SKILL.md`, `skills/codex-drive/SKILL.md`, `skills/codex-workflow/SKILL.md`, `README.md` + fixture/helpers; tests: `tests/fixtures/delegation/`, `tests/commands.test.mjs`, `tests/claude-md.test.mjs`, `tests/delegation.test.mjs` | wave 2 (`m5-mcp`, `m5-fanout-brief`, `m5-workflow` merged) |
| M6-W1 | [`m6-worktree-lib`](lanes/m6-worktree-lib.md) | 22z.1 | FR-6 | `lib/worktree.mjs`, `lib/tree-lease.mjs`; tests: `tests/worktree-lib.test.mjs` | all of M5 merged |
| M6-W1 | [`m6-broker-lib`](lanes/m6-broker-lib.md) | 22z.3, 22z.4 | FR-22, BUG-13 | `app-server-broker.mjs`, `lib/broker-lifecycle.mjs`, `lib/app-server.mjs`, `lib/codex.mjs`, `lib/tracked-jobs.mjs` + fixture/helpers; tests: `tests/broker-lib.test.mjs`, `tests/error-surfacing.test.mjs` | all of M5 merged |
| M6-W1 | [`m6-ci`](lanes/m6-ci.md) | 22z.6 | FR-24 | `.github/workflows/pull-request-ci.yml`, `.github/workflows/nightly.yml`, `scripts/check-doc-consistency.mjs`; tests: `tests/doc-consistency.test.mjs`, `tests/contract.test.mjs`, `tests/fixtures/doc-consistency-allowlist.json` | none strictly (best after M5, so the doc check sees the final docs) |
| M6-W1 | [`m6-history-lib`](lanes/m6-history-lib.md) | 22z.11 | WISH-7 | `lib/archive.mjs`, `lib/state.mjs`; tests: `tests/archive.test.mjs` | all of M5 merged |
| M6-W1 | [`m6-prompting`](lanes/m6-prompting.md) | 22z.10 | WISH-6 | `skills/gpt-5-4-prompting/`, `skills/codex-prompting/`, `agents/codex-rescue.md`, `agents/codex-exec.md`, `commands/rescue.md`; tests: `tests/commands.test.mjs` | all of M5 merged |
| M6-W1 | [`m6-escalation-lib`](lanes/m6-escalation-lib.md) | 22z.8 | WISH-4 | `lib/escalation.mjs`; tests: `tests/escalation-lib.test.mjs` | all of M5 merged |
| M6-W2 | [`m6-isolation`](lanes/m6-isolation.md) | 22z.1, 22z.2 | FR-6, BUG-15 | `codex-companion.mjs`, `lib/job-api.mjs`, `lib/job-control.mjs`, `lib/render.mjs`, `lib/workspace.mjs`, `lib/worktree.mjs`, `lib/tree-lease.mjs`, `lib/tracked-jobs.mjs`, `lib/mcp-tools.mjs`, `skills/codex-drive/SKILL.md`, `README.md`; tests: `tests/orvex.test.mjs`, `tests/isolation.test.mjs`, `tests/overlap.test.mjs` | wave 1 (`m6-worktree-lib`, `m6-broker-lib`, `m6-ci`, `m6-history-lib`, `m6-prompting`, `m6-escalation-lib` merged) |
| M6-W2 | [`m6-approval-worker`](lanes/m6-approval-worker.md) | 22z.9 | WISH-5 | `lib/app-server.mjs`, `lib/codex.mjs`, `lib/approvals.mjs`, `app-server-broker.mjs` + fixture/helpers; tests: `tests/approvals-lib.test.mjs` | wave 1 merged |
| M6-W3 | [`m6-ops`](lanes/m6-ops.md) | 22z.3, 22z.4, 22z.11 | FR-22, BUG-13, WISH-7 | `codex-companion.mjs`, `lib/job-api.mjs`, `lib/render.mjs`, `lib/job-control.mjs`, `lib/archive.mjs`, `lib/broker-lifecycle.mjs`, `lib/config.mjs`, `agents/codex-rescue.md`, `skills/codex-drive/SKILL.md` + fixture/helpers; tests: `tests/ops.test.mjs`, `tests/history.test.mjs` | wave 2 (`m6-isolation`, `m6-approval-worker` merged) |
| M6-W4 | [`m6-rails`](lanes/m6-rails.md) | 22z.5, 22z.8 | WISH-2, WISH-4 | `codex-companion.mjs`, `lib/job-api.mjs`, `lib/render.mjs`, `lib/job-control.mjs`, `lib/tracked-jobs.mjs`, `lib/escalation.mjs`, `lib/config.mjs`, `lib/mcp-tools.mjs`, `skills/codex-drive/SKILL.md` + fixture/helpers; tests: `tests/rails.test.mjs`, `tests/escalation.test.mjs` | wave 3 (`m6-ops` merged) |
| M6-W5 | [`m6-reviews`](lanes/m6-reviews.md) | 22z.7, 22z.9 | WISH-3, WISH-5 | `codex-companion.mjs`, `lib/job-api.mjs`, `lib/codex.mjs`, `lib/tracked-jobs.mjs`, `lib/approvals.mjs`, `lib/mcp-tools.mjs`, `lib/render.mjs`, `commands/review.md`, `commands/adversarial-review.md`, `skills/codex-drive/SKILL.md` + fixture/helpers; tests: `tests/commands.test.mjs`, `tests/reviews.test.mjs`, `tests/approvals.test.mjs` | wave 4 (`m6-rails` merged) |

### 5.2 Waves at a glance (lanes in one row run concurrently)

| Wave | Concurrent lanes | Why this order |
|---|---|---|
| M2-W1 | `m2-events`, `m2-snapshot-lib`, `m2-report-lib`, `m2-transcript-lib` | The event schema plus three pure libraries; only `m2-events` touches the companion |
| M2-W2 | `m2-capture`, `m2-report` | Capture needs the event writer; the report wiring needs both W1 libraries |
| M2-W3 | `m2-worker-idle`, `m2-status-lib` | Worker-side idle/rollout vs. snapshot/render side; both need W2's captured data |
| M2-W4 | `m2-inspect` | CLI for transcript, partial results and status flags on top of W1-W3 |
| M3-W1 | `m3-resume`, `m3-session-start`, `m3-control-lib` | Resume/fork owns the companion; the hook and control libraries are disjoint |
| M3-W2 | `m3-control`, `m3-reattach-lib` | `interrupt --then` and budgets need the control library and BUG-7's resume; adoption library is disjoint |
| M3-W3 | `m3-reattach-send` | `attach`/`adopt`/`messages`/`unsend` need the adoption library and the message ledger |
| M4-W1 | `m4-models-lib`, `m4-lane-lib`, `m4-config-lib`, `m4-effective` | Three pure libraries plus BUG-10 in the worker layer (no companion) |
| M4-W2 | `m4-models` | Model/effort validation in every command |
| M4-W3 | `m4-lane` | Lane flags reuse the model-validated flag parsing |
| M4-W4 | `m4-config` | Centralises every key (including M4-W2/W3's) and profiles |
| M5-W1 | `m5-job-api`, `m5-fanout-lib`, `m5-brief-lib`, `m5-mcp-protocol` | Extract the callable job API; three pure libraries |
| M5-W2 | `m5-mcp`, `m5-fanout-brief`, `m5-workflow` | MCP server (no companion), fan-out/brief/`mcp` subcommand (companion), Workflow docs |
| M5-W3 | `m5-docs` | Delegation docs need the real tool list; `codex_fanout` needs fan-out |
| M6-W1 | `m6-worktree-lib`, `m6-broker-lib`, `m6-ci`, `m6-history-lib`, `m6-prompting`, `m6-escalation-lib` | Libraries, broker/transport layer, CI and docs; no companion |
| M6-W2 | `m6-isolation`, `m6-approval-worker` | Worktrees/lease/overlap (companion) vs. approval bridge (transport) |
| M6-W3 | `m6-ops` | `broker`, Warnings, `gc`/`history` CLI |
| M6-W4 | `m6-rails` | `cancel --all`, badges, lease requirement, escalation wiring |
| M6-W5 | `m6-reviews` | Tracked reviews and the approval CLI (needs W2's bridge) |

`m6-ci` touches only `.github/`, `scripts/check-doc-consistency.mjs` and new test files, so the orchestrator may pull it into any earlier wave as a filler; its doc check is most useful after M5. Critical path: 19 waves; the widest waves are M6-W1 (6 lanes) and M2-W1, M4-W1, M5-W1 (4 lanes each).

### 5.3 Shared-file ownership across M2-M6 (by wave)

| File | Owning lane per wave |
|---|---|
| `codex-companion.mjs` | m2-events (W1) → m2-report (W2) → m2-inspect (W4) → m3-resume → m3-control → m3-reattach-send → m4-models → m4-lane → m4-config → m5-job-api → m5-fanout-brief → m5-docs → m6-isolation → m6-ops → m6-rails → m6-reviews |
| `lib/codex.mjs` | m2-events → m2-capture → m2-worker-idle → m2-inspect → m3-resume → m3-control → m3-reattach-send → m4-effective → m4-lane → m5-fanout-brief → m6-broker-lib → m6-approval-worker → m6-reviews |
| `lib/tracked-jobs.mjs` | m2-events → m2-capture → m2-worker-idle → m3-resume → m3-control → m4-effective → m5-fanout-brief → m6-broker-lib → m6-isolation → m6-rails → m6-reviews |
| `lib/render.mjs` | m2-capture → m2-status-lib → m2-inspect → m3-resume → m3-control → m3-reattach-send → m4-effective → m4-models → m4-config → m5-fanout-brief → m6-isolation → m6-ops → m6-rails → m6-reviews |
| `lib/job-control.mjs` | m2-capture → m2-status-lib → m3-reattach-lib → m3-reattach-send → m6-isolation → m6-ops → m6-rails |
| `skills/codex-drive/SKILL.md` | one lane per wave that adds commands (see each brief) |
| fixture + helpers | exactly one lane per wave (the brief header says which) |

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
