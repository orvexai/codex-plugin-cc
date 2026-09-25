# Lane `m5-brief-lib`: Brief result format renderer (FR-23)

- **Beads:** `codex-plugin-cc-qo4.3`
- **Report items:** FR-23. **Scope in this lane:** the **renderer half** of FR-23: `lib/brief-format.mjs`, unit-tested. The `--format` flags are lane `m5-fanout-brief`; the doc relaxations are lane `m5-docs`.
- **Milestone / wave:** M5, wave 1. **Depends on:** all of M4 merged. **Runs concurrently with:** `m5-job-api`, `m5-fanout-lib`, `m5-mcp-protocol`.

## Goal

Results come back verbatim with no size bound, so one dispatch plus result costs Claude thousands of tokens. Build a compact, bounded `brief` rendering of a job result that keeps what Claude needs to decide the next step and points to everything else.

## Ground rules (non-negotiable)

- **Worktree:** you work in your **own git worktree**, created by the orchestrator from branch `orvex/improvement-report` after the previous wave was merged (normally `/home/crew/workspace/codex-plugin-cc-lanes/m5-brief-lib` on branch `lane/m5-brief-lib`; use the path you were given). Paths below are relative to your worktree root, and `plugins/codex/scripts/` holds the runtime. The other lanes of your wave run at the same time in their own worktrees, and the orchestrator merges every lane of the wave afterwards. **File ownership is what keeps those merges conflict-free**, so respect it exactly.
- **Beads:** run `bd` from the main checkout: `cd /home/crew/workspace/codex-plugin-cc && bd update <id> --claim` for each bead listed above. If a bead is already claimed (another lane of the same item claimed it), skip the claim and still add your note. At the end, run `bd note <id> "<one paragraph: lane m5-brief-lib; what changed, tests added, npm test result, open risks>"` for each bead. **Never** run `bd close`: the orchestrator closes beads after review.
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

- `plugins/codex/scripts/lib/brief-format.mjs` (new)
- `tests/brief-lib.test.mjs` (new)

## Do not touch

- Lane `m5-job-api` runs at the same time and owns: `plugins/codex/scripts/codex-companion.mjs`, `plugins/codex/scripts/lib/job-api.mjs`, `tests/fake-codex-fixture.mjs`, `tests/helpers.mjs`, `tests/job-api.test.mjs`.
- Lane `m5-fanout-lib` runs at the same time and owns: `plugins/codex/scripts/lib/fanout.mjs`, `tests/fanout-lib.test.mjs`.
- Lane `m5-mcp-protocol` runs at the same time and owns: `plugins/codex/scripts/lib/mcp-protocol.mjs`, `tests/mcp-protocol.test.mjs`.
- Any existing test file not listed under "Files you own" (add your tests in your own new test files).

## Design decisions binding on this lane

- **`renderBrief({job, result, scriptPath, maxChars = 6000})`** → string ≤ `maxChars` characters: line 1 `Codex job <id> <status> (exit <code>) · <elapsed> · <badge>`; a 1-5 line summary (`result.structured.data.summary` if present, else the first meaningful lines of `rawOutput`, else `errorMessage`); `Files (<n>):` up to 15 files with `+a -d` (then `… +N more`); `Failed commands:` with exit codes (up to 5); `Validation: ran/passed/failing`; `Warnings:` (up to 5); and a pointers block with the exact commands `result <id>`, `diff <id>`, `logs <id>`, `transcript <id>` (built from `scriptPath`, e.g. `node "<script>" result <id>`). When the budget is tight, drop sections from the bottom of the summary upwards but **always** keep line 1 and the pointers; end truncated text with `…[brief truncated; see result <id>]`.
- **`renderBriefWait(results, {scriptPath, maxChars})`** for `wait --format brief` and group waits: one line per job plus the pointers for failed ones.
- Pure, no I/O.

## Implementation guide

undefined

## Fake-Codex fixture

The fixture API from lane `m0-fixture` (plan D2), in short: `installFakeCodex(binDir, behavior, options)`; `setFakeCodexOptions(binDir, patch)`; `options.turnScript` steps (`command`, `fileChange` with `writeFiles`, `agentMessage`, `reasoning`, `plan`, `diff`, `usage`, `delay`, `silence`, `serverRequest`); `options.interrupt: "cooperate"|"ignore"|"ack-only"`; `options.ignoreSigterm`; `options.delays.{initialize,threadStart,turnStart}`; `options.models`, `options.config`, `options.writeRollout`, `options.forceActiveWriter`, `options.turnStatus`; methods `model/list`, `config/read`, `thread/read`; `readFakeRpcLog(binDir, {method, conn, dir})`, `fakeConnections(binDir)`; `occupyBroker(endpoint, {holdMs})`; `startFakeAppServer(binDir)`; helpers `spawnStubborn()`, `waitFor()`, `isPidAlive()`, `makeCompanionWorkspace()`. M0/M1 lanes extended it further, so **read the fixture source for the exact signatures** before writing tests. Note: the fixture answers `thread/unload`, but the real codex-cli 0.157 app-server does **not** have it (probe §6), so plugin code must never call it.

**You do not own the fixture files in this wave** (lane `m5-job-api` does). Do not edit `tests/fake-codex-fixture.mjs` or `tests/helpers.mjs`. If you need something the fixture lacks, write a small local helper inside your own test file, or record the gap as a follow-up.

## Tests to write first

`tests/brief-lib.test.mjs`:
1. A 20KB final message → output ≤ 6000 characters and includes the pointers and line 1.
2. A result with 40 files lists 15 and `… +25 more`.
3. Structured summary preferred over raw output.
4. `maxChars: 500` still keeps line 1 and the pointers.
5. `renderBriefWait` for 3 jobs (one failed) lists all three and the failed job's pointers.

## Requirements from the report (verbatim)

The text below is copied verbatim from `docs/IMPROVEMENT-REPORT.md`. Line numbers in it predate M0/M1. The "Probe adjustments" and "Design decisions" sections of this brief override it where they differ.

### FR-23: Cut the Claude-side token cost of dispatch and results
- **Priority:** P2
- **Problem:** One dispatch cost about 13k tokens and 2.5 minutes. The cost comes from the command body, the resume probe plus AskUserQuestion, and a Haiku subagent that preloads two skills. Results come back verbatim with no size bound, and the rescue and result contracts forbid summarizing.
- **Evidence:** E2. `agents/codex-rescue.md` 6-9. `commands/rescue.md` 22-44. `commands/result.md` 10-15. `skills/codex-result-handling/SKILL.md` 10-19.
- **Proposal:**
  - Use the direct path (BUG-4).
  - Add `--format brief|full|json` to task, attach, result and wait. `brief` prints status, a 1-5 line summary (the report summary or the first lines of the final message), files with stats, failed commands, and pointers to `result`, `diff`, `logs` and `transcript`, capped by `--max-chars` (default 6000).
  - Load the prompting skill on demand.
  - Relax the "verbatim, no summarizing" rule when the format is brief.
  - Relax `codex-result-handling`'s "must ask before acting on findings" rule when the user delegated autonomously. Keep it configurable.
- **Acceptance criteria:** Brief output for a fixture with a 20KB final message is at most 6000 characters and includes the pointers. A manual measurement of dispatch plus brief result is 3k Claude tokens or fewer, recorded in the PR.

## Probe adjustments and scope narrowing (binding; they override the verbatim text above)

- Not protocol-dependent.

## Acceptance checklist (report PASS/FAIL per line)

- [ ] Brief output for a fixture with a 20KB final message is at most 6000 characters and includes the pointers (library level)
- [ ] Line 1 and the pointers survive any `maxChars`
- [ ] Wait/group brief rendering exists
- [ ] `npm test` green in your worktree; no existing test edited except where this brief allows it

## Required final report (your last message; use exactly these sections)

```
## Lane m5-brief-lib report
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
