# Lane `m2-transcript-lib`: Rollout discovery and transcript rendering library (FR-7)

- **Beads:** `codex-plugin-cc-yew.6`
- **Report items:** FR-7. **Scope in this lane:** the **library half** of FR-7: `lib/transcript.mjs` (rollout lookup, rollout and events parsing, markdown/jsonl rendering, byte cap) and unit tests. Recording `rolloutPath` on jobs is lane `m2-worker-idle` (wave 3); the `transcript` subcommand is lane `m2-inspect` (wave 4).
- **Milestone / wave:** M2, wave 1. **Depends on:** all of M0 and M1 merged; the event schema in brief `docs/lanes/m2-events.md` (read its "Design decisions"; `m2-events` runs concurrently, so code against that schema, not against its implementation). **Runs concurrently with:** `m2-events`, `m2-snapshot-lib`, `m2-report-lib`.

## Goal

After a cancel or restart Claude cannot reconstruct what Codex did. Codex task threads are persistent, so rollout files exist. Build the pure library that finds a thread's rollout, parses it (and, as a fallback, the job's `events.jsonl`) into a normalized item list, and renders a bounded markdown or JSONL transcript that works while the job is still running.

## Ground rules (non-negotiable)

- **Worktree:** you work in your **own git worktree**, created by the orchestrator from branch `orvex/improvement-report` after the previous wave was merged (normally `/home/crew/workspace/codex-plugin-cc-lanes/m2-transcript-lib` on branch `lane/m2-transcript-lib`; use the path you were given). Paths below are relative to your worktree root, and `plugins/codex/scripts/` holds the runtime. The other lanes of your wave run at the same time in their own worktrees, and the orchestrator merges every lane of the wave afterwards. **File ownership is what keeps those merges conflict-free**, so respect it exactly.
- **Beads:** run `bd` from the main checkout: `cd /home/crew/workspace/codex-plugin-cc && bd update <id> --claim` for each bead listed above. If a bead is already claimed (another lane of the same item claimed it), skip the claim and still add your note. At the end, run `bd note <id> "<one paragraph: lane m2-transcript-lib; what changed, tests added, npm test result, open risks>"` for each bead. **Never** run `bd close`: the orchestrator closes beads after review.
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

- `plugins/codex/scripts/lib/transcript.mjs` (new)
- `tests/transcript-lib.test.mjs` (new)
- `tests/fixtures/rollouts/` (new directory; synthetic files only)

## Do not touch

- Lane `m2-events` runs at the same time and owns: `plugins/codex/scripts/lib/events.mjs`, `plugins/codex/scripts/lib/tracked-jobs.mjs`, `plugins/codex/scripts/lib/codex.mjs`, `plugins/codex/scripts/codex-companion.mjs`, `plugins/codex/commands/logs.md`, `plugins/codex/skills/codex-drive/SKILL.md`, `tests/commands.test.mjs`, `tests/fake-codex-fixture.mjs`, `tests/helpers.mjs`, `tests/events.test.mjs`.
- Lane `m2-snapshot-lib` runs at the same time and owns: `plugins/codex/scripts/lib/git-snapshot.mjs`, `tests/git-snapshot.test.mjs`.
- Lane `m2-report-lib` runs at the same time and owns: `plugins/codex/scripts/lib/task-report.mjs`, `plugins/codex/scripts/lib/json-schema.mjs`, `plugins/codex/schemas/task-report.schema.json`, `plugins/codex/schemas/task-result.schema.json`, `tests/task-report.test.mjs`.
- `lib/events.mjs` does not exist in your worktree yet; implement your own small events-file reader inside `lib/transcript.mjs` (partial-line safe) instead of importing it.
- Any existing test file not listed under "Files you own" (add your tests in your own new test files).

## Design decisions binding on this lane

- **`findRolloutPath(threadId, {codexHome = process.env.CODEX_HOME || ~/.codex})`** → absolute path or null: search `<codexHome>/sessions/**/rollout-*-<threadId>.jsonl` (walk year/month/day directories newest-first; stop at the first match; bounded to 10k directory entries).
- **`readRolloutItems(file)`** → normalized items `[{kind, ts, text?, command?, cwd?, exitCode?, paths?, turnId?}]` with `kind` in `prompt | steer | message | reasoning | command | file`. Parse Codex rollout JSONL tolerantly: lines look like `{timestamp, type, payload}` with types such as `session_meta`, `turn_context`, `response_item` (payload `type: message` with `role: user|assistant`, `reasoning`, `function_call`/`local_shell_call`/`custom_tool_call` with outputs) and `event_msg` (payload `type: user_message | agent_message | agent_reasoning | exec_command_end {exit_code} | patch_apply_end …`). The first user message of a turn is `prompt`; later user messages inside the same turn are `steer`. Skip unknown or malformed lines and a torn last line. You may read (never modify) **one** recent file under `~/.codex/sessions` to confirm the line shapes, but **do not copy any of its content** into fixtures: write synthetic fixture files under `tests/fixtures/rollouts/`.
- **`readEventItems(eventsFile, {prompt})`** → the same normalized items from the M2 event schema (`message.agent` → message, `reasoning.summary` → reasoning, `command.completed` → command, `file.changed` → file, `steer.delivered` → steer), with the job's prompt as the first `prompt` item.
- **`renderTranscript(items, {format = "md", include = null, last = null, maxBytes = null})`** → `{text, truncated, itemCount}`. `include` is a set drawn from `messages, commands, reasoning, files, steers` (prompt always included). `last` keeps the last N items after filtering (prompt kept). Markdown: `## Prompt`, `### Steer`, `### Codex`, `### Reasoning`, `` `$ command` → exit N ``, `Files: a, b`. JSONL: one normalized item per line. `maxBytes`: the output (UTF-8 bytes, including the marker) is **at most** `maxBytes` and ends with the marker `\n…[transcript truncated: <n> bytes omitted]\n`; never cut inside a multi-byte character.
- **`buildTranscript({threadId, rolloutPath, eventsFile, prompt, codexHome, ...renderOptions})`** → `{text, truncated, source: "rollout"|"events"|"none", rolloutPath}`: prefer the rollout (given path, else `findRolloutPath`), fall back to events, else `source:"none"` with an explanatory text.

## Implementation guide

- Stream-read large files line by line (`fs.readFileSync` is fine up to 50MB; above that read the tail only and mark `truncated`).
- Keep command outputs out of the markdown except for exit codes (they can be huge); JSONL may carry an `outputTail` ≤ 2KB.

## Fake-Codex fixture

The fixture API from lane `m0-fixture` (plan D2), in short: `installFakeCodex(binDir, behavior, options)`; `setFakeCodexOptions(binDir, patch)`; `options.turnScript` steps (`command`, `fileChange` with `writeFiles`, `agentMessage`, `reasoning`, `plan`, `diff`, `usage`, `delay`, `silence`, `serverRequest`); `options.interrupt: "cooperate"|"ignore"|"ack-only"`; `options.ignoreSigterm`; `options.delays.{initialize,threadStart,turnStart}`; `options.models`, `options.config`, `options.writeRollout`, `options.forceActiveWriter`, `options.turnStatus`; methods `model/list`, `config/read`, `thread/read`; `readFakeRpcLog(binDir, {method, conn, dir})`, `fakeConnections(binDir)`; `occupyBroker(endpoint, {holdMs})`; `startFakeAppServer(binDir)`; helpers `spawnStubborn()`, `waitFor()`, `isPidAlive()`, `makeCompanionWorkspace()`. M0/M1 lanes extended it further, so **read the fixture source for the exact signatures** before writing tests. Note: the fixture answers `thread/unload`, but the real codex-cli 0.157 app-server does **not** have it (probe §6), so plugin code must never call it.

**You do not own the fixture files in this wave** (lane `m2-events` does). Do not edit `tests/fake-codex-fixture.mjs` or `tests/helpers.mjs`. If you need something the fixture lacks, write a small local helper inside your own test file, or record the gap as a follow-up.

## Tests to write first

`tests/transcript-lib.test.mjs` with synthetic rollouts in `tests/fixtures/rollouts/` (one completed two-turn thread with a steer, one torn/in-progress file) and a synthetic events file:
1. `findRolloutPath` finds `sessions/2026/09/25/rollout-<ts>-<id>.jsonl` under a temp `CODEX_HOME`; missing → null.
2. Markdown includes the prompt, every steer message, and each command with its exit code; `include` and `last` filter correctly.
3. `maxBytes: 4000` → output ≤ 4000 bytes and ends with the truncation marker; a multi-byte text near the cut is not corrupted.
4. The in-progress (torn last line) rollout renders the complete lines ("works mid-turn").
5. Events fallback when no rollout exists (`source:"events"`).
6. JSONL format round-trips (each line parses).

## Requirements from the report (verbatim)

The text below is copied verbatim from `docs/IMPROVEMENT-REPORT.md`. Line numbers in it predate M0/M1. The "Probe adjustments" and "Design decisions" sections of this brief override it where they differ.

### FR-7: Expose the Codex rollout path and add a `transcript` subcommand
- **Priority:** P1
- **Problem:** The job record keeps `threadId`, and status and result print `codex resume <threadId>`, but no rollout path is stored and nothing renders the conversation. After a cancel, a restart or (today) a SessionEnd purge, Claude cannot reconstruct what Codex did. Task threads *are* persistent (`persistThread:true` → `ephemeral:false`); only reviews and the stop gate are ephemeral. So rollouts should exist.
- **Evidence:** E3, E4. `codex-companion.mjs` ~720. `lib/codex.mjs` 1162, 1260, 1281, 1291 and 803 (`CODEX_HOME` used only for transfer). `lib/render.mjs` 103-106, 165-166 and 449-490.
- **Proposal:** After the thread starts, resolve the rollout via `thread/read` if it returns a path. Otherwise glob `$CODEX_HOME/sessions/**/rollout-*-<threadId>.jsonl`, with `CODEX_HOME` defaulting to `~/.codex`. Store it as `rolloutPath` and show it in status and result. Add `transcript <jobId|threadId> [--format md|jsonl] [--items messages,commands,reasoning,files,steers] [--last N] [--max-bytes N]`. It renders the prompt, steer messages, agent messages, reasoning summaries, commands with exit codes and file paths. It prefers the rollout, falls back to `events.jsonl`, and works while the job is still running. Make review persistence configurable (`reviewPersist`).
- **Acceptance criteria:** A fixture task with a temp `CODEX_HOME` sets `job.rolloutPath`. `transcript <id> --format md` includes the prompt, every steer message and each command with its exit code. `--max-bytes 4000` gives at most 4000 bytes, ending with a truncation marker. It works mid-turn.

## Probe adjustments and scope narrowing (binding; they override the verbatim text above)

- Probe §5: `thread/read` returns `thread.path`, a **nullable** rollout path, and `ThreadStartResponse.thread.path` carries it too (null for ephemeral threads). Prefer a recorded path; the glob is the fallback. `thread/read` with `includeTurns:true` errors before the first turn (`list_turns is not supported yet`), so this library must not depend on it.

## Acceptance checklist (report PASS/FAIL per line)

- [ ] Rollout lookup via the `$CODEX_HOME/sessions/**/rollout-*-<threadId>.jsonl` glob works (library level; `job.rolloutPath` is lane `m2-worker-idle`)
- [ ] The markdown transcript includes the prompt, every steer message and each command with its exit code
- [ ] `maxBytes: 4000` gives at most 4000 bytes, ending with a truncation marker
- [ ] It works on a rollout that is still being written (torn last line)
- [ ] Events-file fallback works
- [ ] The exported API matches the binding signatures (list them under "Contracts for other lanes")
- [ ] `npm test` green in your worktree; no existing test edited except where this brief allows it

## Required final report (your last message; use exactly these sections)

```
## Lane m2-transcript-lib report
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
