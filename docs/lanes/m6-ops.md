# Lane `m6-ops`: `broker` commands, broker health in status/setup, Warnings in results, and `gc`/`history` (FR-22, BUG-13, WISH-7)

- **Beads:** `codex-plugin-cc-22z.3`, `codex-plugin-cc-22z.4`, `codex-plugin-cc-22z.11`
- **Report items:** FR-22, BUG-13, WISH-7. **Scope in this lane:** the **CLI halves** of FR-22 (`broker status|logs|restart|stop`, the status line, setup health), BUG-13 (rendered Warnings, forwarder check) and WISH-7 (`gc`, `history`, `result` archive fallback).
- **Milestone / wave:** M6, wave 3. **Depends on:** wave 2 (`m6-isolation`, `m6-approval-worker` merged). **Runs concurrently with:** none (runs alone).

## Goal

Expose the operational data built in wave 1: broker health and control commands, a broker line in `status` and `setup`, a Warnings section wherever a job degraded, and history commands that let Claude read old jobs after pruning.

## Ground rules (non-negotiable)

- **Worktree:** you work in your **own git worktree**, created by the orchestrator from branch `orvex/improvement-report` after the previous wave was merged (normally `/home/crew/workspace/codex-plugin-cc-lanes/m6-ops` on branch `lane/m6-ops`; use the path you were given). Paths below are relative to your worktree root, and `plugins/codex/scripts/` holds the runtime. The other lanes of your wave run at the same time in their own worktrees, and the orchestrator merges every lane of the wave afterwards. **File ownership is what keeps those merges conflict-free**, so respect it exactly.
- **Beads:** run `bd` from the main checkout: `cd /home/crew/workspace/codex-plugin-cc && bd update <id> --claim` for each bead listed above. If a bead is already claimed (another lane of the same item claimed it), skip the claim and still add your note. At the end, run `bd note <id> "<one paragraph: lane m6-ops; what changed, tests added, npm test result, open risks>"` for each bead. **Never** run `bd close`: the orchestrator closes beads after review.
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
- `plugins/codex/scripts/lib/job-api.mjs`
- `plugins/codex/scripts/lib/render.mjs`
- `plugins/codex/scripts/lib/job-control.mjs`
- `plugins/codex/scripts/lib/archive.mjs`
- `plugins/codex/scripts/lib/broker-lifecycle.mjs`
- `plugins/codex/scripts/lib/config.mjs`
- `plugins/codex/agents/codex-rescue.md`
- `plugins/codex/skills/codex-drive/SKILL.md`
- `tests/fake-codex-fixture.mjs`
- `tests/helpers.mjs`
- `tests/ops.test.mjs` (new)
- `tests/history.test.mjs` (new)

## Do not touch

- No lane runs concurrently with you in this wave.
- Any existing test file not listed under "Files you own" (add your tests in your own new test files).

## Design decisions binding on this lane

- **`broker status [--json]`** (`getBrokerStatus`: pid, endpoint, uptime, codex version, `activeStream{jobId, threadId, turnId}`, sockets, busy-rejection count, leases); **`broker logs [--tail N]`** (default 100); **`broker restart [--force]`**; **`broker stop [--if-idle]`** (exit 1 with `broker is streaming job <id>` when `--if-idle` refuses). Add a one-line broker summary to `status` (`Broker: running pid N · streaming job X · 3 busy rejections` or `Broker: not running`) and broker health to `setup --json`/text.
- **Warnings:** `renderTaskResult`/the stored-result rendering and `status <id>` show a **Warnings** section listing `job.warnings` (fallbacks, NO_CHANGES, fork notices, unverified claims) when non-empty; `--json` already carries them. When `stderrSource:"broker-log"`, point to `broker logs`.
- **Forwarder (BUG-13 last bullet):** verify that `agents/codex-rescue.md` (the deprecated shim from M1) returns `CODEX_DISPATCH_FAILED exit=<n>` plus stderr on failure and never nothing; fix the text if it regressed.
- **`gc [--older-than 7d] [--keep N] [--dry-run] [--json]`** (`runGc`; durations via `parseDuration`) and **`history [--since 7d] [--json]`** (`listHistory`). **`result <id>`** falls back to `readArchivedJob` when the id is not in the index or jobs dir (`resolveResultJob` in `lib/job-control.mjs`), marking the output `archived:true`. Config keys `historyDays` and `maxJobs` get `setup` flags via `CONFIG_KEYS`.
- Drive skill: `broker status`, `history`, `gc --dry-run` rows (operator commands; keep them out of the main lifecycle table).

## Implementation guide

- `codex-companion.mjs`: `main` (`broker`, `gc`, `history` cases), `handleStatus`, `handleSetup`/`buildSetupReport`, `handleResult`, `printUsage`. `lib/job-control.mjs`: `resolveResultJob`. `lib/render.mjs`: `renderTaskResult`, `renderStoredJobResult`, `renderStatusReport`, `renderSetupReport`.

## Fake-Codex fixture

The fixture API from lane `m0-fixture` (plan D2), in short: `installFakeCodex(binDir, behavior, options)`; `setFakeCodexOptions(binDir, patch)`; `options.turnScript` steps (`command`, `fileChange` with `writeFiles`, `agentMessage`, `reasoning`, `plan`, `diff`, `usage`, `delay`, `silence`, `serverRequest`); `options.interrupt: "cooperate"|"ignore"|"ack-only"`; `options.ignoreSigterm`; `options.delays.{initialize,threadStart,turnStart}`; `options.models`, `options.config`, `options.writeRollout`, `options.forceActiveWriter`, `options.turnStatus`; methods `model/list`, `config/read`, `thread/read`; `readFakeRpcLog(binDir, {method, conn, dir})`, `fakeConnections(binDir)`; `occupyBroker(endpoint, {holdMs})`; `startFakeAppServer(binDir)`; helpers `spawnStubborn()`, `waitFor()`, `isPidAlive()`, `makeCompanionWorkspace()`. M0/M1 lanes extended it further, so **read the fixture source for the exact signatures** before writing tests. Note: the fixture answers `thread/unload`, but the real codex-cli 0.157 app-server does **not** have it (probe §6), so plugin code must never call it.

**You own the fixture files in this wave.** If you need a capability that is missing, add it **additively** (new options, new turnScript step types, new helpers) and keep every existing behaviour string and option working. Where the fixture's shapes differ from `docs/app-server-probe.md` ("Fixture shapes"), make the fixture match the probe for the methods you touch.

## Tests to write first

`tests/ops.test.mjs`:
1. While a turn streams, `broker status --json` succeeds and `activeStream.threadId` matches the job.
2. `broker stop --if-idle` exits non-zero while streaming.
3. The busy count increments after a second client's `thread/list` (`occupyBroker`), visible in `broker status --json`.
4. `broker logs --tail 5` prints lines; `status` shows the broker line; `setup --json` has broker health.
5. After a forced broker startup failure, the rendered result contains "Warnings" and the fallback reason.
6. `agents/codex-rescue.md` contains the `CODEX_DISPATCH_FAILED` contract.
`tests/history.test.mjs`:
7. With 201 jobs, the oldest job's report can still be read with `result <id> --json` (`archived:true`).
8. `gc --dry-run` deletes nothing and lists the candidates; `gc --older-than 1d` archives and deletes eligible jobs only.
9. `history --json` lists index and archived jobs.

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

### WISH-7: Job history retention, archive and `gc`
- **Priority:** P3
- **Problem:** Pruning deletes evidence (BUG-14). There is no `gc`, archive or history command.
- **Evidence:** `lib/state.mjs` 15 and 226-263.
- **Proposal:** Prune by age (`historyDays`, default 14) plus a count cap. Before deleting, archive the report, patch, events and result JSON to `<stateDir>/archive/<yyyy-mm>/<id>.json`. Add `gc [--older-than 7d] [--keep N] [--dry-run] [--json]` and `history [--since] [--json]`. `result <id>` falls back to the archive.
- **Acceptance criteria:** With 201 jobs, the oldest job's report can still be read with `result <id> --json`. `gc --dry-run` deletes nothing and lists the candidates.

## Probe adjustments and scope narrowing (binding; they override the verbatim text above)

- No `daemon` transport (native surfaces, Decision); the broker is the only shared transport to observe.

## Acceptance checklist (report PASS/FAIL per line)

- [ ] FR-22: while a turn streams, `broker status --json` succeeds and `activeStream.threadId` matches the job
- [ ] FR-22: `broker stop --if-idle` exits non-zero while streaming
- [ ] FR-22: the busy count increments after a second client's `thread/list`
- [ ] FR-22: `broker logs`, `broker restart`, a broker line in `status` and broker health in `setup --json`
- [ ] BUG-13: the rendered result contains "Warnings" after a fallback; the forwarder never returns nothing
- [ ] WISH-7: with 201 jobs, the oldest job's report can still be read with `result <id> --json`
- [ ] WISH-7: `gc --dry-run` deletes nothing and lists the candidates; `history` works
- [ ] `npm test` green in your worktree; no existing test edited except where this brief allows it

## Required final report (your last message; use exactly these sections)

```
## Lane m6-ops report
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
