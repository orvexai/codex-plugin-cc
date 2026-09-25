# Lane `m2-capture`: Capture command output deltas, turn diffs, plan updates and token usage (FR-3)

- **Beads:** `codex-plugin-cc-yew.3`
- **Report items:** FR-3. **Scope in this lane:** all of FR-3 except the `task --stream` **flag**, which lane `m2-inspect` (wave 4) adds on top of the `streamDeltas` option and the env var you implement here.
- **Milestone / wave:** M2, wave 2. **Depends on:** wave 1 (`m2-events` merged: event writer and schema). **Runs concurrently with:** `m2-report`.

## Goal

`applyTurnNotification` drops command output deltas, turn diffs, plan updates, token usage and rate-limit notifications (`default: break`). Capture them: stream command output to per-command files with throttled events, keep the live diff, persist plan and usage on the job, store tool and search items, and make message/reasoning delta streaming opt-in.

## Ground rules (non-negotiable)

- **Worktree:** you work in your **own git worktree**, created by the orchestrator from branch `orvex/improvement-report` after the previous wave was merged (normally `/home/crew/workspace/codex-plugin-cc-lanes/m2-capture` on branch `lane/m2-capture`; use the path you were given). Paths below are relative to your worktree root, and `plugins/codex/scripts/` holds the runtime. The other lanes of your wave run at the same time in their own worktrees, and the orchestrator merges every lane of the wave afterwards. **File ownership is what keeps those merges conflict-free**, so respect it exactly.
- **Beads:** run `bd` from the main checkout: `cd /home/crew/workspace/codex-plugin-cc && bd update <id> --claim` for each bead listed above. If a bead is already claimed (another lane of the same item claimed it), skip the claim and still add your note. At the end, run `bd note <id> "<one paragraph: lane m2-capture; what changed, tests added, npm test result, open risks>"` for each bead. **Never** run `bd close`: the orchestrator closes beads after review.
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

- `plugins/codex/scripts/lib/codex.mjs`
- `plugins/codex/scripts/lib/app-server.mjs`
- `plugins/codex/scripts/lib/tracked-jobs.mjs`
- `plugins/codex/scripts/lib/job-control.mjs`
- `plugins/codex/scripts/lib/render.mjs`
- `tests/fake-codex-fixture.mjs`
- `tests/helpers.mjs`
- `tests/capture.test.mjs` (new)

## Do not touch

- Lane `m2-report` runs at the same time and owns: `plugins/codex/scripts/codex-companion.mjs`, `plugins/codex/scripts/lib/task-report.mjs`, `plugins/codex/scripts/lib/json-schema.mjs`, `plugins/codex/scripts/lib/git-snapshot.mjs`, `plugins/codex/schemas/task-report.schema.json`, `plugins/codex/schemas/task-result.schema.json`, `tests/report.test.mjs`.
- `app-server-broker.mjs` (if broker forwarding needs a change for opt-outs, report it as a follow-up).
- Any existing test file not listed under "Files you own" (add your tests in your own new test files).

## Design decisions binding on this lane

- **Keep `lib/codex.mjs` file-agnostic.** In `applyTurnNotification`, forward the new notifications as progress payloads carrying a *transient* event, and let the job reporter in `lib/tracked-jobs.mjs` do the file work:
  - `item/commandExecution/outputDelta` `{threadId, turnId, itemId, delta}` → payload `{transient:true, event:{type:"command.output.delta", data:{itemId, delta}}}`. The reporter appends `delta` to `jobs/<id>.cmd-<itemId>.out` (cap 1MB per file; after the cap write one `…[output truncated at 1MB]` line and drop the rest) and emits a persisted `command.output` event `{itemId, bytes, file, chunkTail}` (chunkTail ≤ 1KB) **at most once per 2s per itemId** (plus one final flush when the command completes, still respecting the 2s rule if possible). Deltas never go to the text log or stderr.
  - `turn/diff/updated` `{diff}` → overwrite `jobs/<id>.live.diff` (atomic tmp+rename); `file.changed` events keep `diffRef:null`, and the job gets `liveDiffFile`.
  - `turn/plan/updated` `{explanation, plan:[{step, status}]}` → `job.plan = {explanation, steps:[{step, status}], updatedAt}` and a `plan.updated` event `{explanation, steps}`.
  - `thread/tokenUsage/updated` `{tokenUsage:{total:{totalTokens, inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens}, last, modelContextWindow}}` (probe shape) → `job.usage = {total: totalTokens, input, cachedInput, output, reasoningOutput, modelContextWindow, updatedAt}` so `usage.total` is a number, and a `usage.updated` event. Persist usage and events at most once per 2s (keep the last value and flush it at turn end).
  - Any notification whose method contains `rateLimits` → `job.rateLimits = params` (best effort, no event; no test required).
  - `mcpToolCall`, `dynamicToolCall` and `webSearch` items: keep them in the capture state as `toolCalls[] = {itemId, kind, server, tool, query, status}` and return `toolCalls` from `runAppServerTurn` (lane `m2-report` adds them to the report).
- **Opt-in delta streaming.** `lib/app-server.mjs` builds the `optOutNotificationMethods` list at initialize. Add a `streamDeltas` option (plumbed from `runAppServerTurn` options; also enabled by env `CODEX_COMPANION_STREAM_DELTAS=1`) that removes the agent-message and reasoning delta methods from the opt-out list; those deltas then become transient events `message.delta`/`reasoning.delta` written to events (throttled 1 per 500ms per item, coalesced), never to the log. In broker mode the broker owns the app-server's initialize: read `app-server-broker.mjs` and document in your report whether a per-client opt-out change reaches the app-server; if it cannot, streaming applies to direct transport only and status says so.
- **Status.** `buildSingleJobSnapshot`/`enrichJob` (`lib/job-control.mjs`) expose `usage`, `plan` and `liveDiffFile` in `status --json`, and the rendered status (`lib/render.mjs`) shows `plan: <n> steps (<in-progress step>)` and `tokens <total>` for running and finished jobs.
- **Throttling helper:** one small `createThrottle(intervalMs)` keyed per id, with tests using an env-configurable interval (`CODEX_COMPANION_EVENT_THROTTLE_MS`, default 2000; add it to `LEAKY_ENV`).

## Implementation guide

- `lib/codex.mjs`: `applyTurnNotification`, `createTurnCaptureState`, `recordItem`, `runAppServerTurn` (return `toolCalls`; accept `streamDeltas`).
- `lib/app-server.mjs`: the initialize params (`optOutNotificationMethods`, around the report's lines 33-42).
- `lib/tracked-jobs.mjs`: `normalizeProgressEvent`, `createProgressReporter`, `createJobProgressUpdater` (plan/usage fields), the event writer from `m2-events`.
- `lib/job-control.mjs`: `enrichJob`, `buildSingleJobSnapshot`; `lib/render.mjs`: `renderJobStatusReport`, `pushJobDetails`.

## Fake-Codex fixture

The fixture API from lane `m0-fixture` (plan D2), in short: `installFakeCodex(binDir, behavior, options)`; `setFakeCodexOptions(binDir, patch)`; `options.turnScript` steps (`command`, `fileChange` with `writeFiles`, `agentMessage`, `reasoning`, `plan`, `diff`, `usage`, `delay`, `silence`, `serverRequest`); `options.interrupt: "cooperate"|"ignore"|"ack-only"`; `options.ignoreSigterm`; `options.delays.{initialize,threadStart,turnStart}`; `options.models`, `options.config`, `options.writeRollout`, `options.forceActiveWriter`, `options.turnStatus`; methods `model/list`, `config/read`, `thread/read`; `readFakeRpcLog(binDir, {method, conn, dir})`, `fakeConnections(binDir)`; `occupyBroker(endpoint, {holdMs})`; `startFakeAppServer(binDir)`; helpers `spawnStubborn()`, `waitFor()`, `isPidAlive()`, `makeCompanionWorkspace()`. M0/M1 lanes extended it further, so **read the fixture source for the exact signatures** before writing tests. Note: the fixture answers `thread/unload`, but the real codex-cli 0.157 app-server does **not** have it (probe §6), so plugin code must never call it.

**You own the fixture files in this wave.** If you need a capability that is missing, add it **additively** (new options, new turnScript step types, new helpers) and keep every existing behaviour string and option working. Where the fixture's shapes differ from `docs/app-server-probe.md` ("Fixture shapes"), make the fixture match the probe for the methods you touch.

Make the fixture's `usage` step emit the **probe shape** (`params.tokenUsage.total.totalTokens` …, see `docs/app-server-probe.md` "Fixture shapes") and its `plan` step emit `{explanation, plan:[{step, status}]}`; keep old options working. Add `outputChunks` timing (`chunkDelayMs`) to `command` steps if missing so a test can spread 10 chunks over ~3s.

## Tests to write first

`tests/capture.test.mjs` (turnScript: a `command` step with 10 `outputChunks` spread over ~3s with `CODEX_COMPANION_EVENT_THROTTLE_MS=1000`, a `plan` step, two `diff` steps, two `usage` steps):
1. `jobs/<id>.cmd-<itemId>.out` equals the concatenated chunks.
2. `status <id> --json` has `usage.total > 0` and `plan.steps` (length and statuses).
3. `jobs/<id>.live.diff` equals the **last** diff payload.
4. At most one `command.output` event per throttle interval per command (check timestamps).
5. The 1MB cap: a command emitting > 1MB ends with the truncation line and the file is ≤ 1MB + marker.
6. Tool/search items are returned in `toolCalls` (unit-level through `runAppServerTurn` with a scripted `mcpToolCall` item if the fixture can emit one; otherwise test `applyTurnNotification` directly).
7. `CODEX_COMPANION_STREAM_DELTAS=1` removes the delta methods from the recorded `initialize` params (RPC log) on a direct connection.
8. Rendered status shows the plan and token lines.

## Requirements from the report (verbatim)

The text below is copied verbatim from `docs/IMPROVEMENT-REPORT.md`. Line numbers in it predate M0/M1. The "Probe adjustments" and "Design decisions" sections of this brief override it where they differ.

### FR-3: Capture command output deltas, turn diffs, plan updates and token usage instead of dropping them
- **Priority:** P1
- **Problem:** The `default: break` in `applyTurnNotification` drops `item/commandExecution/outputDelta`, `turn/diff/updated`, `turn/plan/updated`, `thread/tokenUsage/updated` and rate-limit notifications. These arrive but are discarded; only agent-message and reasoning deltas are opted out at initialize. Claude cannot see output from long commands, Codex's plan, the cumulative diff, or usage. Items such as `mcpToolCall`, `dynamicToolCall` and `webSearch` produce progress text but are not stored.
- **Evidence:** E3. `lib/codex.mjs` 629-637 and 642-706. `lib/app-server.mjs` 33-42.
- **Proposal:**
  - `outputDelta`: append to `jobs/<id>.cmd-<itemId>.out` (capped at 1MB) and emit a throttled `command.output` event (at most one per 2s per command).
  - `turn/plan/updated`: store `job.plan`, emit `plan.updated`.
  - `turn/diff/updated`: overwrite `jobs/<id>.live.diff`.
  - `tokenUsage`: store `job.usage`.
  - Store tool and search items in the payload.
  - Opt-in delta streaming for messages and reasoning (`task --stream` or `CODEX_COMPANION_STREAM_DELTAS=1`; toggles the opt-out list).
  - Surface usage and plan in `status --json` and the rendered status.
- **Acceptance criteria:** When the fixture emits outputDelta, plan, diff and tokenUsage notifications: the cmd output file contains the concatenated deltas, `status --json` has `usage.total>0` and `plan.steps`, `live.diff` equals the last diff payload, and there is at most one `command.output` event per 2s per command.

## Probe adjustments and scope narrowing (binding; they override the verbatim text above)

- Use the notification shapes from `docs/app-server-probe.md` "Fixture shapes" (from the generated `v2/*Notification.ts`): `item/commandExecution/outputDelta {threadId, turnId, itemId, delta}`, `turn/diff/updated {threadId, turnId, diff}`, `turn/plan/updated {threadId, turnId, explanation, plan:[{step, status}]}`, `thread/tokenUsage/updated {threadId, turnId, tokenUsage:{total, last, modelContextWindow}}`. The report's `usage.total>0` criterion is met by storing `tokenUsage.total.totalTokens` as `job.usage.total`.
- The rate-limit notification name was not probed; handle it generically and do not test it.

## Acceptance checklist (report PASS/FAIL per line)

- [ ] When the fixture emits outputDelta, plan, diff and tokenUsage notifications: the cmd output file contains the concatenated deltas
- [ ] `status --json` has `usage.total>0` and `plan.steps`
- [ ] `live.diff` equals the last diff payload
- [ ] There is at most one `command.output` event per 2s (the configured throttle) per command
- [ ] Tool and search items are stored and returned (`toolCalls`)
- [ ] Opt-in delta streaming via `streamDeltas`/`CODEX_COMPANION_STREAM_DELTAS=1` toggles the opt-out list (broker behaviour documented)
- [ ] Usage and plan are surfaced in `status --json` and the rendered status
- [ ] `npm test` green in your worktree; no existing test edited except where this brief allows it

## Required final report (your last message; use exactly these sections)

```
## Lane m2-capture report
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
