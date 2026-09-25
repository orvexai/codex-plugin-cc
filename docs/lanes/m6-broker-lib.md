# Lane `m6-broker-lib`: Broker status RPC, lifecycle helpers and error surfacing in the transport layer (FR-22, BUG-13)

- **Beads:** `codex-plugin-cc-22z.3`, `codex-plugin-cc-22z.4`
- **Report items:** FR-22, BUG-13. **Scope in this lane:** the **broker and transport halves** of FR-22 (`broker/status`, busy counter, restart/stop helpers) and BUG-13 (fallback reasons, log lines, warnings, stderr cap). The `broker` CLI, the status line and the rendered Warnings section are lane `m6-ops` (wave 3).
- **Milestone / wave:** M6, wave 1. **Depends on:** all of M5 merged. **Runs concurrently with:** `m6-worktree-lib`, `m6-ci`, `m6-history-lib`, `m6-prompting`, `m6-escalation-lib`.

## Goal

The broker is shared, serialises streams and can be torn down by anyone, yet Claude sees one line about it; and several failures (broker startup, busy fallback, stderr) degrade silently. Add a busy-exempt `broker/status` method with the data operators need, lifecycle helpers for restart/stop/log tail, and make every transport fallback visible on the job as `transportFallbackReason`, a log line and a warning.

## Ground rules (non-negotiable)

- **Worktree:** you work in your **own git worktree**, created by the orchestrator from branch `orvex/improvement-report` after the previous wave was merged (normally `/home/crew/workspace/codex-plugin-cc-lanes/m6-broker-lib` on branch `lane/m6-broker-lib`; use the path you were given). Paths below are relative to your worktree root, and `plugins/codex/scripts/` holds the runtime. The other lanes of your wave run at the same time in their own worktrees, and the orchestrator merges every lane of the wave afterwards. **File ownership is what keeps those merges conflict-free**, so respect it exactly.
- **Beads:** run `bd` from the main checkout: `cd /home/crew/workspace/codex-plugin-cc && bd update <id> --claim` for each bead listed above. If a bead is already claimed (another lane of the same item claimed it), skip the claim and still add your note. At the end, run `bd note <id> "<one paragraph: lane m6-broker-lib; what changed, tests added, npm test result, open risks>"` for each bead. **Never** run `bd close`: the orchestrator closes beads after review.
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

- `plugins/codex/scripts/app-server-broker.mjs`
- `plugins/codex/scripts/lib/broker-lifecycle.mjs`
- `plugins/codex/scripts/lib/app-server.mjs`
- `plugins/codex/scripts/lib/codex.mjs`
- `plugins/codex/scripts/lib/tracked-jobs.mjs`
- `tests/fake-codex-fixture.mjs`
- `tests/helpers.mjs`
- `tests/broker-lib.test.mjs` (new)
- `tests/error-surfacing.test.mjs` (new)

## Do not touch

- Lane `m6-worktree-lib` runs at the same time and owns: `plugins/codex/scripts/lib/worktree.mjs`, `plugins/codex/scripts/lib/tree-lease.mjs`, `tests/worktree-lib.test.mjs`.
- Lane `m6-ci` runs at the same time and owns: `.github/workflows/pull-request-ci.yml`, `.github/workflows/nightly.yml`, `scripts/check-doc-consistency.mjs`, `tests/doc-consistency.test.mjs`, `tests/contract.test.mjs`, `tests/fixtures/doc-consistency-allowlist.json`.
- Lane `m6-history-lib` runs at the same time and owns: `plugins/codex/scripts/lib/archive.mjs`, `plugins/codex/scripts/lib/state.mjs`, `tests/archive.test.mjs`.
- Lane `m6-prompting` runs at the same time and owns: `plugins/codex/skills/gpt-5-4-prompting/`, `plugins/codex/skills/codex-prompting/`, `plugins/codex/agents/codex-rescue.md`, `plugins/codex/agents/codex-exec.md`, `plugins/codex/commands/rescue.md`, `tests/commands.test.mjs`.
- Lane `m6-escalation-lib` runs at the same time and owns: `plugins/codex/scripts/lib/escalation.mjs`, `tests/escalation-lib.test.mjs`.
- Any existing test file not listed under "Files you own" (add your tests in your own new test files).

## Design decisions binding on this lane

- **`broker/status` (busy-exempt, like `turn/interrupt` and `broker/markDetached`):** returns `{pid, endpoint, startedAt, uptimeMs, codexVersion, activeStream: {jobId, threadId, turnId, since} | null, sockets, busyRejections, leases}` (`leases` read from `broker.json` via `lib/broker-lifecycle.mjs`). `jobId` comes from a new `turn/start` param `brokerJobId` that clients send and the broker strips before forwarding (same pattern as `brokerDetached`); `runAppServerTurn` passes the job id. `busyRejections` counts every `-32001` reply.
- **`lib/broker-lifecycle.mjs`:** `getBrokerStatus(cwd, {timeoutMs = 2000})` → the status object or `{running:false, reason}`; `stopBroker(cwd, {ifIdle})` → `{stopped, reason}` (`ifIdle` refuses while `activeStream` is non-null: `{stopped:false, reason:"streaming"}`); `restartBroker(cwd)` → stop (refusing while streaming unless `force`) then start via `ensureBrokerSession`; `readBrokerLogTail(cwd, {lines})` from `<stateDir>/broker.log` (the persistent log from `m0-session-end`; verify it is never deleted by teardown).
- **BUG-13, broker startup:** make the failure reason explicit: add `ensureBrokerSessionDetailed(cwd, …)` → `{session, reason}` (`reason` e.g. `startup-timeout`, `spawn-error: …`, `endpoint-unreachable`), keep `ensureBrokerSession` returning the session or null for existing callers.
- **BUG-13, fallbacks:** `withAppServer` records every fallback to direct: `transport:"direct"`, `transportFallbackReason` (`broker-busy`, `broker-startup-failed: <reason>`, `broker-unreachable: ENOENT|ECONNREFUSED`), a progress **log line** `Broker unavailable (<reason>); using a direct Codex app-server.` and a `job.warning` event, and `runAppServerTurn` returns `warnings[]`. `runTrackedJob` persists `job.warnings[]` (deduplicated) and copies them into the result payload's `warnings` (and `report.warnings` when a report exists).
- **BUG-13, stderr:** cap the direct client's accumulated stderr to a 64KB ring buffer (keep the tail). In broker mode, stderr is only in `broker.log`; record `stderrSource:"broker-log"` on the job so rendering can point there.
- **Leases in status:** keep `m0-session-end`'s lease format; only read it.

## Implementation guide

- `app-server-broker.mjs`: `main`, `isInterruptRequest` (the busy-exempt list), `buildJsonRpcError`, the `turn/start` handling where `brokerDetached` is stripped.
- `lib/broker-lifecycle.mjs`: `ensureBrokerSession`, `teardownBrokerSession`, the lease helpers.
- `lib/app-server.mjs`: `CodexAppServerClient.connect`, the stderr accumulation (report lines 63, 199-203). `lib/codex.mjs`: `withAppServer`, `withDirectAppServer`, `runAppServerTurn`. `lib/tracked-jobs.mjs`: `runTrackedJob`, `createJobProgressUpdater`.

## Fake-Codex fixture

The fixture API from lane `m0-fixture` (plan D2), in short: `installFakeCodex(binDir, behavior, options)`; `setFakeCodexOptions(binDir, patch)`; `options.turnScript` steps (`command`, `fileChange` with `writeFiles`, `agentMessage`, `reasoning`, `plan`, `diff`, `usage`, `delay`, `silence`, `serverRequest`); `options.interrupt: "cooperate"|"ignore"|"ack-only"`; `options.ignoreSigterm`; `options.delays.{initialize,threadStart,turnStart}`; `options.models`, `options.config`, `options.writeRollout`, `options.forceActiveWriter`, `options.turnStatus`; methods `model/list`, `config/read`, `thread/read`; `readFakeRpcLog(binDir, {method, conn, dir})`, `fakeConnections(binDir)`; `occupyBroker(endpoint, {holdMs})`; `startFakeAppServer(binDir)`; helpers `spawnStubborn()`, `waitFor()`, `isPidAlive()`, `makeCompanionWorkspace()`. M0/M1 lanes extended it further, so **read the fixture source for the exact signatures** before writing tests. Note: the fixture answers `thread/unload`, but the real codex-cli 0.157 app-server does **not** have it (probe §6), so plugin code must never call it.

**You own the fixture files in this wave.** If you need a capability that is missing, add it **additively** (new options, new turnScript step types, new helpers) and keep every existing behaviour string and option working. Where the fixture's shapes differ from `docs/app-server-probe.md` ("Fixture shapes"), make the fixture match the probe for the methods you touch.

Add a way to make broker startup fail deterministically (for example `options.delays.initialize` longer than the broker startup wait, with the wait made configurable through an env var such as `CODEX_COMPANION_BROKER_START_TIMEOUT_MS` added to `LEAKY_ENV`) and a way to make the fake write a known line to stderr.

## Tests to write first

`tests/broker-lib.test.mjs`:
1. While a turn streams through the broker, `getBrokerStatus` succeeds (busy-exempt) and `activeStream.threadId` matches the job's thread (and `jobId` matches).
2. `stopBroker({ifIdle:true})` returns `stopped:false` while streaming, `stopped:true` when idle.
3. `busyRejections` increments after a second client's `thread/list` during a stream (`occupyBroker`).
4. `readBrokerLogTail` returns lines; `broker.log` survives teardown.
`tests/error-surfacing.test.mjs`:
5. Broker startup forced to fail → the job has `transport:"direct"`, a non-null `transportFallbackReason`, a fallback log line, a `job.warning` event, and `warnings[]` in `result --json`.
6. Broker busy (`occupyBroker`) → `transportFallbackReason:"broker-busy"` and the log line.
7. A direct client's stderr beyond 64KB keeps only the last 64KB.

## Requirements from the report (verbatim)

The text below is copied verbatim from `docs/IMPROVEMENT-REPORT.md`. Line numbers in it predate M0/M1. The "Probe adjustments" and "Design decisions" sections of this brief override it where they differ.

### FR-22: Broker observability and health commands
- **Priority:** P2
- **Problem:** The broker serializes sockets, returns BUSY, is shared across sessions, and can be torn down by any session. Claude sees only `Session runtime: shared session|direct startup` and the endpoint.
- **Evidence:** `app-server-broker.mjs` 85-90 and 171-183. `lib/codex.mjs` `getSessionRuntimeStatus` 1055-1072. `lib/render.mjs` ~370.
- **Proposal:** Add a busy-exempt `broker/status` method in the broker. Add `broker status [--json]` (pid, endpoint, uptime, codex version, `activeStream{jobId, threadId, turnId}`, sockets, busy-rejection count, leases), `broker logs [--tail N]`, `broker restart` and `broker stop [--if-idle]`. Add a broker line to `status` and broker health to `setup --json`.
- **Acceptance criteria:** While a turn streams, `broker status --json` succeeds and `activeStream.threadId` matches the job. `broker stop --if-idle` exits non-zero while streaming. The busy count increments after a second client's `thread/list`.

### BUG-13: Errors are swallowed (broker startup, busy fallback, broker logs, stderr, forwarder)
- **Priority:** P2
- **Problem:** Several failures degrade silently:
  - `ensureBrokerSession` returns null after a 2s wait, and the client silently uses a direct app-server.
  - `withAppServer` retries BUSY, ENOENT and ECONNREFUSED errors on a direct app-server without any progress line.
  - Teardown deletes `broker.log`.
  - In broker mode `client.stderr` stays empty, so Codex stderr never reaches the job.
  - The direct client's stderr grows without bound.
  - The forwarder "returns nothing" on failure.
- **Evidence:** `lib/broker-lifecycle.mjs` 149-160 and 186-188. `lib/codex.mjs` 762-791. `lib/app-server.mjs` 63 and 199-203. `agents/codex-rescue.md` 44.
- **Proposal:** Record `transport`, `transportFallbackReason` and `warnings[]` on every job, and write a log line for each fallback. Keep broker logs at `<stateDir>/broker.log` with rotation. Tee broker-side stderr per thread into the job log where it can be attributed, or at least add a `broker logs` command (FR-23). Cap direct stderr at a ring buffer of about 64KB. Rendered results include a **Warnings** section when needed.
- **Acceptance criteria:** When `ensureBrokerSession` fails, the job has `transport:'direct'`, a non-null `transportFallbackReason` and a fallback log line. `broker.log` survives teardown. The rendered result contains "Warnings" after a fallback.

## Probe adjustments and scope narrowing (binding; they override the verbatim text above)

- **Native daemon (native surfaces §1 and Decision):** keep the plugin broker; do **not** add a `daemon` transport. The proxy handshake to the native control socket failed and no interrupt-on-disconnect or ownership contract was established. This removes plan D1's optional M6 `daemon` transport from scope (scope narrowing); `transport` stays `broker|direct`.
- `codex agents` has no non-interactive listing, so broker observability must come from the broker itself (native surfaces §3).

## Acceptance checklist (report PASS/FAIL per line)

- [ ] FR-22: while a turn streams, broker status succeeds and `activeStream.threadId` matches the job (library level; `broker status --json` CLI is lane `m6-ops`)
- [ ] FR-22: stop-if-idle refuses while streaming
- [ ] FR-22: the busy count increments after a second client's `thread/list`
- [ ] BUG-13: when `ensureBrokerSession` fails, the job has `transport:'direct'`, a non-null `transportFallbackReason` and a fallback log line
- [ ] BUG-13: `broker.log` survives teardown
- [ ] BUG-13: `warnings[]` recorded on every job with a fallback; direct stderr capped at 64KB
- [ ] No `daemon` transport is added (probe decision)
- [ ] `npm test` green in your worktree; no existing test edited except where this brief allows it

## Required final report (your last message; use exactly these sections)

```
## Lane m6-broker-lib report
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
