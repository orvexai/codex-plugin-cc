# Lane `m3-reattach-send`: `attach`/`adopt`/`status --all-sessions`, and `send` delivery semantics (`unsend`, `messages`, `--wait-delivery`) (FR-10, FR-20)

- **Beads:** `codex-plugin-cc-e8s.5`, `codex-plugin-cc-e8s.6`
- **Report items:** FR-10, FR-20. **Scope in this lane:** the **CLI half** of FR-10 (items 1-2, plus the `attach` hint in the SessionStart context) and all of FR-20.
- **Milestone / wave:** M3, wave 3. **Depends on:** wave 2 (`m3-control`, `m3-reattach-lib` merged). **Runs concurrently with:** none (runs alone).

## Goal

Let a new session list, adopt and follow jobs from earlier sessions, and make `send` truthful and controllable: distinguish a dead worker (`lost`) from pending delivery, report follow-ups by job id, wait for delivery on request, withdraw a queued message, and list every message's state.

## Ground rules (non-negotiable)

- **Worktree:** you work in your **own git worktree**, created by the orchestrator from branch `orvex/improvement-report` after the previous wave was merged (normally `/home/crew/workspace/codex-plugin-cc-lanes/m3-reattach-send` on branch `lane/m3-reattach-send`; use the path you were given). Paths below are relative to your worktree root, and `plugins/codex/scripts/` holds the runtime. The other lanes of your wave run at the same time in their own worktrees, and the orchestrator merges every lane of the wave afterwards. **File ownership is what keeps those merges conflict-free**, so respect it exactly.
- **Beads:** run `bd` from the main checkout: `cd /home/crew/workspace/codex-plugin-cc && bd update <id> --claim` for each bead listed above. If a bead is already claimed (another lane of the same item claimed it), skip the claim and still add your note. At the end, run `bd note <id> "<one paragraph: lane m3-reattach-send; what changed, tests added, npm test result, open risks>"` for each bead. **Never** run `bd close`: the orchestrator closes beads after review.
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
- `plugins/codex/scripts/lib/message-ledger.mjs`
- `plugins/codex/scripts/lib/job-adopt.mjs`
- `plugins/codex/scripts/lib/job-control.mjs`
- `plugins/codex/scripts/lib/render.mjs`
- `plugins/codex/scripts/lib/session-context.mjs`
- `plugins/codex/commands/attach.md` (new)
- `plugins/codex/commands/messages.md` (new)
- `plugins/codex/commands/send.md`
- `plugins/codex/skills/codex-drive/SKILL.md`
- `tests/commands.test.mjs` (only the command-file list and new assertions for `attach.md`/`messages.md`)
- `tests/fake-codex-fixture.mjs`
- `tests/helpers.mjs`
- `tests/reattach.test.mjs` (new)
- `tests/messages.test.mjs` (new)

## Do not touch

- No lane runs concurrently with you in this wave.
- Any existing test file not listed under "Files you own" (add your tests in your own new test files).

## Design decisions binding on this lane

- **`status --all-sessions`** (alias `--workspace`): `buildStatusSnapshot({allSessions:true})`, rendered with an "Other sessions" section (id, session, owner, liveness, badge). `status --json --all-sessions` returns the grouped snapshot.
- **`attach <job-id> [--follow] [--timeout-ms N] [--json]`:** `adoptJob(..., {sessionId: current, ownerKind:"attach", ownerPid: process.pid})`, start the owner heartbeat, then behave exactly like the watcher half of `task --attach` from `m0-ownership` (reuse that code; refactor it into a shared function if needed): stream compact events (`formatCompactEvent`) to stderr, print the rendered result on completion, exit `exitCodeForJob(status, {mode:"attach"})`; SIGTERM/SIGINT/SIGHUP → verified cancel, exit 130; `--timeout-ms` → `releaseOwnership`, print wait/cancel commands, exit 124. `--follow` is accepted and is the default behaviour. A terminal job: adopt (session only), print the result, exit with its code.
- **`adopt <job-id> [--json]`:** adopt without following: session → current, owner → `detached` with `onOwnerExit:"continue"` (nothing is watching it). After `attach`/`adopt`, a bare `status` and a bare `cancel` in the new session target the job.
- **SessionStart hint:** add `attach <id>` to the hints in `lib/session-context.mjs` and the `status --all-sessions` overflow hint.
- **FR-20 delivery statuses:** `send` reports `delivered | queued | finished-undelivered | lost | followed-up` (`followed-up` includes `followUpJobId`; today's follow-up path must set this status explicitly). `lost` = the worker is dead after reconcile (existing behaviour from `m0-liveness` when `--no-follow-up`; keep it).
- **`--wait-delivery`:** block until the message is delivered or the job is terminal (poll the job record; honours `--timeout-ms` when given, otherwise no limit). Document `--timeout-ms 0` as the no-wait mode in `send --help` and `commands/send.md`.
- **Delivery records:** `recordDeliveredMessage` also appends `{id, deliveredAt, firstItemId:null}` to `job.deliveredMessages` (keep `deliveredMessageIds`). In `lib/codex.mjs`, after a steer is accepted, log the first Codex item id that starts afterwards (`[codex] steer <msgId> → first item <itemId>`) and update `firstItemId` through a progress payload.
- **`unsend <job-id> <msg-id> [--json]`:** `appendUnsend`; the worker's steering loop (`startInboxSteering`) reads `readUnsentIds` before **each** delivery attempt and skips voided ids (they are reported as `voided`, never steered). Exit 0 for `voided`, 1 for `already-delivered`/`job-finished`, 2 for `unknown-message`.
- **`messages <job-id> [--json]`:** `listMessages` rendered as a table (id, status, createdAt, deliveredAt, excerpt).
- **Docs:** `commands/attach.md` and `commands/messages.md` (model-invocable), `commands/send.md` (`--wait-delivery`, `--timeout-ms 0`, `unsend`), drive-skill rows `reattach` and message listing. Update the command-list assertion.

## Implementation guide

- `codex-companion.mjs`: `main` (`attach`, `adopt`, `unsend`, `messages` cases), `handleStatus`, `handleSend`, `deliverToRunningJob`, `recordDeliveredMessage`, `renderDelivery`, the attach watcher from `m0-ownership`, `printUsage`.
- `lib/codex.mjs`: `startInboxSteering` (unsend check, first-item log).
- Owned wave-1/2 libraries: fix integration bugs there and list them.

## Fake-Codex fixture

The fixture API from lane `m0-fixture` (plan D2), in short: `installFakeCodex(binDir, behavior, options)`; `setFakeCodexOptions(binDir, patch)`; `options.turnScript` steps (`command`, `fileChange` with `writeFiles`, `agentMessage`, `reasoning`, `plan`, `diff`, `usage`, `delay`, `silence`, `serverRequest`); `options.interrupt: "cooperate"|"ignore"|"ack-only"`; `options.ignoreSigterm`; `options.delays.{initialize,threadStart,turnStart}`; `options.models`, `options.config`, `options.writeRollout`, `options.forceActiveWriter`, `options.turnStatus`; methods `model/list`, `config/read`, `thread/read`; `readFakeRpcLog(binDir, {method, conn, dir})`, `fakeConnections(binDir)`; `occupyBroker(endpoint, {holdMs})`; `startFakeAppServer(binDir)`; helpers `spawnStubborn()`, `waitFor()`, `isPidAlive()`, `makeCompanionWorkspace()`. M0/M1 lanes extended it further, so **read the fixture source for the exact signatures** before writing tests. Note: the fixture answers `thread/unload`, but the real codex-cli 0.157 app-server does **not** have it (probe §6), so plugin code must never call it.

**You own the fixture files in this wave.** If you need a capability that is missing, add it **additively** (new options, new turnScript step types, new helpers) and keep every existing behaviour string and option working. Where the fixture's shapes differ from `docs/app-server-probe.md` ("Fixture shapes"), make the fixture match the probe for the methods you touch.

## Tests to write first

`tests/reattach.test.mjs`:
1. Create a running job in session A; with a different `CODEX_COMPANION_SESSION_ID` (B), `status --all-sessions` lists it; `attach <id>` succeeds, streams, and exits 0 when the job completes; afterwards a bare `status` in B shows it and a bare `cancel` in B targets it (use a second slow job for the cancel check).
2. SIGTERM an `attach` process → verified cancel, exit 130, `cancelReason` recorded.
3. `adopt <id>` then kill nothing: the job continues (owner detached); B's bare `status` lists it.
4. B's SessionStart output mentions the job id and the `attach` hint.
`tests/messages.test.mjs`:
5. `send` to a job whose worker is dead returns `lost` (with `--no-follow-up`).
6. `send` to a finished job returns `followed-up` with `followUpJobId`.
7. `unsend` before delivery (steer-before-turnId window via `delays.turnStart`, or a worker with a long inbox poll) → the fixture never receives `turn/steer` for that message; `messages --json` shows it `voided`.
8. `messages --json` lists states and timestamps (`deliveredAt` for delivered ones).
9. `--wait-delivery` returns only after delivery.
10. The first-item log line appears after a delivered steer.

## Requirements from the report (verbatim)

The text below is copied verbatim from `docs/IMPROVEMENT-REPORT.md`. Line numbers in it predate M0/M1. The "Probe adjustments" and "Design decisions" sections of this brief override it where they differ.

### FR-10: Reattach after a restart or from another session; SessionStart awareness
- **Priority:** P1
- **Problem:** Id-based access (`status`, `wait`, `cancel`, `result` and `send` with an id) already works across sessions and workspaces. But nothing *lists* other sessions' jobs, adopts a job, follows it, or tells a new session that jobs exist. The SessionStart hook only exports env vars. (It also depends on BUG-3, because today the records are deleted.)
- **Evidence:** E4. `lib/job-control.mjs` 15-25 and 230-255. `codex-companion.mjs` ~505-511. `scripts/session-lifecycle-hook.mjs` 81-91.
- **Proposal:**
  1. `status --all-sessions` (alias `--workspace`) lists every job in the workspace with `sessionId`, owner and lease state, and liveness.
  2. `attach <job-id> [--follow]` sets `job.sessionId` to the current session, takes the owner lease (BUG-1), and streams events until the job is terminal, exiting with the job's code. `adopt <job-id>` does the same without following.
  3. SessionStart emits `hookSpecificOutput.additionalContext` listing this workspace's jobs from prior sessions that are running or finished within the last 24h and unread: id, status, sandbox badge, and `attach`/`result`/`cancel` hints. Keep the hook within its 5s budget: read state files only, no app-server calls.
- **Acceptance criteria:** Create a job in session A, then start session B with a different `CODEX_COMPANION_SESSION_ID`. `status --all-sessions` lists the job. `attach <id>` succeeds, after which a bare `status` and `cancel` in B target it. B's SessionStart output mentions the job id. A resumed Claude session (`claude --resume`/`--continue`, SessionStart `source: "resume"`) that reports the same `session_id` sees its own earlier jobs as its own without `attach`; if the hook input carries a new id, the SessionStart context still lists the old jobs. (Record which of the two Claude Code does in a test fixture; E4 was a process restart and it was unclear which applied.)

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

### 8.1 Companion CLI (`orvex-codex <cmd>` ≡ `node scripts/codex-companion.mjs <cmd>`)

All commands accept `--json`. The JSON output carries `schemaVersion`. Canonical exit codes (every item above defers to this table):

| Code | Meaning |
|---|---|
| 0 | ok, or the job completed |
| 1 | the job failed (`wait` also returns 1 for cancelled, for backward compatibility with today's 0/1/124 contract) |
| 2 | usage or validation error, unknown model, invalid structured output, or `cancel-failed` (the JSON `error.code` tells them apart) |
| 3 | the job is `lost` or `orphaned` |
| 4 | the job itself ended `timed-out` (FR-17) |
| 124 | the *waiter* timed out; the job is still running |
| 130 | the job was cancelled or interrupted (`attach` and foreground `task`) |

```
task [prompt|--prompt-file f|stdin]
     [--attach|--follow | --background [--detach] | (foreground default)] [--timeout-ms N]
     [--profile p] [--sandbox m | --read-only | --write | --full-access] [--network|--no-network]
     [--model m|-m] [--effort e] [--cwd d|-C] [--name n]
     [--resume [last|<jobId>|<threadId>]] [--thread <threadId>] [--resume-last] [--fresh]
     [--worktree[=name]] [--base ref] [--shared-tree]
     [--output-schema file|builtin:task-report] [--expect-changes]
     [--max-runtime dur] [--idle-timeout dur]
     [--on-owner-exit cancel|continue] [--owner-pid pid] [--on-writer-conflict fork|wait|fail]
     [-c key=value]... [--codex-profile p] [--developer-instructions f] [--lane-preamble f|builtin:delegated-worker]
     [--skills off|allow:glob|deny:glob] [--hooks off] [--no-agents-md]
     [--format brief|full|json] [--max-chars N] [--progress-stderr] [--stream]
send <jobId> [msg|--prompt-file|stdin] [--interrupt] [--timeout-ms N] [--wait-delivery] [--no-follow-up] [runtime flags] [--background|--attach]
interrupt <jobId> [--then msg|--prompt-file f]
unsend <jobId> <msgId>
messages <jobId>
cancel [<jobId>|--all [--workspace|--everywhere]|--group g] [--grace-ms N] [--force]
wait [ids...] [--any] [--group g] [--timeout-ms N] [--poll-interval-ms N] [--format brief|json]
attach <jobId> [--follow]     adopt <jobId>
status [<jobId>] [--all] [--all-sessions|--workspace] [--lines N] [--full] [--wait --timeout-ms N]
result [<jobId>] [--partial] [--report-only] [--diff] [--files] [--format brief|full|json] [--output f]
events <jobId> [--since seq] [--follow] [--types a,b] [--compact]
logs <jobId> [--tail N] [--follow]
diff <jobId> [--stat|--name-only]
transcript <jobId|threadId> [--format md|jsonl] [--items ...] [--last N] [--max-bytes N]
fork <jobId|threadId> [prompt] [--background|--attach] [runtime flags]
fanout --spec f|- [--max-parallel N] [--group g] [--worktree] [--output-schema ...] [--attach]
worktree list | merge <jobId> [--ff-only|--squash] | discard <jobId> | pr <jobId>
models [--all] [--refresh]
config show | set <key> <value> [--global|--repo] | unset <key> [...] | doctor
setup [existing flags] [--profile p] [--default-profile p] [--alias name=id|name=none]
      [--default-* for every key in §8.4] [--print-claude-md] [--install-cli]
broker status | logs [--tail N] | restart | stop [--if-idle]
gc [--older-than dur] [--keep N] [--dry-run]     history [--since dur]
lane-context     mcp                               (stdio MCP server)
review / adversarial-review [--background|--attach] [--effort e] [--model m] ...   (existing + WISH-3)
```

The launch line (first line of stdout, text mode): `CODEX_JOB <jobId> status=<queued|running> thread=<id|pending> sandbox=<m> network=<eff> log=<path>`

## Probe adjustments and scope narrowing (binding; they override the verbatim text above)

- `codex queue` schedules a message for a **later** turn (native surfaces §2); it is not a steer and is not used by `send`. `turn/steer` requires `expectedTurnId` (probe §7) and native review turns cannot be steered, so `send` to a native `review` job keeps failing with a clear message.

## Acceptance checklist (report PASS/FAIL per line)

- [ ] FR-10: create a job in session A, then start session B with a different `CODEX_COMPANION_SESSION_ID`; `status --all-sessions` lists the job
- [ ] FR-10: `attach <id>` succeeds, after which a bare `status` and `cancel` in B target it
- [ ] FR-10: B's SessionStart output mentions the job id (with the `attach` hint)
- [ ] FR-10: `adopt <job-id>` adopts without following
- [ ] FR-20: `send` to a job whose worker is dead returns `lost`
- [ ] FR-20: with `unsend` before delivery, the fixture never receives `turn/steer` for that message
- [ ] FR-20: `messages --json` lists states and timestamps
- [ ] FR-20: `followed-up` status with the new job id; `--wait-delivery`; `deliveredAt` recorded; the first Codex item id after each steer is logged
- [ ] `commands/attach.md` and `commands/messages.md` exist and are model-invocable; the drive skill lists attach and messages
- [ ] `npm test` green in your worktree; no existing test edited except where this brief allows it

## Required final report (your last message; use exactly these sections)

```
## Lane m3-reattach-send report
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
