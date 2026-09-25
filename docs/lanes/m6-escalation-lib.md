# Lane `m6-escalation-lib`: Escalation ladder library (WISH-4)

- **Beads:** `codex-plugin-cc-22z.8`
- **Report items:** WISH-4. **Scope in this lane:** the **library half** of WISH-4: `lib/escalation.mjs`. Wiring into `result`, `status` and `send` is lane `m6-rails` (wave 4).
- **Milestone / wave:** M6, wave 1. **Depends on:** all of M5 merged. **Runs concurrently with:** `m6-worktree-lib`, `m6-broker-lib`, `m6-ci`, `m6-history-lib`, `m6-prompting`.

## Goal

The repo policy is to escalate a model after two failures, but nothing counts failures or suggests the next rung. Build the pure logic: count failures along a job's lineage, validate a ladder against the catalog, and compute the next rung and a suggestion object.

## Ground rules (non-negotiable)

- **Worktree:** you work in your **own git worktree**, created by the orchestrator from branch `orvex/improvement-report` after the previous wave was merged (normally `/home/crew/workspace/codex-plugin-cc-lanes/m6-escalation-lib` on branch `lane/m6-escalation-lib`; use the path you were given). Paths below are relative to your worktree root, and `plugins/codex/scripts/` holds the runtime. The other lanes of your wave run at the same time in their own worktrees, and the orchestrator merges every lane of the wave afterwards. **File ownership is what keeps those merges conflict-free**, so respect it exactly.
- **Beads:** run `bd` from the main checkout: `cd /home/crew/workspace/codex-plugin-cc && bd update <id> --claim` for each bead listed above. If a bead is already claimed (another lane of the same item claimed it), skip the claim and still add your note. At the end, run `bd note <id> "<one paragraph: lane m6-escalation-lib; what changed, tests added, npm test result, open risks>"` for each bead. **Never** run `bd close`: the orchestrator closes beads after review.
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

- `plugins/codex/scripts/lib/escalation.mjs` (new)
- `tests/escalation-lib.test.mjs` (new)

## Do not touch

- Lane `m6-worktree-lib` runs at the same time and owns: `plugins/codex/scripts/lib/worktree.mjs`, `plugins/codex/scripts/lib/tree-lease.mjs`, `tests/worktree-lib.test.mjs`.
- Lane `m6-broker-lib` runs at the same time and owns: `plugins/codex/scripts/app-server-broker.mjs`, `plugins/codex/scripts/lib/broker-lifecycle.mjs`, `plugins/codex/scripts/lib/app-server.mjs`, `plugins/codex/scripts/lib/codex.mjs`, `plugins/codex/scripts/lib/tracked-jobs.mjs`, `tests/fake-codex-fixture.mjs`, `tests/helpers.mjs`, `tests/broker-lib.test.mjs`, `tests/error-surfacing.test.mjs`.
- Lane `m6-ci` runs at the same time and owns: `.github/workflows/pull-request-ci.yml`, `.github/workflows/nightly.yml`, `scripts/check-doc-consistency.mjs`, `tests/doc-consistency.test.mjs`, `tests/contract.test.mjs`, `tests/fixtures/doc-consistency-allowlist.json`.
- Lane `m6-history-lib` runs at the same time and owns: `plugins/codex/scripts/lib/archive.mjs`, `plugins/codex/scripts/lib/state.mjs`, `tests/archive.test.mjs`.
- Lane `m6-prompting` runs at the same time and owns: `plugins/codex/skills/gpt-5-4-prompting/`, `plugins/codex/skills/codex-prompting/`, `plugins/codex/agents/codex-rescue.md`, `plugins/codex/agents/codex-exec.md`, `plugins/codex/commands/rescue.md`, `tests/commands.test.mjs`.
- Any existing test file not listed under "Files you own" (add your tests in your own new test files).

## Design decisions binding on this lane

- **Lineage:** follow the fields the merged code actually records for follow-ups, resumes and forks (read `handleSend`'s follow-up job creation and M3's `resumedFromJobId`/`forkedFromJobId`; report the field names you used). `countLineageFailures(jobs, jobId)` → `{failures, lineage:[ids]}` counting `failed`, `timed-out` and `cancel-failed` (not user cancels) along the chain, most recent first, stopping at the first completed job (a success resets the count).
- **Config shape:** `escalation: {ladder: [modelIdOrAlias], effortLadder: [effort], afterFailures: 2, mode: "suggest"|"auto"}`. `validateEscalationConfig(config, {catalog, resolveModel})` → `{ok, errors}` (every ladder model resolves; every effort supported by the paired rung's model when the catalog is known).
- **`nextRung(config, currentRuntime)`** → `{model, effort}` or null: the next ladder entry after the current model (or the first one if the current model is not in the ladder); effort from `effortLadder` at the same index when present.
- **`buildEscalationSuggestion({config, job, jobs, scriptPath})`** → null or `{failures, afterFailures, mode, from:{model, effort}, to:{model, effort}, command: "node … send <id> --model <m> --effort <e> '<msg>'"}` when `failures >= afterFailures`.

## Implementation guide

undefined

## Fake-Codex fixture

The fixture API from lane `m0-fixture` (plan D2), in short: `installFakeCodex(binDir, behavior, options)`; `setFakeCodexOptions(binDir, patch)`; `options.turnScript` steps (`command`, `fileChange` with `writeFiles`, `agentMessage`, `reasoning`, `plan`, `diff`, `usage`, `delay`, `silence`, `serverRequest`); `options.interrupt: "cooperate"|"ignore"|"ack-only"`; `options.ignoreSigterm`; `options.delays.{initialize,threadStart,turnStart}`; `options.models`, `options.config`, `options.writeRollout`, `options.forceActiveWriter`, `options.turnStatus`; methods `model/list`, `config/read`, `thread/read`; `readFakeRpcLog(binDir, {method, conn, dir})`, `fakeConnections(binDir)`; `occupyBroker(endpoint, {holdMs})`; `startFakeAppServer(binDir)`; helpers `spawnStubborn()`, `waitFor()`, `isPidAlive()`, `makeCompanionWorkspace()`. M0/M1 lanes extended it further, so **read the fixture source for the exact signatures** before writing tests. Note: the fixture answers `thread/unload`, but the real codex-cli 0.157 app-server does **not** have it (probe §6), so plugin code must never call it.

**You do not own the fixture files in this wave** (lane `m6-broker-lib` does). Do not edit `tests/fake-codex-fixture.mjs` or `tests/helpers.mjs`. If you need something the fixture lacks, write a small local helper inside your own test file, or record the gap as a follow-up.

## Tests to write first

`tests/escalation-lib.test.mjs`: lineage counting across follow-ups (and reset on success); ladder validation with a catalog; `nextRung` at each position and at the top (null); the suggestion appears after 2 failures and not after 1.

## Requirements from the report (verbatim)

The text below is copied verbatim from `docs/IMPROVEMENT-REPORT.md`. Line numbers in it predate M0/M1. The "Probe adjustments" and "Design decisions" sections of this brief override it where they differ.

### WISH-4: Escalation ladder (the Luna → Terra rule)
- **Priority:** P3
- **Problem:** The repo policy is to escalate after two failures. You can already escalate by hand without losing context, with `send <job> --model X --effort Y`. There is no failure counting or suggestion.
- **Evidence:** E5. `codex-companion.mjs` `handleSend` ~1119-1190 and `RUNTIME_VALUE_OPTIONS` ~1002.
- **Proposal:** Add config `escalation {ladder[], effortLadder[], afterFailures, mode: suggest|auto}`, validated against `model/list`, with failures counted per `parentJobId` lineage. In `suggest` mode, result and status append `nextStep.escalation`. In `auto` mode, the next send switches to the next rung and records `runtime.escalatedFrom`.
- **Acceptance criteria:** After 2 failed jobs in a lineage, `result --json` includes `nextStep.escalation`. In auto mode the next `send` uses the next rung, and status shows `escalated from`.

## Probe adjustments and scope narrowing (binding; they override the verbatim text above)

- Model ids come from `model/list` (probe §1); ladders may use aliases resolved through FR-12's `resolveModel`.

## Acceptance checklist (report PASS/FAIL per line)

- [ ] After 2 failed jobs in a lineage, a suggestion (`nextStep.escalation` payload) is produced (library level)
- [ ] The ladder is validated against the catalog
- [ ] `nextRung` walks the ladder and effort ladder
- [ ] `npm test` green in your worktree; no existing test edited except where this brief allows it

## Required final report (your last message; use exactly these sections)

```
## Lane m6-escalation-lib report
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
