# Lane `m6-history-lib`: Job archive, retention and gc library (WISH-7)

- **Beads:** `codex-plugin-cc-22z.11`
- **Report items:** WISH-7. **Scope in this lane:** the **library half** of WISH-7: `lib/archive.mjs` plus archive-before-delete and age-based retention in `lib/state.mjs` pruning. `gc`/`history` commands and the `result` archive fallback are lane `m6-ops` (wave 3).
- **Milestone / wave:** M6, wave 1. **Depends on:** all of M5 merged. **Runs concurrently with:** `m6-worktree-lib`, `m6-broker-lib`, `m6-ci`, `m6-prompting`, `m6-escalation-lib`.

## Goal

Pruning deletes evidence, and there is no history or gc. Archive a compact record (report, patch, events, result) before any job's files are deleted, prune by age plus a count cap without ever dropping active or recently-unread jobs, and provide the gc/history primitives.

## Ground rules (non-negotiable)

- **Worktree:** you work in your **own git worktree**, created by the orchestrator from branch `orvex/improvement-report` after the previous wave was merged (normally `/home/crew/workspace/codex-plugin-cc-lanes/m6-history-lib` on branch `lane/m6-history-lib`; use the path you were given). Paths below are relative to your worktree root, and `plugins/codex/scripts/` holds the runtime. The other lanes of your wave run at the same time in their own worktrees, and the orchestrator merges every lane of the wave afterwards. **File ownership is what keeps those merges conflict-free**, so respect it exactly.
- **Beads:** run `bd` from the main checkout: `cd /home/crew/workspace/codex-plugin-cc && bd update <id> --claim` for each bead listed above. If a bead is already claimed (another lane of the same item claimed it), skip the claim and still add your note. At the end, run `bd note <id> "<one paragraph: lane m6-history-lib; what changed, tests added, npm test result, open risks>"` for each bead. **Never** run `bd close`: the orchestrator closes beads after review.
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

- `plugins/codex/scripts/lib/archive.mjs` (new)
- `plugins/codex/scripts/lib/state.mjs`
- `tests/archive.test.mjs` (new)

## Do not touch

- Lane `m6-worktree-lib` runs at the same time and owns: `plugins/codex/scripts/lib/worktree.mjs`, `plugins/codex/scripts/lib/tree-lease.mjs`, `tests/worktree-lib.test.mjs`.
- Lane `m6-broker-lib` runs at the same time and owns: `plugins/codex/scripts/app-server-broker.mjs`, `plugins/codex/scripts/lib/broker-lifecycle.mjs`, `plugins/codex/scripts/lib/app-server.mjs`, `plugins/codex/scripts/lib/codex.mjs`, `plugins/codex/scripts/lib/tracked-jobs.mjs`, `tests/fake-codex-fixture.mjs`, `tests/helpers.mjs`, `tests/broker-lib.test.mjs`, `tests/error-surfacing.test.mjs`.
- Lane `m6-ci` runs at the same time and owns: `.github/workflows/pull-request-ci.yml`, `.github/workflows/nightly.yml`, `scripts/check-doc-consistency.mjs`, `tests/doc-consistency.test.mjs`, `tests/contract.test.mjs`, `tests/fixtures/doc-consistency-allowlist.json`.
- Lane `m6-prompting` runs at the same time and owns: `plugins/codex/skills/gpt-5-4-prompting/`, `plugins/codex/skills/codex-prompting/`, `plugins/codex/agents/codex-rescue.md`, `plugins/codex/agents/codex-exec.md`, `plugins/codex/commands/rescue.md`, `tests/commands.test.mjs`.
- Lane `m6-escalation-lib` runs at the same time and owns: `plugins/codex/scripts/lib/escalation.mjs`, `tests/escalation-lib.test.mjs`.
- `tests/prune.test.mjs` (the M0 pruning tests must keep passing unchanged).
- Any existing test file not listed under "Files you own" (add your tests in your own new test files).

## Design decisions binding on this lane

- **`lib/archive.mjs`:** `archiveJob(workspaceRoot, job)` writes `<stateDir>/archive/<yyyy-mm>/<id>.json` = `{schemaVersion:2, archivedAt, job, result, report, patch (≤1MB, else truncated with a marker), events (last 2000 lines, ≤2MB), logTail (last 200 lines)}` atomically; idempotent. `readArchivedJob(workspaceRoot, jobId)` searches the archive months newest-first (exact id, then unique prefix). `planGc(jobs, {olderThanMs, keep, now})` → `{candidates:[{id, reason}], kept}`: never an active job, never an unread job younger than 24h (same rule as BUG-14), and never more than needed to satisfy `keep`. `runGc(workspaceRoot, {olderThanMs, keep, dryRun, now})` → `{archived, deleted, candidates}`; `dryRun` deletes nothing. `listHistory(workspaceRoot, {sinceMs, now})` → index jobs plus archived ones, newest first, `{id, status, title, completedAt, archived}`.
- **`lib/state.mjs` pruning:** `pruneJobs` keeps today's safety rules (from `m0-prune`) and adds age-based pruning: terminal jobs older than `historyDays` (config, default 14; read with `getConfig`/`getGlobalConfig`) are pruned, plus the count cap `maxJobs` (config, default 200). `saveStateUnlocked` calls `archiveJob` **before** unlinking a dropped job's files (catch and log archive errors; never block the save on them, but do not delete files whose archive failed).
- Keep `state.lock` hold times short: archive writes happen outside the lock where possible (collect the dropped jobs under the lock, archive, then delete), or document why not.

## Implementation guide

- `lib/state.mjs`: `pruneJobs`, `saveStateUnlocked`, `removeJobFile`, `MAX_JOBS`, `UNREAD_RETENTION_MS`, `TERMINAL_JOB_STATUSES`/the M0 exit-codes sets.
- File names: events `jobs/<id>.events.jsonl`, patch `jobs/<id>.patch`, report inside `result.report` (M2).

## Fake-Codex fixture

The fixture API from lane `m0-fixture` (plan D2), in short: `installFakeCodex(binDir, behavior, options)`; `setFakeCodexOptions(binDir, patch)`; `options.turnScript` steps (`command`, `fileChange` with `writeFiles`, `agentMessage`, `reasoning`, `plan`, `diff`, `usage`, `delay`, `silence`, `serverRequest`); `options.interrupt: "cooperate"|"ignore"|"ack-only"`; `options.ignoreSigterm`; `options.delays.{initialize,threadStart,turnStart}`; `options.models`, `options.config`, `options.writeRollout`, `options.forceActiveWriter`, `options.turnStatus`; methods `model/list`, `config/read`, `thread/read`; `readFakeRpcLog(binDir, {method, conn, dir})`, `fakeConnections(binDir)`; `occupyBroker(endpoint, {holdMs})`; `startFakeAppServer(binDir)`; helpers `spawnStubborn()`, `waitFor()`, `isPidAlive()`, `makeCompanionWorkspace()`. M0/M1 lanes extended it further, so **read the fixture source for the exact signatures** before writing tests. Note: the fixture answers `thread/unload`, but the real codex-cli 0.157 app-server does **not** have it (probe §6), so plugin code must never call it.

**You do not own the fixture files in this wave** (lane `m6-broker-lib` does). Do not edit `tests/fake-codex-fixture.mjs` or `tests/helpers.mjs`. If you need something the fixture lacks, write a small local helper inside your own test file, or record the gap as a follow-up.

## Tests to write first

`tests/archive.test.mjs`:
1. With 201 jobs (oldest terminal and read), the pruned oldest job's archive file exists and `readArchivedJob` returns its report.
2. Active and unread-recent jobs are never pruned or archived.
3. Age pruning with `historyDays: 1` and fake timestamps.
4. `planGc`/`runGc` with `dryRun` deletes nothing and lists candidates; without it, archives then deletes.
5. `listHistory` merges index and archive.
6. The existing `tests/prune.test.mjs` still passes (run it).

## Requirements from the report (verbatim)

The text below is copied verbatim from `docs/IMPROVEMENT-REPORT.md`. Line numbers in it predate M0/M1. The "Probe adjustments" and "Design decisions" sections of this brief override it where they differ.

### WISH-7: Job history retention, archive and `gc`
- **Priority:** P3
- **Problem:** Pruning deletes evidence (BUG-14). There is no `gc`, archive or history command.
- **Evidence:** `lib/state.mjs` 15 and 226-263.
- **Proposal:** Prune by age (`historyDays`, default 14) plus a count cap. Before deleting, archive the report, patch, events and result JSON to `<stateDir>/archive/<yyyy-mm>/<id>.json`. Add `gc [--older-than 7d] [--keep N] [--dry-run] [--json]` and `history [--since] [--json]`. `result <id>` falls back to the archive.
- **Acceptance criteria:** With 201 jobs, the oldest job's report can still be read with `result <id> --json`. `gc --dry-run` deletes nothing and lists the candidates.

## Probe adjustments and scope narrowing (binding; they override the verbatim text above)

- Not protocol-dependent.

## Acceptance checklist (report PASS/FAIL per line)

- [ ] With 201 jobs, the oldest job's report can still be read from the archive (library level; `result <id> --json` fallback is lane `m6-ops`)
- [ ] gc dry-run deletes nothing and lists the candidates (library level)
- [ ] Pruning is by age (`historyDays`, default 14) plus a count cap, and archives before deleting; active and unread-recent jobs are never pruned
- [ ] `npm test` green in your worktree; no existing test edited except where this brief allows it

## Required final report (your last message; use exactly these sections)

```
## Lane m6-history-lib report
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
