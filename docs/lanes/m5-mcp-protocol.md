# Lane `m5-mcp-protocol`: Minimal MCP stdio server library (FR-11)

- **Beads:** `codex-plugin-cc-qo4.1`
- **Report items:** FR-11. **Scope in this lane:** the **protocol half** of FR-11: `lib/mcp-protocol.mjs`, a dependency-free MCP server over stdio, unit-tested with toy tools. The Codex tools and the server entry point are lane `m5-mcp`.
- **Milestone / wave:** M5, wave 1. **Depends on:** all of M4 merged. **Runs concurrently with:** `m5-job-api`, `m5-fanout-lib`, `m5-brief-lib`.

## Goal

The plugin ships no MCP server, and the runtime has no npm dependencies, so there is no SDK. Build a small, correct MCP stdio server core: JSON-RPC 2.0 framing, the initialize handshake, `tools/list`, `tools/call` with input validation and structured results, progress notifications, and request cancellation mapped to an `AbortSignal`.

## Ground rules (non-negotiable)

- **Worktree:** you work in your **own git worktree**, created by the orchestrator from branch `orvex/improvement-report` after the previous wave was merged (normally `/home/crew/workspace/codex-plugin-cc-lanes/m5-mcp-protocol` on branch `lane/m5-mcp-protocol`; use the path you were given). Paths below are relative to your worktree root, and `plugins/codex/scripts/` holds the runtime. The other lanes of your wave run at the same time in their own worktrees, and the orchestrator merges every lane of the wave afterwards. **File ownership is what keeps those merges conflict-free**, so respect it exactly.
- **Beads:** run `bd` from the main checkout: `cd /home/crew/workspace/codex-plugin-cc && bd update <id> --claim` for each bead listed above. If a bead is already claimed (another lane of the same item claimed it), skip the claim and still add your note. At the end, run `bd note <id> "<one paragraph: lane m5-mcp-protocol; what changed, tests added, npm test result, open risks>"` for each bead. **Never** run `bd close`: the orchestrator closes beads after review.
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

- `plugins/codex/scripts/lib/mcp-protocol.mjs` (new)
- `tests/mcp-protocol.test.mjs` (new)

## Do not touch

- Lane `m5-job-api` runs at the same time and owns: `plugins/codex/scripts/codex-companion.mjs`, `plugins/codex/scripts/lib/job-api.mjs`, `tests/fake-codex-fixture.mjs`, `tests/helpers.mjs`, `tests/job-api.test.mjs`.
- Lane `m5-fanout-lib` runs at the same time and owns: `plugins/codex/scripts/lib/fanout.mjs`, `tests/fanout-lib.test.mjs`.
- Lane `m5-brief-lib` runs at the same time and owns: `plugins/codex/scripts/lib/brief-format.mjs`, `tests/brief-lib.test.mjs`.
- Any existing test file not listed under "Files you own" (add your tests in your own new test files).

## Design decisions binding on this lane

- **`createMcpServer({name, version, tools, instructions})`** → `{serve({input, output, onError}) → Promise<void>, close()}`. Transport: newline-delimited JSON-RPC 2.0 messages on stdin/stdout (the MCP stdio transport: one JSON object per line, no embedded newlines; stdout carries only protocol messages, logs go to stderr).
- **Handshake:** `initialize` → `{protocolVersion, capabilities:{tools:{listChanged:false}}, serverInfo:{name, version}, instructions?}`; respond with the client's requested `protocolVersion` if it is one of `SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"]`, else the newest. Accept `notifications/initialized`. `ping` → `{}`. Unknown method → `-32601`; invalid JSON → `-32700`; invalid params → `-32602`.
- **Tools:** each tool `{name, title?, description, inputSchema, outputSchema?, annotations?, handler(args, ctx)}`; `ctx = {signal, requestId, progress(progress, total?, message?), log(level, message)}`. Names must match `^[A-Za-z0-9_-]{1,64}$` (checked at creation). `tools/list` returns them (no pagination needed). `tools/call`: validate `arguments` against `inputSchema` with `lib/json-schema.mjs` (invalid → a tool result with `isError:true` and the validation errors, not a protocol error); the handler returns `{structuredContent, text?}` → result `{content:[{type:"text", text: text ?? JSON.stringify(structuredContent)}], structuredContent, isError:false}`; a thrown error → `{content:[{type:"text", text: message}], isError:true}` (plus `structuredContent:{error:{code, message}}` when the error has a `code`).
- **Progress:** when the request has `params._meta.progressToken`, `ctx.progress()` sends `notifications/progress {progressToken, progress, total?, message?}` (progress strictly increasing; throttle to ≤ 4/s).
- **Cancellation:** `notifications/cancelled {requestId, reason}` aborts that call's `signal`; the server still sends no response for a cancelled request if the handler resolves after cancellation (per spec, responses to cancelled requests should be suppressed).
- **Concurrency:** calls run concurrently; responses carry the request `id`.

## Implementation guide

- Pure module over injected streams; tests use `PassThrough` streams and a tiny client helper inside the test file.

## Fake-Codex fixture

The fixture API from lane `m0-fixture` (plan D2), in short: `installFakeCodex(binDir, behavior, options)`; `setFakeCodexOptions(binDir, patch)`; `options.turnScript` steps (`command`, `fileChange` with `writeFiles`, `agentMessage`, `reasoning`, `plan`, `diff`, `usage`, `delay`, `silence`, `serverRequest`); `options.interrupt: "cooperate"|"ignore"|"ack-only"`; `options.ignoreSigterm`; `options.delays.{initialize,threadStart,turnStart}`; `options.models`, `options.config`, `options.writeRollout`, `options.forceActiveWriter`, `options.turnStatus`; methods `model/list`, `config/read`, `thread/read`; `readFakeRpcLog(binDir, {method, conn, dir})`, `fakeConnections(binDir)`; `occupyBroker(endpoint, {holdMs})`; `startFakeAppServer(binDir)`; helpers `spawnStubborn()`, `waitFor()`, `isPidAlive()`, `makeCompanionWorkspace()`. M0/M1 lanes extended it further, so **read the fixture source for the exact signatures** before writing tests. Note: the fixture answers `thread/unload`, but the real codex-cli 0.157 app-server does **not** have it (probe §6), so plugin code must never call it.

**You do not own the fixture files in this wave** (lane `m5-job-api` does). Do not edit `tests/fake-codex-fixture.mjs` or `tests/helpers.mjs`. If you need something the fixture lacks, write a small local helper inside your own test file, or record the gap as a follow-up.

## Tests to write first

`tests/mcp-protocol.test.mjs`:
1. Initialize negotiation (supported and unsupported versions), `tools/list`, `ping`, unknown method `-32601`, invalid JSON `-32700`.
2. `tools/call` success with `structuredContent`; invalid arguments → `isError:true` with validation errors; thrown coded error → `isError:true`.
3. Progress notifications with a progress token, increasing and throttled.
4. `notifications/cancelled` aborts the handler's signal, and no response is sent for the cancelled request.
5. Two concurrent calls resolve out of order with correct ids.
6. Nothing but JSON lines is written to the output stream.

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

## Probe adjustments and scope narrowing (binding; they override the verbatim text above)

- Not an app-server concern. Codex CLI 0.157 has no `mcp-server` subcommand (report E7), so the plugin must implement the server itself.

## Acceptance checklist (report PASS/FAIL per line)

- [ ] A dependency-free MCP stdio server core handles initialize, tools/list, tools/call (with `structuredContent` and input validation), progress notifications and cancellation
- [ ] Tool names are validated against `[A-Za-z0-9_-]`
- [ ] Protocol errors and tool errors are distinguished correctly
- [ ] `npm test` green in your worktree; no existing test edited except where this brief allows it

## Required final report (your last message; use exactly these sections)

```
## Lane m5-mcp-protocol report
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
