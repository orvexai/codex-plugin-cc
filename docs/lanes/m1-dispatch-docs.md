# Lane `m1-dispatch-docs`: Direct dispatch docs and the model-facing lifecycle surface (BUG-4 docs half, FR-1)

- **Beads:** `codex-plugin-cc-8kj.1`, `codex-plugin-cc-8kj.2`
- **Report items:** BUG-4 (proposal steps 1, 4, 7 for commands.test), FR-1
- **Wave:** 5. **Depends on:** all of M0. **Runs concurrently with:** `m1-completion-signal`.

## Goal

Remove the Haiku forwarder from the default path. `/codex:rescue` becomes one direct `task --attach` Bash call (run in the background for anything non-trivial), so Claude's own background-task notification fires exactly when Codex finishes. Give the main thread a documented lifecycle: model-invocable `status`, `result` and `cancel`, plus a `codex:drive` skill with the rules "steer, don't restart", "always cancel what you launched if you abandon it" and "never report Codex work as done until the job is terminal". This lane is **docs and command frontmatter only**; the runtime half of BUG-4 is lane `m1-completion-signal`.

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

- `plugins/codex/commands/rescue.md`
- `plugins/codex/commands/status.md`
- `plugins/codex/commands/result.md`
- `plugins/codex/commands/cancel.md`
- `plugins/codex/commands/wait.md`
- `plugins/codex/commands/send.md`
- `plugins/codex/agents/codex-rescue.md`
- `plugins/codex/skills/codex-drive/SKILL.md (new)`
- `plugins/codex/skills/codex-cli-runtime/SKILL.md`
- `plugins/codex/skills/codex-result-handling/SKILL.md`
- `tests/commands.test.mjs`

## Do not touch

Lane `m1-completion-signal` runs at the same time and owns: `plugins/codex/scripts/**` (including `codex-companion.mjs`, `stop-review-gate-hook.mjs`, `lib/render.mjs`, `lib/state.mjs`), `tests/fake-codex-fixture.mjs`, `tests/helpers.mjs`, `tests/completion-signal.test.mjs`, `tests/runtime.test.mjs`. Do not edit any script. Also do not edit `README.md`, `hooks/hooks.json`, `commands/review.md`, `commands/adversarial-review.md`, `commands/transfer.md`, `commands/setup.md` (out of scope).

## Design decisions binding on this lane

Binding decisions (plan D8):

- **Only reference subcommands and flags that exist after M0.** Run `node plugins/codex/scripts/codex-companion.mjs <sub> --help` for each command you mention and copy the flags from there. Existing after M0: `task [--attach|--background [--detach]] [--timeout-ms] [--on-owner-exit] [--owner-pid] [--resume-last|--fresh] [--prompt-file] …`, `send`, `wait`, `status`, `result`, `cancel [--force] [--grace-ms]`, `setup`, `task-resume-candidate`.
- **Brief deviation from FR-1:** `interrupt`, `attach`, `logs`, `messages` and `models` do **not** exist yet (they arrive with FR-9, FR-10, FR-2, FR-20, FR-12). Do not create commands for them, and do not mention them in the skill. The FR-1 criterion "the skill list exposes `codex:interrupt`" moves to FR-9. The drive skill's verb table lists only existing verbs, and each later lane adds its own row.
- **Launch line contract** (implemented by `m1-completion-signal`; document it): the first stdout line is `CODEX_JOB <jobId> status=<queued|running> thread=<id|pending> sandbox=<m> network=<eff> log=<path>`. Pure background prints `CODEX_JOB_QUEUED id=<id> status=queued (NOT finished)` followed by the `wait` command. Attach exit codes (§8.1): 0 completed, 1 failed, 130 cancelled/interrupted, 3 lost/orphaned, 124 when `--timeout-ms` expires while the job keeps running.
- **`commands/rescue.md`:** `allowed-tools: Bash(node:*), AskUserQuestion` (no `Agent`). Exactly **one** model Bash call: `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task --attach [runtime flags] --prompt-file <file>|"<text>"`, with `run_in_background: true` unless the task is trivially small. Do the resume-candidate check **without** a model Bash call: use the inline command-expansion form (`` !`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task-resume-candidate --json` ``, the same mechanism `status.md` uses) so its output is in the prompt, and ask AskUserQuestion only when it reports `available: true` and the user gave neither `--resume` nor `--fresh`. Tell Claude what to do when the background task notification arrives (read the output; the exit code tells the job status; use `result <id>` for the full output) and that it must never report the work as done before that. Keep the existing flag semantics (`--resume` → `--resume-last`, `--fresh`, `--model`, `--effort`, sandbox/network flags, `--name`).
- **`agents/codex-rescue.md`:** a deprecated shim. `description` must **not** contain "Proactively" (start it with "Deprecated:"). It uses `task --attach` and never `--background`. On a non-zero exit it returns `CODEX_DISPATCH_FAILED exit=<n>` plus stderr, never nothing. Remove the `gpt-5-4-prompting` preload only if a test does not require it (WISH-6 handles it later; leave it if unsure).
- **FR-1:** remove `disable-model-invocation: true` from `status.md`, `result.md` and `cancel.md`, and make sure their bodies are safe when model-invoked. New skill `skills/codex-drive/SKILL.md` (model-invocable; frontmatter `name: codex-drive` or the convention the other skills use, and a description that says when to use it) documents the lifecycle table (launch, observe, steer, stop, wait, continue, inspect) with the exact commands, the three rules, "the main thread owns the lifecycle", and the exit-code table. `skills/codex-cli-runtime/SKILL.md`: drop "use only inside the codex:codex-rescue subagent" and point to `codex-drive`. `skills/codex-result-handling/SKILL.md`: keep its rules, but say they apply to the result text, not to lifecycle control.

## Implementation guide

Read all of `plugins/codex/commands/*.md`, `agents/codex-rescue.md` and `skills/*/SKILL.md` first, then `tests/commands.test.mjs`. It contains tests that lock the old behaviour (around lines 96-114: Agent routing; 135-156 and 187-192: disable-model-invocation). Update those to the new contract, and add new assertions. Keep every other test in that file passing unchanged.

## Fake-Codex fixture API (from lane `m0-fixture`)

The fixture API from lane `m0-fixture` (see `docs/IMPLEMENTATION-PLAN.md` D2), in short: `installFakeCodex(binDir, behavior, options)`; `setFakeCodexOptions(binDir, patch)`; `options.turnScript` steps (`command`, `fileChange`, `agentMessage`, `reasoning`, `plan`, `diff`, `usage`, `delay`, `silence`, `serverRequest`); `options.interrupt: "cooperate"|"ignore"|"ack-only"`; `options.ignoreSigterm`; `options.delays.{initialize,threadStart,turnStart}`; `options.models`, `options.config`, `options.forceActiveWriter`; `readFakeRpcLog(binDir, {method, conn})`, `fakeConnections(binDir)`; `occupyBroker(endpoint, {holdMs})`; helpers `spawnStubborn()`, `waitFor()`, `isPidAlive()`, `makeCompanionWorkspace()`, `startFakeAppServer()`. Read the fixture source for the exact signatures before writing tests. You do **not** own the fixture files in this wave: if a capability is missing, write a small local helper inside your own test file and report it as a follow-up.

## Tests to write first

In `tests/commands.test.mjs` (you own it in this wave):
1. `rescue.md` makes 0 Agent calls and 1 model Bash call: its frontmatter `allowed-tools` excludes `Agent`; its body contains exactly one fenced/inline instruction to run `codex-companion.mjs task --attach`; it contains no `subagent_type`.
2. `status.md`, `result.md`, `cancel.md` frontmatter do not contain `disable-model-invocation: true`.
3. `skills/codex-drive/SKILL.md` exists and mentions `send`, `cancel`, `wait`, `result`, `status`, `task --attach`, and the steer rule ("steer, don't restart").
4. `agents/codex-rescue.md` description does not contain "Proactively", uses `--attach`, never `--background`, and mentions `CODEX_DISPATCH_FAILED`.
5. **Doc consistency (light):** every `codex-companion.mjs <subcommand>` referenced in `commands/*.md`, `agents/*.md` and `skills/**/SKILL.md` appears in the `main()` switch of `codex-companion.mjs` (parse the file text), and every `--flag` referenced right after `task` is accepted by `task --help` output (run it).

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

### FR-1: A model-facing lifecycle surface: model-invocable status, result and cancel, plus a "drive Codex" skill
- **Priority:** P1
- **Problem:** `/codex:status`, `/codex:result`, `/codex:cancel`, `/codex:review`, `/codex:adversarial-review` and `/codex:transfer` all have `disable-model-invocation: true`. The `codex-cli-runtime` skill says "use only inside the codex:codex-rescue subagent". The rescue docs forbid polling, fetching and cancelling. The main thread only discovers that it can cancel an orphan (E1) or steer (E6) by improvising. `send` and `wait` are already model-invocable, so the asymmetry is arbitrary.
- **Evidence:** E1, E3, E6. `commands/{status,result,cancel,review,adversarial-review,transfer}.md` line 4. `skills/codex-cli-runtime/SKILL.md` 3 and 8. `commands/rescue.md` 42-45. `tests/commands.test.mjs` 135-156 and 187-192.
- **Proposal:** Remove `disable-model-invocation` from status, result and cancel, and add model-invocable `interrupt`, `attach`, `logs`, `messages` and `models` commands. Add a skill `codex:drive` (model-invocable) that documents the full lifecycle through `orvex-codex`, or through `node ${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs`:

  | Verb | Command |
  |---|---|
  | launch | `task --attach` under run_in_background |
  | observe | `status`, `logs --follow`, `events` |
  | steer | `send` |
  | redirect | `interrupt --then` |
  | stop | `cancel` |
  | wait | `wait` |
  | reattach | `attach` |
  | continue | `task --resume <id>` or `send <id>` |
  | inspect | `result --partial`, `diff`, `transcript` |

  The skill includes rules: **"steer, don't restart"**, **"always cancel what you launched if you abandon it"**, and **"never report Codex work as done until the job is terminal"**. Keep the forwarder's restrictions for the subagent only, and state that the main thread owns the lifecycle. Update `tests/commands.test.mjs`.
- **Acceptance criteria:** The skill list exposes `codex:status`, `codex:result`, `codex:cancel`, `codex:interrupt` and `codex:drive`. `tests/commands.test.mjs` asserts that their frontmatter does not disable model invocation, and that the drive skill mentions send, interrupt, cancel, wait, logs, result and attach, plus the steer rule.

## Acceptance checklist (report PASS/FAIL per line)

- [ ] A `/codex:rescue` run makes 0 Agent calls and 1 Bash call (asserted in `tests/commands.test.mjs`)
- [ ] `agents/codex-rescue.md` is a deprecated shim: no "Proactively", `--attach` only, `CODEX_DISPATCH_FAILED exit=<n>` on failure
- [ ] The skill list exposes `codex:status`, `codex:result`, `codex:cancel` and `codex:drive` (`codex:interrupt` deferred to FR-9 per plan D8, noted)
- [ ] `tests/commands.test.mjs` asserts their frontmatter does not disable model invocation, and that the drive skill mentions send, cancel, wait, result, status and task --attach, plus the steer rule
- [ ] Docs reference only existing subcommands and flags (doc-consistency assertion)
- [ ] `npm test` green

## Required final report (your last message; use exactly these sections)

```
## Lane m1-dispatch-docs report
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
