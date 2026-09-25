# Lane `m5-job-api`: Extract a callable job API from the companion, and `--progress-stderr` (FR-11, FR-19)

- **Beads:** `codex-plugin-cc-qo4.1`, `codex-plugin-cc-qo4.2`
- **Report items:** FR-11, FR-19. **Scope in this lane:** preparation for FR-11 (a library entry point the MCP server can call instead of shelling out) and FR-19 item 4 (`--progress-stderr`). No user-visible behaviour change other than the new flag.
- **Milestone / wave:** M5, wave 1. **Depends on:** all of M4 merged. **Runs concurrently with:** `m5-fanout-lib`, `m5-brief-lib`, `m5-mcp-protocol`.

## Goal

The MCP server (FR-11) must "reuse the job machinery so every MCP job is a normal tracked job", but that machinery lives inside `codex-companion.mjs` handlers that parse argv, print and call `process.exit`. Extract it into `lib/job-api.mjs`: plain async functions that take options objects, return payload objects, honour an `AbortSignal`, and never print or exit. The companion's handlers become thin argv → API → render wrappers. The full existing test suite must pass **unchanged**.

## Ground rules (non-negotiable)

- **Worktree:** you work in your **own git worktree**, created by the orchestrator from branch `orvex/improvement-report` after the previous wave was merged (normally `/home/crew/workspace/codex-plugin-cc-lanes/m5-job-api` on branch `lane/m5-job-api`; use the path you were given). Paths below are relative to your worktree root, and `plugins/codex/scripts/` holds the runtime. The other lanes of your wave run at the same time in their own worktrees, and the orchestrator merges every lane of the wave afterwards. **File ownership is what keeps those merges conflict-free**, so respect it exactly.
- **Beads:** run `bd` from the main checkout: `cd /home/crew/workspace/codex-plugin-cc && bd update <id> --claim` for each bead listed above. If a bead is already claimed (another lane of the same item claimed it), skip the claim and still add your note. At the end, run `bd note <id> "<one paragraph: lane m5-job-api; what changed, tests added, npm test result, open risks>"` for each bead. **Never** run `bd close`: the orchestrator closes beads after review.
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
- `plugins/codex/scripts/lib/job-api.mjs` (new)
- `tests/fake-codex-fixture.mjs`
- `tests/helpers.mjs`
- `tests/job-api.test.mjs` (new)

## Do not touch

- Lane `m5-fanout-lib` runs at the same time and owns: `plugins/codex/scripts/lib/fanout.mjs`, `tests/fanout-lib.test.mjs`.
- Lane `m5-brief-lib` runs at the same time and owns: `plugins/codex/scripts/lib/brief-format.mjs`, `tests/brief-lib.test.mjs`.
- Lane `m5-mcp-protocol` runs at the same time and owns: `plugins/codex/scripts/lib/mcp-protocol.mjs`, `tests/mcp-protocol.test.mjs`.
- Any existing test file not listed under "Files you own" (add your tests in your own new test files).

## Design decisions binding on this lane

- **`lib/job-api.mjs` exports (binding contract for `m5-mcp` and `m5-fanout-brief`):**
  - `launchTask(options, {mode: "attach"|"background"|"foreground"|"owned-by-pid", ownerPid, signal, onEvent})` → `{jobId, threadId, status, launch}`; with `mode:"attach"`/`"foreground"` it resolves when the job is terminal and returns `{…, result, exitCode}`; `signal` abort → verified cancel of the job (the same path as the attach SIGTERM handler) and resolves with the cancelled job. `options` is the already-parsed task request (prompt, runtime, model, effort, profile, resume/thread/fork target, outputSchema, lane options, worktree placeholder, name, cwd).
  - `resolveJob(cwd, ref, {allSessions})`, `getStatus(cwd, {jobRef, allSessions, lines, full})`, `waitForJobs(cwd, refs, {any, timeoutMs, pollIntervalMs, signal})` → `{results:[{jobId, status, exitCode, report}], timedOut}`, `getResult(cwd, ref, {partial, reportOnly})`, `getEvents(cwd, ref, {since, types, limit})`, `getTranscript(cwd, ref, opts)`, `getDiff(cwd, ref, {stat})`.
  - `sendMessage(cwd, ref, text, {interrupt, waitDelivery, timeoutMs, noFollowUp, runtime, signal})` → the delivery payload (`delivered|queued|finished-undelivered|lost|followed-up|voided`).
  - `interruptJob(cwd, ref, {thenText})`, `cancelJob(cwd, ref, {graceMs, force, reason})` (the verified cancel), `forkJob(cwd, ref, options, launchOpts)`, `listModels(cwd, {refresh, all})`.
  - Errors are thrown as `Error` objects with `exitCode` and `code` (e.g. `unknown-model`, `thread-not-found`, `job-not-found`), never printed.
- **Companion:** each `handleX` parses argv, calls the API, renders (existing render functions), prints, and sets the exit code exactly as before. Signal handlers for foreground/attach stay in the companion (they call `cancelJob`). Keep every existing function that tests import (search `tests/` for imports from `codex-companion.mjs`; if any exist, keep those exports).
- **`--progress-stderr`** on `task`, `send`, `attach`, `wait`, `fork`: with `--json`, print compact event lines (`formatCompactEvent`) to stderr while stdout stays pure JSON. Without `--json` it is a no-op (progress already goes to stderr).
- **No behaviour change otherwise:** text output, JSON shapes and exit codes of every command must be identical; the existing tests are the regression suite. Do not "fix" anything in passing; list odd behaviour as a follow-up.

## Implementation guide

- Work incrementally: extract one handler at a time and run `npm test` after each. `handleTask`/`executeTaskRun`/attach watcher, `handleCancel`, `handleSend`/`deliverToRunningJob`, `handleWait`, `handleStatus`, `handleResult`, `handleEvents`, `handleTranscript`, `handleDiff`, `handleInterrupt`, the `fork` handler, `handleModels`.
- Put an `AbortSignal` check into every poll loop the API runs (wait, attach follow, send `--wait-delivery`).

## Fake-Codex fixture

The fixture API from lane `m0-fixture` (plan D2), in short: `installFakeCodex(binDir, behavior, options)`; `setFakeCodexOptions(binDir, patch)`; `options.turnScript` steps (`command`, `fileChange` with `writeFiles`, `agentMessage`, `reasoning`, `plan`, `diff`, `usage`, `delay`, `silence`, `serverRequest`); `options.interrupt: "cooperate"|"ignore"|"ack-only"`; `options.ignoreSigterm`; `options.delays.{initialize,threadStart,turnStart}`; `options.models`, `options.config`, `options.writeRollout`, `options.forceActiveWriter`, `options.turnStatus`; methods `model/list`, `config/read`, `thread/read`; `readFakeRpcLog(binDir, {method, conn, dir})`, `fakeConnections(binDir)`; `occupyBroker(endpoint, {holdMs})`; `startFakeAppServer(binDir)`; helpers `spawnStubborn()`, `waitFor()`, `isPidAlive()`, `makeCompanionWorkspace()`. M0/M1 lanes extended it further, so **read the fixture source for the exact signatures** before writing tests. Note: the fixture answers `thread/unload`, but the real codex-cli 0.157 app-server does **not** have it (probe §6), so plugin code must never call it.

**You own the fixture files in this wave.** If you need a capability that is missing, add it **additively** (new options, new turnScript step types, new helpers) and keep every existing behaviour string and option working. Where the fixture's shapes differ from `docs/app-server-probe.md` ("Fixture shapes"), make the fixture match the probe for the methods you touch.

No new fixture capability is expected; you own the files in case a helper is needed to drive `lib/job-api.mjs` in-process.

## Tests to write first

`tests/job-api.test.mjs` (in-process calls against the fake fixture):
1. `launchTask(..., {mode:"attach"})` resolves with a completed job, `exitCode 0`, and the report.
2. Aborting the `signal` of an attach launch mid-turn → verified cancel: job `cancelled`, the fake received `turn/interrupt`, no live worker.
3. `waitForJobs` with a timeout returns `timedOut:true` without throwing; with an aborted signal it returns promptly.
4. `sendMessage` to a running job returns `delivered`; to a finished job `followed-up` with a job id.
5. An unknown model throws with `exitCode 2`, `code:"unknown-model"`, and no job record.
6. The API never writes to stdout (capture `process.stdout.write` during the calls).
7. `task --json --progress-stderr` prints compact event lines on stderr and a single JSON document on stdout.

## Requirements from the report (verbatim)

The text below is copied verbatim from `docs/IMPROVEMENT-REPORT.md`. Line numbers in it predate M0/M1. The "Probe adjustments" and "Design decisions" sections of this brief override it where they differ.

### FR-11: A thin MCP server: `codex`, `codex_reply`, `codex_steer`, `codex_status`, `codex_transcript`, `codex_cancel`, `codex_models` (and more)
- **Priority:** P1
- **Problem:** Consuming repos (e.g. the houston CLAUDE.md) instruct Claude to use `mcp__codex__codex` and `codex-reply` with a threadId, but the plugin ships no MCP server: there is no `.mcp.json`, and `plugin.json` has no `mcpServers`. MCP tools would give schema-validated inputs and outputs, native permissions, cancellation, and direct use from Workflow agents.
- **Evidence:** E7, E12. `lib/cli-shim.mjs` (the `orvex-codex` shim). `lib/codex.mjs` `runAppServerTurn`, `interruptAppServerTurn` and `startInboxSteering`.
- **Proposal:** Add `scripts/mcp-server.mjs`, a stdio MCP server built on the same library functions. Do not shell out; reuse the job machinery so every MCP job is a normal tracked job. Expose it in two ways:
  - `plugins/codex/.mcp.json`, which is plugin-scoped, so tools are namespaced `mcp__plugin_codex_codex__*`.
  - An `orvex-codex mcp` subcommand, so that `claude mcp add -s user codex -- orvex-codex mcp` yields exactly `mcp__codex__codex` and `mcp__codex__codex-reply`, matching downstream docs. Register `codex-reply` (hyphenated) only: Claude tool names allow `[A-Za-z0-9_-]`, and a duplicate `codex_reply` would just cost context. Other tools use `codex_<verb>`.

  Do not rely on the upstream Codex CLI for this. The downstream `mcp__codex__codex`/`codex-reply` naming comes from an older upstream `codex mcp-server`, and codex-cli 0.157.0 has no `mcp-server` subcommand (`codex --help` lists `mcp` only for managing *external* servers). The plugin must provide the server itself.

  Long waits emit MCP progress notifications from events. **An MCP request cancellation cancels the job** (owner-lease path). The tool list and shapes are in §8.3.
- **Acceptance criteria:** `claude mcp add codex -- orvex-codex mcp` lists all tools. An MCP client test against the fake fixture checks four things. (1) `codex{wait:true, outputSchema}` returns `structuredContent` matching the schema. (2) `codex-reply{threadId}` calls `thread/resume` with that id. (3) `codex_steer` delivers mid-turn. (4) Cancelling a waiting `codex` call leads to a verified cancel of the job.

### FR-19: First-class Workflow integration (a schema-returning `codex-exec` lane)
- **Priority:** P2
- **Problem:** Workflow scripts reach Codex through `agent({agentType:'codex:codex-rescue'})`, a double hop that returns free text, may complete early, and has no schema. Today a general agent can run `orvex-codex task --json` in the foreground, but the result is not validated against a schema and is not cancel-safe (BUG-1).
- **Evidence:** E12, E2. `agents/codex-rescue.md`. `codex-companion.mjs` `runForegroundCommand` ~898-909 (`--json` suppresses stderr progress).
- **Proposal:**
  1. Add a skill `codex:workflow` with an example workflow.
  2. Add an agent `codex:codex-exec` (Haiku, tools restricted to `Bash(orvex-codex:*)` or the codex MCP tools) whose only instruction is to run `orvex-codex task --attach --output-schema <caller schema> --json` (or call `codex{wait:true, outputSchema}`) and return `data` as structured output.
  3. Where the Workflow runtime can call MCP tools directly, document calling `codex()` directly.
  4. Add `--progress-stderr` so that `--json` keeps compact event lines on stderr.
  5. Cancellation propagates through the owner lease, the MCP cancel, and the broker's interrupt on disconnect.
- **Acceptance criteria:** An example workflow in `tests/fixtures` runs 3 codex-exec lanes with a JSON schema and receives schema-valid objects. Stopping the workflow mid-run leaves no active turns at the fake. The Claude-side median is 3k tokens or fewer per lane.

## Probe adjustments and scope narrowing (binding; they override the verbatim text above)

- Not protocol-dependent.

## Acceptance checklist (report PASS/FAIL per line)

- [ ] `lib/job-api.mjs` exposes the binding functions; they return payloads, throw coded errors, honour `AbortSignal`, and never print or exit
- [ ] Every existing test passes unchanged (behaviour-preserving extraction)
- [ ] FR-19 item 4: `--progress-stderr` keeps compact event lines on stderr with `--json`
- [ ] Aborting an attach-mode launch performs the verified cancel (the path MCP cancellation will use)
- [ ] `npm test` green in your worktree; no existing test edited except where this brief allows it

## Required final report (your last message; use exactly these sections)

```
## Lane m5-job-api report
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
