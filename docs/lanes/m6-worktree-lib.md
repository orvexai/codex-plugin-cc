# Lane `m6-worktree-lib`: Job worktree and working-tree lease libraries (FR-6)

- **Beads:** `codex-plugin-cc-22z.1`
- **Report items:** FR-6. **Scope in this lane:** the **library half** of FR-6: `lib/worktree.mjs` (create/list/merge/discard/pr) and `lib/tree-lease.mjs` (advisory write lease), unit-tested in temp repos. CLI flags, state keying and status are lane `m6-isolation` (wave 2).
- **Milestone / wave:** M6, wave 1. **Depends on:** all of M5 merged. **Runs concurrently with:** `m6-broker-lib`, `m6-ci`, `m6-history-lib`, `m6-prompting`, `m6-escalation-lib`.

## Goal

Write jobs run in the shared tree, and nothing detects two writers or automates isolation. Build the two primitives FR-6 needs: per-job git worktrees on their own branches (with merge/discard/PR helpers) and an advisory lease that lets exactly one shared-tree writer hold a tree.

## Ground rules (non-negotiable)

- **Worktree:** you work in your **own git worktree**, created by the orchestrator from branch `orvex/improvement-report` after the previous wave was merged (normally `/home/crew/workspace/codex-plugin-cc-lanes/m6-worktree-lib` on branch `lane/m6-worktree-lib`; use the path you were given). Paths below are relative to your worktree root, and `plugins/codex/scripts/` holds the runtime. The other lanes of your wave run at the same time in their own worktrees, and the orchestrator merges every lane of the wave afterwards. **File ownership is what keeps those merges conflict-free**, so respect it exactly.
- **Beads:** run `bd` from the main checkout: `cd /home/crew/workspace/codex-plugin-cc && bd update <id> --claim` for each bead listed above. If a bead is already claimed (another lane of the same item claimed it), skip the claim and still add your note. At the end, run `bd note <id> "<one paragraph: lane m6-worktree-lib; what changed, tests added, npm test result, open risks>"` for each bead. **Never** run `bd close`: the orchestrator closes beads after review.
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

- `plugins/codex/scripts/lib/worktree.mjs` (new)
- `plugins/codex/scripts/lib/tree-lease.mjs` (new)
- `tests/worktree-lib.test.mjs` (new)

## Do not touch

- Lane `m6-broker-lib` runs at the same time and owns: `plugins/codex/scripts/app-server-broker.mjs`, `plugins/codex/scripts/lib/broker-lifecycle.mjs`, `plugins/codex/scripts/lib/app-server.mjs`, `plugins/codex/scripts/lib/codex.mjs`, `plugins/codex/scripts/lib/tracked-jobs.mjs`, `tests/fake-codex-fixture.mjs`, `tests/helpers.mjs`, `tests/broker-lib.test.mjs`, `tests/error-surfacing.test.mjs`.
- Lane `m6-ci` runs at the same time and owns: `.github/workflows/pull-request-ci.yml`, `.github/workflows/nightly.yml`, `scripts/check-doc-consistency.mjs`, `tests/doc-consistency.test.mjs`, `tests/contract.test.mjs`, `tests/fixtures/doc-consistency-allowlist.json`.
- Lane `m6-history-lib` runs at the same time and owns: `plugins/codex/scripts/lib/archive.mjs`, `plugins/codex/scripts/lib/state.mjs`, `tests/archive.test.mjs`.
- Lane `m6-prompting` runs at the same time and owns: `plugins/codex/skills/gpt-5-4-prompting/`, `plugins/codex/skills/codex-prompting/`, `plugins/codex/agents/codex-rescue.md`, `plugins/codex/agents/codex-exec.md`, `plugins/codex/commands/rescue.md`, `tests/commands.test.mjs`.
- Lane `m6-escalation-lib` runs at the same time and owns: `plugins/codex/scripts/lib/escalation.mjs`, `tests/escalation-lib.test.mjs`.
- Any existing test file not listed under "Files you own" (add your tests in your own new test files).

## Design decisions binding on this lane

- **Location decision (binding):** job worktrees live at `<repoRoot>/.codex-worktrees/<name>` where `<name>` is the job id or the `--worktree=<name>` value; the branch is `codex/<jobId>`. On first use append `.codex-worktrees/` to `$(git rev-parse --git-common-dir)/info/exclude` (once).
- **`lib/worktree.mjs`:** `createJobWorktree({repoRoot, jobId, name, baseRef = "HEAD"})` → `{path, branch, baseRef, baseSha}` via `git worktree add <path> -b codex/<jobId> <baseRef>` (fail clearly if the branch or path exists); `listJobWorktrees(repoRoot)` → `[{path, branch, jobId, head, dirty}]` parsed from `git worktree list --porcelain`, filtered to `.codex-worktrees/`; `commitWorktreeChanges({path, jobId, message})` → commits everything in **that job worktree only** on its own branch (`git -C <path> add -A && git -C <path> commit -m …`; skip when clean) — allowed because the branch and index are private to the job; `mergeJobWorktree({repoRoot, jobId, mode: "ff-only"|"squash"})` → commits pending job changes first, then in the main tree `git merge --ff-only codex/<jobId>` or `git merge --squash codex/<jobId>` (squash leaves the changes staged, no commit), refusing when the main tree has uncommitted changes to the same paths; `discardJobWorktree({repoRoot, jobId})` → `git worktree remove --force` + `git branch -D codex/<jobId>`; `prJobWorktree({repoRoot, jobId, remote = "origin", dryRun})` → commits pending changes, then `git push -u <remote> codex/<jobId>` and `gh pr create --fill --head codex/<jobId>`; with `dryRun` (and in tests) only return the commands. Every function returns data and throws coded errors (`exitCode 2` for usage problems).
- **`lib/tree-lease.mjs`:** `resolveTreeLeaseFile(stateDir)` → `<stateDir>/tree.lease`; `acquireTreeLease(stateDir, {treePath, jobId, pid, startTime, sharedTree = false})` → `{acquired:true}` or `{acquired:false, holder}`. Creation is atomic (`fs.openSync(file, "wx")`); a lease is **stale** when its holder pid is not the same process (`isSameProcess`) and its `heartbeatAt` is older than `CODEX_COMPANION_TREE_LEASE_STALE_MS` (default 30000; add to `LEAKY_ENV`), or the holder job is terminal (caller passes `isHolderActive(jobId)`); stale leases are reclaimed atomically (rename-then-verify, like the state lock reclaim). `sharedTree:true` never takes the lease but returns the current holder so the caller can record `concurrentJobs`. `refreshTreeLease`, `releaseTreeLease(stateDir, jobId)` (only the holder can release), `readTreeLease`.
- Read-only jobs never call these (enforced by the caller).

## Implementation guide

- Reuse `isSameProcess`/`readProcessStartTime` from `lib/process.mjs` and the lock-reclaim pattern in `lib/state.mjs` (`withStateLock`, `reclaimStaleLock`) — import or mirror, do not edit them.

## Fake-Codex fixture

The fixture API from lane `m0-fixture` (plan D2), in short: `installFakeCodex(binDir, behavior, options)`; `setFakeCodexOptions(binDir, patch)`; `options.turnScript` steps (`command`, `fileChange` with `writeFiles`, `agentMessage`, `reasoning`, `plan`, `diff`, `usage`, `delay`, `silence`, `serverRequest`); `options.interrupt: "cooperate"|"ignore"|"ack-only"`; `options.ignoreSigterm`; `options.delays.{initialize,threadStart,turnStart}`; `options.models`, `options.config`, `options.writeRollout`, `options.forceActiveWriter`, `options.turnStatus`; methods `model/list`, `config/read`, `thread/read`; `readFakeRpcLog(binDir, {method, conn, dir})`, `fakeConnections(binDir)`; `occupyBroker(endpoint, {holdMs})`; `startFakeAppServer(binDir)`; helpers `spawnStubborn()`, `waitFor()`, `isPidAlive()`, `makeCompanionWorkspace()`. M0/M1 lanes extended it further, so **read the fixture source for the exact signatures** before writing tests. Note: the fixture answers `thread/unload`, but the real codex-cli 0.157 app-server does **not** have it (probe §6), so plugin code must never call it.

**You do not own the fixture files in this wave** (lane `m6-broker-lib` does). Do not edit `tests/fake-codex-fixture.mjs` or `tests/helpers.mjs`. If you need something the fixture lacks, write a small local helper inside your own test file, or record the gap as a follow-up.

## Tests to write first

`tests/worktree-lib.test.mjs` (temp repos):
1. Two worktrees for two job ids edit the same file on separate branches; the main tree's `git status` is unchanged; `.codex-worktrees/` is in `info/exclude`.
2. `mergeJobWorktree(..., "squash")` applies the edits (staged) to the main tree; `ff-only` fast-forwards when possible and fails cleanly when not.
3. `discardJobWorktree` removes the directory and the branch.
4. `prJobWorktree({dryRun:true})` returns the push and `gh` commands.
5. Lease: first acquire succeeds; second returns the holder; a stale holder (dead pid, old heartbeat) is reclaimed; `sharedTree` does not acquire; release by a non-holder is refused.
6. Concurrent acquire from two processes: exactly one wins.

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

## Probe adjustments and scope narrowing (binding; they override the verbatim text above)

- Not protocol-dependent.

## Acceptance checklist (report PASS/FAIL per line)

- [ ] Two job worktrees can edit the same file on separate branches, and the main tree's `git status` is unchanged (library level)
- [ ] Squash merge applies the edits; discard removes both the directory and the branch
- [ ] The tree lease admits one shared-tree writer, reports the holder to the next, reclaims stale leases atomically, and supports the shared-tree bypass
- [ ] `npm test` green in your worktree; no existing test edited except where this brief allows it

## Required final report (your last message; use exactly these sections)

```
## Lane m6-worktree-lib report
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
