# Lane `m3-control-lib`: Control-op, run-budget and message-ledger libraries (FR-9, FR-17, FR-20)

- **Beads:** `codex-plugin-cc-e8s.4`, `codex-plugin-cc-e8s.7`, `codex-plugin-cc-e8s.6`
- **Report items:** FR-9, FR-17, FR-20. **Scope in this lane:** the **library halves** only: interrupt-with-follow-up ops in `lib/control-channel.mjs`, the budget state machine in `lib/job-budget.mjs`, and the steer-message ledger (`unsend`, message states) in `lib/message-ledger.mjs`. Worker and CLI wiring are lanes `m3-control` (FR-9, FR-17) and `m3-reattach-send` (FR-20).
- **Milestone / wave:** M3, wave 1. **Depends on:** all of M2 merged. **Runs concurrently with:** `m3-resume`, `m3-session-start`.

## Goal

Three M3 features need small, pure, well-tested building blocks before the worker and CLI can use them: an interrupt op that carries a follow-up message, a wall-clock/idle budget evaluator with an 80% wrap-up step, and a ledger that reports the state of every steer message and lets a queued one be withdrawn.

## Ground rules (non-negotiable)

- **Worktree:** you work in your **own git worktree**, created by the orchestrator from branch `orvex/improvement-report` after the previous wave was merged (normally `/home/crew/workspace/codex-plugin-cc-lanes/m3-control-lib` on branch `lane/m3-control-lib`; use the path you were given). Paths below are relative to your worktree root, and `plugins/codex/scripts/` holds the runtime. The other lanes of your wave run at the same time in their own worktrees, and the orchestrator merges every lane of the wave afterwards. **File ownership is what keeps those merges conflict-free**, so respect it exactly.
- **Beads:** run `bd` from the main checkout: `cd /home/crew/workspace/codex-plugin-cc && bd update <id> --claim` for each bead listed above. If a bead is already claimed (another lane of the same item claimed it), skip the claim and still add your note. At the end, run `bd note <id> "<one paragraph: lane m3-control-lib; what changed, tests added, npm test result, open risks>"` for each bead. **Never** run `bd close`: the orchestrator closes beads after review.
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

- `plugins/codex/scripts/lib/control-channel.mjs`
- `plugins/codex/scripts/lib/job-budget.mjs` (new)
- `plugins/codex/scripts/lib/message-ledger.mjs` (new)
- `tests/control-lib.test.mjs` (new)

## Do not touch

- Lane `m3-resume` runs at the same time and owns: `plugins/codex/scripts/lib/args.mjs`, `plugins/codex/scripts/codex-companion.mjs`, `plugins/codex/scripts/lib/codex.mjs`, `plugins/codex/scripts/lib/thread-forks.mjs`, `plugins/codex/scripts/lib/render.mjs`, `plugins/codex/scripts/lib/tracked-jobs.mjs`, `plugins/codex/commands/rescue.md`, `plugins/codex/skills/codex-drive/SKILL.md`, `plugins/codex/skills/codex-cli-runtime/SKILL.md`, `plugins/codex/CHANGELOG.md`, `tests/fake-codex-fixture.mjs`, `tests/helpers.mjs`, `tests/resume.test.mjs`, `tests/orvex.test.mjs`.
- Lane `m3-session-start` runs at the same time and owns: `plugins/codex/scripts/session-lifecycle-hook.mjs`, `plugins/codex/scripts/lib/session-context.mjs`, `tests/session-start.test.mjs`, `tests/fixtures/session-start/`.
- Any existing test file not listed under "Files you own" (add your tests in your own new test files).

## Design decisions binding on this lane

- **`lib/control-channel.mjs` (extend, keep every existing export and behaviour):** `appendInterruptOp(workspaceRoot, jobId, {thenText = null, reason = "user"})` → `{id}` appends `{op:"interrupt", then: thenText ? {text} : null, reason}` (text capped at 64KB; larger → throw `exitCode 2`). `validateControlOp(op)` rejects unknown ops. Reserve (document only) `{op:"continue", text}`; it is **not** implemented in M3 (see probe adjustments).
- **`lib/job-budget.mjs`:** `parseDuration(input)` accepts `1500ms`, `90s`, `10m`, `2h`, `1h30m`, bare numbers as seconds, and `none`/`off` → null; invalid → throws with `exitCode 2`. `createBudget({maxRuntimeMs, idleTimeoutMs, wrapUpRatio = 0.8, startedAt})` and `evaluateBudget(budget, {now, lastEventAt})` → `{action:"none"|"wrap-up"|"interrupt", reason: null|"max-runtime"|"idle-timeout", msLeft}`; `wrap-up` is returned **once** (the budget object remembers it), only for max-runtime, when `now - startedAt >= wrapUpRatio * maxRuntimeMs`; `interrupt` for max-runtime at the limit, or for idle when `now - lastEventAt >= idleTimeoutMs`. `formatWrapUpMessage(msLeft)` → `Wrap up; about N minute(s) left before this job is interrupted. Return your final summary.` (N rounded up, minimum 1).
- **`lib/message-ledger.mjs`:** read the inbox line format in `lib/codex.mjs` (`readInboxEntries`, `resolveClosedInboxFile`) and `handleSend`/`recordDeliveredMessage` in the companion first, and reuse it exactly. `resolveUnsendFile(workspaceRoot, jobId)` → `jobs/<id>.unsend.jsonl`; `appendUnsend(workspaceRoot, jobId, messageId)` → `{status:"voided"|"already-delivered"|"unknown-message"|"job-finished"}` (checks the job's delivered ids first; appends `{id, at}` otherwise); `readUnsentIds(workspaceRoot, jobId)` → Set; `listMessages(workspaceRoot, job)` → `[{id, textExcerpt, status:"queued"|"delivered"|"voided"|"undelivered"|"followed-up", createdAt, deliveredAt, followUpJobId}]` from the inbox (open or `.closed`), the unsend file, `job.deliveredMessageIds`, `job.deliveredMessages` (`[{id, deliveredAt, firstItemId}]`, a field lane `m3-reattach-send` will write; treat it as optional) and the result's `undeliveredMessages`. A separate unsend file (not a marker inside the inbox) keeps the inbox offset logic untouched.

## Implementation guide

- Pure modules: no app-server or broker imports. Use the atomic append helpers and state API already in `lib/state.mjs`/`lib/control-channel.mjs`.

## Fake-Codex fixture

The fixture API from lane `m0-fixture` (plan D2), in short: `installFakeCodex(binDir, behavior, options)`; `setFakeCodexOptions(binDir, patch)`; `options.turnScript` steps (`command`, `fileChange` with `writeFiles`, `agentMessage`, `reasoning`, `plan`, `diff`, `usage`, `delay`, `silence`, `serverRequest`); `options.interrupt: "cooperate"|"ignore"|"ack-only"`; `options.ignoreSigterm`; `options.delays.{initialize,threadStart,turnStart}`; `options.models`, `options.config`, `options.writeRollout`, `options.forceActiveWriter`, `options.turnStatus`; methods `model/list`, `config/read`, `thread/read`; `readFakeRpcLog(binDir, {method, conn, dir})`, `fakeConnections(binDir)`; `occupyBroker(endpoint, {holdMs})`; `startFakeAppServer(binDir)`; helpers `spawnStubborn()`, `waitFor()`, `isPidAlive()`, `makeCompanionWorkspace()`. M0/M1 lanes extended it further, so **read the fixture source for the exact signatures** before writing tests. Note: the fixture answers `thread/unload`, but the real codex-cli 0.157 app-server does **not** have it (probe §6), so plugin code must never call it.

**You do not own the fixture files in this wave** (lane `m3-resume` does). Do not edit `tests/fake-codex-fixture.mjs` or `tests/helpers.mjs`. If you need something the fixture lacks, write a small local helper inside your own test file, or record the gap as a follow-up.

## Tests to write first

`tests/control-lib.test.mjs`:
1. `appendInterruptOp` round-trips through `readControlOps` with `then.text`; an oversized text throws with exitCode 2; existing `cancel` ops still read back unchanged.
2. `parseDuration` table (valid and invalid inputs).
3. `evaluateBudget`: wrap-up exactly once at 80%, interrupt at the limit; idle interrupt from `lastEventAt`; both null → always `none`.
4. `listMessages` for a queued, a delivered, a voided and an undelivered message (hand-written inbox, closed inbox, job record); `appendUnsend` returns `already-delivered` for a delivered id and `voided` for a queued one.

## Requirements from the report (verbatim)

The text below is copied verbatim from `docs/IMPROVEMENT-REPORT.md`. Line numbers in it predate M0/M1. The "Probe adjustments" and "Design decisions" sections of this brief override it where they differ.

### FR-9: Interrupt and redirect on the same thread and the same job
- **Priority:** P1
- **Problem:** When plans change mid-task (E6), Claude can steer with `send`, which Codex may absorb late, or cancel, which kills the worker. There is no primitive that interrupts the current turn and immediately starts a new turn on the same thread. The multi-step fallback (`cancel`, then `send <jobId> msg` on the now-finished job) works but is undocumented, creates a new job id, and may fork (BUG-11).
- **Evidence:** E6. `codex-companion.mjs` `handleCancel` ~1441-1501 and `handleSend` ~1146-1195. `lib/codex.mjs` 1109-1149 and 150-232.
- **Proposal:** Add `interrupt <job-id> [--then <message>|--prompt-file f] [--json]`, with the alias `send <job-id> --interrupt <message>`. It uses the BUG-2 control channel (`{op:'interrupt', then}`). The worker calls `turn/interrupt`, waits for the turn to end, and if a message was given, issues `turn/start` on the same threadId with the same runtime, inside the same job. The job gains `turns[]` (`turnId`, `startedAt`, `endedAt`, `status`, `prompt excerpt`), and the result shows every turn. Without `--then` the job ends as `interrupted`, which is a terminal status that can be resumed by id. Expose it as the model-invocable `/codex:interrupt`, and document it in `codex:drive` alongside the `cancel` + `send <id>` fallback. Also generalize the worker so the same job can accept a `{op:'continue', text}` after natural completion, if that is cheap. Otherwise keep follow-up jobs.
- **Acceptance criteria:** On a long fake turn, `interrupt <id> --then 'service already restarted; skip step 3'` produces `turn/interrupt` followed by `turn/start` on the same threadId, under one job id with `turns.length==2`, and `result <id>` shows both. Without `--then`, status is `interrupted`, and `task --resume <id>` resumes the thread.

### FR-17: Per-job wall-clock budget and idle timeout with automatic interrupt
- **Priority:** P2
- **Problem:** A runaway job can run indefinitely against a live system. The only timeouts are on the caller side (wait at 1h, status `--wait`, steer and import requests).
- **Evidence:** E1. `codex-companion.mjs` ~99-101. `lib/tracked-jobs.mjs` `runTrackedJob` 139-207 (no deadline). `lib/codex.mjs` ~52, ~119 and 532-542.
- **Proposal:** Add `task --max-runtime <dur>` and `--idle-timeout <dur>` (no events for that long), plus `setup --default-max-runtime`. The worker enforces them: at 80% of the budget it delivers a steer through the inbox ("wrap up; N minutes left"). At the limit it interrupts, then runs the BUG-2 escalation, and records `status:'timed-out'` with `cancelReason:'max-runtime'` or `'idle-timeout'`. `wait` and attach exit **4** for a timed-out job, so Claude can tell "the job hit its budget" (4) apart from "the waiter gave up while the job still runs" (124). See the exit-code table in §8.1.
- **Acceptance criteria:** `--max-runtime 5s` on a long fake turn ends as `timed-out` within about 7s, the fixture received `turn/interrupt`, and `wait <id>` exits 4. `wait <other-running-id> --timeout-ms 1000` exits 124 and the job is still running. `--idle-timeout` fires when the fixture goes silent. The 80% wrap-up steer is recorded in the inbox and events.

### FR-20: `send` delivery semantics: lost status, unsend, message listing, and wait-for-delivery
- **Priority:** P2
- **Problem:** `send` already returns `delivered`, `queued` or `finished-undelivered`, and auto-follows-up. But `queued` after the 20s ack timeout is ambiguous, because the worker may be dead. A queued steer cannot be withdrawn, and no command lists messages with their states. Steering is impossible before `turn/start` returns a turnId: lines accumulate. Late messages become a follow-up job.
- **Evidence:** E6. `codex-companion.mjs` ~100 and ~1082-1198. `lib/codex.mjs` 150-232 and 214-230.
- **Proposal:**
  - Add the statuses `lost` (worker dead, via BUG-6) and `followed-up` (with the new job id).
  - Add `--wait-delivery`, which blocks until the message is delivered or the job is terminal. `--timeout-ms 0` already returns immediately; document it as the no-wait mode.
  - Add `unsend <job-id> <msg-id>`, which appends a void marker that the worker honours.
  - Add `messages <job-id> [--json]`, listing each message's id, status, createdAt and deliveredAt. Record `deliveredAt` alongside `deliveredMessageIds`.
  - Log the first Codex item id after each steer.
- **Acceptance criteria:** `send` to a job whose worker is dead returns `lost`. With `unsend` before delivery, the fixture never receives `turn/steer` for that message. `messages --json` lists states and timestamps.

## Probe adjustments and scope narrowing (binding; they override the verbatim text above)

- `codex queue` only schedules a message for a later turn and does not steer (native surfaces §2); it is not used by the message ledger.
- **Scope narrowing (FR-9):** the optional `{op:"continue", text}` after natural completion is **not** implemented in M3; follow-up jobs (`send <finishedJob>`, `task --resume <id>`) remain the way to continue a finished job. The op name is reserved.

## Acceptance checklist (report PASS/FAIL per line)

- [ ] Interrupt ops carry an optional follow-up text and read back through the existing control-channel reader; existing ops unchanged
- [ ] The budget evaluator yields one wrap-up at 80% of max-runtime, an interrupt at the limit (`max-runtime`), and an idle interrupt (`idle-timeout`)
- [ ] The message ledger lists queued, delivered, voided and undelivered messages with timestamps, and `appendUnsend` refuses already-delivered messages
- [ ] The exported APIs match the binding signatures (list them under "Contracts for other lanes")
- [ ] `npm test` green in your worktree; no existing test edited except where this brief allows it

## Required final report (your last message; use exactly these sections)

```
## Lane m3-control-lib report
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
