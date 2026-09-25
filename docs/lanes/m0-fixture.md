# Lane `m0-fixture`: Upgrade the fake-Codex fixture (scripted turns, RPC recording, forced modes)

- **Beads:** `codex-plugin-cc-1mh.2`
- **Report items:** FIXTURE (report §9.1)
- **Wave:** 1. **Depends on:** none. **Runs concurrently with:** `m0-spike`, `m0-cli-hygiene`, `m0-prune`.

## Goal

Almost every later acceptance test needs fake-Codex capabilities that do not exist yet. Upgrade `tests/fake-codex-fixture.mjs` and `tests/helpers.mjs` so tests can script turns, change behaviour between steps, force failure modes, and assert on every JSON-RPC message per connection. **You change no plugin code.** Every existing test must keep passing unchanged. The fixture you build becomes the shared test substrate for about 50 later items, so design it to be extended.

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

- `tests/fake-codex-fixture.mjs`
- `tests/helpers.mjs`
- `tests/fixture-smoke.test.mjs`

## Do not touch

- `plugins/codex/**` (no plugin code changes in this lane at all).
- `plugins/codex/scripts/lib/args.mjs`, `plugins/codex/scripts/codex-companion.mjs` (lane `m0-cli-hygiene`).
- `plugins/codex/scripts/lib/state.mjs` (lane `m0-prune`).
- `docs/**`, `scripts/probe-app-server.mjs` (lane `m0-spike`).
- Every existing `tests/*.test.mjs` file.

## Design decisions binding on this lane

From `docs/IMPLEMENTATION-PLAN.md` D2 (binding):

- **Backward compatible signature:** `installFakeCodex(binDir, behavior = "review-ok", options = {})`. Every existing behaviour string (`review-ok`, `slow-task`, `interruptible-slow-task`, `steerable-task`, `steer-flaky`, `steer-hang`, `steer-rejected`, `resume-locked`, `with-subagent`, …) must keep producing exactly what it produces today.
- **Runtime options file:** options are written to `binDir/fake-codex-options.json`, and the fake **re-reads it on every inbound message**. Export `setFakeCodexOptions(binDir, patch)` (shallow merge) so a test can change behaviour mid-test. When `options.turnScript` is set it takes precedence over the behaviour string for `turn/start`.
- **Scripted turns** (`options.turnScript`, an array played after `turn/start` answers and `turn/started` is sent):
  - `{type:"command", command, exitCode=0, output="", durationMs=0, outputChunks?}`: sends `item/started` (commandExecution, status inProgress), then for each chunk an `item/commandExecution/outputDelta` notification `{threadId, turnId, itemId, delta}`, then `item/completed` with `{type:"commandExecution", id, command, cwd, status:"completed"|"failed", exitCode, aggregatedOutput, durationMs}`.
  - `{type:"fileChange", changes:[{path, kind:"add"|"update"|"delete", diff?}], writeFiles=false}`: `item/started` + `item/completed` for a `fileChange` item. With `writeFiles:true`, also really write or delete those files relative to the thread cwd.
  - `{type:"agentMessage", text, phase?}`, `{type:"reasoning", text}`, `{type:"plan", steps:[{step, status}]}` → `turn/plan/updated`, `{type:"diff", diff}` → `turn/diff/updated`, `{type:"usage", total, input?, output?}` → `thread/tokenUsage/updated`.
  - `{type:"delay", ms}`, `{type:"silence"}` (stop emitting; the turn never completes unless interrupted), `{type:"serverRequest", method="item/commandExecution/requestApproval", params}` (sends a server-initiated JSON-RPC request with an id and records the client's answer).
  - The turn ends with `item/completed` for a final agentMessage (unless the script already produced one with `phase:"final_answer"`) and `turn/completed` (`status:"completed"`, or `"failed"` when `options.turnStatus === "failed"`).
  - Match the **existing** notification shapes the plugin already consumes (see `applyTurnNotification`, `recordItem`, `describeStartedItem`, `describeCompletedItem` in `plugins/codex/scripts/lib/codex.mjs`, which you may read but not edit). For shapes the plugin does not consume yet, use the upstream app-server names given above. Lane `m0-spike` records the real shapes in `docs/app-server-probe.md`, and later lanes will adjust. Keep each shape built in one small function so it is easy to change.
- **Interrupt behaviour:** `options.interrupt`: `"cooperate"` (default: answer `{}`, stop the script, emit `turn/completed` with `status:"interrupted"`), `"ignore"` (never answer, keep running), `"ack-only"` (answer `{}`, keep running). This applies to scripted turns and to the existing slow behaviours.
- **Process behaviour:** `options.ignoreSigterm: true` makes the fake app-server process ignore SIGTERM (only SIGKILL ends it). `options.delays = {initialize, threadStart, turnStart}` delays those responses by N ms. This is needed to test cancelling a job before it has a turnId.
- **New methods:** `model/list` → `{data: options.models ?? [...defaults]}`, each model `{id, model, displayName, isDefault, supportedReasoningEfforts:[{reasoningEffort, description}], defaultReasoningEffort}`. `config/read`: when `options.config` is set, return it merged over today's behaviour-based result. `thread/read` `{threadId}` → `{thread: buildThread(...)}` with `turns:[{id, status}]` and `status` `{type:"active"}` while a turn is running, otherwise `{type:"idle"}`, plus `path` pointing to a real rollout file written under `$CODEX_HOME/sessions/<yyyy>/<mm>/<dd>/rollout-<ts>-<threadId>.jsonl` when `options.writeRollout` is true. `thread/unload` `{threadId}` → `{}` and recorded.
- **Forced modes:** `options.forceActiveWriter: true` makes `thread/resume` fail with the message `Thread <id> has an active writer` (the plugin's fork fallback matches `/active writer/i`). Do **not** add any test hook to plugin code for broker-busy. Instead, export `occupyBroker(endpoint, {holdMs})`: it opens a raw socket to the broker endpoint (unix path; parse it the way `plugins/codex/scripts/lib/broker-endpoint.mjs` does), sends `initialize` and then a `thread/start` + `turn/start` against a fake scripted to `delay` for `holdMs`, and returns `{release()}`. While it holds the stream, other clients get broker-busy `-32001`.
- **RPC recording:** every fake app-server process appends one JSON line per message to `binDir/fake-codex-rpc.jsonl` using `fs.appendFileSync`: `{ts, conn, pid, dir:"in"|"out", id, method, params}` (for responses, `method` is the request's method and a `result`/`error` field is included). `conn` is `"<pid>-<processStartMs>"`, fixed for the life of the process (one stdio connection per process). Export `readFakeRpcLog(binDir, {method, conn, dir} = {})` and `fakeConnections(binDir)` (distinct conns in order). The legacy `fake-codex-state.json` stays for existing assertions; **also make its load/save tolerant** of concurrent writers (write to a tmp file, then rename).
- **Direct driver:** export `startFakeAppServer(binDir, {env})`, which spawns `codex app-server` from `binDir` and returns `{request(method, params), notifications: [], waitForNotification(method, predicate, timeoutMs), close()}`, for fixture smoke tests that do not need the companion.
- **helpers.mjs additions:** `spawnStubborn()` (a node child that ignores SIGTERM and prints its pid; returns `{pid, kill()}`), `waitFor(predicate, {timeoutMs=5000, intervalMs=50})`, `isPidAlive(pid)`, and `makeCompanionWorkspace(behavior, options)`, which generalises `makeWorkspace` from `tests/orvex.test.mjs` (temp git repo + fake Codex + isolated `CODEX_COMPANION_CONFIG`/`CODEX_COMPANION_BIN_DIR` + a `companion(args, opts)` runner + `spawnCompanion(args, opts)` for long-running background processes + `binDir`/`fakeState()`). Do not change `tests/orvex.test.mjs`: the old local helper stays there.

## Implementation guide

1. Read `tests/fake-codex-fixture.mjs` fully. The fake's source is a template string, so any code you add inside it must be valid inside a JS template literal (escape backticks and `${`).
2. Refactor the `turn/start` branch so behaviour strings and the new `turnScript` player share one "active turn" registry (`threadId`, `turnId`, timers, interrupted flag). This lets `turn/interrupt`, `turn/steer` and `thread/read` see the running turn consistently.
3. Add the options file reader, the RPC logger (wrap `send` and the `rl.on("line")` handler), the new methods, delays, ignoreSigterm and forceActiveWriter.
4. Add the exported helpers.
5. Keep the Windows `codex.cmd` wrapper logic.

## Tests to write first

Create `tests/fixture-smoke.test.mjs` with at least one test per capability (seven or more tests). Drive the fake directly through `startFakeAppServer` where possible, and use one or two tests through the companion (`task --json` in a temp repo) to prove end-to-end compatibility:
1. `interrupt:"ignore"`: `turn/interrupt` gets no answer within 500ms and the turn keeps emitting. `"cooperate"` → `turn/completed` status interrupted.
2. Slow turn (`delay` step) and `silence` (no `turn/completed` within 1s). `ignoreSigterm`: SIGTERM leaves the process alive, SIGKILL ends it.
3. `command` with `outputChunks` → outputDelta notifications in order; `plan`, `diff`, `usage` notifications emitted.
4. `model/list`, `config/read` (options merged), `thread/read` (status active during a slow turn, idle after; `path` exists when `writeRollout`).
5. `forceActiveWriter` → resume error matches `/active writer/i`. `occupyBroker`: start a companion broker via one `task` run, occupy it, and show that a second raw client's `thread/list` gets code `-32001`.
6. `serverRequest` step: the request is sent and the client's reply is recorded in the RPC log.
7. RPC log: two separate `startFakeAppServer` processes produce two `conn` values, and `readFakeRpcLog(binDir, {conn})` returns only that connection's messages.
8. `setFakeCodexOptions` mid-test changes behaviour for the next `turn/start`.
9. Back-compat: a companion `task --json` with behaviour `review-ok` and no options still produces the same `rawOutput` as before.

## Requirements from the report (verbatim)

The text below is copied verbatim from `docs/IMPROVEMENT-REPORT.md`. You do not need to read the rest of the report.

Fixture upgrades needed:
- a fake that ignores `turn/interrupt`
- a slow-turn mode
- emission of `outputDelta`, `turn/diff/updated`, `turn/plan/updated` and `tokenUsage`
- `model/list`, `config/read` and `thread/read` responses
- forced active-writer and forced broker-busy modes
- a server-initiated request
- recording of all RPCs, per connection, for assertions

1. **App-server protocol surface is unverified locally.** The generated types (`.generated/app-server-types`) are not in the checkout. Before building on any of the following, verify it against codex-cli 0.157.0 (write a small probe script, or use the nightly contract test): `model/list`, `config/read` layers, `thread/read` (and whether it returns a rollout path or turn status), `thread/unload` (or an equivalent), `turn/steer` semantics on native review turns, `ThreadStartResponse` fields (effective model and sandbox), `ThreadStartParams.developerInstructions`, the per-thread config keys that disable skills, hooks and AGENTS.md, and whether a missing `sandbox` param falls back to config.toml. Items BUG-5, BUG-10, BUG-11, FR-7, FR-12 and FR-13 depend on these.

## Acceptance checklist (report PASS/FAIL per line)

- [ ] All seven report capabilities exist and can be toggled per test: ignore turn/interrupt; slow turn (+ go-silent mode); outputDelta / turn/diff/updated / turn/plan/updated / tokenUsage emission; model/list, config/read, thread/read responses; forced active-writer and broker-busy (test-side `occupyBroker`); server-initiated request; per-connection RPC recording
- [ ] Each capability has at least one smoke test in `tests/fixture-smoke.test.mjs`
- [ ] RPC recordings can be queried per connection (`readFakeRpcLog(binDir, {conn})`)
- [ ] Options can be changed mid-test (`setFakeCodexOptions`) and take effect on the next message
- [ ] Existing behaviour strings unchanged; no existing test file modified; no plugin file modified
- [ ] `npm test` green

## Required final report (your last message; use exactly these sections)

```
## Lane m0-fixture report
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
