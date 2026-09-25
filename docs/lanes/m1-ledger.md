# Lane `m1-ledger`: Hook-injected completion ledger for jobs Claude is not following (FR-16)

- **Beads:** `codex-plugin-cc-8kj.6`
- **Report items:** FR-16
- **Wave:** 6. **Depends on:** Wave 5 (BUG-4). **Runs concurrently with:** `m1-runtime`.

## Goal

Jobs started with `--background`/`--detach`, or still running after a restart, finish silently. Add cheap UserPromptSubmit and PostToolUse hooks that read state files only and inject `additionalContext` once per terminal transition, e.g. `Codex job X completed (exit 0): <summary>; see result X`.

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

- `plugins/codex/scripts/job-ledger-hook.mjs (new)`
- `plugins/codex/hooks/hooks.json`
- `tests/ledger.test.mjs`

## Do not touch

Lane `m1-runtime` runs at the same time and owns: `codex-companion.mjs`, `lib/codex.mjs`, `lib/render.mjs`, `stop-review-gate-hook.mjs`, `README.md`, `tests/fake-codex-fixture.mjs`, `tests/helpers.mjs`, `tests/runtime-defaults.test.mjs`, `tests/orvex.test.mjs`. Do not edit them. Do not edit any `lib/*.mjs` either: **import** what you need (`listJobs`, `readJobFile`, `writeJobFile`, `upsertJob`, `resolveStateDir`, `resolveStateFile`, `getConfig`, `getGlobalConfig` from `lib/state.mjs`; `reconcileJob` from `lib/job-liveness.mjs`; `exitCodeForJob`, `TERMINAL_STATUSES` from `lib/exit-codes.mjs`; `resolveWorkspaceRoot` from `lib/workspace.mjs`). If an import you need does not exist, write a local helper in your hook script. Do not edit `session-lifecycle-hook.mjs` or existing tests, except that `tests/commands.test.mjs` "hooks keep session-end cleanup and stop gating enabled" must keep passing with your `hooks.json` change.

## Design decisions binding on this lane

- **`scripts/job-ledger-hook.mjs`**: reads hook JSON from stdin (`session_id`, `cwd`, `hook_event_name`). The fast path, first: `stat` the workspace `state.json` and compare its `mtimeMs` with `<stateDir>/ledger-<sessionId>.json` (`{stateMtimeMs}`). If unchanged, exit 0 with no output. Otherwise list the jobs of this session (`job.sessionId === session_id`), reconcile each active one (file-only), and select terminal jobs with `notifiedAt` unset. For each, emit one line: `Codex job <id> <status> (exit <exitCodeForJob(status,{mode:"wait"})>): <summary or first line of errorMessage>; see: node "<script>" result <id>`. Set `notifiedAt` in the job file and index. Output `{"hookSpecificOutput":{"hookEventName":"<event>","additionalContext":"<lines>"}}`, then save the new mtime.
- The job must belong to this session (adopted jobs arrive with FR-10 later; it sets `sessionId`, so this rule already covers them).
- Config `notifyVia: "hooks"|"off"` (default `hooks`) from `getConfig`/`getGlobalConfig`; `off` → exit 0 silently. (The `setup` flag lands with FR-14; note it as a follow-up.)
- **Budget:** under 1s with 200 jobs; hooks.json timeout 5, but aim for under 200ms on the fast path. No app-server calls, no `require` of heavy modules beyond what is listed.
- **`hooks/hooks.json`:** add `UserPromptSubmit` and `PostToolUse` entries running `node "${CLAUDE_PLUGIN_ROOT}/scripts/job-ledger-hook.mjs"`. PostToolUse without a matcher (all tools); keep the existing entries unchanged.
- Never throw from the hook: on any error, exit 0 with no output (stderr logging is fine).

## Implementation guide

New script plus `hooks.json` edit. Make the script's main function exported or testable by spawning it with stdin JSON, the same way `tests/runtime.test.mjs` drives the other hooks.

## Fake-Codex fixture API (from lane `m0-fixture`)

The fixture API from lane `m0-fixture` (see `docs/IMPLEMENTATION-PLAN.md` D2), in short: `installFakeCodex(binDir, behavior, options)`; `setFakeCodexOptions(binDir, patch)`; `options.turnScript` steps (`command`, `fileChange`, `agentMessage`, `reasoning`, `plan`, `diff`, `usage`, `delay`, `silence`, `serverRequest`); `options.interrupt: "cooperate"|"ignore"|"ack-only"`; `options.ignoreSigterm`; `options.delays.{initialize,threadStart,turnStart}`; `options.models`, `options.config`, `options.forceActiveWriter`; `readFakeRpcLog(binDir, {method, conn})`, `fakeConnections(binDir)`; `occupyBroker(endpoint, {holdMs})`; helpers `spawnStubborn()`, `waitFor()`, `isPidAlive()`, `makeCompanionWorkspace()`, `startFakeAppServer()`. Read the fixture source for the exact signatures before writing tests. You do **not** own the fixture files in this wave: if a capability is missing, write a small local helper inside your own test file and report it as a follow-up.

## Tests to write first

`tests/ledger.test.mjs` (create jobs by writing job records and index entries through the state API, or by running a quick fake task; set `CODEX_COMPANION_SESSION_ID`):
1. After a background job completes, the PostToolUse hook's stdout JSON contains the job id exactly once, and the next run prints nothing.
2. The UserPromptSubmit variant behaves the same way; a job from another session is never announced.
3. A lost job (dead worker pid) is reconciled and announced as `lost (exit 3)`.
4. Fast path: with state.json unchanged since the last run, the hook outputs nothing and does not read job files (assert by timing, or by a job file that would throw if parsed).
5. 200 jobs → the hook completes in under 1s.
6. `notifyVia: "off"` → no output.

## Requirements from the report (verbatim)

The text below is copied verbatim from `docs/IMPROVEMENT-REPORT.md`. You do not need to read the rest of the report.

### FR-16: Hook-injected job events (a completion ledger) for jobs Claude is not following
- **Priority:** P2 (complements BUG-4)
- **Problem:** Jobs started with `--background`/`--detach`, or still running after a restart, finish silently. No hook reports completion.
- **Evidence:** E2, E4. `hooks/hooks.json`. `scripts/stop-review-gate-hook.mjs` 33-38 and 150-183.
- **Proposal:** Add UserPromptSubmit and PostToolUse hooks with a budget of 1s or less. They read state files only (no app-server calls) and emit `additionalContext` for each terminal transition not yet announced, tracked with `notifiedAt` per job, e.g. `Codex job X completed (exit 0): <1-line summary>; files: a, b; see result X`. Each transition is emitted at most once per session. The job must belong to this session or have been adopted. Make it configurable (`notifyVia: hooks|off`). Keep PostToolUse cheap: bail out after a single `stat` of `state.json` if its mtime has not changed.
- **Acceptance criteria:** After a background job completes, the PostToolUse hook's stdout JSON contains the job id once, and the next run prints nothing. The hook stays under 1s with 200 jobs.

## Acceptance checklist (report PASS/FAIL per line)

- [ ] After a background job completes, the PostToolUse hook's stdout JSON contains the job id once, and the next run prints nothing
- [ ] The hook stays under 1s with 200 jobs
- [ ] UserPromptSubmit also announces once; other sessions' jobs never announced; state-files only (no app-server calls)
- [ ] `hooks/hooks.json` registers both hooks; existing hook entries unchanged
- [ ] `npm test` green

## Required final report (your last message; use exactly these sections)

```
## Lane m1-ledger report
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
