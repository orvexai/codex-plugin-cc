# Lane `m5-fanout-brief`: `fanout`, group wait/cancel, `--format brief`, and the `mcp` subcommand (FR-18, FR-23)

- **Beads:** `codex-plugin-cc-qo4.4`, `codex-plugin-cc-qo4.3`
- **Report items:** FR-18, FR-23. **Scope in this lane:** the **wiring halves** of FR-18 (CLI, group records, detached scheduler, direct transport) and FR-23 (`--format brief|full|json`, `--max-chars`), plus the `mcp` subcommand entry point for FR-11. The MCP `codex_fanout` tool and the FR-23 doc relaxations are lane `m5-docs`.
- **Milestone / wave:** M5, wave 2. **Depends on:** wave 1 merged. **Runs concurrently with:** `m5-mcp`, `m5-workflow`.

## Goal

Give Claude a Workflow-style fan-out for Codex: one command launches N lanes under a concurrency cap as a group, `wait --group` returns every lane's report, and cancelling the group (or SIGTERM in attach mode) stops them all. Make results cheap to read with a bounded `brief` format. Expose the MCP server as `orvex-codex mcp`.

## Ground rules (non-negotiable)

- **Worktree:** you work in your **own git worktree**, created by the orchestrator from branch `orvex/improvement-report` after the previous wave was merged (normally `/home/crew/workspace/codex-plugin-cc-lanes/m5-fanout-brief` on branch `lane/m5-fanout-brief`; use the path you were given). Paths below are relative to your worktree root, and `plugins/codex/scripts/` holds the runtime. The other lanes of your wave run at the same time in their own worktrees, and the orchestrator merges every lane of the wave afterwards. **File ownership is what keeps those merges conflict-free**, so respect it exactly.
- **Beads:** run `bd` from the main checkout: `cd /home/crew/workspace/codex-plugin-cc && bd update <id> --claim` for each bead listed above. If a bead is already claimed (another lane of the same item claimed it), skip the claim and still add your note. At the end, run `bd note <id> "<one paragraph: lane m5-fanout-brief; what changed, tests added, npm test result, open risks>"` for each bead. **Never** run `bd close`: the orchestrator closes beads after review.
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
- `plugins/codex/scripts/lib/fanout.mjs`
- `plugins/codex/scripts/lib/brief-format.mjs`
- `plugins/codex/scripts/lib/codex.mjs`
- `plugins/codex/scripts/lib/tracked-jobs.mjs`
- `plugins/codex/scripts/lib/render.mjs`
- `tests/fake-codex-fixture.mjs`
- `tests/helpers.mjs`
- `tests/fanout.test.mjs` (new)
- `tests/brief.test.mjs` (new)

## Do not touch

- Lane `m5-mcp` runs at the same time and owns: `plugins/codex/scripts/mcp-server.mjs`, `plugins/codex/scripts/lib/mcp-tools.mjs`, `plugins/codex/scripts/lib/mcp-protocol.mjs`, `plugins/codex/.mcp.json`, `tests/mcp.test.mjs`.
- Lane `m5-workflow` runs at the same time and owns: `plugins/codex/agents/codex-exec.md`, `plugins/codex/skills/codex-workflow/SKILL.md`, `tests/fixtures/workflow/`, `tests/workflow.test.mjs`.
- Any existing test file not listed under "Files you own" (add your tests in your own new test files).

## Design decisions binding on this lane

- **`fanout --spec <file.jsonl|-> [--max-parallel 4] [--group <name>] [--worktree] [--output-schema …] [--attach] [--json]`:** parse with `parseFanoutSpec`; create **all** job records up front as `queued` with `groupId` (the `--group` name, else `createGroupId()`), `groupName`, and `fanoutIndex`, so `wait --group` sees every lane at once. Scheduling (binding): with `--attach`, the foreground process runs `runFanout` and owns every job (owner `attach`, the fanout process pid); SIGTERM/SIGINT → cancel the whole group (verified), exit 130. Without `--attach`, spawn a detached `fanout-worker <groupId>` internal subcommand (same spawning helper as task workers, stderr to `jobs/<groupId>.fanout.err`) that runs the schedule; jobs are owned by that worker (`owner.kind:"pid"`), and a `cancel --group` also stops the fanout worker. `--worktree` is accepted and passed through to each lane, but until FR-6 (M6) exists it errors with `--worktree requires FR-6 (not yet available)`; per-spec `outputSchema` and the group `--output-schema` flow to each task.
- **Transport (FR-18 decision):** fan-out jobs use **direct** app-servers intentionally (the broker serves one stream at a time). Add a `transport: "direct"` option to `withAppServer`/`runAppServerTurn` in `lib/codex.mjs` that skips the broker; record `transport:"direct"` and `transportFallbackReason:null` (it is a choice, not a fallback).
- **`wait --group <g> [--json] [--format brief]`** → `[{name, jobId, status, report, exitCode}]` via `aggregateGroupResults` (JSON) or `renderBriefWait` (brief); exit code from `summarizeGroup`. **`cancel --group <g>`** → verified cancel of every non-terminal job in the group, plus the fanout worker; report per job.
- **`--format brief|full|json`** (and `--max-chars N`, default 6000) on `task` (foreground/attach), `attach`, `result` and `wait`: `brief` uses `renderBrief`/`renderBriefWait`; `full` is today's text; `json` equals `--json`. Default stays `full` (rescue docs switch to brief in `m5-docs`).
- **`mcp` subcommand:** `case "mcp"` does `const { runMcpServer } = await import("./mcp-server.mjs"); await runMcpServer();` (dynamic import, so this lane's tests never load it; `m5-mcp` creates the file concurrently). `mcp --help` prints usage without importing. Add to `printUsage`.
- **job-api additions:** `launchFanout`, `waitGroup`, `cancelGroup` in `lib/job-api.mjs` (the MCP `codex_fanout` tool in `m5-docs` calls them).
- **Job records:** `createJobRecord` accepts `groupId`, `groupName`, `fanoutIndex`; status shows the group.

## Implementation guide

- `codex-companion.mjs`: `main` (`fanout`, `fanout-worker`, `mcp` cases), `handleWait`, `handleCancel`, `handleResult`, `handleTask`, the attach watcher, `printUsage`. `lib/codex.mjs`: `withAppServer`, `runAppServerTurn`. `lib/tracked-jobs.mjs`: `createJobRecord`, the worker spawn helper.

## Fake-Codex fixture

The fixture API from lane `m0-fixture` (plan D2), in short: `installFakeCodex(binDir, behavior, options)`; `setFakeCodexOptions(binDir, patch)`; `options.turnScript` steps (`command`, `fileChange` with `writeFiles`, `agentMessage`, `reasoning`, `plan`, `diff`, `usage`, `delay`, `silence`, `serverRequest`); `options.interrupt: "cooperate"|"ignore"|"ack-only"`; `options.ignoreSigterm`; `options.delays.{initialize,threadStart,turnStart}`; `options.models`, `options.config`, `options.writeRollout`, `options.forceActiveWriter`, `options.turnStatus`; methods `model/list`, `config/read`, `thread/read`; `readFakeRpcLog(binDir, {method, conn, dir})`, `fakeConnections(binDir)`; `occupyBroker(endpoint, {holdMs})`; `startFakeAppServer(binDir)`; helpers `spawnStubborn()`, `waitFor()`, `isPidAlive()`, `makeCompanionWorkspace()`. M0/M1 lanes extended it further, so **read the fixture source for the exact signatures** before writing tests. Note: the fixture answers `thread/unload`, but the real codex-cli 0.157 app-server does **not** have it (probe §6), so plugin code must never call it.

**You own the fixture files in this wave.** If you need a capability that is missing, add it **additively** (new options, new turnScript step types, new helpers) and keep every existing behaviour string and option working. Where the fixture's shapes differ from `docs/app-server-probe.md` ("Fixture shapes"), make the fixture match the probe for the methods you touch.

Make sure several fake app-server processes can run concurrently (each direct job has its own) and that `fakeConnections` distinguishes them; add a helper that counts live fake app-server processes if missing.

## Tests to write first

`tests/fanout.test.mjs`:
1. 6 specs, `--max-parallel 2`, each a short scripted turn: sampling the job files every 100ms never shows more than 2 `running` jobs; all 6 complete.
2. `wait --group <g> --json` returns 6 entries with reports and exit codes, in spec order.
3. `cancel --group <g>` mid-run leaves 0 live workers and 0 active turns at the fake (`thread/read` status idle, or no `turn/start` without a matching completion/interrupt in the RPC log); unlaunched lanes end `cancelled` without ever starting.
4. SIGTERM a `fanout --attach` process → the whole group is cancelled, exit 130.
5. Fan-out jobs record `transport:"direct"`.
6. `mcp --help` prints usage and exits 0.
`tests/brief.test.mjs`:
7. `task --format brief` for a fixture with a 20KB final message prints ≤ 6000 characters including the pointers; `result <id> --format brief` and `wait <id> --format brief` too; `--max-chars 800` is honoured.

## Requirements from the report (verbatim)

The text below is copied verbatim from `docs/IMPROVEMENT-REPORT.md`. Line numbers in it predate M0/M1. The "Probe adjustments" and "Design decisions" sections of this brief override it where they differ.

### FR-18: A parallel fan-out primitive with a concurrency cap and aggregated results
- **Priority:** P2
- **Problem:** Workflow/Ultracode fans out subagents and collects typed results. With Codex, fan-out means N separate `task --background` calls with no cap, no group, and `wait` returning only statuses. All jobs also share one broker, which serves one stream at a time and pushes the rest to direct app-servers.
- **Evidence:** E12. `codex-companion.mjs` ~911-950 and ~1205-1272. `README.md` 222-230. `lib/codex.mjs` 762-791.
- **Proposal:** Add `fanout --spec <file.jsonl|-> [--max-parallel 4] [--group <name>] [--worktree] [--output-schema …] [--attach]`. Each spec line is `{name, prompt|promptFile, model?, effort?, sandbox?, cwd?, outputSchema?}`. Jobs share a `groupId` and are scheduled under the state lock: queued jobs are not launched until a slot is free. Add `wait --group <g> --json`, which returns `[{name, jobId, status, report, exitCode}]`, and `cancel --group <g>`. Attach mode cancels the whole group on SIGTERM. Mirror it as the MCP tool `codex_fanout`. Given the broker's one-stream design, decide whether fan-out jobs should use direct app-servers intentionally (recommended) and record `transport`.
- **Acceptance criteria:** With 6 specs and `--max-parallel 2`, sampling never shows more than 2 running jobs. `wait --group --json` returns 6 entries with reports. Cancelling the group leaves 0 live workers and 0 active turns at the fake. SIGTERM in attach mode cancels the group.

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

- The broker serves one active stream at a time and returns `-32001` to others (report §2.1); direct transport for fan-out avoids that by design. The native daemon is not used (native surfaces, Decision).

## Acceptance checklist (report PASS/FAIL per line)

- [ ] FR-18: with 6 specs and `--max-parallel 2`, sampling never shows more than 2 running jobs
- [ ] FR-18: `wait --group --json` returns 6 entries with reports
- [ ] FR-18: cancelling the group leaves 0 live workers and 0 active turns at the fake
- [ ] FR-18: SIGTERM in attach mode cancels the group
- [ ] FR-18: fan-out jobs use direct app-servers intentionally and record `transport`
- [ ] FR-23: brief output for a fixture with a 20KB final message is at most 6000 characters and includes the pointers (task, attach, result and wait)
- [ ] The `mcp` subcommand exists (dynamic import of `scripts/mcp-server.mjs`)
- [ ] `npm test` green in your worktree; no existing test edited except where this brief allows it

## Required final report (your last message; use exactly these sections)

```
## Lane m5-fanout-brief report
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
