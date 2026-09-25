# Lane `m0-ownership`: Job ownership: broker interrupt-on-disconnect, signal handlers, `--attach`/`--detach`/owner lease (BUG-1)

- **Beads:** `codex-plugin-cc-1mh.6`
- **Report items:** BUG-1
- **Wave:** 4. **Depends on:** `m0-cancel`; the orchestrator has reviewed `docs/codex-native-surfaces.md` (lane `m0-spike`). **Runs concurrently with:** `m0-session-end`.

## Goal

Stopping the Claude-side handle (TaskStop, KillShell, killing the worker or a foreground `task`) leaves Codex editing files. This was the P0 safety incident: a full-access job ran against a live system for 11+ minutes. Tie every job's lifetime to an owner: the broker interrupts a turn when its owning socket dies, foreground and attach processes cancel their job on signals, and a detached worker cancels itself when its owner disappears. Add the canonical launch `task --attach`.

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

- `plugins/codex/scripts/app-server-broker.mjs`
- `plugins/codex/scripts/lib/app-server.mjs`
- `plugins/codex/scripts/lib/codex.mjs`
- `plugins/codex/scripts/lib/job-liveness.mjs`
- `plugins/codex/scripts/lib/control-channel.mjs`
- `plugins/codex/scripts/lib/tracked-jobs.mjs`
- `plugins/codex/scripts/lib/job-control.mjs`
- `plugins/codex/scripts/lib/render.mjs`
- `plugins/codex/scripts/lib/process.mjs`
- `plugins/codex/scripts/codex-companion.mjs`
- `tests/fake-codex-fixture.mjs`
- `tests/helpers.mjs`
- `tests/ownership.test.mjs`

## Do not touch

Lane `m0-session-end` runs at the same time and owns:
- `plugins/codex/scripts/session-lifecycle-hook.mjs`
- `plugins/codex/scripts/lib/broker-lifecycle.mjs` (broker.json leases, broker log location). If you need a broker-lifecycle change, describe it as a follow-up instead.
- `tests/session-end.test.mjs`, `tests/runtime.test.mjs`
Also do not edit: `stop-review-gate-hook.mjs`, `hooks/hooks.json`, `commands/**`, `agents/**`, `skills/**`, `lib/state.mjs`, any existing test file.

## Design decisions binding on this lane

Binding decisions (plan D1, D3, D4, D8):

- **Broker interrupt-on-disconnect (step 1, required):** in `app-server-broker.mjs` `main`, track the active stream's `{threadId, turnId}`: `turnId` comes from the `turn/start` result (`result.turn.id`) or the first `turn/started` notification for that thread. When the socket that owns `activeStreamSocket` emits `close` or `error` while a turn is active and that thread is **not** registered as detached, the broker calls `appClient.request("turn/interrupt", {threadId, turnId})` and logs it. Add a busy-exempt method `broker/markDetached {threadId}` (and the `turn/start` param `brokerDetached: true`, stripped before forwarding) that registers the thread as detached. Detached registrations are cleared on `turn/completed`.
- **Ownership lease (step 3):** new task flags `--attach` (alias `--follow`), `--detach`, `--on-owner-exit cancel|continue` (default `cancel`; `--detach` implies `continue`), `--owner-pid <pid>`, `--timeout-ms <n>` (attach only). Config key `onOwnerExit` (read with `getConfig`/`getGlobalConfig`; `setup --default-on-detach cancel|continue [--global]` writes it). The job record gets `owner: {kind:"attach"|"foreground"|"pid"|"detached", pid, startTime, heartbeatAt, ttlMs}` and `onOwnerExit`. `ttlMs` = `CODEX_COMPANION_OWNER_TTL_MS` or 30000.
- **Owner heartbeat:** the attach process (and a foreground task) writes `jobs/<id>.owner.hb` every `CODEX_COMPANION_HEARTBEAT_MS` using `startHeartbeat(resolveHeartbeatFile(ws, id, "owner"))` from `lib/job-liveness.mjs`.
- **Worker owner check:** the worker polls every `CODEX_COMPANION_OWNER_POLL_MS` (default 2000). It treats the owner as lost when `!isSameProcess(owner)`, or when the owner heartbeat is older than `ttlMs` (only if a heartbeat was ever written). If `onOwnerExit === "cancel"`, it appends a `cancel` control op to **its own job** with `reason:"owner-lost"` (one cancel path; `m0-cancel` finalises the job with `status:"cancelled"`, `cancelReason:"owner-lost"`), and logs `owner exited; cancelling`. Detached jobs call `broker/markDetached` **before** `turn/start` is sent, so a worker death cannot race it.
- **`--attach` behaviour:** enqueue the detached worker exactly like `--background` (with `owner.kind:"attach"`, `owner.pid = process.pid`), then stay in the foreground: print the launch line (below) to stdout, stream compact progress lines to stderr (tail the job log or poll the job file), and on a terminal status print the rendered result to stdout and exit `exitCodeForJob(status, {mode:"attach"})`. `--attach --json` prints the final JSON payload. On SIGTERM/SIGINT/SIGHUP: run the verified cancel for the job (reuse the `handleCancel` internals; refactor them into a callable `cancelJob(...)`), then exit 130. On `--timeout-ms` expiry: **release ownership first** (rewrite `owner.kind` to `"detached"` and `onOwnerExit` to `"continue"`, and call `broker/markDetached`), print the `wait <id>` / `cancel <id>` commands, and exit 124 (the waiter gave up; the job keeps running).
- **Foreground `task` (step 2):** records `owner.kind:"foreground"` with its own pid, and installs SIGTERM/SIGINT/SIGHUP handlers that append a `cancel` control op to its own job (its in-process turn loop handles it), wait up to the grace period, and exit 130.
- **`--background` without `--attach` (step 4):** still works. Without `--detach`, the job gets `owner.kind:"detached"` **and** a warning on stderr: `Warning: job <id> is unowned (use --attach). Stop it with: <exact cancel command>`. With `--detach`, the same ownership but no warning.
- **Launch line (plan D8; lane `m1-completion-signal` extends it later):** `--attach` prints `CODEX_JOB <jobId> status=<queued|running> thread=<id|pending> log=<path>` as the first stdout line. Pure `--background` prints `CODEX_JOB_QUEUED id=<id> status=queued (NOT finished)` as the first line and then `Wait with: node <script> wait <id> --json`. `--json` output is unchanged (JSON only).
- **Status (step 5):** `status --json` adds `owner`, `ownerAlive`, and `orphaned` (= active && owner not alive && `owner.kind !== "detached"`). The rendered status shows an owner marker.

## Implementation guide

- `app-server-broker.mjs`: `main` (turn tracking, interrupt-on-disconnect in the socket `close`/`error` handlers, `broker/markDetached`), `isInterruptRequest` (make `broker/markDetached` busy-exempt too).
- `lib/codex.mjs`: `runAppServerTurn` (owner poll alongside the control poll; the markDetached call; pass `brokerDetached`).
- `lib/job-liveness.mjs`: `assessOwner(workspaceRoot, job)` → `{alive, reason}`.
- `lib/tracked-jobs.mjs`: owner fields in `createJobRecord`/queued record.
- `codex-companion.mjs`: `handleTask` (flags, attach loop, foreground handlers, warnings, launch line), refactor `handleCancel` → `cancelJob`, `handleSetup` (`--default-on-detach`), `renderQueuedTaskLaunch`, `printUsage` (task line), `handleStatus`.
- `lib/job-control.mjs`/`lib/render.mjs`: `ownerAlive`/`orphaned` in snapshots and rendering.

## Fake-Codex fixture API (from lane `m0-fixture`)

The fixture API from lane `m0-fixture` (see `docs/IMPLEMENTATION-PLAN.md` D2), in short: `installFakeCodex(binDir, behavior, options)`; `setFakeCodexOptions(binDir, patch)`; `options.turnScript` steps (`command`, `fileChange`, `agentMessage`, `reasoning`, `plan`, `diff`, `usage`, `delay`, `silence`, `serverRequest`); `options.interrupt: "cooperate"|"ignore"|"ack-only"`; `options.ignoreSigterm`; `options.delays.{initialize,threadStart,turnStart}`; `options.models`, `options.config`, `options.forceActiveWriter`; `readFakeRpcLog(binDir, {method, conn})`, `fakeConnections(binDir)`; `occupyBroker(endpoint, {holdMs})`; helpers `spawnStubborn()`, `waitFor()`, `isPidAlive()`, `makeCompanionWorkspace()`, `startFakeAppServer()`. Read the fixture source for the exact signatures before writing tests. If you need a fixture capability that is missing, add it **additively** (this lane owns the fixture files in this wave) and keep every existing behaviour string working.

## Tests to write first

`tests/ownership.test.mjs` (fixture with a long scripted turn; `CODEX_COMPANION_OWNER_TTL_MS=1500`, `CODEX_COMPANION_OWNER_POLL_MS=200`, `CODEX_COMPANION_HEARTBEAT_MS=200`, short cancel graces; use `spawnCompanion` for long-running processes and `readFakeRpcLog` for interrupts). Make sure the turn is broker-hosted (the default path; assert the `transport:"broker"` field):
1. Start `task --attach --full-access` in a background shell (`sh -c "node … task --attach …"`), then SIGTERM that shell's process tree. Within 5s: status `cancelled`, `cancelReason:"owner-lost"` (or the attach handler's reason; accept either as long as the turn stopped, and document which), the fake (via the broker) received `turn/interrupt`, and no worker pid or fake app-server child pid for that job is alive.
2. SIGKILL the attach process: the worker self-cancels within ttl+5s.
3. SIGKILL the **worker** of a broker-hosted turn: the fake receives `turn/interrupt` from the broker within 2s.
4. `task --background --detach` survives its parent's exit; `status --json` shows `owner.kind:"detached"` and `ownerAlive:false`, and it completes normally.
5. `--owner-pid <sleep pid>`, then kill the sleep: status becomes `cancelled`/`owner-lost` within 5s.
6. `--attach` exit codes: completed → 0 (stdout ends with the result), failed (`turnStatus:"failed"`) → 1, cancelled via `cancel <id>` from another process → 130. `--timeout-ms 500` on a long turn → exit 124, the job still running and now `detached`.
7. `--background` without `--detach` prints the unowned warning with the exact cancel command; its first stdout line matches `/^CODEX_JOB_QUEUED /`. `--attach`'s first line matches `/^CODEX_JOB /`.
8. Foreground `task` receiving SIGTERM exits 130 and the fake received `turn/interrupt`.

## Requirements from the report (verbatim)

The text below is copied verbatim from `docs/IMPROVEMENT-REPORT.md`. You do not need to read the rest of the report.

### BUG-1: Stopping the Claude-side handle leaves the Codex job running (orphaned full-access jobs)
- **Priority:** P0
- **Problem:** Nothing ties a job's lifetime to its launcher. (a) Background: `spawnDetachedTaskWorker` uses `detached:true`, `stdio:'ignore'` and `child.unref()`, and returns immediately. (b) Foreground `task` has no SIGTERM, SIGINT or SIGHUP handlers; `grep process.on(` finds none in `codex-companion.mjs` or `lib/`. (c) **Most important:** the worker runs its turn through the shared **broker** by default, so the turn executes inside the broker's app-server. When the owning socket closes, the broker's handler only calls `clearSocketOwnership` and never sends `turn/interrupt`. Killing the worker, its process group or a foreground `task` therefore **cannot** stop a broker-hosted turn. The job record stores only a `sessionId`, with no owner and no liveness.
- **Evidence:** E1, E2. `codex-companion.mjs` `spawnDetachedTaskWorker` ~911-922 and `enqueueBackgroundTask` ~924-950. `lib/app-server.mjs` 336-353 (connect defaults to `ensureBrokerSession`). `app-server-broker.mjs` 75-83 and 228-236 (close/error → `clearSocketOwnership` only). `lib/tracked-jobs.mjs` 62-70 (job record). `agents/codex-rescue.md` 22-25.
- **Proposal:**
  1. **Broker interrupt-on-disconnect (required).** When the socket that owns `activeStreamSocket` closes or errors mid-turn, the broker sends `turn/interrupt` for the tracked `{threadId, turnId}`. Skip this only when the job is marked `detached` (see 3): the worker records that in the job file, and the broker is told through a `broker/markDetached {threadId}` call or a param at `turn/start`.
  2. **Signal handlers.** Foreground `task` and the new `--attach` watcher install SIGTERM, SIGINT and SIGHUP handlers that run the verified-cancel path (BUG-2) for their job, then exit 130.
  3. **Ownership lease.** Add these task flags:
     - `--attach` (alias `--follow`): enqueue the detached worker, then stay in the foreground, stream compact progress to stderr, and exit with the job's exit code. This becomes the canonical launch.
     - `--detach`: today's fire-and-forget behaviour, recorded as `owner.kind:'detached'`.
     - `--on-owner-exit cancel|continue`: default `cancel`, except `--detach` implies `continue`.
     - `--owner-pid <pid>`: explicit owner.
     - Persistent default through `setup --default-on-detach cancel|continue`.

     The job record gains `owner: {kind:'attach'|'foreground'|'pid'|'detached', pid, startTime, heartbeatAt, ttlMs:30000}`. The attached or waiting process refreshes `heartbeatAt` every 5s. The worker checks owner liveness every 2-5s (`kill(pid,0)` plus a start-time comparison against pid reuse; see BUG-6) or heartbeat age. On owner loss it interrupts the turn, logs `owner exited; cancelling`, and writes `status:'cancelled', cancelReason:'owner-lost'`.
  4. `--background` without `--attach` keeps working but prints a warning that the job is unowned, plus the exact `cancel <id>` command.
  5. `status` shows `ownerAlive` and `orphaned`.
- **Acceptance criteria:**
  - Start `task --attach --full-access` against the fake fixture in a background shell, then SIGTERM that shell. Within 5s: status is `cancelled`, `cancelReason` is `owner-lost`, the fake app-server (through the broker) received `turn/interrupt`, and `pgrep` finds no worker or codex child.
  - Same test with SIGKILL of the attach process: the worker self-cancels within ttl+5s.
  - SIGKILL the **worker** of a broker-hosted turn: the broker issues `turn/interrupt` within 2s.
  - `task --background --detach` survives its parent's exit, and `status --json` shows `owner.kind:'detached'` and `ownerAlive:false`.
  - `--owner-pid <sleep pid>`, then kill the sleep: status becomes `cancelled`/`owner-lost` within 5s.

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

- [ ] Start `task --attach --full-access` against the fake fixture in a background shell, then SIGTERM that shell. Within 5s: status is `cancelled`, `cancelReason` is `owner-lost`, the fake app-server (through the broker) received `turn/interrupt`, and `pgrep` finds no worker or codex child
- [ ] Same test with SIGKILL of the attach process: the worker self-cancels within ttl+5s
- [ ] SIGKILL the **worker** of a broker-hosted turn: the broker issues `turn/interrupt` within 2s
- [ ] `task --background --detach` survives its parent's exit, and `status --json` shows `owner.kind:'detached'` and `ownerAlive:false`
- [ ] `--owner-pid <sleep pid>`, then kill the sleep: status becomes `cancelled`/`owner-lost` within 5s
- [ ] `--attach` exits with the §8.1 code (0/1/130), and 124 on `--timeout-ms` with ownership released
- [ ] Unowned `--background` prints a warning and the exact cancel command; launch first lines match `/^CODEX_JOB(_QUEUED)? /`
- [ ] Foreground `task` has SIGTERM/SIGINT/SIGHUP handlers that verify-cancel and exit 130
- [ ] `npm test` green with no existing test modified

## Required final report (your last message; use exactly these sections)

```
## Lane m0-ownership report
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
