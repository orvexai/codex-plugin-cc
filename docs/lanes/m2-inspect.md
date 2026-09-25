# Lane `m2-inspect`: `transcript`, `result --partial`, `status --lines/--full`, `task --stream` and review persistence (CLI) (FR-7, FR-8, FR-3)

- **Beads:** `codex-plugin-cc-yew.6`, `codex-plugin-cc-yew.7`, `codex-plugin-cc-yew.3`
- **Report items:** FR-7, FR-8, FR-3. **Scope in this lane:** the **CLI halves**: FR-7 (`transcript` subcommand, `reviewPersist`), FR-8 (`result --partial`, `status --lines/--full`, `schemaVersion`), and FR-3's `task --stream` flag.
- **Milestone / wave:** M2, wave 4. **Depends on:** wave 3 (`m2-worker-idle`, `m2-status-lib` merged) and wave 1 (`m2-transcript-lib`). **Runs concurrently with:** none (runs alone).

## Goal

Expose the M2 visibility data to Claude: a `transcript` command that works mid-turn, partial results for running jobs, full status for any job, opt-in delta streaming from the CLI, and configurable persistence for reviews.

## Ground rules (non-negotiable)

- **Worktree:** you work in your **own git worktree**, created by the orchestrator from branch `orvex/improvement-report` after the previous wave was merged (normally `/home/crew/workspace/codex-plugin-cc-lanes/m2-inspect` on branch `lane/m2-inspect`; use the path you were given). Paths below are relative to your worktree root, and `plugins/codex/scripts/` holds the runtime. The other lanes of your wave run at the same time in their own worktrees, and the orchestrator merges every lane of the wave afterwards. **File ownership is what keeps those merges conflict-free**, so respect it exactly.
- **Beads:** run `bd` from the main checkout: `cd /home/crew/workspace/codex-plugin-cc && bd update <id> --claim` for each bead listed above. If a bead is already claimed (another lane of the same item claimed it), skip the claim and still add your note. At the end, run `bd note <id> "<one paragraph: lane m2-inspect; what changed, tests added, npm test result, open risks>"` for each bead. **Never** run `bd close`: the orchestrator closes beads after review.
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
- `plugins/codex/scripts/lib/codex.mjs`
- `plugins/codex/scripts/lib/transcript.mjs`
- `plugins/codex/scripts/lib/partial-result.mjs`
- `plugins/codex/scripts/lib/render.mjs`
- `plugins/codex/commands/status.md`
- `plugins/codex/skills/codex-drive/SKILL.md`
- `tests/fake-codex-fixture.mjs`
- `tests/helpers.mjs`
- `tests/inspect.test.mjs` (new)

## Do not touch

- No lane runs concurrently with you in this wave.
- Any existing test file not listed under "Files you own" (add your tests in your own new test files).

## Design decisions binding on this lane

- **`transcript <jobId|threadId> [--format md|jsonl] [--items messages,commands,reasoning,files,steers] [--last N] [--max-bytes N] [--json]`:** resolve a job id (any session/workspace) → `buildTranscript({threadId: job.threadId, rolloutPath: job.rolloutPath, eventsFile, prompt: <job prompt>})`; a raw thread id with no job → rollout glob only. `--json` → `{schemaVersion:2, jobId, threadId, source, rolloutPath, truncated, text}`. Works while the job runs.
- **`result <id> --partial [--json]`:** for an active job (after reconcile), return `buildPartialResult` instead of throwing "still running"; for a terminal job, return the stored result (which may itself be `partial:true` from `m2-worker-idle`). Text mode renders last message, files and commands.
- **`status [<id>] --lines N` and `--full`:** wire to `buildSingleJobSnapshot({maxProgressLines, full})`, for all statuses. `status --json` carries `schemaVersion: 2`. Update `commands/status.md` so the command may show progress lines when asked (keep it compact by default).
- **`task --stream`** (and `send` follow-ups): sets `streamDeltas: true` for `runAppServerTurn` (the option and env var exist from `m2-capture`).
- **`reviewPersist`:** config key (`getConfig`/`getGlobalConfig`; `setup --review-persist on|off [--global]`); when on, `review`, `adversarial-review` and the stop gate's review turns run with `ephemeral:false` so rollouts exist. Default off (today's behaviour). Reviews stay read-only.
- **Drive skill:** add rows for `inspect` (`result --partial`, `diff`, `transcript`) with exact flags from `--help`.
- Add everything to `printUsage`/`--help`.

## Implementation guide

- `codex-companion.mjs`: `main` (new `transcript` case), `handleResult`, `handleStatus`, `handleTask`/`buildTaskRequest`, `handleSend`, `handleSetup`, `executeReviewRun`, `printUsage`.
- `lib/codex.mjs`: `runAppServerReview` and the adversarial path (`ephemeral` option only).
- You own `lib/transcript.mjs` and `lib/partial-result.mjs` this wave: fix integration bugs there and list them.

## Fake-Codex fixture

The fixture API from lane `m0-fixture` (plan D2), in short: `installFakeCodex(binDir, behavior, options)`; `setFakeCodexOptions(binDir, patch)`; `options.turnScript` steps (`command`, `fileChange` with `writeFiles`, `agentMessage`, `reasoning`, `plan`, `diff`, `usage`, `delay`, `silence`, `serverRequest`); `options.interrupt: "cooperate"|"ignore"|"ack-only"`; `options.ignoreSigterm`; `options.delays.{initialize,threadStart,turnStart}`; `options.models`, `options.config`, `options.writeRollout`, `options.forceActiveWriter`, `options.turnStatus`; methods `model/list`, `config/read`, `thread/read`; `readFakeRpcLog(binDir, {method, conn, dir})`, `fakeConnections(binDir)`; `occupyBroker(endpoint, {holdMs})`; `startFakeAppServer(binDir)`; helpers `spawnStubborn()`, `waitFor()`, `isPidAlive()`, `makeCompanionWorkspace()`. M0/M1 lanes extended it further, so **read the fixture source for the exact signatures** before writing tests. Note: the fixture answers `thread/unload`, but the real codex-cli 0.157 app-server does **not** have it (probe §6), so plugin code must never call it.

**You own the fixture files in this wave.** If you need a capability that is missing, add it **additively** (new options, new turnScript step types, new helpers) and keep every existing behaviour string and option working. Where the fixture's shapes differ from `docs/app-server-probe.md` ("Fixture shapes"), make the fixture match the probe for the methods you touch.

If the fixture's rollout writer (`options.writeRollout`) does not produce lines in the shapes `lib/transcript.mjs` parses (prompt, steer, agent message, command with exit code), extend it additively so a real fixture run yields a meaningful rollout.

## Tests to write first

`tests/inspect.test.mjs`:
1. A fixture task with a temp `CODEX_HOME` and `writeRollout:true`: `transcript <id> --format md` includes the prompt, a steer sent with `send`, and each command with its exit code.
2. `--max-bytes 4000` → at most 4000 bytes ending with the truncation marker.
3. Mid-turn (during a `delay`): `transcript <id>` and `result <id> --partial --json` both work; the partial result contains the agent message emitted so far.
4. `status <id> --lines 20` on a completed job returns up to 20 lines; `status --json` has `schemaVersion: 2`.
5. `task --stream` removes the delta methods from the recorded `initialize` opt-out list (direct transport).
6. `setup --review-persist on` → a review's `thread/start` has `ephemeral:false`; default stays ephemeral; the review still sends `sandbox:"read-only"`.

## Requirements from the report (verbatim)

The text below is copied verbatim from `docs/IMPROVEMENT-REPORT.md`. Line numbers in it predate M0/M1. The "Probe adjustments" and "Design decisions" sections of this brief override it where they differ.

### FR-7: Expose the Codex rollout path and add a `transcript` subcommand
- **Priority:** P1
- **Problem:** The job record keeps `threadId`, and status and result print `codex resume <threadId>`, but no rollout path is stored and nothing renders the conversation. After a cancel, a restart or (today) a SessionEnd purge, Claude cannot reconstruct what Codex did. Task threads *are* persistent (`persistThread:true` → `ephemeral:false`); only reviews and the stop gate are ephemeral. So rollouts should exist.
- **Evidence:** E3, E4. `codex-companion.mjs` ~720. `lib/codex.mjs` 1162, 1260, 1281, 1291 and 803 (`CODEX_HOME` used only for transfer). `lib/render.mjs` 103-106, 165-166 and 449-490.
- **Proposal:** After the thread starts, resolve the rollout via `thread/read` if it returns a path. Otherwise glob `$CODEX_HOME/sessions/**/rollout-*-<threadId>.jsonl`, with `CODEX_HOME` defaulting to `~/.codex`. Store it as `rolloutPath` and show it in status and result. Add `transcript <jobId|threadId> [--format md|jsonl] [--items messages,commands,reasoning,files,steers] [--last N] [--max-bytes N]`. It renders the prompt, steer messages, agent messages, reasoning summaries, commands with exit codes and file paths. It prefers the rollout, falls back to `events.jsonl`, and works while the job is still running. Make review persistence configurable (`reviewPersist`).
- **Acceptance criteria:** A fixture task with a temp `CODEX_HOME` sets `job.rolloutPath`. `transcript <id> --format md` includes the prompt, every steer message and each command with its exit code. `--max-bytes 4000` gives at most 4000 bytes, ending with a truncation marker. It works mid-turn.

### FR-8: Partial results and fuller status for running jobs
- **Priority:** P2
- **Problem:** `resolveResultJob` throws "still running". `status` has no `--lines` or `--full`; `maxProgressLines` exists in `buildSingleJobSnapshot` but is never wired to the CLI. There is no preview for completed or cancelled jobs, and agent-message blocks are filtered out of the preview. `/codex:status` says to render a compact table without progress. There is no `schemaVersion`.
- **Evidence:** E3. `lib/job-control.mjs` 9, 165-169 and 280-286. `codex-companion.mjs` `handleStatus` ~1332-1357. `commands/status.md` 10-13.
- **Proposal:** Add `result <id> --partial [--json]`, returning `lastAgentMessage`, the reasoning summary so far, `filesChanged` and `commands`, read from events or the log. Add `status --lines N` and `--full`, both covering all statuses, plus `lastMessage`, `lastCommand` (full text), `currentPlan` and `counts:{commands, failedCommands, filesChanged}`. Add `schemaVersion` to `status --json`. Show a sandbox and network badge on each row (WISH-2).
- **Acceptance criteria:** Mid-turn, after one agent message, `result <id> --partial --json` returns it. `status <id> --lines 20` returns up to 20 lines for a completed job. `counts.commands` equals the number of `command.completed` events. A command longer than 96 characters appears intact in `status <id> --json`.

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

- Rollout path: `thread.path` from start/resume/fork/read (probe §4-§6); glob fallback. `includeTurns:true` is not used.

## Acceptance checklist (report PASS/FAIL per line)

- [ ] FR-7: a fixture task with a temp `CODEX_HOME` sets `job.rolloutPath`, and `transcript <id> --format md` includes the prompt, every steer message and each command with its exit code
- [ ] FR-7: `--max-bytes 4000` gives at most 4000 bytes, ending with a truncation marker; it works mid-turn
- [ ] FR-7: review persistence is configurable (`reviewPersist`) and reviews stay read-only
- [ ] FR-8: mid-turn, after one agent message, `result <id> --partial --json` returns it
- [ ] FR-8: `status <id> --lines 20` returns up to 20 lines for a completed job; `status --json` has `schemaVersion`
- [ ] FR-3: `task --stream` enables delta streaming
- [ ] The drive skill lists `transcript`, `diff` and `result --partial` with flags that exist
- [ ] `npm test` green in your worktree; no existing test edited except where this brief allows it

## Required final report (your last message; use exactly these sections)

```
## Lane m2-inspect report
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
