# Lane `m0-prune`: Pruning never evicts active or unread jobs (BUG-14)

- **Beads:** `codex-plugin-cc-1mh.8`
- **Report items:** BUG-14
- **Wave:** 1. **Depends on:** none. **Runs concurrently with:** `m0-fixture`, `m0-spike`, `m0-cli-hygiene`.

## Goal

`pruneJobs` keeps the 200 most recently updated jobs with no status check, so a long-running job can be evicted and its json, log and inbox deleted. That is one suspected cause of BUG-18 ("No job found" for a running job). Make pruning status-aware and unread-aware, and provide the `resultReadAt` marker API that later lanes wire into `result`, `wait` and `attach`.

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

- `plugins/codex/scripts/lib/state.mjs`
- `tests/prune.test.mjs`

## Do not touch

- `plugins/codex/scripts/codex-companion.mjs`, `plugins/codex/scripts/lib/args.mjs` (lane `m0-cli-hygiene`): you do **not** wire `resultReadAt` into commands here. Lane `m0-liveness` does that in the next wave.
- `tests/fake-codex-fixture.mjs`, `tests/helpers.mjs` (lane `m0-fixture`).
- `docs/**`, `scripts/probe-app-server.mjs` (lane `m0-spike`).
- `plugins/codex/scripts/session-lifecycle-hook.mjs`: its `cleanupSessionJobs` deletes jobs through `saveState`. That is BUG-3 (lane `m0-session-end`), and the existing test "session end fully cleans up jobs" must keep passing in this wave.

## Design decisions binding on this lane

- Terminal statuses (define locally in `state.mjs` as `TERMINAL_JOB_STATUSES`; lane `m0-liveness` will later centralise them in `lib/exit-codes.mjs`): `completed, failed, cancelled, cancel-failed, interrupted, timed-out, lost, orphaned`. **Any other status, including unknown future ones, counts as active and is never pruned.**
- New `pruneJobs(jobs, {now = Date.now(), maxJobs = MAX_JOBS} = {})`: (1) keep every active job; (2) keep every terminal job whose `resultReadAt` is unset and whose `completedAt` (or `updatedAt`) is less than 24h old (`UNREAD_RETENTION_MS = 24*3600*1000`); (3) fill the remaining slots up to `maxJobs` with the newest other jobs by `updatedAt`. If (1)+(2) exceed `maxJobs`, keep them all (never evict protected jobs to hit the cap).
- `saveStateUnlocked` only deletes the files of jobs that `pruneJobs` dropped **or** that the caller explicitly removed from `state.jobs` (today's semantics for callers such as the SessionEnd hook stay unchanged in this wave).
- Export `markResultRead(workspaceRoot, jobId, {at = nowIso()} = {})`: sets `resultReadAt` in both the job file (`writeJobFile`, merge) and the index entry (`upsertJob`), and is a no-op when the job is unknown.
- Keep the private `isProcessAlive` in `state.mjs` as it is (lane `m0-liveness` moves it).

## Implementation guide

`lib/state.mjs`: `pruneJobs`, `saveStateUnlocked`, new `markResultRead`, `TERMINAL_JOB_STATUSES`, `UNREAD_RETENTION_MS`. Check every caller of `saveState`/`updateState`/`upsertJob` (`find_referencing_symbols`) to make sure nothing relied on the old ordering.

## Tests to write first

`tests/prune.test.mjs`, using the state API directly on a temp workspace (no fixture needed):
1. Report criterion: create 201 jobs where the **oldest** (by `updatedAt`) is `running` and has a job file, a log file and an inbox file. After an `upsertJob` that triggers pruning, the running job and all three of its files survive.
2. An unread `completed` job less than 24h old survives over 200 newer read jobs; the same job with `resultReadAt` set is pruned.
3. An unread `completed` job older than 24h is prunable.
4. More than 200 protected (active) jobs are all kept.
5. `markResultRead` sets the field in the job file and the index, and is a no-op for an unknown id.
6. An unknown status (e.g. `"weird"`) is treated as active.

## Requirements from the report (verbatim)

The text below is copied verbatim from `docs/IMPROVEMENT-REPORT.md`. You do not need to read the rest of the report.

### BUG-14: Job pruning can evict active or unread jobs and delete their evidence
- **Priority:** P2
- **Problem:** `pruneJobs` keeps the 200 most recently updated jobs, sorted by `updatedAt` with no status check. `updatedAt` only changes on phase, thread or turn changes, so a long-running job can be evicted, and its json, log and inbox are deleted. Nothing records whether a result has been read.
- **Evidence:** `lib/state.mjs` 15 (`MAX_JOBS=200`), 226-230 and 238-263. `lib/tracked-jobs.mjs` 69-111.
- **Proposal:** Pruning never drops active jobs, or jobs younger than 24h whose `resultReadAt` is unset (`result`, `wait` and attach set it). Archiving and gc are covered in WISH-7.
- **Acceptance criteria:** Create 201 jobs with the oldest still running. The running job survives, and so do its files.

## Acceptance checklist (report PASS/FAIL per line)

- [ ] 201 jobs with the oldest still running: the running job survives, and so do its files (.json, .log, inbox)
- [ ] Unread terminal jobs younger than 24h are never pruned; read or old ones are
- [ ] Protected jobs are never evicted to satisfy the 200 cap
- [ ] `markResultRead` exported and tested
- [ ] `npm test` green; the existing SessionEnd cleanup test is unchanged and passing

## Required final report (your last message; use exactly these sections)

```
## Lane m0-prune report
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
