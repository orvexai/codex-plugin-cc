# Lane `m3-resume`: `--resume <id>`/`--thread`, fork visibility and policy, and an explicit `fork` command (BUG-7, BUG-11, FR-21)

- **Beads:** `codex-plugin-cc-e8s.1`, `codex-plugin-cc-e8s.2`, `codex-plugin-cc-e8s.3`
- **Report items:** BUG-7, BUG-11, FR-21. **Scope in this lane:** all of BUG-7, BUG-11 (narrowed: no `thread/unload`, see probe adjustments) and FR-21 (the MCP `codex_fork` tool is lane `m5-mcp`).
- **Milestone / wave:** M3, wave 1. **Depends on:** all of M2 merged. **Runs concurrently with:** `m3-session-start`, `m3-control-lib`.

## Goal

`task --resume thr_abc 'fix X'` silently resumes the *last* thread with the prompt `thr_abc fix X`, and follow-ups that land on another app-server silently fork the thread with no structured record. Make `--resume` target a job or thread explicitly (keeping bare `--resume` working), add `--thread`, record and resolve forks, give callers a writer-conflict policy, and add an explicit `fork` command.

## Ground rules (non-negotiable)

- **Worktree:** you work in your **own git worktree**, created by the orchestrator from branch `orvex/improvement-report` after the previous wave was merged (normally `/home/crew/workspace/codex-plugin-cc-lanes/m3-resume` on branch `lane/m3-resume`; use the path you were given). Paths below are relative to your worktree root, and `plugins/codex/scripts/` holds the runtime. The other lanes of your wave run at the same time in their own worktrees, and the orchestrator merges every lane of the wave afterwards. **File ownership is what keeps those merges conflict-free**, so respect it exactly.
- **Beads:** run `bd` from the main checkout: `cd /home/crew/workspace/codex-plugin-cc && bd update <id> --claim` for each bead listed above. If a bead is already claimed (another lane of the same item claimed it), skip the claim and still add your note. At the end, run `bd note <id> "<one paragraph: lane m3-resume; what changed, tests added, npm test result, open risks>"` for each bead. **Never** run `bd close`: the orchestrator closes beads after review.
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

- `plugins/codex/scripts/lib/args.mjs`
- `plugins/codex/scripts/codex-companion.mjs`
- `plugins/codex/scripts/lib/codex.mjs`
- `plugins/codex/scripts/lib/thread-forks.mjs` (new)
- `plugins/codex/scripts/lib/render.mjs`
- `plugins/codex/scripts/lib/tracked-jobs.mjs`
- `plugins/codex/commands/rescue.md`
- `plugins/codex/skills/codex-drive/SKILL.md`
- `plugins/codex/skills/codex-cli-runtime/SKILL.md`
- `plugins/codex/CHANGELOG.md`
- `tests/fake-codex-fixture.mjs`
- `tests/helpers.mjs`
- `tests/resume.test.mjs` (new)
- `tests/orvex.test.mjs` (only the automatic-fork test around line 255, and only if its assertions conflict with the new `forked`/`forkedFromThreadId` fields)

## Do not touch

- Lane `m3-session-start` runs at the same time and owns: `plugins/codex/scripts/session-lifecycle-hook.mjs`, `plugins/codex/scripts/lib/session-context.mjs`, `tests/session-start.test.mjs`, `tests/fixtures/session-start/`.
- Lane `m3-control-lib` runs at the same time and owns: `plugins/codex/scripts/lib/control-channel.mjs`, `plugins/codex/scripts/lib/job-budget.mjs`, `plugins/codex/scripts/lib/message-ledger.mjs`, `tests/control-lib.test.mjs`.
- Any existing test file not listed under "Files you own" (add your tests in your own new test files).

## Design decisions binding on this lane

- **Optional-value options in `lib/args.mjs`:** `parseArgs(argv, {valueOptions, booleanOptions, optionalValueOptions: {resume: {defaultValue: "last", accepts: looksLikeResumeTarget}}})`. The next token is consumed as the value **only** if `accepts(token)` is true: `last`, a job id (`/^(task|review)-[a-z0-9-]+$/i`), a UUID thread id, or a `thr_…` id. Otherwise (bare flag, next token is a flag, or the next token is prompt text) the value is `"last"` and the token stays positional. `--resume=<v>` always takes `<v>`. This keeps `task --resume 'fix the bug'` meaning resume-last (backward compatible), and `task --resume thr_abc 'x'` meaning thread `thr_abc` with prompt `x`.
- **Targets:** `--resume last` = today's `--resume-last`. A job id resolves (any workspace, `findJobAcrossWorkspaces`) to its `threadId` and sets `resumedFromJobId`. A thread id is used as is; `--thread <threadId>` is the explicit form. Both go through `buildTaskRequest` → `resumeThreadId`. Before creating a job record, validate the thread with `thread/read {threadId}` (no `includeTurns`): not found → `thread not found: <id>` on stderr, exit 2, no job. Record `resumedFromThreadId` and `resumedFromJobId` on the job and in `result --json`.
- **Refusal rule:** refuse only when an **active** job (after reconcile) holds the **same** thread; unrelated running jobs no longer block a resume.
- **Fork recording (BUG-11):** whenever `runAppServerTurn` falls back to `thread/fork`, return `{forked:true, forkedFromThreadId}`; the job and payload get `forkedFromThreadId`, `forked:true`, and `warnings[]` gets `continued on a fork of <old> (thread held by another Codex process)`. Render `Continued on forked thread <new> (from <old>)` in the result and status. Keep the existing progress line.
- **`lib/thread-forks.mjs`:** `recordThreadFork(workspaceRoot, fromThreadId, toThreadId, {jobId})` persists `<stateDir>/thread-forks.json` (atomic write, under the state lock or its own small lock); `resolveLatestFork(workspaceRoot, threadId)` follows the chain (cycle-safe) and returns `{threadId, chain}`. `--thread <old>`/`--resume <old>` resolve to the latest fork and print `Note: thread <old> was forked; continuing on <new>.`
- **`--on-writer-conflict fork|wait|fail`** on `task` and `send` (default `fork`, with the warning above). `fail` → the job fails with `errorCode:"thread-writer-conflict"` and a foreground/attach exit 1 (the job ran and failed) — make the message name the thread. `wait` → retry `thread/resume` every 2s for up to `CODEX_COMPANION_WRITER_WAIT_MS` (default 30000; add to `LEAKY_ENV`), then fail as `fail` does.
- **Prefer resuming in place:** when the thread's last job ran on the broker (`job.transport === "broker"`), a follow-up connects through the broker first (today's default); only on broker-busy does the direct fallback apply, which is where the writer conflict and the fork policy come in. Do not add any unload call.
- **Resume sandbox:** a follow-up that inherits an explicit sandbox (source not `codex-config`/built-in) sends it explicitly on `thread/resume`/`thread/fork`. After resume, compare the response's effective `sandbox` with what was requested/inherited; on a mismatch add a warning and record the effective value (see probe adjustments).
- **FR-21 `fork <jobId|threadId> [prompt] [--background|--attach] [runtime flags]`:** new job whose first action is `thread/fork {threadId}` (add a `forkThreadId` option to `runAppServerTurn` that starts from a fork instead of start/resume), `forkedFromThreadId` = the parent thread, `forkedFromJobId` when a job id was given. Default prompt when none: `DEFAULT_CONTINUE_PROMPT`. Launch-mode flags behave as for `task` (including the bypass/ownership coupling from FR-25).
- **Docs:** `commands/rescue.md` and `skills/codex-drive/SKILL.md` map "continue job X" to `task --resume <jobId>` (and `send <jobId>` for a finished job), add the `fork` row, and `skills/codex-cli-runtime/SKILL.md` documents `--resume <id>`/`--thread`. Add a CHANGELOG entry describing the `--resume` parse change.

## Implementation guide

- `lib/args.mjs`: `parseArgs`. `codex-companion.mjs`: `handleTask` (booleanOptions currently includes `resume`), `buildTaskRequest`, `resolveLatestTrackedTaskThread`, `findLatestResumableTaskJob`, `handleSend` (follow-up path), `executeTaskRun`, `printUsage`, `main` (`fork` case).
- `lib/codex.mjs`: `runAppServerTurn` (fork fallback), `resumeThread`, `withAppServer`.
- `lib/render.mjs`: `renderTaskResult`, `pushJobDetails`. `lib/tracked-jobs.mjs`: `createJobRecord` (new fields).

## Fake-Codex fixture

The fixture API from lane `m0-fixture` (plan D2), in short: `installFakeCodex(binDir, behavior, options)`; `setFakeCodexOptions(binDir, patch)`; `options.turnScript` steps (`command`, `fileChange` with `writeFiles`, `agentMessage`, `reasoning`, `plan`, `diff`, `usage`, `delay`, `silence`, `serverRequest`); `options.interrupt: "cooperate"|"ignore"|"ack-only"`; `options.ignoreSigterm`; `options.delays.{initialize,threadStart,turnStart}`; `options.models`, `options.config`, `options.writeRollout`, `options.forceActiveWriter`, `options.turnStatus`; methods `model/list`, `config/read`, `thread/read`; `readFakeRpcLog(binDir, {method, conn, dir})`, `fakeConnections(binDir)`; `occupyBroker(endpoint, {holdMs})`; `startFakeAppServer(binDir)`; helpers `spawnStubborn()`, `waitFor()`, `isPidAlive()`, `makeCompanionWorkspace()`. M0/M1 lanes extended it further, so **read the fixture source for the exact signatures** before writing tests. Note: the fixture answers `thread/unload`, but the real codex-cli 0.157 app-server does **not** have it (probe §6), so plugin code must never call it.

**You own the fixture files in this wave.** If you need a capability that is missing, add it **additively** (new options, new turnScript step types, new helpers) and keep every existing behaviour string and option working. Where the fixture's shapes differ from `docs/app-server-probe.md` ("Fixture shapes"), make the fixture match the probe for the methods you touch.

Make `thread/read` return a JSON-RPC error `thread not found` (or the real server's message shape, if the probe or generated types show one) for unknown thread ids, and make `thread/fork` responses include `thread.path`, `model`, `sandbox` like `thread/start`. Add an option `resumeSandboxOverride: "danger-full-access"` that makes `thread/resume` report that effective sandbox regardless of the request (to test the mismatch warning).

## Tests to write first

`tests/resume.test.mjs`:
1. `task --resume <jobId> 'x'` and `task --resume <threadId> 'x'` both send `thread/resume` with that id and a `turn/start` whose input text is exactly `x`.
2. `task --resume 'fix the bug'` behaves like `--resume-last` with the prompt `fix the bug`; a bare `--resume` too.
3. Unknown id → exit 2, stderr contains `thread not found`, no job record.
4. With job A running (slow turn), `task --resume <jobB>` (B finished, different thread) succeeds.
5. `forceActiveWriter`: `send <finishedJob> msg` → `result --json` has `forked:true`, `forkedFromThreadId`, a warning; text shows "Continued on forked thread".
6. `--on-writer-conflict fail` exits non-zero and names the thread; `wait` with `CODEX_COMPANION_WRITER_WAIT_MS=500` gives up and fails.
7. After a recorded fork, `task --thread <old> 'y'` resumes the fork's id and prints the notice.
8. Under the broker (idle), `send` on a finished job resumes the same threadId (no fork).
9. `fork <jobId> 'try B'` → a new job with a different threadId and `forkedFromThreadId` equal to the parent's.
10. Resume sandbox mismatch (`resumeSandboxOverride`) → warning recorded.
11. `thread/unload` never appears in the RPC log.

## Requirements from the report (verbatim)

The text below is copied verbatim from `docs/IMPROVEMENT-REPORT.md`. Line numbers in it predate M0/M1. The "Probe adjustments" and "Design decisions" sections of this brief override it where they differ.

### BUG-7: `task --resume <threadId>` silently ignores the id, resumes the last thread, and prepends the id to the prompt
- **Priority:** P1
- **Problem:** `resume` is registered in `booleanOptions`, and `resumeLast = options['resume-last'] || options.resume`. So `task --resume thr_abc 'fix X'` resumes the latest finished task in the session with the prompt `thr_abc fix X`. `task` cannot target a specific job or thread. Resume is also refused while *any* unrelated task in the session is running. The existing workaround, `send <jobId> msg` on a finished job, works across sessions but cannot take a raw thread id and is not exposed through rescue.
- **Evidence:** E7. `codex-companion.mjs` ~1008 (`resume` in booleanOptions), ~1020, `resolveLatestTrackedTaskThread` ~533-555. Workaround in `handleSend` ~1146-1195.
- **Proposal:** Make `--resume` a value option that accepts `last`, a job id (`task-…`, resolved to its threadId from any workspace through `findJobAcrossWorkspaces`) or a raw Codex thread id. A bare `--resume` with no value, or followed by another flag, means `last`, for backward compatibility; the parser needs an "optional value" mode in `lib/args.mjs`. Add `--thread <threadId>` as an explicit form. Reuse `resumeThreadId` in `buildTaskRequest`. Validate that the thread exists with `thread/read`, failing with `thread not found: <id>` (exit 2). Record `resumedFromThreadId` and `resumedFromJobId`. Refuse only when a running job holds the *same* thread. If the thread has been forked (BUG-11), map it to the latest fork and print a notice. Update the rescue docs and skill: "continue job X" maps to `--resume <id>`.
- **Acceptance criteria:**
  - `task --resume <jobId> 'x'` and `task --resume <threadId> 'x'` both cause thread/resume with that id and the prompt exactly `x`.
  - An unknown id exits non-zero with `thread not found`.
  - A bare `--resume` behaves like `--resume-last`.
  - With job A running, `task --resume <jobB>` succeeds when B is on a different thread.

### BUG-11: Follow-ups fork threads, splitting history with no structured record
- **Priority:** P2
- **Problem:** The shared broker keeps a finished job's thread loaded with its writer. A follow-up (`send` on a finished job, or `--resume-last`) that lands on a direct app-server, for example after a busy fallback, gets "active writer" and continues on a `thread/fork` with a new thread id. A progress and log line is emitted ("Thread X is held by another Codex process; continuing on a fork of it."), and CHANGELOG.md:17 documents the behaviour. However, there is no `forkedFrom` in the job or payload, no `forked` flag in JSON, no mapping from old thread to fork, no policy switch, and nothing unloads the thread.
- **Evidence:** `lib/codex.mjs` 762-791 and 1253-1284. `app-server-broker.mjs` 174-183. `CHANGELOG.md` 17. `tests/orvex.test.mjs` ~255. No `thread/unload` anywhere.
- **Proposal:**
  1. After a turn completes and its job is terminal, the broker releases or unloads the thread (verify that the app-server supports `thread/unload` or an equivalent), so follow-ups resume in place.
  2. On any fork, record `forkedFromThreadId` in the job and payload, add `forked:true` and a warning to the JSON output, and render "Continued on forked thread X (from Y)".
  3. `--on-writer-conflict fork|wait|fail` on task and send (default `fork`, with a warning).
  4. Keep a per-workspace `threadForks` map so that `--thread <old>` and `--resume <old>` resolve to the latest fork.
- **Acceptance criteria:** Under the broker, `send` on a finished job resumes the *same* threadId. A forced active-writer case gives `result --json` with `forked:true` and `forkedFromThreadId` set. `--on-writer-conflict fail` exits non-zero. `task --thread <old>` continues on the fork and prints a notice.

### FR-21: An explicit `fork` command
- **Priority:** P2
- **Problem:** There is no user-facing fork for trying alternatives from the same context. The automatic fork is covered in BUG-11.
- **Evidence:** `lib/codex.mjs` 1253-1284.
- **Proposal:** Add `fork <jobId|threadId> [prompt] [--background|--attach] [runtime flags]`, which creates a new job via `thread/fork` with `forkedFromThreadId`. Mirror it as the MCP tool `codex_fork`.
- **Acceptance criteria:** `fork <jobId> 'try B'` produces a job with a different threadId and `forkedFromThreadId` equal to the parent's.

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

- **No `thread/unload` (probe §6):** the real app-server rejects it (`unknown variant`). BUG-11 proposal step 1 ("the broker releases or unloads the thread") is **dropped**. Instead: follow-ups prefer the broker that already holds the thread (resume in place), and the fork policy (`--on-writer-conflict`) plus structured fork records handle the direct-fallback case. The criterion "Under the broker, `send` on a finished job resumes the same threadId" is tested with an idle broker.
- **`thread/read` (probe §5):** use it without `includeTurns` to validate that a thread exists (`includeTurns:true` errors before the first turn). A persisted thread is readable from another app-server process after the original closed.
- **Resume sandbox (probe §6):** a thread started explicitly `read-only` reported `dangerFullAccess` when resumed under this host's config. So a resume does not preserve the original sandbox by itself: always send the inherited explicit sandbox, and record the effective one from the response.
- Thread ids in 0.157 are UUIDs; keep accepting `thr_…` for the report's examples.

## Acceptance checklist (report PASS/FAIL per line)

- [ ] BUG-7: `task --resume <jobId> 'x'` and `task --resume <threadId> 'x'` both cause thread/resume with that id and the prompt exactly `x`
- [ ] BUG-7: an unknown id exits non-zero with `thread not found`
- [ ] BUG-7: a bare `--resume` behaves like `--resume-last` (and `--resume '<prompt>'` stays backward compatible)
- [ ] BUG-7: with job A running, `task --resume <jobB>` succeeds when B is on a different thread
- [ ] BUG-11: under the broker, `send` on a finished job resumes the *same* threadId
- [ ] BUG-11: a forced active-writer case gives `result --json` with `forked:true` and `forkedFromThreadId` set
- [ ] BUG-11: `--on-writer-conflict fail` exits non-zero
- [ ] BUG-11: `task --thread <old>` continues on the fork and prints a notice
- [ ] BUG-11 (narrowed): no `thread/unload` call is ever sent
- [ ] FR-21: `fork <jobId> 'try B'` produces a job with a different threadId and `forkedFromThreadId` equal to the parent's
- [ ] Rescue docs, drive skill and runtime skill map "continue job X" to `--resume <id>`
- [ ] `npm test` green in your worktree; no existing test edited except where this brief allows it

## Required final report (your last message; use exactly these sections)

```
## Lane m3-resume report
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
