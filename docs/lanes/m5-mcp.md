# Lane `m5-mcp`: The Codex MCP server and its tools (FR-11)

- **Beads:** `codex-plugin-cc-qo4.1`
- **Report items:** FR-11. **Scope in this lane:** FR-11's server and tools (all §8.3 tools except `codex_fanout`, which lane `m5-docs` adds), plus the MCP mirrors of FR-21 (`codex_fork`) and FR-12 (`codex_models`). The `orvex-codex mcp` subcommand is added by `m5-fanout-brief` (it owns the companion this wave); install/registration is `m5-docs`.
- **Milestone / wave:** M5, wave 2. **Depends on:** wave 1 (`m5-job-api`, `m5-fanout-lib`, `m5-brief-lib`, `m5-mcp-protocol` merged). **Runs concurrently with:** `m5-fanout-brief`, `m5-workflow`.

## Goal

Consuming repos tell Claude to call `mcp__codex__codex` and `codex-reply`, but no such server exists. Ship a thin stdio MCP server built on `lib/job-api.mjs`, so every MCP job is a normal tracked job with ownership, verified cancellation, events and reports, and tool calls return schema-validated `structuredContent`.

## Ground rules (non-negotiable)

- **Worktree:** you work in your **own git worktree**, created by the orchestrator from branch `orvex/improvement-report` after the previous wave was merged (normally `/home/crew/workspace/codex-plugin-cc-lanes/m5-mcp` on branch `lane/m5-mcp`; use the path you were given). Paths below are relative to your worktree root, and `plugins/codex/scripts/` holds the runtime. The other lanes of your wave run at the same time in their own worktrees, and the orchestrator merges every lane of the wave afterwards. **File ownership is what keeps those merges conflict-free**, so respect it exactly.
- **Beads:** run `bd` from the main checkout: `cd /home/crew/workspace/codex-plugin-cc && bd update <id> --claim` for each bead listed above. If a bead is already claimed (another lane of the same item claimed it), skip the claim and still add your note. At the end, run `bd note <id> "<one paragraph: lane m5-mcp; what changed, tests added, npm test result, open risks>"` for each bead. **Never** run `bd close`: the orchestrator closes beads after review.
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

- `plugins/codex/scripts/mcp-server.mjs` (new)
- `plugins/codex/scripts/lib/mcp-tools.mjs` (new)
- `plugins/codex/scripts/lib/mcp-protocol.mjs`
- `plugins/codex/.mcp.json` (new)
- `tests/mcp.test.mjs` (new)

## Do not touch

- Lane `m5-fanout-brief` runs at the same time and owns: `plugins/codex/scripts/codex-companion.mjs`, `plugins/codex/scripts/lib/job-api.mjs`, `plugins/codex/scripts/lib/fanout.mjs`, `plugins/codex/scripts/lib/brief-format.mjs`, `plugins/codex/scripts/lib/codex.mjs`, `plugins/codex/scripts/lib/tracked-jobs.mjs`, `plugins/codex/scripts/lib/render.mjs`, `tests/fake-codex-fixture.mjs`, `tests/helpers.mjs`, `tests/fanout.test.mjs`, `tests/brief.test.mjs`.
- Lane `m5-workflow` runs at the same time and owns: `plugins/codex/agents/codex-exec.md`, `plugins/codex/skills/codex-workflow/SKILL.md`, `tests/fixtures/workflow/`, `tests/workflow.test.mjs`.
- `lib/job-api.mjs` belongs to `m5-fanout-brief` this wave: call it, do not edit it. If you need an API change, describe it as a follow-up and work around it in `lib/mcp-tools.mjs`.
- Any existing test file not listed under "Files you own" (add your tests in your own new test files).

## Design decisions binding on this lane

- **`scripts/mcp-server.mjs`:** exports `runMcpServer({input = process.stdin, output = process.stdout, cwd = process.cwd()})` and runs it when executed directly (`node scripts/mcp-server.mjs`). Server name `codex`, version from `plugin.json`. Logs go to stderr only.
- **`lib/mcp-tools.mjs`:** `buildCodexTools({cwd})` → the tool list for `createMcpServer`. Tools and shapes follow report §8.3 (verbatim below): `codex`, `codex-reply` (**hyphenated only**; no `codex_reply` duplicate), `codex_steer`, `codex_interrupt`, `codex_status`, `codex_wait`, `codex_result`, `codex_transcript`, `codex_events`, `codex_diff`, `codex_cancel`, `codex_models`, and `codex_fork` (FR-21: `{jobId | threadId, prompt?, wait=true, runtime overrides}` → same shape as `codex`). Each tool has an `inputSchema` and an `outputSchema` (strict enough to be useful; `additionalProperties:false` on inputs).
- **Ownership (binding):** jobs launched by `codex`/`codex-reply`/`codex_fork` are owned by the MCP server process: `wait:true` → `launchTask(..., {mode:"attach", signal})` (the call's cancellation signal aborts it, which runs the **verified cancel**); `wait:false` → `mode:"owned-by-pid"` with `ownerPid = process.pid` and `onOwnerExit:"cancel"`, so the job is cancelled if the MCP server (i.e. the Claude session) goes away; a `detach:true` param opts out (owner `detached`). Owned jobs get the FR-25 bypass default; detached ones get the unowned fallback unless a sandbox is given.
- **`codex` params:** `prompt` (required), `cwd?`, `model?`, `effort?`, `profile?`, `sandbox?`, `network?`, `worktree?` (accepted; rejected with a clear error until FR-6 lands in M6), `outputSchema?` (a JSON Schema object, validated with the M2 library; passed as the task's output schema), `developerInstructions?`, `config?` (object → `-c`-equivalent overrides), `wait=true`, `timeoutMs?`, `name?`, `detach=false`. Result per §8.3: `{jobId, threadId, status, report, structured?, rawOutput (brief, via renderBrief), pointers}`; `timeoutMs` expiry with `wait:true` → release ownership (the job keeps running, owner detached) and return `{…, status:"running", timedOut:true}`.
- **`codex-reply`:** `threadId` or `jobId` (one required), `prompt`, `wait=true`, `interrupt=false`, runtime overrides. If the job/thread's job is **running**: `interrupt:false` → steer (`sendMessage`), `interrupt:true` → `interruptJob({thenText: prompt})`. Otherwise resume that exact thread (or its latest fork, returning `forkedFrom`) as a new owned job.
- **Progress:** long waits send MCP progress notifications built from job events (`formatCompactEvent`), throttled.
- **Errors:** job-api coded errors map to `isError:true` results with `structuredContent.error {code, message}`.
- **`.mcp.json`** (plugin-scoped): `{"mcpServers": {"codex": {"command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/mcp-server.mjs"]}}}`, so tools appear as `mcp__plugin_codex_codex__*`. Confirm the variable expansion convention against `hooks/hooks.json` (which uses `${CLAUDE_PLUGIN_ROOT}`).

## Implementation guide

- Build on `createMcpServer` (`lib/mcp-protocol.mjs`, owned this wave for fixes) and `lib/job-api.mjs` (read-only). Use `renderBrief` for `rawOutput`.
- Tests spawn `node plugins/codex/scripts/mcp-server.mjs` with the fixture env (`buildEnv`) and speak JSON-RPC over its stdio with a small client helper inside `tests/mcp.test.mjs`.

## Fake-Codex fixture

The fixture API from lane `m0-fixture` (plan D2), in short: `installFakeCodex(binDir, behavior, options)`; `setFakeCodexOptions(binDir, patch)`; `options.turnScript` steps (`command`, `fileChange` with `writeFiles`, `agentMessage`, `reasoning`, `plan`, `diff`, `usage`, `delay`, `silence`, `serverRequest`); `options.interrupt: "cooperate"|"ignore"|"ack-only"`; `options.ignoreSigterm`; `options.delays.{initialize,threadStart,turnStart}`; `options.models`, `options.config`, `options.writeRollout`, `options.forceActiveWriter`, `options.turnStatus`; methods `model/list`, `config/read`, `thread/read`; `readFakeRpcLog(binDir, {method, conn, dir})`, `fakeConnections(binDir)`; `occupyBroker(endpoint, {holdMs})`; `startFakeAppServer(binDir)`; helpers `spawnStubborn()`, `waitFor()`, `isPidAlive()`, `makeCompanionWorkspace()`. M0/M1 lanes extended it further, so **read the fixture source for the exact signatures** before writing tests. Note: the fixture answers `thread/unload`, but the real codex-cli 0.157 app-server does **not** have it (probe §6), so plugin code must never call it.

**You do not own the fixture files in this wave** (lane `m5-fanout-brief` does). Do not edit `tests/fake-codex-fixture.mjs` or `tests/helpers.mjs`. If you need something the fixture lacks, write a small local helper inside your own test file, or record the gap as a follow-up.

## Tests to write first

`tests/mcp.test.mjs` (spawned server, fake fixture):
1. `tools/list` lists every tool above, including `codex-reply` (and no `codex_reply`), each with an input schema.
2. `codex{prompt, wait:true, outputSchema}` with a conforming final message returns `structuredContent` whose `structured.data` matches the schema (and `ok:true`).
3. `codex-reply{threadId}` calls `thread/resume` with that id (RPC log).
4. `codex_steer` delivers a message mid-turn (`turn/steer` in the RPC log; delivery `delivered`).
5. Cancelling a waiting `codex` call (`notifications/cancelled`) leads to a verified cancel: job `cancelled`, `turn/interrupt` at the fake, no live worker.
6. `wait:false` job: killing the MCP server process makes the worker self-cancel with `owner-lost` (short owner TTL/poll env).
7. `codex_models` returns the fake catalog; `codex_fork{jobId}` creates a job with `forkedFromThreadId`.
8. `codex_status`, `codex_result`, `codex_events`, `codex_diff`, `codex_transcript`, `codex_cancel` return their §8.3 shapes for a finished job.

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

### 8.3 MCP tools (`orvex-codex mcp`; registered as server `codex`)

| Tool | Params | Returns (`structuredContent`) |
|---|---|---|
| `codex` | `prompt` (req), `cwd?`, `model?`, `effort?`, `profile?`, `sandbox?`, `network?`, `worktree?`, `outputSchema?` (JSON Schema object), `developerInstructions?`, `config?` (object), `wait=true`, `timeoutMs?`, `name?` | `wait:true`: `{jobId, threadId, status, report, structured?, rawOutput(brief), pointers}`; `wait:false`: `{jobId, threadId?, status:'queued'}`. Sends progress notifications. MCP cancellation cancels the job. |
| `codex-reply` (and/or `codex_reply`) | `threadId` or `jobId` (one required), `prompt`, `wait=true`, `interrupt=false`, runtime overrides | Same as `codex`. Resumes that exact thread (or its latest fork, with `forkedFrom`). If the job is running: steer, or interrupt+redirect when `interrupt:true`. |
| `codex_steer` | `jobId`, `message`, `waitDelivery=false`, `timeoutMs?` | `{messageId, delivery:'delivered|queued|finished-undelivered|lost|followed-up', followUpJobId?}` |
| `codex_interrupt` | `jobId`, `then?` | `{jobId, turnInterrupted, newTurnId?}` |
| `codex_status` | `jobId?`, `allSessions=false`, `lines=4` | `{jobs:[{jobId, status, phase, elapsedMs, runtime badge, lastMessage, lastCommand, counts, ownerAlive, heartbeatAgeSec}]}` |
| `codex_wait` | `jobIds?`, `group?`, `any=false`, `timeoutMs?` | `{results:[{jobId, status, exitCode, report}] , timedOut}` |
| `codex_result` | `jobId`, `partial=false`, `format='brief'` | the result payload (§8.2) |
| `codex_transcript` | `jobId` or `threadId`, `format='md'`, `items?`, `last?`, `maxBytes=20000` | `{text, truncated, rolloutPath}` |
| `codex_events` | `jobId`, `since?`, `types?`, `limit=200` | `{events:[...], nextSeq}` |
| `codex_diff` | `jobId`, `stat=false` | `{patch|stat, files}` |
| `codex_cancel` | `jobId` or `all:true`, `graceMs?` | `{jobId, status, verifiedStopped, residualPids}` |
| `codex_models` | `refresh=false` | `{models:[{id, displayName, isDefault, efforts, defaultEffort}], aliases:{}}` |
| `codex_fanout` (M5) | `specs[]`, `maxParallel=4`, `worktree=true`, `outputSchema?`, `wait=true` | `{groupId, results:[{name, jobId, status, report, structured}]}` |

## Probe adjustments and scope narrowing (binding; they override the verbatim text above)

- Codex CLI 0.157 has no `mcp-server` subcommand and `codex mcp` only manages external servers (report E7); the native daemon is not used (native surfaces §1): the server drives jobs through the plugin's own machinery.
- `codex-reply` on a running native **review** job cannot steer (probe §7); return an `isError` result saying so.

## Acceptance checklist (report PASS/FAIL per line)

- [ ] The server lists all tools (§8.3 minus `codex_fanout`, plus `codex_fork`), with `codex-reply` hyphenated only
- [ ] (1) `codex{wait:true, outputSchema}` returns `structuredContent` matching the schema
- [ ] (2) `codex-reply{threadId}` calls `thread/resume` with that id
- [ ] (3) `codex_steer` delivers mid-turn
- [ ] (4) Cancelling a waiting `codex` call leads to a verified cancel of the job
- [ ] MCP-launched jobs are owned (server death cancels `wait:false` jobs unless `detach:true`)
- [ ] Long waits emit MCP progress notifications from events
- [ ] `.mcp.json` registers the server for the plugin
- [ ] `npm test` green in your worktree; no existing test edited except where this brief allows it

## Required final report (your last message; use exactly these sections)

```
## Lane m5-mcp report
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
