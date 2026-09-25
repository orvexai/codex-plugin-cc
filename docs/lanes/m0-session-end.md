# Lane `m0-session-end`: SessionEnd keeps evidence; broker lease ref-counting; persistent broker log (BUG-3)

- **Beads:** `codex-plugin-cc-1mh.7`
- **Report items:** BUG-3
- **Wave:** 4. **Depends on:** `m0-cancel`; the orchestrator has reviewed `docs/codex-native-surfaces.md`. **Runs concurrently with:** `m0-ownership`.

## Goal

The SessionEnd hook deletes every job record, log and inbox for the ending session (finished jobs included), and shuts down the per-workspace broker that other live sessions share. Make SessionEnd non-destructive: it cancels (or detaches) the session's active jobs through the control channel within its 5s budget, writes a session summary, and shuts the broker down only when no other session holds a lease and no job is active. Broker logs become persistent.

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

- `plugins/codex/scripts/session-lifecycle-hook.mjs`
- `plugins/codex/scripts/lib/broker-lifecycle.mjs`
- `tests/session-end.test.mjs`
- `tests/runtime.test.mjs (only the SessionEnd test, currently around line 1804: "session end fully cleans up jobs for the ending session")`

## Do not touch

Lane `m0-ownership` runs at the same time and owns: `app-server-broker.mjs`, `lib/app-server.mjs`, `lib/codex.mjs`, `lib/job-liveness.mjs`, `lib/control-channel.mjs`, `lib/tracked-jobs.mjs`, `lib/job-control.mjs`, `lib/render.mjs`, `lib/process.mjs`, `codex-companion.mjs`, `tests/fake-codex-fixture.mjs`, `tests/helpers.mjs`, `tests/ownership.test.mjs`. You may **import** from those modules (read-only use of their exported APIs: `appendControlOp`, `reconcileJob`, `isSameProcess`, `readProcessStartTime`, `isActiveJobStatus`), but you must not edit them. Also do not edit `lib/state.mjs` (use its exported API), `hooks/hooks.json`, `stop-review-gate-hook.mjs`, or any other existing test.
If you need a fixture capability that does not exist, write a small local helper inside `tests/session-end.test.mjs` instead.

## Design decisions binding on this lane

Binding decisions (plan D7):

- **SessionEnd never deletes records or artifacts.** Remove the `saveState(… jobs.filter(sessionId !== …))` deletion in `cleanupSessionJobs`. Nothing under `jobs/` is removed by the hook.
- **Policy per active job of the ending session** (first reconcile it with `reconcileJob`, file-only): if `job.owner?.kind === "detached"` → `detach`; else the workspace/global config key `sessionEndPolicy` (`cancel|detach`, read with `getConfig`/`getGlobalConfig`), default `cancel`. (The `setup --session-end-policy` flag lives in the companion, which you do not own; it lands with FR-14. Record this as a follow-up.)
  - `cancel`: `appendControlOp(ws, id, {op:"cancel", reason:"session-ended"})`, then write `status:"cancel-pending"`, `cancelReason:"session-ended"`, `sessionEndedAt` to the job file and index. **Do not wait for verification.** The worker finalises (lane `m0-cancel` wrote `cancelReason` from `op.reason`); a dead worker is finalised by the next `reconcileJob`. As a fallback for a v1/legacy job with a live pid and no control support, SIGTERM its pid as today.
  - `detach`: leave it running and set `endedWithSession:true`, `sessionEndedAt`.
- **Session summary:** write `jobs/session-end-<sessionId>.json` = `{sessionId, endedAt, jobs:[{id, status, action:"cancel-requested"|"detached"|"none", threadId}]}`. Make sure `listJobs`/`findJobAcrossWorkspaces`/pruning never mistake it for a job. It is not in `state.json`, and `findJobAcrossWorkspaces` only opens `<id>.json` for an exact id. Verify with a test that `status` ignores it.
- **Broker leases:** `broker.json` gains `leases: [{sessionId, pid, startTime, addedAt, touchedAt}]`. Add `addBrokerLease(cwd, {sessionId, pid})`, `removeBrokerLease(cwd, sessionId)`, `listLiveBrokerLeases(cwd, {now})` to `lib/broker-lifecycle.mjs`. A lease is live when its pid+startTime is alive (`isSameProcess`), or, when the pid is unknown, `touchedAt` is younger than 24h. SessionStart adds or refreshes a lease (`pid = process.ppid`, best effort) **only if** a broker session exists. `ensureBrokerSession` adds or refreshes the lease for `process.env.CODEX_COMPANION_SESSION_ID` when it creates or reuses a broker.
- **SessionEnd broker handling:** remove this session's lease. Send `broker/shutdown` + teardown **only if** no other live lease remains **and** no job in the workspace is active after reconcile. Otherwise leave the broker running.
- **Broker log:** move the broker log to `<stateDir>/broker.log` (`resolveStateDir(workspaceRoot)`), rotate at 5MB to `broker.log.1` (keep one) when spawning, and **never** delete it in `teardownBrokerSession`.
- **Budget:** the whole hook must finish well under 5s. No app-server calls except the existing `broker/shutdown` send when shutting down.

## Implementation guide

- `session-lifecycle-hook.mjs`: `cleanupSessionJobs` (rewrite), `handleSessionEnd`, `handleSessionStart` (lease).
- `lib/broker-lifecycle.mjs`: `ensureBrokerSession`, `spawnBrokerProcess`/`createBrokerSessionDir` (log path + rotation), `teardownBrokerSession` (keep the log), `saveBrokerSession`/`loadBrokerSession` (leases), new lease helpers.
- Rewrite the existing runtime test "session end fully cleans up jobs for the ending session" (~line 1804) to assert the new semantics, and rename it (e.g. "session end cancels running jobs and keeps their records"). Explain the change in your report.

## Fake-Codex fixture API (from lane `m0-fixture`)

The fixture API from lane `m0-fixture` (see `docs/IMPLEMENTATION-PLAN.md` D2), in short: `installFakeCodex(binDir, behavior, options)`; `setFakeCodexOptions(binDir, patch)`; `options.turnScript` steps (`command`, `fileChange`, `agentMessage`, `reasoning`, `plan`, `diff`, `usage`, `delay`, `silence`, `serverRequest`); `options.interrupt: "cooperate"|"ignore"|"ack-only"`; `options.ignoreSigterm`; `options.delays.{initialize,threadStart,turnStart}`; `options.models`, `options.config`, `options.forceActiveWriter`; `readFakeRpcLog(binDir, {method, conn})`, `fakeConnections(binDir)`; `occupyBroker(endpoint, {holdMs})`; helpers `spawnStubborn()`, `waitFor()`, `isPidAlive()`, `makeCompanionWorkspace()`, `startFakeAppServer()`. Read the fixture source for the exact signatures before writing tests. You do **not** own the fixture files in this wave: if a capability is missing, write a small local helper inside your own test file and report it as a follow-up.

## Tests to write first

`tests/session-end.test.mjs` (invoke the hook as `node plugins/codex/scripts/session-lifecycle-hook.mjs SessionEnd` with JSON on stdin `{session_id, cwd}`; build jobs through the companion with the fake fixture as it exists at wave start; slow turns via behaviour `interruptible-slow-task` or `turnScript`):
1. One running job and one completed job in session A → run SessionEnd(A). Both job `.json` and `.log` files still exist. The running job is `cancelled` or `cancel-pending` with `cancelReason:"session-ended"`, and `status <id> --json` resolves both. Eventually (waitFor, a few seconds) the running job is `cancelled`, and the fake saw `turn/interrupt`.
2. Snapshot the file list under `jobs/` before and after the hook: nothing removed (additions such as the summary file are allowed).
3. Sessions A and B share a workspace, and B has a running job (and a lease). A's SessionEnd leaves B's job running and the broker process alive (pid check), and `broker.json` still lists B's lease.
4. With `sessionEndPolicy: "detach"` in the workspace config (or a job with `owner.kind:"detached"` written into its record), the job keeps running and gets `endedWithSession:true`. (The FR-10 SessionStart context part of this criterion is M3; skip it and say so.)
5. When the last lease ends and no job is active, the broker is shut down, and `broker.log` still exists afterwards.
6. The hook finishes in under 2s with 20 jobs in the session.
7. The summary file `jobs/session-end-<sid>.json` exists and lists the actions; `status` does not show it as a job.

## Requirements from the report (verbatim)

The text below is copied verbatim from `docs/IMPROVEMENT-REPORT.md`. You do not need to read the rest of the report.

### BUG-3: SessionEnd deletes job records, logs and inboxes for the whole session and shuts down the workspace-shared broker
- **Priority:** P0
- **Problem:** `cleanupSessionJobs` SIGTERMs this session's queued and running jobs, then saves state with **every** job for that `sessionId` removed, completed ones included. `saveStateUnlocked` unlinks the job `.json`, `.log`, `.inbox.jsonl` and `.closed` for every dropped id. After a restart nothing is left to inspect or resume (E4). `handleSessionEnd` also always sends `broker/shutdown` and tears down the broker. The broker is keyed per **workspace**, so ending one Claude session kills Codex turns belonging to other live sessions in the same repo. Teardown deletes `broker.log`. There is an existing test that asserts the full cleanup. Jobs without a `sessionId` are not affected.
- **Evidence:** E4. `scripts/session-lifecycle-hook.mjs` 46-79 (`cleanupSessionJobs`) and 92-124 (`handleSessionEnd`). `lib/state.mjs` 238-263 (`saveStateUnlocked` unlinks dropped jobs' files). `lib/broker-lifecycle.mjs` 176-209 (teardown deletes the log). `hooks/hooks.json` (SessionEnd timeout 5s). `tests/runtime.test.mjs` ~1804 ("session end fully cleans up jobs").
- **Proposal:**
  1. SessionEnd never deletes records or artifacts. Add a policy `sessionEndPolicy: cancel|detach`, settable with `setup --session-end-policy`. The default is `cancel` for owned or lease-required jobs and `detach` for jobs launched `--detach`.
     - `cancel`: send the control op or interrupt from BUG-2, then mark the job `cancelled` with `cancelReason:'session-ended'` and `sessionEndedAt`. The hook has only a 5s budget, so write `cancel-pending` and let the worker or the next status reconcile it (BUG-6). **Do not block** on verification.
     - `detach`: leave the job running and set `endedWithSession:true`.
  2. Write `jobs/session-end-<sessionId>.json`, a summary of the session's jobs.
  3. **Broker reference counting.** `broker.json` gets `leases: [{sessionId, pid, heartbeatAt}]`. SessionEnd removes its own lease, and calls `broker/shutdown` only when no other live lease remains and no job is active. Broker logs move to `<stateDir>/broker.log` (rotated, never deleted on teardown).
  4. Deletion happens only through pruning and gc (BUG-14, WISH-7).
  5. Update `tests/runtime.test.mjs` ~1804 to the new semantics.
- **Acceptance criteria:**
  - Run the SessionEnd hook with one running job and one completed job. Both job `.json` and `.log` files still exist. The running job is `cancelled` or `cancel-pending` with `cancelReason:'session-ended'`, and `status <id> --json` resolves both.
  - A test asserts that the hook removes no files under `jobs/`.
  - Sessions A and B share a workspace and B has a running job. A's SessionEnd leaves B's job running and the broker alive.
  - With `detach`, the job keeps running and FR-10's SessionStart context in a new session names it.

## Acceptance checklist (report PASS/FAIL per line)

- [ ] Run the SessionEnd hook with one running job and one completed job. Both job `.json` and `.log` files still exist. The running job is `cancelled` or `cancel-pending` with `cancelReason:'session-ended'`, and `status <id> --json` resolves both
- [ ] A test asserts that the hook removes no files under `jobs/`
- [ ] Sessions A and B share a workspace and B has a running job. A's SessionEnd leaves B's job running and the broker alive
- [ ] With `detach`, the job keeps running (FR-10 SessionStart part deferred to M3, noted)
- [ ] `broker.log` lives at `<stateDir>/broker.log`, is rotated, and survives teardown
- [ ] Hook completes within budget (<2s for 20 jobs)
- [ ] `npm test` green; only the ~1804 SessionEnd test in `tests/runtime.test.mjs` changed

## Required final report (your last message; use exactly these sections)

```
## Lane m0-session-end report
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
