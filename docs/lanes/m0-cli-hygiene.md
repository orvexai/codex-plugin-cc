# Lane `m0-cli-hygiene`: `--help` and unknown flags never reach Codex (BUG-16)

- **Beads:** `codex-plugin-cc-1mh.9`
- **Report items:** BUG-16
- **Wave:** 1. **Depends on:** none. **Runs concurrently with:** `m0-fixture`, `m0-spike`, `m0-prune`.

## Goal

Today `codex-companion.mjs task --help` starts a real, privileged Codex thread whose prompt is `--help`, and a typo'd flag becomes prompt text. Make every subcommand print its own usage for `-h`/`--help` and exit 0 without touching Codex, and reject unknown flags that appear before the first prompt token with exit 2.

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

- `plugins/codex/scripts/lib/args.mjs`
- `plugins/codex/scripts/codex-companion.mjs`
- `tests/cli-hygiene.test.mjs`

## Do not touch

- `tests/fake-codex-fixture.mjs`, `tests/helpers.mjs`, `tests/fixture-smoke.test.mjs` (lane `m0-fixture`). Use the fixture exactly as it is today (`installFakeCodex(binDir, "review-ok")`, `buildEnv`), because the upgrade is landing at the same time.
- `plugins/codex/scripts/lib/state.mjs` (lane `m0-prune`).
- `docs/**`, `scripts/probe-app-server.mjs` (lane `m0-spike`).

## Design decisions binding on this lane

- **Parser (`lib/args.mjs` `parseArgs`)**: add an opt-in `strict: true` config. With `strict`, a token that starts with `-` and is not a known value/boolean option (after alias mapping) **and appears before the first positional** throws a `UsageError`. After the first positional, unknown dash tokens stay positional text, as today, so `task fix the --verbose flag handling` still works. `--` ends option parsing (as today), so `task -- --help` sends the literal `--help`. `-h` and `--help` are recognised as a boolean `help` option in strict mode, anywhere before `--`.
- **`UsageError`**: export `class UsageError extends Error` with `exitCode = 2` from `lib/args.mjs`. `main().catch` in `codex-companion.mjs` sets `process.exitCode = error.exitCode ?? 1` and prints `message` plus a one-line hint (`Run "<subcommand> --help" for usage.`). Use the literal `2` here; lane `m0-liveness` later introduces `lib/exit-codes.mjs` and may switch it over.
- **Per-subcommand usage:** turn `printUsage()` into a map `USAGE = {setup: [...], review: [...], …}` built from the existing lines (keep their text), plus `printUsage(subcommand?)`. `help <sub>` and `<sub> --help` print that subcommand's lines; bare `help`/`--help` print all (current behaviour). Internal subcommands (`task-worker`, `task-resume-candidate`) get a one-line usage too.
- Every `handle*` function passes `strict: true` through `parseCommandInput` and checks `options.help` **before** any side effect: before `ensureCodexAvailable`, reading stdin, creating a job, resolving the workspace state, or connecting to an app-server. For `setup`, `--help` must not run the setup report (which probes Codex).

## Implementation guide

- `lib/args.mjs`: `parseArgs` (add `strict`, `help`), `UsageError`.
- `codex-companion.mjs`: `printUsage`, `parseCommandInput` (default `strict: true` for user-facing subcommands; `task-worker` may stay non-strict), every handler (`handleSetup`, `handleReview`, `handleReviewCommand`, `handleTask`, `handleSend`, `handleWait`, `handleTransfer`, `handleStatus`, `handleResult`, `handleTaskResumeCandidate`, `handleCancel`), `main` and its `.catch`.
- Check the `normalizeArgv` path, which shell-splits a single `$ARGUMENTS` string, so `status "--help"` from a slash command also works.
- Watch out for existing flags each handler must still accept. Collect them from the current `valueOptions`/`booleanOptions`; `RUNTIME_VALUE_OPTIONS`/`RUNTIME_BOOLEAN_OPTIONS` are shared. Existing tests exercise many flag combinations: run the whole suite often.

## Tests to write first

`tests/cli-hygiene.test.mjs` (use `installFakeCodex(binDir, "review-ok")` in a temp git repo with isolated `CODEX_COMPANION_CONFIG`; copy the small `makeWorkspace` pattern from `tests/orvex.test.mjs`):
1. `task --help`, `send --help`, `status --help`, `wait --help`, `cancel --help`, `result --help`, `setup --help`, `review --help`, `adversarial-review --help`, `transfer --help` and `-h` each print a usage line containing the subcommand name and exit 0. The fake state file shows **no** app-server start (`appServerStarts` absent or 0), and the workspace `jobs/` dir has no job files.
2. `task --wirte "x"` exits 2, and stderr names `--wirte`; no job and no app-server start.
3. `task -- --help` sends the literal text `--help` to the fake (assert the recorded prompt or the thread preview) and exits 0.
4. `task fix the --verbose flag` still runs with that full prompt text.
5. `help task` prints the task usage.
6. Unit tests of `parseArgs` strict mode: unknown before positional throws `UsageError` (exitCode 2); unknown after positional stays positional; inline `--k=v` known works; `--` passthrough.

## Requirements from the report (verbatim)

The text below is copied verbatim from `docs/IMPROVEMENT-REPORT.md`. You do not need to read the rest of the report.

### BUG-16: `--help` / unknown flags are sent to Codex as the task prompt
- **Observed:** `codex-companion.mjs task --help` started a real Codex thread (full-access runtime) whose prompt was `--help`; Codex replied "`--help` needs a command to apply to". Any typo'd flag likewise becomes prompt text on a live, privileged job.
- **Proposal:** every subcommand handles `-h/--help` by printing its usage line(s) (already present at `codex-companion.mjs` ~103-119) and exiting 0 without contacting Codex; reject unknown `--flags` before the first positional prompt token with exit 2 and a usage hint (allow `--` to pass literal text).
- **Acceptance:** `task --help`, `send --help`, `status --help` print usage, exit 0, create no job/thread; `task --wirte "x"` exits 2 naming the unknown flag; `task -- --help` sends the literal text.

## Acceptance checklist (report PASS/FAIL per line)

- [ ] `task --help`, `send --help`, `status --help` print usage, exit 0, create no job/thread (checked for every user-facing subcommand)
- [ ] `task --wirte "x"` exits 2 naming the unknown flag
- [ ] `task -- --help` sends the literal text
- [ ] Unknown dash tokens after the first prompt word remain prompt text (no regression)
- [ ] `npm test` green with no existing test modified

## Required final report (your last message; use exactly these sections)

```
## Lane m0-cli-hygiene report
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
