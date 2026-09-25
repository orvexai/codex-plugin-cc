# Lane `m1-completion-signal`: Truthful launch line, attach exit codes and Stop-hook JSON (BUG-4 runtime half)

- **Beads:** `codex-plugin-cc-8kj.1`
- **Report items:** BUG-4 (proposal steps 2, 3, 5, 7 for runtime.test)
- **Wave:** 5. **Depends on:** all of M0. **Runs concurrently with:** `m1-dispatch-docs`.

## Goal

Make every launch machine-readable and truthful, and make sure Claude actually *sees* running jobs at stop time. Every launch's first stdout line is a `CODEX_JOB…` line. `task --attach` exit codes follow the canonical table. The Stop hook reports running jobs as JSON on stdout (the model never sees stderr) and can block the stop once per job.

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

- `plugins/codex/scripts/codex-companion.mjs`
- `plugins/codex/scripts/stop-review-gate-hook.mjs`
- `plugins/codex/scripts/lib/render.mjs`
- `plugins/codex/scripts/lib/state.mjs`
- `tests/fake-codex-fixture.mjs`
- `tests/helpers.mjs`
- `tests/completion-signal.test.mjs`
- `tests/runtime.test.mjs (only the Stop-hook tests, currently around lines 1926-2118)`

## Do not touch

Lane `m1-dispatch-docs` runs at the same time and owns: `plugins/codex/commands/**`, `plugins/codex/agents/**`, `plugins/codex/skills/**`, `tests/commands.test.mjs`. Do not edit them. Also do not edit `hooks/hooks.json`, `README.md`, `lib/codex.mjs`, `app-server-broker.mjs`, `lib/broker-lifecycle.mjs`, `session-lifecycle-hook.mjs`, or other existing tests.

## Design decisions binding on this lane

Binding decisions (plan D8):

- **Launch line, universal:** in text mode, the first stdout line of **every** task launch (foreground, `--attach`, `--background`, and `send` follow-ups that start a job) is `CODEX_JOB <jobId> status=<queued|running> thread=<threadId|pending> sandbox=<sandbox> network=<effective> log=<logPath>`, or for pure background `CODEX_JOB_QUEUED id=<id> status=queued (NOT finished) sandbox=<…> network=<…> log=<…>` followed by `Wait with: node "<script>" wait <id> --json`. For the foreground task, print it as soon as the job record exists, before the turn runs. `network=` is the value as recorded today (`on`/`off`); lane `m1-runtime` makes it the *effective* network (BUG-12). `--json` output stays pure JSON: add the same fields as `launch: {jobId, status, threadId, sandbox, network, logFile}` instead of a text line.
- **Exit codes:** foreground `task` and `task --attach` exit `exitCodeForJob(status, {mode:"attach"|"task"})` (from `lib/exit-codes.mjs`): completed 0, failed 1, cancelled/interrupted 130, lost/orphaned 3. `timed-out` → 4 is already in the table (FR-17 produces it later). Waiter timeout → 124. Verify that `m0-ownership` implemented this; fill any gaps (e.g. foreground `task` may still exit 0 on failure).
- **Stop hook JSON:** in `stop-review-gate-hook.mjs`, when the review gate is off and a job of this session is active (after the file-only `reconcileJob`), print to **stdout** `{"systemMessage": "Codex job <id> (<status>, <elapsed>) is still running. Wait: … wait <id>. Cancel: … cancel <id>."}` listing all active jobs. Config `stopRunningJobs: "block"|"warn"|"off"` (default `warn`), set by `setup --stop-running-jobs <block|warn|off> [--global]`. In `block` mode, return `{"decision":"block","reason":"Codex job <id> still running; wait or cancel"}` **once per job**, tracked with `stopNotifiedAt` in the job record (written with the state API). The next stop for the same job only warns. `off` prints nothing. When the review gate is on, keep today's flow, but put the running-job note in the JSON (`systemMessage`, or appended to `reason`) instead of stderr.
- **Setup report:** show the `stopRunningJobs` value and its source, like the other defaults.

## Implementation guide

- `codex-companion.mjs`: `handleTask`, `runForegroundCommand`, `enqueueBackgroundTask`, `renderQueuedTaskLaunch`, `handleSend` (follow-up launch line), `handleSetup` + `buildSetupReport` (`--stop-running-jobs`), `printUsage`.
- `lib/render.mjs`: a `renderLaunchLine(job, runtime)` helper used everywhere.
- `stop-review-gate-hook.mjs`: `main`, `logNote` → JSON emission, `filterJobsForCurrentSession`.
- `lib/state.mjs`: config default for `stopRunningJobs` only, if the config schema needs it.
- Update the existing Stop-hook tests (notably "stop hook logs running tasks to stderr without blocking when the review gate is disabled", ~line 1982) to the new stdout-JSON contract, and explain each change.

## Fake-Codex fixture API (from lane `m0-fixture`)

The fixture API from lane `m0-fixture` (see `docs/IMPLEMENTATION-PLAN.md` D2), in short: `installFakeCodex(binDir, behavior, options)`; `setFakeCodexOptions(binDir, patch)`; `options.turnScript` steps (`command`, `fileChange`, `agentMessage`, `reasoning`, `plan`, `diff`, `usage`, `delay`, `silence`, `serverRequest`); `options.interrupt: "cooperate"|"ignore"|"ack-only"`; `options.ignoreSigterm`; `options.delays.{initialize,threadStart,turnStart}`; `options.models`, `options.config`, `options.forceActiveWriter`; `readFakeRpcLog(binDir, {method, conn})`, `fakeConnections(binDir)`; `occupyBroker(endpoint, {holdMs})`; helpers `spawnStubborn()`, `waitFor()`, `isPidAlive()`, `makeCompanionWorkspace()`, `startFakeAppServer()`. Read the fixture source for the exact signatures before writing tests. If you need a fixture capability that is missing, add it **additively** (this lane owns the fixture files in this wave) and keep every existing behaviour string working.

## Tests to write first

`tests/completion-signal.test.mjs`:
1. The first stdout line of `task --background "x"` matches `/^CODEX_JOB_QUEUED /`; of `task --attach "x"` and foreground `task "x"`, `/^CODEX_JOB /`; each contains `sandbox=`, `network=`, `log=`.
2. Report criterion, scaled: a `turnScript` with `delay` 3000ms and `task --attach`. The process exits after 3s ±1.5s, stdout ends with the result text, and the exit code is 0. With `turnStatus:"failed"` it is 1. Cancelled from another process: 130. Worker SIGKILLed so the job becomes lost: 3. (Report text says a 30s turn; 3s is the scaled test, and the orchestrator measures 30s manually.)
3. Foreground `task` on a failed turn exits 1 (not 0).
4. Stop hook, gate off, one running job: stdout parses as JSON and contains the job id. `stopRunningJobs=block`: first run → `decision:"block"`, second run for the same job → no block (warning only). `off` → no output.
5. `--json` launch payloads contain `launch.jobId` and no extra text lines.

## Requirements from the report (verbatim)

The text below is copied verbatim from `docs/IMPROVEMENT-REPORT.md`. You do not need to read the rest of the report.

### BUG-4: The wrapper agent reports COMPLETED at dispatch, and nothing notifies Claude when Codex finishes
- **Priority:** P0
- **Problem:** The `codex-rescue` subagent (Haiku, Bash only, preloading two skills) makes one Bash call and returns its stdout. It is told to prefer `--background` for complex tasks, so the call returns only the enqueue receipt, and Claude's harness marks the agent COMPLETED while Codex works. No hook fires when a job finishes: `hooks.json` has only SessionStart, SessionEnd and Stop. The Stop hook's running-job note goes to stderr with exit 0 whenever the review gate is off (the default), so the model never sees it; `tests/runtime.test.mjs` ~1982 locks this in. `wait` exists and is designed for Bash `run_in_background`, but the rescue path never uses it or mentions it. The hop costs about 2.5 min and 13k Claude tokens.
- **Evidence:** E2, E12. `agents/codex-rescue.md` 4-9, 22-28, 40-44. `commands/rescue.md` 6, 13-17, 42-45. `codex-companion.mjs` `enqueueBackgroundTask` ~924-950 and `renderQueuedTaskLaunch` ~786-818. `scripts/stop-review-gate-hook.mjs` 33-38 and ~150-157 (`logNote` → stderr). `commands/wait.md`. `tests/commands.test.mjs` 96-114 (asserts Agent routing).
- **Proposal:**
  1. **Remove the forwarder from the default path.** Rewrite `commands/rescue.md` to make **one direct Bash call**: `node ${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs task --attach --format brief ...`, with Bash `run_in_background: true` for anything non-trivial. Claude's own background-task notification then fires exactly when Codex finishes.
  2. The first stdout line of every launch is machine-readable: `CODEX_JOB <jobId> status=<queued|running> thread=<threadId|pending> log=<path>`. A pure `--background` launch prints `CODEX_JOB_QUEUED id=<id> status=queued (NOT finished)`, then the exact `wait <id> --json` command.
  3. The attach exit codes follow the canonical table in §8.1: completed → 0, failed → 1, cancelled or interrupted → 130, job timed-out (FR-17) → 4, lost or orphaned → 3. Exit 124 is reserved for the *waiter* giving up (`wait --timeout-ms`, `attach --timeout-ms`) while the job is still running.
  4. Keep `agents/codex-rescue.md` only as a deprecated shim. It must use `--attach`, never `--background`. On failure it returns `CODEX_DISPATCH_FAILED exit=<n>` plus stderr, never nothing. Remove "Proactively use" from its `description` (line 3): with a bypass default (FR-25), Claude must not auto-dispatch full-access Codex jobs on its own initiative through a deprecated path.
  5. The Stop hook emits JSON (`systemMessage` or `hookSpecificOutput.additionalContext`) naming active jobs. The config `blockStopWhileCodexRunning` (settable with `setup --stop-running-jobs block|warn|off`, default `warn`) returns `{decision:'block', reason:'Codex job X still running; wait or cancel'}` once per job (tracked in `stopNotifiedAt`).
  6. The hook-injected completion ledger is FR-16.
  7. Update `tests/commands.test.mjs` 96-114 and `tests/runtime.test.mjs` ~1982.
- **Acceptance criteria:**
  - A `/codex:rescue` run makes 0 Agent calls and 1 Bash call (asserted in `tests/commands.test.mjs`).
  - With a 30s fake turn, the Claude background Bash task completes at 30s ±2s, its output ends with the result, and its exit code matches the job status.
  - Stop hook with the gate off and one running job: stdout JSON contains the job id. In `block` mode it returns `decision:block`.
  - The first line of background launch stdout matches `/^CODEX_JOB(_QUEUED)? /`.
  - The Claude-side dispatch cost is under about 2-3k tokens, measured once manually and recorded in the PR.

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

- [ ] With a 30s fake turn (scaled to 3s in tests), the Claude background Bash task completes at the turn end ±2s, its output ends with the result, and its exit code matches the job status
- [ ] Stop hook with the gate off and one running job: stdout JSON contains the job id. In `block` mode it returns `decision:block` (once per job)
- [ ] The first line of background launch stdout matches `/^CODEX_JOB(_QUEUED)? /` (and every other launch mode prints a CODEX_JOB line)
- [ ] Foreground and attach exit codes follow §8.1
- [ ] The Claude-side dispatch cost (under 2-3k tokens) is left to the orchestrator to measure manually; say so in your report
- [ ] `npm test` green; only Stop-hook tests in `tests/runtime.test.mjs` changed

## Required final report (your last message; use exactly these sections)

```
## Lane m1-completion-signal report
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
