# Lane `m6-isolation`: `--worktree`, the tree lease, `worktree` subcommands, and cross-session overlap visibility (FR-6, BUG-15)

- **Beads:** `codex-plugin-cc-22z.1`, `codex-plugin-cc-22z.2`
- **Report items:** FR-6, BUG-15. **Scope in this lane:** the **wiring half** of FR-6 and all of BUG-15.
- **Milestone / wave:** M6, wave 2. **Depends on:** wave 1 (`m6-worktree-lib`, `m6-broker-lib`, `m6-ci`, `m6-history-lib`, `m6-prompting`, `m6-escalation-lib` merged). **Runs concurrently with:** `m6-approval-worker`.

## Goal

Two Codex write jobs in one shared tree interleave edits and nobody can attribute them. Make isolation one flag away (`--worktree`), make the shared tree single-writer by default with an explicit escape hatch, keep worktree jobs visible from the main tree, and show every session's active jobs on the same tree.

## Ground rules (non-negotiable)

- **Worktree:** you work in your **own git worktree**, created by the orchestrator from branch `orvex/improvement-report` after the previous wave was merged (normally `/home/crew/workspace/codex-plugin-cc-lanes/m6-isolation` on branch `lane/m6-isolation`; use the path you were given). Paths below are relative to your worktree root, and `plugins/codex/scripts/` holds the runtime. The other lanes of your wave run at the same time in their own worktrees, and the orchestrator merges every lane of the wave afterwards. **File ownership is what keeps those merges conflict-free**, so respect it exactly.
- **Beads:** run `bd` from the main checkout: `cd /home/crew/workspace/codex-plugin-cc && bd update <id> --claim` for each bead listed above. If a bead is already claimed (another lane of the same item claimed it), skip the claim and still add your note. At the end, run `bd note <id> "<one paragraph: lane m6-isolation; what changed, tests added, npm test result, open risks>"` for each bead. **Never** run `bd close`: the orchestrator closes beads after review.
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
- `plugins/codex/scripts/lib/job-control.mjs`
- `plugins/codex/scripts/lib/render.mjs`
- `plugins/codex/scripts/lib/workspace.mjs`
- `plugins/codex/scripts/lib/worktree.mjs`
- `plugins/codex/scripts/lib/tree-lease.mjs`
- `plugins/codex/scripts/lib/tracked-jobs.mjs`
- `plugins/codex/scripts/lib/mcp-tools.mjs`
- `plugins/codex/skills/codex-drive/SKILL.md`
- `README.md`
- `tests/orvex.test.mjs` (only the "parallel background jobs in one workspace" test around line 176, and only to add `--shared-tree`/read-only where the new lease rightly refuses it)
- `tests/isolation.test.mjs` (new)
- `tests/overlap.test.mjs` (new)

## Do not touch

- Lane `m6-approval-worker` runs at the same time and owns: `plugins/codex/scripts/lib/app-server.mjs`, `plugins/codex/scripts/lib/codex.mjs`, `plugins/codex/scripts/lib/approvals.mjs`, `plugins/codex/scripts/app-server-broker.mjs`, `tests/fake-codex-fixture.mjs`, `tests/helpers.mjs`, `tests/approvals-lib.test.mjs`.
- Any existing test file not listed under "Files you own" (add your tests in your own new test files).

## Design decisions binding on this lane

- **`task --worktree[=<name>] [--base <ref>]`** (also `fork`, `fanout --worktree` and the MCP `codex`/`codex_fanout` `worktree` params, which previously errored): before creating the worker, `createJobWorktree` and run the job with cwd = the worktree path; record `job.worktree = {path, branch, baseRef, baseSha}`; the result shows a diff stat against `baseSha`. Config `defaultIsolation: none|worktree` (from `m4-config`) now takes effect for write-capable tasks; fan-out defaults to `worktree` (flip the `codex_fanout` default to `true`).
- **`worktree list | merge <jobId> [--ff-only|--squash] | discard <jobId> | pr <jobId> [--dry-run]`** → the library functions; refuse `merge`/`discard` while the job is active.
- **State keying (binding):** a path inside `<repo>/.codex-worktrees/<x>` resolves (`resolveWorkspaceRoot` in `lib/workspace.mjs`) to the **main repo root**, so the job's state lives with the parent repo and `status` in the main tree lists it. Detect it via `git rev-parse --git-common-dir` plus the `.codex-worktrees/` path segment, **only** for plugin-created worktrees; other git worktrees (for example the orchestrator's lane worktrees) keep their own state key. Test both.
- **Tree lease:** a write-capable job (effective sandbox not `read-only`) without `--worktree` acquires the lease for the tree realpath at launch (before the worker spawns). If held by another active job: fail fast with `workspace busy: job <id>; use --worktree or --shared-tree` (exit 2, no job record). `--shared-tree` proceeds without the lease and records `concurrentJobs:[holder and other active write jobs]` on the new job **and** appends the new job id to the holder's `concurrentJobs`. Read-only jobs are never blocked. The worker refreshes the lease with its heartbeat and releases it in `runTrackedJob`'s `finally`; a dead holder is reclaimed through staleness. `status` shows the lease holder.
- **BUG-15:** `status` (single-session view) gains an "Other active Codex jobs in this workspace" section listing active jobs from other sessions on the same tree: id, session, badge (`formatRuntimeBadge`), elapsed, files changed so far (`counts.filesChanged` from events). When a write-capable task starts (shared tree) while another write-capable job is active on the same tree realpath, log a warning naming it and record `overlapsWith:[ids]` (with the lease on, this happens under `--shared-tree`, and the refusal message itself names the holder).
- Docs: README worktree section (replace the manual `--cwd` recipe, lines ~225-248, with `--worktree`) and drive-skill rows.

## Implementation guide

- `codex-companion.mjs`: `handleTask`, `buildTaskRequest`, `executeTaskRun`, the `fork`/`fanout` handlers, `handleStatus`, `printUsage`, `main` (`worktree` case). `lib/workspace.mjs`: `resolveWorkspaceRoot`. `lib/job-control.mjs`: `buildStatusSnapshot`. `lib/tracked-jobs.mjs`: `runTrackedJob` (lease release), heartbeat hookup.

## Fake-Codex fixture

The fixture API from lane `m0-fixture` (plan D2), in short: `installFakeCodex(binDir, behavior, options)`; `setFakeCodexOptions(binDir, patch)`; `options.turnScript` steps (`command`, `fileChange` with `writeFiles`, `agentMessage`, `reasoning`, `plan`, `diff`, `usage`, `delay`, `silence`, `serverRequest`); `options.interrupt: "cooperate"|"ignore"|"ack-only"`; `options.ignoreSigterm`; `options.delays.{initialize,threadStart,turnStart}`; `options.models`, `options.config`, `options.writeRollout`, `options.forceActiveWriter`, `options.turnStatus`; methods `model/list`, `config/read`, `thread/read`; `readFakeRpcLog(binDir, {method, conn, dir})`, `fakeConnections(binDir)`; `occupyBroker(endpoint, {holdMs})`; `startFakeAppServer(binDir)`; helpers `spawnStubborn()`, `waitFor()`, `isPidAlive()`, `makeCompanionWorkspace()`. M0/M1 lanes extended it further, so **read the fixture source for the exact signatures** before writing tests. Note: the fixture answers `thread/unload`, but the real codex-cli 0.157 app-server does **not** have it (probe §6), so plugin code must never call it.

**You do not own the fixture files in this wave** (lane `m6-approval-worker` does). Do not edit `tests/fake-codex-fixture.mjs` or `tests/helpers.mjs`. If you need something the fixture lacks, write a small local helper inside your own test file, or record the gap as a follow-up.

## Tests to write first

`tests/isolation.test.mjs`:
1. Two concurrent `--worktree` jobs edit the same file (`fileChange` with `writeFiles:true`) and both succeed on separate branches; the main tree's `git status` is unchanged.
2. `worktree merge <id> --squash` applies the edits; `discard <id>` removes both the directory and the branch.
3. A second shared-tree `--write` job exits non-zero naming the first job; with `--shared-tree` it runs, and both reports list `concurrentJobs`.
4. `status` in the main tree lists a worktree job; a job run in a non-plugin git worktree keeps its own state key.
5. Read-only jobs are never blocked by the lease; the lease is released when the holder finishes and reclaimed when the holder's worker is SIGKILLed.
`tests/overlap.test.mjs`:
6. With a running job from session A, `status` in session B lists it under "Other active"; a `--write --shared-tree` task started in B logs a warning naming A's job and `job.overlapsWith` contains it.

## Requirements from the report (verbatim)

The text below is copied verbatim from `docs/IMPROVEMENT-REPORT.md`. Line numbers in it predate M0/M1. The "Probe adjustments" and "Design decisions" sections of this brief override it where they differ.

### FR-6: Per-job git worktree isolation and a working-tree lease for write jobs
- **Priority:** P1
- **Problem:** Write jobs run in the shared tree named by `--cwd` (E10). The README (225-248) tells users to create their own worktrees, but nothing automates it, detects two writers on one tree, or reports the result. There is a test that parallel background jobs in one workspace all run (`tests/orvex.test.mjs` ~176), so concurrency is by design with no guard.
- **Evidence:** E10. `codex-companion.mjs` `buildTaskRequest` ~840-853 and ~723. `README.md` 225-248. `tests/orvex.test.mjs` ~176.
- **Proposal:**
  1. `task --worktree[=<name>] [--base <ref>]`: run `git worktree add <repoRoot>/.codex-worktrees/<jobId> -b codex/<jobId> <base|HEAD>` (or place it under `<stateDir>/worktrees/`; pick one and document it), then run the job with cwd there. Add `.codex-worktrees/` to `.git/info/exclude` automatically. The job records `worktreePath`, `branch` and `baseRef`, and the result shows a diff stat.
  2. Add `worktree list | merge <jobId> [--ff-only|--squash] | discard <jobId> | pr <jobId>`.
  3. Config `defaultIsolation: none|worktree`. Fan-out (FR-18) defaults to `worktree`.
  4. **Tree lease.** A write-capable job without `--worktree` takes an advisory lease on the tree realpath, `<stateDir>/tree.lease`, with owner job id and heartbeat. A second write job fails fast with `workspace busy: job <id>; use --worktree or --shared-tree`. `--shared-tree` proceeds and records `concurrentJobs`. Read-only jobs are never blocked. Status shows the lease holder.
  5. Job state keys must still group worktree jobs under the parent repo, so `status` in the main tree lists them. Today the state dir is keyed by workspace realpath, so decide on a key and test it.
- **Acceptance criteria:**
  - Two concurrent `--worktree` jobs edit the same file and both succeed on separate branches. The main tree's `git status` is unchanged.
  - `worktree merge --squash` applies the edits. `discard` removes both the directory and the branch.
  - A second shared-tree `--write` job exits non-zero naming the first job. With `--shared-tree` it runs, and both reports list `concurrentJobs`.

### BUG-15: Concurrent write jobs on one tree are neither detected nor warned about, and other sessions' jobs are invisible
- **Priority:** P2 (the isolation fix itself is FR-6)
- **Problem:** `buildStatusSnapshot` always filters by `CODEX_COMPANION_SESSION_ID`, and `status --all` only lifts the display cap. So two sessions' Codex jobs on the same tree cannot see each other (E10), and nothing warns when overlapping write-capable jobs start.
- **Evidence:** E10. `lib/job-control.mjs` 15-25 and 212-255. `codex-companion.mjs` ~1233. `scripts/stop-review-gate-hook.mjs` 42-48.
- **Proposal:** `status` adds an "Other active Codex jobs in this workspace" section (id, session, sandbox badge, elapsed, files changed so far). When a write-capable task starts while another write-capable job is active on the same tree realpath, log a warning and record `overlapsWith:[ids]`. FR-6 turns this into a lease.
- **Acceptance criteria:** With a running job from session A, `status` in session B lists it under "Other active". A `--write` task started in B logs a warning naming A's job, and `job.overlapsWith` contains it.

## Probe adjustments and scope narrowing (binding; they override the verbatim text above)

- Not protocol-dependent.
- **Interaction with FR-25 (note):** the bypass default is write-capable, so two concurrent default tasks in one tree now need `--worktree` or `--shared-tree`. That is the intended FR-6 behaviour; say so in the README and CHANGELOG follow-up.

## Acceptance checklist (report PASS/FAIL per line)

- [ ] FR-6: two concurrent `--worktree` jobs edit the same file and both succeed on separate branches. The main tree's `git status` is unchanged
- [ ] FR-6: `worktree merge --squash` applies the edits. `discard` removes both the directory and the branch
- [ ] FR-6: a second shared-tree `--write` job exits non-zero naming the first job. With `--shared-tree` it runs, and both reports list `concurrentJobs`
- [ ] FR-6: worktree jobs are grouped under the parent repo's state (decision tested), and `defaultIsolation` works
- [ ] BUG-15: with a running job from session A, `status` in session B lists it under "Other active". A `--write` task started in B (with `--shared-tree`) logs a warning naming A's job, and `job.overlapsWith` contains it
- [ ] `npm test` green in your worktree; no existing test edited except where this brief allows it

## Required final report (your last message; use exactly these sections)

```
## Lane m6-isolation report
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
