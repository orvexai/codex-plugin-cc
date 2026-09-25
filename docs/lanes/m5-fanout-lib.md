# Lane `m5-fanout-lib`: Fan-out spec parsing, slot scheduling and group aggregation library (FR-18)

- **Beads:** `codex-plugin-cc-qo4.4`
- **Report items:** FR-18. **Scope in this lane:** the **scheduler half** of FR-18: `lib/fanout.mjs` with injected launch/status functions, unit-tested. CLI and wiring are lane `m5-fanout-brief`.
- **Milestone / wave:** M5, wave 1. **Depends on:** all of M4 merged. **Runs concurrently with:** `m5-job-api`, `m5-brief-lib`, `m5-mcp-protocol`.

## Goal

Fan-out today means N separate background tasks with no cap, no group and no aggregated results. Build the pure scheduling core: validate a spec file, create a group, launch at most `maxParallel` jobs at a time (queued jobs wait for a slot), cancel a whole group, and aggregate per-lane results.

## Ground rules (non-negotiable)

- **Worktree:** you work in your **own git worktree**, created by the orchestrator from branch `orvex/improvement-report` after the previous wave was merged (normally `/home/crew/workspace/codex-plugin-cc-lanes/m5-fanout-lib` on branch `lane/m5-fanout-lib`; use the path you were given). Paths below are relative to your worktree root, and `plugins/codex/scripts/` holds the runtime. The other lanes of your wave run at the same time in their own worktrees, and the orchestrator merges every lane of the wave afterwards. **File ownership is what keeps those merges conflict-free**, so respect it exactly.
- **Beads:** run `bd` from the main checkout: `cd /home/crew/workspace/codex-plugin-cc && bd update <id> --claim` for each bead listed above. If a bead is already claimed (another lane of the same item claimed it), skip the claim and still add your note. At the end, run `bd note <id> "<one paragraph: lane m5-fanout-lib; what changed, tests added, npm test result, open risks>"` for each bead. **Never** run `bd close`: the orchestrator closes beads after review.
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

- `plugins/codex/scripts/lib/fanout.mjs` (new)
- `tests/fanout-lib.test.mjs` (new)

## Do not touch

- Lane `m5-job-api` runs at the same time and owns: `plugins/codex/scripts/codex-companion.mjs`, `plugins/codex/scripts/lib/job-api.mjs`, `tests/fake-codex-fixture.mjs`, `tests/helpers.mjs`, `tests/job-api.test.mjs`.
- Lane `m5-brief-lib` runs at the same time and owns: `plugins/codex/scripts/lib/brief-format.mjs`, `tests/brief-lib.test.mjs`.
- Lane `m5-mcp-protocol` runs at the same time and owns: `plugins/codex/scripts/lib/mcp-protocol.mjs`, `tests/mcp-protocol.test.mjs`.
- Any existing test file not listed under "Files you own" (add your tests in your own new test files).

## Design decisions binding on this lane

- **`parseFanoutSpec(input, {cwd})`**: `input` is JSONL text or an array. Each entry `{name, prompt | promptFile, model?, effort?, sandbox?, cwd?, outputSchema?, profile?}`; `name` is required, unique, `[A-Za-z0-9._-]{1,64}`; exactly one of `prompt`/`promptFile` (read relative to `cwd`); unknown keys → error. Errors carry `exitCode 2` and the line number.
- **`createGroupId()`** → `grp-<base36 time>-<random>`.
- **`runFanout({specs, groupId, maxParallel = 4, launch, poll, cancel, pollMs = 500, signal, onUpdate})`**: `launch(spec, {groupId, index})` → `jobId` (the caller creates the job; in the wiring, every job record exists as `queued` with its `groupId` from the start, so `wait --group` sees all of them), `poll(jobIds)` → `{jobId: status}`, `cancel(jobId)`. Never more than `maxParallel` jobs are non-terminal-and-launched at once; the next spec launches when a slot frees. On `signal` abort: stop launching, cancel every launched non-terminal job (in parallel), mark unlaunched specs `cancelled` without launching them, and resolve. Resolves with `[{name, jobId, status}]` in spec order.
- **`aggregateGroupResults(jobs, {getResult})`** → `[{name, jobId, status, exitCode, report, structured}]` in spec order, `exitCode` from `exitCodeForJob(status, {mode:"wait"})`; plus `summarizeGroup(results)` → `{total, completed, failed, cancelled, other, exitCode}` (0 only when all completed).
- **Slot accounting across processes (for the wiring):** `countActiveGroupJobs(jobs, groupId)` helper; the wiring lane decides whether a detached fanout worker or the attached process owns scheduling (see `m5-fanout-brief`).

## Implementation guide

- Pure module: inject every side effect. Use fake launchers with controllable completion in tests.

## Fake-Codex fixture

The fixture API from lane `m0-fixture` (plan D2), in short: `installFakeCodex(binDir, behavior, options)`; `setFakeCodexOptions(binDir, patch)`; `options.turnScript` steps (`command`, `fileChange` with `writeFiles`, `agentMessage`, `reasoning`, `plan`, `diff`, `usage`, `delay`, `silence`, `serverRequest`); `options.interrupt: "cooperate"|"ignore"|"ack-only"`; `options.ignoreSigterm`; `options.delays.{initialize,threadStart,turnStart}`; `options.models`, `options.config`, `options.writeRollout`, `options.forceActiveWriter`, `options.turnStatus`; methods `model/list`, `config/read`, `thread/read`; `readFakeRpcLog(binDir, {method, conn, dir})`, `fakeConnections(binDir)`; `occupyBroker(endpoint, {holdMs})`; `startFakeAppServer(binDir)`; helpers `spawnStubborn()`, `waitFor()`, `isPidAlive()`, `makeCompanionWorkspace()`. M0/M1 lanes extended it further, so **read the fixture source for the exact signatures** before writing tests. Note: the fixture answers `thread/unload`, but the real codex-cli 0.157 app-server does **not** have it (probe §6), so plugin code must never call it.

**You do not own the fixture files in this wave** (lane `m5-job-api` does). Do not edit `tests/fake-codex-fixture.mjs` or `tests/helpers.mjs`. If you need something the fixture lacks, write a small local helper inside your own test file, or record the gap as a follow-up.

## Tests to write first

`tests/fanout-lib.test.mjs`:
1. Spec parsing: valid JSONL; duplicate names, both prompt and promptFile, missing name, bad JSON line → exitCode 2 with line numbers; `promptFile` resolution.
2. With 6 specs and `maxParallel: 2`, a sampler inside `poll` never sees more than 2 launched-and-active jobs; all 6 finish.
3. Abort mid-run: launched jobs get `cancel`, unlaunched specs are never launched and end `cancelled`.
4. `aggregateGroupResults` ordering and exit codes; `summarizeGroup` exit code.

## Requirements from the report (verbatim)

The text below is copied verbatim from `docs/IMPROVEMENT-REPORT.md`. Line numbers in it predate M0/M1. The "Probe adjustments" and "Design decisions" sections of this brief override it where they differ.

### FR-18: A parallel fan-out primitive with a concurrency cap and aggregated results
- **Priority:** P2
- **Problem:** Workflow/Ultracode fans out subagents and collects typed results. With Codex, fan-out means N separate `task --background` calls with no cap, no group, and `wait` returning only statuses. All jobs also share one broker, which serves one stream at a time and pushes the rest to direct app-servers.
- **Evidence:** E12. `codex-companion.mjs` ~911-950 and ~1205-1272. `README.md` 222-230. `lib/codex.mjs` 762-791.
- **Proposal:** Add `fanout --spec <file.jsonl|-> [--max-parallel 4] [--group <name>] [--worktree] [--output-schema …] [--attach]`. Each spec line is `{name, prompt|promptFile, model?, effort?, sandbox?, cwd?, outputSchema?}`. Jobs share a `groupId` and are scheduled under the state lock: queued jobs are not launched until a slot is free. Add `wait --group <g> --json`, which returns `[{name, jobId, status, report, exitCode}]`, and `cancel --group <g>`. Attach mode cancels the whole group on SIGTERM. Mirror it as the MCP tool `codex_fanout`. Given the broker's one-stream design, decide whether fan-out jobs should use direct app-servers intentionally (recommended) and record `transport`.
- **Acceptance criteria:** With 6 specs and `--max-parallel 2`, sampling never shows more than 2 running jobs. `wait --group --json` returns 6 entries with reports. Cancelling the group leaves 0 live workers and 0 active turns at the fake. SIGTERM in attach mode cancels the group.

## Probe adjustments and scope narrowing (binding; they override the verbatim text above)

- Not protocol-dependent.

## Acceptance checklist (report PASS/FAIL per line)

- [ ] With 6 specs and `maxParallel 2`, the scheduler never has more than 2 running jobs (library level)
- [ ] Group cancellation cancels launched jobs and never launches the rest
- [ ] Aggregated results come back as `[{name, jobId, status, report, exitCode}]` in spec order
- [ ] Spec validation errors are precise (exit code 2, line number)
- [ ] `npm test` green in your worktree; no existing test edited except where this brief allows it

## Required final report (your last message; use exactly these sections)

```
## Lane m5-fanout-lib report
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
