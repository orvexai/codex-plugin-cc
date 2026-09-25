# Orvex Codex Plugin: Improvement Report and Implementation Handoff

- Repo: `/home/crew/workspace/codex-plugin-cc` (HEAD `2218ca5`, package `@orvexai/codex-plugin-cc` 1.0.6-orvex.1, installed as `codex@orvex-codex`)
- Upstream base: `db52e28` (openai 1.0.6). Orvex commits: `796b82f` (sandbox/send/wait/defaults), `87ae0f5` (rebrand), `01958f1` (fork fallback), `be46052` (steer never dropped), `f095298` (atomic inbox close), `2218ca5` (test reaping).
- Local Codex CLI observed: `codex-cli 0.157.0`. The local model catalog (`codex debug models`, cached in `~/.codex/models_cache.json`, fetched 2026-09-25) lists `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna` and `gpt-5.5` (plus hidden `gpt-reserve` and `codex-auto-review`). It does **not** list `gpt-5.4-mini` or `gpt-5.3-codex-spark`, both of which the plugin's docs or alias table use.
- The user's `~/.codex/config.toml` on this host already sets `model = "gpt-6-luna"`, `model_reasoning_effort = "high"`, `approval_policy = "never"` and `sandbox_mode = "danger-full-access"`. So the bypass goal is **already the user's Codex configuration**, and the plugin's built-in `read-only` fallback overrides it (BUG-5).
- Audience: the engineering agent that will implement these fixes. Everything below is self-contained.

> **Line-number note.** The evidence was gathered by several independent readers, so line numbers for the same function can differ by roughly 10-40 lines (for example, `handleCancel` is cited as starting at 1441 and at 1454). **Function names are authoritative. Line numbers are approximate.** Paths are relative to `plugins/codex/` unless they start with `tests/`, `README.md`, `scripts/run-tests.mjs` or `.github/`. `codex-companion.mjs` means `plugins/codex/scripts/codex-companion.mjs`, and `lib/…` means `plugins/codex/scripts/lib/…`.

---

## 1. Executive summary

- **Stopping Claude does not stop Codex (P0).** Background workers are spawned `detached` and `unref`'d, with stdio ignored. Turns run inside a shared per-workspace **broker** app-server, and the broker does *not* interrupt a turn when its client socket dies. TaskStop, KillShell, killing the worker, or killing a foreground `task` all leave Codex editing files. Only `cancel` stops it (E1), and `cancel` reports success without checking.
- **Claude is told "completed" while Codex is still working, and gets no signal when Codex finishes (P0).** The Haiku `codex-rescue` forwarder returns the enqueue receipt. The Stop hook's "job still running" note goes to stderr, which the model never sees (E2).
- **Evidence is destroyed at SessionEnd (P0).** The SessionEnd hook deletes *every* job record, log and inbox for the ending session, finished jobs included. It also shuts down the broker that other live sessions in the same workspace share. Ghost jobs whose worker died stay "running" forever, because nothing checks pid liveness (E4).
- **Visibility is thin (P1).** Claude gets a 4-line log preview, commands cut to 96 characters, file changes as counts only, and no command output, diffs, plan, token usage, transcript or partial result. The data is already captured in memory (`commandExecutions` and `fileChanges`) but thrown away (E3, E11).
- **Control primitives exist but are hidden or incomplete (P1).** `send` (turn/steer), `wait` (exit codes 0/1/124) and `send <finishedJob>` (continue a thread) all work. Missing: interrupt-and-redirect, targeting a raw thread id, cross-session listing and reattach. `status`, `result` and `cancel` cannot be invoked by the model. `task --resume <id>` silently ignores the id (E6, E7).
- **Defaults and models (P0/P1).** The bypass goal (`danger-full-access` plus `approvalPolicy: never`) can be reached today with `setup --global --default-sandbox danger-full-access`. However, the built-in fallback silently *overrides* the user's `~/.codex/config.toml` with `read-only`, and on this host that config.toml already says `danger-full-access`: this is the direct cause of E8. The fork should ship bypass as its out-of-box default once the M0 safety items land (FR-25). There is no model listing, alias or validation mechanism, and the effort list is stale (E5, E8). Both `gpt-6-luna` and `gpt-5.6-luna` are real, distinct catalog ids, so "Luna 6" is ambiguous rather than wrong.
- **Integration (P1/P2).** Add an MCP server (`codex`, `codex_reply`, `codex_steer`, …) and a direct `task --attach --json` path with `--output-schema`. Codex can then be used from Claude and from Workflow scripts without the Haiku double hop (E7, E12).
- **Isolation (P1/P2).** Add per-job git worktrees, a lock on the shared working tree for write jobs, git snapshots before and after each job, and lane-level control over which Codex skills and hooks load and what developer instructions are sent (E9, E10).

**Target experience.** Claude dispatches Codex with one direct call, either an MCP `codex` tool or `orvex-codex task --attach` under Bash `run_in_background`. Bypass mode is the persisted default. The Claude-side handle owns the Codex job: if the handle is killed, Codex is interrupted and the stop is verified. When Codex finishes, Claude's harness notification fires at that moment, not at dispatch. The result is a compact structured report that lists files changed with diff stats, commands with exit codes, whether validation ran and passed, and any risks, with pointers to the full diff, events and transcript. While the job runs, Claude can tail structured events, read the latest agent message, steer with `send`, interrupt and redirect on the same thread, or cancel with confirmation. After a restart, the previous session's jobs are still listed, their records are intact, and Claude can reattach to them. Parallel lanes run in their own worktrees under a concurrency cap and return schema-validated results to Workflow scripts, just like Claude's own subagents.

---

## 2. Current state

### 2.1 Architecture sketch

```
Claude main thread
  │  /codex:rescue (inline command, model-invocable)  ─or─  Agent(subagent_type: codex:codex-rescue)
  ▼
codex-rescue subagent  (model: haiku, tools: Bash only, preloads codex-cli-runtime + gpt-5-4-prompting skills)
  │  exactly ONE Bash call, stdout returned verbatim, forbidden to poll/cancel/monitor
  ▼
node scripts/codex-companion.mjs task [--background] [--write|--full-access] [--network] [--model] ...
  │  foreground: runTrackedJob in this process (no signal handlers)
  │  background: write job 'queued' → spawnDetachedTaskWorker (detached:true, stdio:'ignore', unref) → return jobId
  ▼
task-worker process  ── runTrackedJob → executeTaskRun → runAppServerTurn (lib/codex.mjs)
  │  connect(): default ensureBrokerSession(cwd)                        fallback on BROKER_BUSY/ENOENT/ECONNREFUSED
  ▼                                                                      ▼
app-server-broker.mjs (one per WORKSPACE, detached, unix socket)     direct `codex app-server` child (JSON-RPC over stdio)
  │  one active stream socket at a time; others get -32001 BUSY (turn/interrupt exempt)
  │  socket close → clearSocketOwnership only (turn keeps running)
  ▼
`codex app-server` → Codex thread/turn (sandbox from plugin; approvalPolicy 'never'; persistent task threads)

Side channels:
  jobs/<id>.json        job record (status, phase, pid, threadId, turnId, runtime, result payload, deliveredMessageIds)
  jobs/<id>.log         timestamped progress lines + blocks (Assistant message, Reasoning summary, Final output)
  jobs/<id>.inbox.jsonl steer messages (send) → worker polls every 500ms → turn/steer → .inbox.jsonl.closed at turn end
  state.json            per-workspace index (max 200 jobs) + config; guarded by state.lock (owner pid+token)
  broker.json           per-workspace broker session (endpoint, pid)
Hooks: SessionStart (env vars + shim refresh), SessionEnd (kill session jobs, DELETE records, shut down broker), Stop (optional review gate)
State root: $CLAUDE_PLUGIN_DATA/state or $TMPDIR/codex-companion; per workspace <slug>-<sha256(realpath)[0:16]>/
```

### 2.2 Existing capabilities (verified)

| Area | What exists | Where |
|---|---|---|
| Subcommands | setup, review, adversarial-review, task, send, wait, transfer, status, result, cancel; internal task-worker, task-resume-candidate | `codex-companion.mjs` `main()` switch (~1502-1551), usage ~103-119 |
| Arg parsing | `--k v`, `--k=v`, `-C`→cwd, `-m`→model, `--`, shell-split of `$ARGUMENTS` | `lib/args.mjs` |
| task flags | `--background --write --read-only --full-access --sandbox --network/--no-network --name --resume-last --resume(bool!) --fresh --model/-m --effort --cwd/-C --prompt-file --json`, stdin | `handleTask` ~1005-1070 |
| Sandbox resolution | flag > inherited (send follow-ups) > env `CODEX_COMPANION_*` > workspace config > global config > fallback `read-only`; aliases none/off/full→danger-full-access; `--write` never downgrades | `resolveTaskRuntime` ~200-247, `readRuntimeDefaults` ~155-182 |
| Approvals | `approvalPolicy: 'never'` on thread/start, resume, fork (not configurable) | `lib/codex.mjs` 67, 81, 1278 |
| Persistent defaults | `setup --default-model/-effort/-sandbox/-network [--global]`, clear with none/unset/default/clear; setup report shows value and source | `codex-companion.mjs` ~344-446; `lib/state.mjs` ~307-356; `lib/render.mjs` 220-228 |
| Steering | `send <job> msg`: inbox line, worker `turn/steer` with 3×30s retries, offset advances only after acceptance, 20s ack wait (`--timeout-ms`), result `delivered/queued/finished-undelivered` | `deliverToRunningJob`/`handleSend` ~1082-1198; `lib/codex.mjs` `startInboxSteering` ~87-232 |
| Continue a finished job | `send <finishedJob> msg` → follow-up job on the same threadId, inherits runtime, auto-fork on "active writer" | `handleSend` ~1150-1198; `lib/codex.mjs` 1253-1284 |
| wait | `wait [ids...] [--any] [--timeout-ms 1h] --json`; exit 0 all completed / 1 any failed-or-cancelled / 124 timeout; no ids = active jobs in this session | `handleWait` ~1221-1272; `commands/wait.md` (model-invocable, says to use run_in_background) |
| status | session-filtered table + last 4 log lines; `status <id> [--wait]`; `--all` only lifts the 8-job cap | `handleStatus` ~1332-1357; `lib/job-control.mjs` |
| result | finished jobs only; `--json` gives `{job, storedJob}` with `status, threadId, rawOutput, touchedFiles, reasoningSummary, undeliveredMessages`; `--output file` | `handleResult` ~1359-1404; payload ~744-751 |
| cancel | turn/interrupt via `reuseExistingBroker`, then SIGTERM to the process group, then status `cancelled` unconditionally | `handleCancel` ~1441-1500; `lib/codex.mjs` `interruptAppServerTurn` 1109-1149; `lib/process.mjs` 100-117 |
| Reviews | native `review/start` (read-only, ephemeral) and adversarial-review (read-only turn with JSON output schema); always foreground | `handleReviewCommand` ~952-1000 |
| transfer | import a Claude JSONL transcript into a Codex thread | `lib/claude-session-transfer.mjs`; `lib/codex.mjs` 802-879 |
| Broker | per-workspace detached broker; busy fallback to direct app-server; torn down at SessionEnd | `app-server-broker.mjs`; `lib/broker-lifecycle.mjs`; `lib/app-server.mjs` 335-353 |
| CLI shim | `setup --install-cli` → `~/.local/bin/orvex-codex` (refreshed at SessionStart) | `lib/cli-shim.mjs` |
| Model-invocable commands | rescue, send, wait, setup. **Not** model-invocable: status, result, cancel, review, adversarial-review, transfer (`disable-model-invocation: true`) | `commands/*.md` line 4 |
| Tests | `tests/orvex.test.mjs` (18 tests, fake Codex fixture), `tests/state.test.mjs` (lock), `tests/runtime.test.mjs` (incl. cancel happy path 1542/1740, SessionEnd cleanup 1804, Stop-hook stderr 1982), `tests/commands.test.mjs`; runner `scripts/run-tests.mjs` isolates env and reaps processes | — |

### 2.3 Strengths to keep (do not regress)

1. **Per-job log file** with timestamped progress lines and full multi-line blocks (Assistant message, Reasoning summary, Final output). See `lib/tracked-jobs.mjs` 36-50 and 117-132.
2. **captureTurn already collects full `commandExecution` items (with exitCode) and `fileChange` items**, and tracks collab/subagent threads. Structured output only needs to be *persisted and rendered* (`lib/codex.mjs` 365-388, 627-634, 1337-1350).
3. **The steer transport is robust.** It uses a durable JSONL inbox, advances the offset only after acceptance, applies bounded retries, closes the inbox atomically by renaming it to `.closed`, and reports undelivered messages. Extend it into a general **control channel**; do not replace it.
4. **A `send` to a finished job becomes a follow-up job** that inherits sandbox, network, model and effort. This is the right continuity default.
5. **`wait` has meaningful exit codes (0/1/124) and `--any`**, and is designed for Bash `run_in_background`. It is the natural completion signal.
6. **Cancel tries `turn/interrupt` before killing**, and the broker exempts `turn/interrupt` from the busy check. Keep this ordering and add verification.
7. **Concurrency-safe state:** atomic tmp+rename writes, a `state.lock` owned by pid+token with guarded dead-owner reclaim, and job ids that resolve across workspaces. This is a good base for leases and heartbeats.
8. **threadId and turnId are persisted as soon as they are known.** Task threads are persistent (`persistThread:true` → `ephemeral:false`), and status and result print `codex resume <threadId>`.
9. **Automatic fork on an active-writer conflict** avoids hard failures. Keep it, but make it visible and structured.
10. **`approvalPolicy: 'never'` plus a configurable persistent `danger-full-access` default already meets the bypass goal.** Layered defaults (flag > env > workspace > global) support clear values, and `--write` never narrows.
11. **Contradictory sandbox and network flags are rejected up front.** The sandbox aliases are ergonomic.
12. **`--json` works on every subcommand, and the stable `orvex-codex` shim exists.** This makes it the natural host for `orvex-codex mcp` and for direct Bash use.
13. **Reviews are hard-coded read-only and ephemeral.** Keep that, and extend it to the stop gate.
14. **Adversarial review already uses `outputSchema` on turn/start** (`codex-companion.mjs` ~622, `lib/codex.mjs` 1319). The same mechanism can back schema-validated task reports.
15. **The fake-Codex fixture plus an env-stripping, process-reaping test runner** is a solid base for lifecycle tests.
16. According to one reader's live probe on codex-cli 0.157.0, the app-server exposes `model/list`, `config/read`, `skills/list`, `hooks/list`, and per-thread `developerInstructions`/`config`. Most proposals below would therefore be thin wrappers. **Verify each method before relying on it** (see §9 risks).

---

## 3. Observed failures from the live session

| ID | Observation | Impact | Root cause (see item) |
|---|---|---|---|
| E1 | TaskStop on the `codex-rescue` wrapper left job `task-mugvlp54` (danger-full-access, network on, LIVE system) running for 11+ minutes, until a manual `codex-companion.mjs cancel`. The same happened when the user stopped another wrapper. | An unowned agent with full privileges kept changing production. This is a safety incident. | BUG-1, BUG-2 |
| E2 | The forwarder returned "forwarded … running in background" after about 2.5 min and 13k tokens. The harness marked the agent COMPLETED. No notification arrived when Codex actually finished. | Claude acts on a false completion, pays for the Haiku hop, and must poll. | BUG-4, FR-1, FR-24 |
| E3 | The only view was a manual `status`, showing a few truncated lines. There was no transcript, reasoning, diffs or final-message stream. | Claude cannot supervise or verify the work. | FR-2, FR-3, FR-4, FR-7, FR-8, WISH-1 |
| E4 | After a Claude restart the wrapper showed "stopped, no completion record". It was unclear whether the Codex job survived, how to reattach, or what it had done. | Work is lost and nothing can be audited. | BUG-3, BUG-6, FR-10 |
| E5 | "Luna 6" / `gpt-6-luna` vs the repo's `gpt-5.6-luna`. The plugin cannot list, alias or validate models. Both ids exist in the live catalog, so the request is ambiguous; the runtime skill says to leave the model unset, which (after BUG-5) would pick config.toml's `gpt-6-luna`, but today nothing tells Claude that. | Claude guesses, and a wrong name fails late inside the worker. | FR-12, BUG-9, BUG-10, BUG-5 |
| E6 | "I already restarted the service": Claude killed the job and relaunched from scratch. | Codex's context is lost, time is wasted. `send` would have worked but was not discoverable. | FR-9, FR-1 |
| E7 | The consuming repo's CLAUDE.md names `mcp__codex__codex` and `codex-reply` with a threadId. Neither exists: the plugin ships no MCP server, and codex-cli 0.157.0 has no `mcp-server` subcommand either (checked with `codex --help`). Continuity is only `--resume-last`, or `send <jobId>`. | Doc and tool mismatch, so Claude improvises. | FR-11, BUG-7, FR-15, FR-27 |
| E8 | Every dispatch needed `--write --full-access --network --fresh --model`. | Tokens and errors on every call. The user's config.toml already says `danger-full-access`, but the plugin overrides it with `read-only`. Persistent plugin defaults for sandbox, network and model exist but were not used, and resume, follow and isolation have none. | BUG-5, FR-14, FR-25 |
| E9 | Codex auto-invoked repo skills (bmad-build), which hard-blocked. bd prime and Serena hooks injected context. | Every brief needs boilerplate. Lanes are fragile. | FR-13 |
| E10 | Two Codex jobs ran concurrently in a working tree shared with other Claude sessions. There was no isolation and no diff report. | Edits interleave, and nobody can attribute changes. | FR-6, FR-5, BUG-15 |
| E11 | Results are free text only. | Claude cannot check validation claims. | FR-4 |
| E12 | Workflow scripts can reach Codex only through `agent({agentType:'codex:codex-rescue'})`: a double hop with no schema. | Codex lanes do not fit typed pipelines. | FR-11, FR-19, FR-1 |

### 3.1 Goal coverage

Every user goal maps to items with acceptance criteria. An implementation is not done until the end-to-end check in the last column passes.

| Goal | Items | End-to-end check |
|---|---|---|
| G1: no sandbox and no approval prompts by default, like Claude's bypass mode | BUG-5, FR-14, FR-25, BUG-8 (reviews stay read-only), WISH-2 | On a fresh install with no flags and no plugin config, a bare `task "x"` runs `danger-full-access` with network and `approvalPolicy: never`, and prints that runtime on its first line. Review paths still run read-only. |
| G2: Codex use as effective and efficient as Claude's own Ultracode/Workflow subagents | BUG-4, FR-4, FR-11, FR-18, FR-19, FR-23, FR-6, FR-13 | A Workflow script fans out 3 Codex lanes, gets schema-valid results, gets a completion notification at the moment each lane finishes, and spends 3k Claude tokens or fewer per lane. |
| G3: Claude can message, steer, interrupt, cancel and otherwise drive Codex mid-task | FR-1, FR-9, FR-20, BUG-1, BUG-2, BUG-7, FR-10, FR-17, FR-26, WISH-4 | From the main thread with no subagent: launch, `send` a steer that is delivered, `interrupt --then` on the same job, `cancel` with verified stop, and continue a finished job by job id or thread id. |
| G4: Claude is never blind to what Codex is doing | FR-2, FR-3, FR-4, FR-5, FR-7, FR-8, FR-16, BUG-6, BUG-10, WISH-1 | While a job runs, Claude can read full commands with exit codes, the current plan, the last agent message, the live diff and the transcript; after it finishes, it gets a structured report and a patch. |

---

## 4. Bug list

### BUG-1: Stopping the Claude-side handle leaves the Codex job running (orphaned full-access jobs)
- **Priority:** P0
- **Problem:** Nothing ties a job's lifetime to its launcher. (a) Background: `spawnDetachedTaskWorker` uses `detached:true`, `stdio:'ignore'` and `child.unref()`, and returns immediately. (b) Foreground `task` has no SIGTERM, SIGINT or SIGHUP handlers; `grep process.on(` finds none in `codex-companion.mjs` or `lib/`. (c) **Most important:** the worker runs its turn through the shared **broker** by default, so the turn executes inside the broker's app-server. When the owning socket closes, the broker's handler only calls `clearSocketOwnership` and never sends `turn/interrupt`. Killing the worker, its process group or a foreground `task` therefore **cannot** stop a broker-hosted turn. The job record stores only a `sessionId`, with no owner and no liveness.
- **Evidence:** E1, E2. `codex-companion.mjs` `spawnDetachedTaskWorker` ~911-922 and `enqueueBackgroundTask` ~924-950. `lib/app-server.mjs` 336-353 (connect defaults to `ensureBrokerSession`). `app-server-broker.mjs` 75-83 and 228-236 (close/error → `clearSocketOwnership` only). `lib/tracked-jobs.mjs` 62-70 (job record). `agents/codex-rescue.md` 22-25.
- **Proposal:**
  1. **Broker interrupt-on-disconnect (required).** When the socket that owns `activeStreamSocket` closes or errors mid-turn, the broker sends `turn/interrupt` for the tracked `{threadId, turnId}`. Skip this only when the job is marked `detached` (see 3): the worker records that in the job file, and the broker is told through a `broker/markDetached {threadId}` call or a param at `turn/start`.
  2. **Signal handlers.** Foreground `task` and the new `--attach` watcher install SIGTERM, SIGINT and SIGHUP handlers that run the verified-cancel path (BUG-2) for their job, then exit 130.
  3. **Ownership lease.** Add these task flags:
     - `--attach` (alias `--follow`): enqueue the detached worker, then stay in the foreground, stream compact progress to stderr, and exit with the job's exit code. This becomes the canonical launch.
     - `--detach`: today's fire-and-forget behaviour, recorded as `owner.kind:'detached'`.
     - `--on-owner-exit cancel|continue`: default `cancel`, except `--detach` implies `continue`.
     - `--owner-pid <pid>`: explicit owner.
     - Persistent default through `setup --default-on-detach cancel|continue`.

     The job record gains `owner: {kind:'attach'|'foreground'|'pid'|'detached', pid, startTime, heartbeatAt, ttlMs:30000}`. The attached or waiting process refreshes `heartbeatAt` every 5s. The worker checks owner liveness every 2-5s (`kill(pid,0)` plus a start-time comparison against pid reuse; see BUG-6) or heartbeat age. On owner loss it interrupts the turn, logs `owner exited; cancelling`, and writes `status:'cancelled', cancelReason:'owner-lost'`.
  4. `--background` without `--attach` keeps working but prints a warning that the job is unowned, plus the exact `cancel <id>` command.
  5. `status` shows `ownerAlive` and `orphaned`.
- **Acceptance criteria:**
  - Start `task --attach --full-access` against the fake fixture in a background shell, then SIGTERM that shell. Within 5s: status is `cancelled`, `cancelReason` is `owner-lost`, the fake app-server (through the broker) received `turn/interrupt`, and `pgrep` finds no worker or codex child.
  - Same test with SIGKILL of the attach process: the worker self-cancels within ttl+5s.
  - SIGKILL the **worker** of a broker-hosted turn: the broker issues `turn/interrupt` within 2s.
  - `task --background --detach` survives its parent's exit, and `status --json` shows `owner.kind:'detached'` and `ownerAlive:false`.
  - `--owner-pid <sleep pid>`, then kill the sleep: status becomes `cancelled`/`owner-lost` within 5s.

### BUG-2: `cancel` reports "cancelled" without verifying; the interrupt can reach the wrong app-server; no SIGKILL escalation
- **Priority:** P0
- **Problem:** `handleCancel` always writes `status:'cancelled', pid:null`, whatever the outcome of the interrupt or the kill. It can fail in five ways:
  1. There is no `turnId` yet (queued or starting job), so the interrupt is skipped.
  2. `interruptAppServerTurn` connects with `reuseExistingBroker`. When no `broker.json` exists, `CodexAppServerClient.connect` spawns a **fresh direct app-server**, which cannot see the turn.
  3. A worker that fell back to a direct app-server (broker busy) owns its turn in its own child process, which a broker-routed interrupt cannot reach.
  4. `terminateProcessTree` sends one SIGTERM, with no exit check and no SIGKILL.
  5. For a broker-hosted turn, killing the worker does nothing to the turn (BUG-1).

  The payload does have `turnInterruptAttempted` and `turnInterrupted` fields, but they are not persisted in the job file, `renderCancelReport` ignores them, and the exit code is always 0. Cancelling a *foreground* job targets `pid=process.pid` of that companion, whose process group may be the caller's shell (it is not detached).
- **Evidence:** E1. `codex-companion.mjs` `handleCancel` ~1441-1500. `lib/codex.mjs` `interruptAppServerTurn` 1109-1149 and `withAppServer` 762-791 (direct fallback). `lib/app-server.mjs` 338-351. `lib/process.mjs` `terminateProcessTree` 57-117 (POSIX branch 100-117: one `kill(-pid,'SIGTERM')`, then return). `lib/tracked-jobs.mjs` 161 (foreground pid). `lib/render.mjs` `renderCancelReport` 508-525. Existing tests: `tests/runtime.test.mjs` 1542 and 1740, `tests/orvex.test.mjs` ~202 (happy path only).
- **Proposal:** Implement a verified cancel state machine.
  1. At turn start, the worker records `transport: 'broker'|'direct'`, `brokerEndpoint`, `appServerPid` and `workerStartTime` in the job file.
  2. **Control channel.** Add `jobs/<id>.control.jsonl`, polled by the worker alongside the inbox (reuse the `startInboxSteering` loop) and carrying ops `{op:'interrupt'|'cancel', id, reason}`. The worker calls `turn/interrupt` on **its own** client connection, so the right app-server always receives it.
  3. Cancel then proceeds in order: write the control op; if the worker is dead or does not ack within 3s, send `turn/interrupt` to the *recorded* broker endpoint (never spawn a fresh direct app-server for an interrupt; report `broker-not-found` instead); if `turnId` is missing, resolve it with `thread/read`; wait up to `--grace-ms` (default 10s) for `turn/completed` or an idle thread; SIGTERM the worker process group; wait 5s; SIGKILL; confirm with `kill(pid,0)` that the worker and `appServerPid` are gone.
  4. Persist `cancel: {requestedAt, reason, interruptDelivered, turnConfirmedStopped, workerExited, appServerExited, residualPids, detail}`. Status becomes `cancelled` only when the stop is verified. Otherwise it is `cancel-failed`, and the command exits 2.
  5. The worker gets a SIGTERM handler that interrupts its own turn before exiting.
  6. Do not SIGTERM the process group of a non-detached foreground companion. Signal its pid only, and rely on its signal handler (BUG-1).
  7. `renderCancelReport` shows the interrupt, process and verification outcomes.
  8. Add `cancel --all [--workspace|--everywhere]` and `--force` (skip the grace period). See WISH-2.
- **Acceptance criteria:**
  - Cooperative fake: `status` is `cancelled`, `cancel.turnConfirmedStopped` is true, and no new `Running command` lines appear in the log after cancel.
  - A fake that ignores `turn/interrupt`, plus a worker that ignores SIGTERM: the SIGKILL path runs and ends verified, or the command exits 2 with `cancel-failed` and a non-empty `residualPids`.
  - A worker on a direct transport (broker forced busy): the fake records `turn/interrupt` on the worker's own connection.
  - A queued job with no turnId is cancelled cleanly: the worker never starts a turn.
  - The rendered cancel report contains the interrupt outcome.

### BUG-3: SessionEnd deletes job records, logs and inboxes for the whole session and shuts down the workspace-shared broker
- **Priority:** P0
- **Problem:** `cleanupSessionJobs` SIGTERMs this session's queued and running jobs, then saves state with **every** job for that `sessionId` removed, completed ones included. `saveStateUnlocked` unlinks the job `.json`, `.log`, `.inbox.jsonl` and `.closed` for every dropped id. After a restart nothing is left to inspect or resume (E4). `handleSessionEnd` also always sends `broker/shutdown` and tears down the broker. The broker is keyed per **workspace**, so ending one Claude session kills Codex turns belonging to other live sessions in the same repo. Teardown deletes `broker.log`. There is an existing test that asserts the full cleanup. Jobs without a `sessionId` are not affected.
- **Evidence:** E4. `scripts/session-lifecycle-hook.mjs` 46-79 (`cleanupSessionJobs`) and 92-124 (`handleSessionEnd`). `lib/state.mjs` 238-263 (`saveStateUnlocked` unlinks dropped jobs' files). `lib/broker-lifecycle.mjs` 176-209 (teardown deletes the log). `hooks/hooks.json` (SessionEnd timeout 5s). `tests/runtime.test.mjs` ~1804 ("session end fully cleans up jobs").
- **Proposal:**
  1. SessionEnd never deletes records or artifacts. Add a policy `sessionEndPolicy: cancel|detach`, settable with `setup --session-end-policy`. The default is `cancel` for owned or lease-required jobs and `detach` for jobs launched `--detach`.
     - `cancel`: send the control op or interrupt from BUG-2, then mark the job `cancelled` with `cancelReason:'session-ended'` and `sessionEndedAt`. The hook has only a 5s budget, so write `cancel-pending` and let the worker or the next status reconcile it (BUG-6). **Do not block** on verification.
     - `detach`: leave the job running and set `endedWithSession:true`.
  2. Write `jobs/session-end-<sessionId>.json`, a summary of the session's jobs.
  3. **Broker reference counting.** `broker.json` gets `leases: [{sessionId, pid, heartbeatAt}]`. SessionEnd removes its own lease, and calls `broker/shutdown` only when no other live lease remains and no job is active. Broker logs move to `<stateDir>/broker.log` (rotated, never deleted on teardown).
  4. Deletion happens only through pruning and gc (BUG-14, WISH-7).
  5. Update `tests/runtime.test.mjs` ~1804 to the new semantics.
- **Acceptance criteria:**
  - Run the SessionEnd hook with one running job and one completed job. Both job `.json` and `.log` files still exist. The running job is `cancelled` or `cancel-pending` with `cancelReason:'session-ended'`, and `status <id> --json` resolves both.
  - A test asserts that the hook removes no files under `jobs/`.
  - Sessions A and B share a workspace and B has a running job. A's SessionEnd leaves B's job running and the broker alive.
  - With `detach`, the job keeps running and FR-10's SessionStart context in a new session names it.

### BUG-4: The wrapper agent reports COMPLETED at dispatch, and nothing notifies Claude when Codex finishes
- **Priority:** P0
- **Problem:** The `codex-rescue` subagent (Haiku, Bash only, preloading two skills) makes one Bash call and returns its stdout. It is told to prefer `--background` for complex tasks, so the call returns only the enqueue receipt, and Claude's harness marks the agent COMPLETED while Codex works. No hook fires when a job finishes: `hooks.json` has only SessionStart, SessionEnd and Stop. The Stop hook's running-job note goes to stderr with exit 0 whenever the review gate is off (the default), so the model never sees it; `tests/runtime.test.mjs` ~1982 locks this in. `wait` exists and is designed for Bash `run_in_background`, but the rescue path never uses it or mentions it. The hop costs about 2.5 min and 13k Claude tokens.
- **Evidence:** E2, E12. `agents/codex-rescue.md` 4-9, 22-28, 40-44. `commands/rescue.md` 6, 13-17, 42-45. `codex-companion.mjs` `enqueueBackgroundTask` ~924-950 and `renderQueuedTaskLaunch` ~786-818. `scripts/stop-review-gate-hook.mjs` 33-38 and ~150-157 (`logNote` → stderr). `commands/wait.md`. `tests/commands.test.mjs` 96-114 (asserts Agent routing).
- **Proposal:**
  1. **Remove the forwarder from the default path.** Rewrite `commands/rescue.md` to make **one direct Bash call**: `node ${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs task --attach --format brief ...`, with Bash `run_in_background: true` for anything non-trivial. Claude's own background-task notification then fires exactly when Codex finishes.
  2. The first stdout line of every launch is machine-readable: `CODEX_JOB <jobId> status=<queued|running> thread=<threadId|pending> log=<path>`. A pure `--background` launch prints `CODEX_JOB_QUEUED id=<id> status=queued (NOT finished)`, then the exact `wait <id> --json` command.
  3. The attach exit codes follow the canonical table in §8.1: completed → 0, failed → 1, cancelled or interrupted → 130, job timed-out (FR-17) → 4, lost or orphaned → 3. Exit 124 is reserved for the *waiter* giving up (`wait --timeout-ms`, `attach --timeout-ms`) while the job is still running.
  4. Keep `agents/codex-rescue.md` only as a deprecated shim. It must use `--attach`, never `--background`. On failure it returns `CODEX_DISPATCH_FAILED exit=<n>` plus stderr, never nothing. Remove "Proactively use" from its `description` (line 3): with a bypass default (FR-25), Claude must not auto-dispatch full-access Codex jobs on its own initiative through a deprecated path.
  5. The Stop hook emits JSON (`systemMessage` or `hookSpecificOutput.additionalContext`) naming active jobs. The config `blockStopWhileCodexRunning` (settable with `setup --stop-running-jobs block|warn|off`, default `warn`) returns `{decision:'block', reason:'Codex job X still running; wait or cancel'}` once per job (tracked in `stopNotifiedAt`).
  6. The hook-injected completion ledger is FR-16.
  7. Update `tests/commands.test.mjs` 96-114 and `tests/runtime.test.mjs` ~1982.
- **Acceptance criteria:**
  - A `/codex:rescue` run makes 0 Agent calls and 1 Bash call (asserted in `tests/commands.test.mjs`).
  - With a 30s fake turn, the Claude background Bash task completes at 30s ±2s, its output ends with the result, and its exit code matches the job status.
  - Stop hook with the gate off and one running job: stdout JSON contains the job id. In `block` mode it returns `decision:block`.
  - The first line of background launch stdout matches `/^CODEX_JOB(_QUEUED)? /`.
  - The Claude-side dispatch cost is under about 2-3k tokens, measured once manually and recorded in the PR.

### BUG-5: The plugin silently overrides the user's Codex config (`sandbox_mode`) with `read-only`, and mislabels it "(Codex default)"
- **Priority:** P0
- **Problem:** When no flag, env var or plugin default is set, `resolveTaskRuntime` falls back to `'read-only'`, and `buildThreadParams`, `buildResumeParams` and the fork call independently default `sandbox` to `'read-only'`. That overrides `sandbox_mode` in `~/.codex/config.toml` without telling anyone. `model` falls back to `null`, which lets config.toml decide, so the two settings follow inconsistent rules. The setup report prints `(Codex default)` for an unset sandbox, and README.md:19 says "Codex's own defaults unless you pass flags". Both are false. This is the direct cause of E8 on this host: `~/.codex/config.toml` already sets `sandbox_mode = "danger-full-access"` and `approval_policy = "never"`, yet every plugin job without flags ran `read-only`, so every dispatch had to repeat `--full-access`.
- **Evidence:** E8. `lib/codex.mjs` 68, 82, 1279. `codex-companion.mjs` ~191, ~228, ~708 (read-only fallbacks). `lib/render.mjs` ~221. `README.md` 19. `tests/orvex.test.mjs` 81-83 (asserts the read-only fallback).
- **Proposal:**
  1. Add a resolution tier `codex-config` at the bottom of the task precedence chain: flag > inherited > env > workspace > repo (FR-15) > global > profile (FR-14) > **codex-config** > built-in (the same order as §8.4). When nothing plugin-side is set, **omit** `sandbox` (and `model`) from thread/start, resume and fork, so config.toml and its profiles apply. Keep an explicit built-in only if the app-server rejects a missing sandbox (verify this).
  2. Read the effective values through `config/read` (already called for auth around `lib/codex.mjs` 1020) and display them with source `codex config.toml`.
  3. Keep forced `read-only` for review, adversarial-review and the stop gate (BUG-8).
  4. Fix the `(Codex default)` label and README.md:19 so they describe exactly what is sent.
  5. `approvalPolicy` stays `never` (WISH-5).
- **Acceptance criteria:**
  - With no plugin defaults and a temp `CODEX_HOME/config.toml` containing `sandbox_mode="danger-full-access"`, the fake records thread/start with no sandbox (or null), and `status --json` shows the effective sandbox `danger-full-access` with source `codex-config`.
  - `tests/orvex.test.mjs` 81-83 is updated accordingly.
  - Review paths still send `read-only`.
  - The setup text never shows `(Codex default)` for a value the plugin overrides.

### BUG-6: Jobs whose worker died stay queued or running forever (no liveness check)
- **Priority:** P0 (one reader rated it P1; raised because it is the root of E4's ambiguity and blocks `wait`, `--resume-last` and cancel)
- **Problem:** Workers are detached with stdio ignored. Suppose a worker crashes before `runTrackedJob` writes `running` (for example "No stored job found"), is SIGKILLed or OOM-killed, or dies with the host, or a foreground companion is killed. The record stays `queued` or `running`, and its stderr is lost. `enrichJob`, `buildStatusSnapshot`, `buildSingleJobSnapshot`, `handleWait`, `deliverToRunningJob`, `resolveCancelableJob`, `resolveResultJob` and the resume candidate all trust the stored status. As a result, `wait` blocks until its 1h default. `send` returns `queued` after 20s as though delivery were pending. `--resume-last` refuses ("task still running"). The Stop hook reports ghost jobs. A pid-liveness helper `isProcessAlive` exists in `lib/state.mjs` (~87-98) but is used only for the state lock.
- **Evidence:** E4, E1. `codex-companion.mjs` `spawnDetachedTaskWorker` ~911-922, resume refusal ~545-551, `deliverToRunningJob` ~1082-1105, `handleWait` ~1221-1272, `DEFAULT_WAIT_TIMEOUT_MS` ~99. `lib/job-control.mjs` `enrichJob` ~158-181 and ~225-265. `scripts/stop-review-gate-hook.mjs` ~151-154. `lib/state.mjs` ~87-98.
- **Proposal:**
  1. Move `isProcessAlive` to `lib/process.mjs` and export it. Add a pid-reuse guard: record `workerStartTime` (from `/proc/<pid>/stat` field 22 on Linux, `ps -o lstart=` on macOS) and compare it.
  2. The worker writes `heartbeatAt` every 5s. It can go in the job file under the lock, or in a cheap separate file `jobs/<id>.hb` (preferred, to avoid lock churn).
  3. Add a shared `reconcileJob(job)` called from `buildStatusSnapshot`, `buildSingleJobSnapshot`, `handleWait`'s poll loop, `deliverToRunningJob`, `resolveCancelableJob`, `resolveResultJob` and the resume-candidate lookup. If the job is active and the pid is dead, or the heartbeat is older than 30s:
     - if a threadId exists, call `thread/read`. If the turn is still running on the broker, set `status:'orphaned'` and suggest `cancel`. If the turn has finished, reconcile to `completed` or `failed`, recover the final message, and set `reconciled:true`.
     - otherwise set `status:'lost'`, `phase:'worker-exited'`, `errorMessage:'worker exited without completion record'`, append the log tail, and keep the threadId so the job can still be resumed.
  4. `wait` treats `lost` and `orphaned` as terminal (exit 3). `send` to a dead worker returns `lost` (FR-20).
  5. Redirect worker stderr to `jobs/<id>.worker.err` instead of `'ignore'`. `status` references it when it is non-empty.
  6. Show `heartbeatAgeSec` in `status --json`.
- **Acceptance criteria:**
  - SIGKILL a background worker (fake fixture). The next `status <id> --json` shows `lost` (or `orphaned`, or `completed` with `reconciled:true`, depending on the fake thread's state) with a threadId, and `wait <id>` exits 3 within one poll interval.
  - A worker that throws before `runTrackedJob` leaves a non-empty `.worker.err` that status references.
  - `task --resume <jobId>` (BUG-7) continues a `lost` job's thread.

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

### BUG-8: The stop review gate inherits the full-access default, so a "review" runs with write access, network and no sandbox
- **Priority:** P1
- **Problem:** The Stop hook spawns `codex-companion task --json <prompt>` with no sandbox flags. `handleTask` calls `resolveTaskRuntime`, which applies the workspace or global `defaultSandbox`, `defaultNetwork` and `defaultModel`. `STOP_REVIEW_TASK_MARKER` only affects job metadata. So with a bypass default, the stop-time review runs as `danger-full-access`. Separately, `review` and `adversarial-review` ignore the model and effort defaults and accept no `--effort`.
- **Evidence:** `scripts/stop-review-gate-hook.mjs` ~105. `codex-companion.mjs` ~1016, ~775, ~954 (review valueOptions exclude effort), ~579 and ~620.
- **Proposal:** The gate passes `--read-only --no-network` explicitly (later `--profile readonly`, FR-14). Add config keys `reviewModel` and `reviewEffort`, set with `setup --default-review-model/--default-review-effort`, applying to review, adversarial-review and the gate. Add `--effort` to the review commands.
- **Acceptance criteria:**
  - With `defaultSandbox=danger-full-access`, the gate's job records sandbox `read-only`, and the fake's last thread/start has `sandbox:'read-only'`.
  - A test asserts that the gate argv contains `--read-only`.
  - `setup --default-review-model X` changes the model for all three review paths.

### BUG-9: Effort validation rejects real efforts (`max`, `ultra`) and accepts efforts that current models do not support
- **Priority:** P1
- **Problem:** `VALID_REASONING_EFFORTS` is hard-coded to `none|minimal|low|medium|high|xhigh`. The local catalog (`~/.codex/models_cache.json`, codex-cli 0.157.0) confirms that every listed model supports `low|medium|high|xhigh`; all except `gpt-5.5` also support `max`; `gpt-6-astra`, `gpt-6-sol`, `gpt-5.6-sol` and `gpt-5.6-terra` also support `ultra`; and **no** listed model supports `none` or `minimal`. So `--effort max` fails synchronously, while `minimal` passes validation and then fails late inside a background worker. The stale list is repeated in the docs.
- **Evidence:** `codex-companion.mjs` 77 and `normalizeReasoningEffort` ~276-290, usage ~110. `skills/codex-cli-runtime/SKILL.md` 36. `commands/rescue.md` 3 (argument-hint). `~/.codex/models_cache.json` `supported_reasoning_levels`.
- **Proposal:** Validate against the target model's `supportedReasoningEfforts` from `model/list` (cached by FR-12). If the catalog is unavailable, accept any string with a warning. Apply this to `task`, `send` follow-ups and `setup --default-effort`. The docs say efforts are model-dependent and point to `models`.
- **Acceptance criteria:** `task --effort max` is accepted when the fake `model/list` lists `max`. An unsupported effort fails before a worker spawns and lists the valid values. `setup --default-effort max` succeeds. The docs no longer hard-code the list.

### BUG-10: Status and results record the *requested* runtime, not the effective one
- **Priority:** P1
- **Problem:** `job.runtime` stores what `resolveTaskRuntime` chose. When `--model` or `--effort` is absent those values are null, and `formatRuntime` omits them. The thread/start, resume and fork responses are used only for `thread.id`. So Claude never learns which model actually ran (E5), and it cannot see what a fork inherited.
- **Evidence:** E5. `codex-companion.mjs` ~244-245 and ~1031. `lib/render.mjs` `formatRuntime` 124-139. `lib/codex.mjs` 882-883, 1259, 1284, 1294.
- **Proposal:** Capture the effective `model`, `reasoningEffort`, `sandbox`, `approvalPolicy` and `cwd` from the thread responses if the schema carries them. The generated `ThreadStartResponse` types are not in the checkout, so check the real response. Otherwise fall back to `config/read`. Persist `job.runtime = {requested, effective, sources}`. Render e.g. `model gpt-x (codex default)`, and add `effectiveRuntime` to `result --json`.
- **Acceptance criteria:** A fake thread/start response containing a model is persisted and rendered. A task run without `--model` shows the resolved model and its source in status and result. A forked follow-up records its own effective runtime.

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

### BUG-12: `--network` is silently ignored outside workspace-write, and status still says "network on"
- **Priority:** P2
- **Problem:** `buildSandboxConfig` sets only `sandbox_workspace_write.network_access`. Under `read-only` the flag does nothing. Under `danger-full-access` the network is open whatever the flag says. `formatRuntime` prints `network on` whenever `runtime.network` is true, and prints nothing when it is false.
- **Evidence:** E1. `codex-companion.mjs` `buildSandboxConfig` ~249-251 and ~232-240. `lib/render.mjs` 128-131.
- **Proposal:** Compute `effectiveNetwork`: `unrestricted` for danger-full-access, the flag value for workspace-write, and `blocked (flag ignored)` for read-only. Warn on stderr and in `warnings[]` of the JSON output. Render the effective value everywhere.
- **Acceptance criteria:** `task --read-only --network` warns and status shows network blocked. `--full-access --no-network` shows unrestricted with a note. Unit tests cover all three combinations.

### BUG-13: Errors are swallowed (broker startup, busy fallback, broker logs, stderr, forwarder)
- **Priority:** P2
- **Problem:** Several failures degrade silently:
  - `ensureBrokerSession` returns null after a 2s wait, and the client silently uses a direct app-server.
  - `withAppServer` retries BUSY, ENOENT and ECONNREFUSED errors on a direct app-server without any progress line.
  - Teardown deletes `broker.log`.
  - In broker mode `client.stderr` stays empty, so Codex stderr never reaches the job.
  - The direct client's stderr grows without bound.
  - The forwarder "returns nothing" on failure.
- **Evidence:** `lib/broker-lifecycle.mjs` 149-160 and 186-188. `lib/codex.mjs` 762-791. `lib/app-server.mjs` 63 and 199-203. `agents/codex-rescue.md` 44.
- **Proposal:** Record `transport`, `transportFallbackReason` and `warnings[]` on every job, and write a log line for each fallback. Keep broker logs at `<stateDir>/broker.log` with rotation. Tee broker-side stderr per thread into the job log where it can be attributed, or at least add a `broker logs` command (FR-23). Cap direct stderr at a ring buffer of about 64KB. Rendered results include a **Warnings** section when needed.
- **Acceptance criteria:** When `ensureBrokerSession` fails, the job has `transport:'direct'`, a non-null `transportFallbackReason` and a fallback log line. `broker.log` survives teardown. The rendered result contains "Warnings" after a fallback.

### BUG-14: Job pruning can evict active or unread jobs and delete their evidence
- **Priority:** P2
- **Problem:** `pruneJobs` keeps the 200 most recently updated jobs, sorted by `updatedAt` with no status check. `updatedAt` only changes on phase, thread or turn changes, so a long-running job can be evicted, and its json, log and inbox are deleted. Nothing records whether a result has been read.
- **Evidence:** `lib/state.mjs` 15 (`MAX_JOBS=200`), 226-230 and 238-263. `lib/tracked-jobs.mjs` 69-111.
- **Proposal:** Pruning never drops active jobs, or jobs younger than 24h whose `resultReadAt` is unset (`result`, `wait` and attach set it). Archiving and gc are covered in WISH-7.
- **Acceptance criteria:** Create 201 jobs with the oldest still running. The running job survives, and so do its files.

### BUG-15: Concurrent write jobs on one tree are neither detected nor warned about, and other sessions' jobs are invisible
- **Priority:** P2 (the isolation fix itself is FR-6)
- **Problem:** `buildStatusSnapshot` always filters by `CODEX_COMPANION_SESSION_ID`, and `status --all` only lifts the display cap. So two sessions' Codex jobs on the same tree cannot see each other (E10), and nothing warns when overlapping write-capable jobs start.
- **Evidence:** E10. `lib/job-control.mjs` 15-25 and 212-255. `codex-companion.mjs` ~1233. `scripts/stop-review-gate-hook.mjs` 42-48.
- **Proposal:** `status` adds an "Other active Codex jobs in this workspace" section (id, session, sandbox badge, elapsed, files changed so far). When a write-capable task starts while another write-capable job is active on the same tree realpath, log a warning and record `overlapsWith:[ids]`. FR-6 turns this into a lease.
- **Acceptance criteria:** With a running job from session A, `status` in session B lists it under "Other active". A `--write` task started in B logs a warning naming A's job, and `job.overlapsWith` contains it.

---

## 5. Feature requests

### FR-1: A model-facing lifecycle surface: model-invocable status, result and cancel, plus a "drive Codex" skill
- **Priority:** P1
- **Problem:** `/codex:status`, `/codex:result`, `/codex:cancel`, `/codex:review`, `/codex:adversarial-review` and `/codex:transfer` all have `disable-model-invocation: true`. The `codex-cli-runtime` skill says "use only inside the codex:codex-rescue subagent". The rescue docs forbid polling, fetching and cancelling. The main thread only discovers that it can cancel an orphan (E1) or steer (E6) by improvising. `send` and `wait` are already model-invocable, so the asymmetry is arbitrary.
- **Evidence:** E1, E3, E6. `commands/{status,result,cancel,review,adversarial-review,transfer}.md` line 4. `skills/codex-cli-runtime/SKILL.md` 3 and 8. `commands/rescue.md` 42-45. `tests/commands.test.mjs` 135-156 and 187-192.
- **Proposal:** Remove `disable-model-invocation` from status, result and cancel, and add model-invocable `interrupt`, `attach`, `logs`, `messages` and `models` commands. Add a skill `codex:drive` (model-invocable) that documents the full lifecycle through `orvex-codex`, or through `node ${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs`:

  | Verb | Command |
  |---|---|
  | launch | `task --attach` under run_in_background |
  | observe | `status`, `logs --follow`, `events` |
  | steer | `send` |
  | redirect | `interrupt --then` |
  | stop | `cancel` |
  | wait | `wait` |
  | reattach | `attach` |
  | continue | `task --resume <id>` or `send <id>` |
  | inspect | `result --partial`, `diff`, `transcript` |

  The skill includes rules: **"steer, don't restart"**, **"always cancel what you launched if you abandon it"**, and **"never report Codex work as done until the job is terminal"**. Keep the forwarder's restrictions for the subagent only, and state that the main thread owns the lifecycle. Update `tests/commands.test.mjs`.
- **Acceptance criteria:** The skill list exposes `codex:status`, `codex:result`, `codex:cancel`, `codex:interrupt` and `codex:drive`. `tests/commands.test.mjs` asserts that their frontmatter does not disable model invocation, and that the drive skill mentions send, interrupt, cancel, wait, logs, result and attach, plus the steer rule.

### FR-2: A structured event stream (`events.jsonl`) with `events`, `logs` and `tail` subcommands that Monitor can follow
- **Priority:** P1
- **Problem:** The only progress channel is a human-readable log (96-char commands, counts instead of paths). The only CLI view is `status`, with 4 lines, and only for queued, running or failed jobs. There is no way to stream a running job.
- **Evidence:** E3. `lib/tracked-jobs.mjs` `createProgressReporter` 117-132. `lib/job-control.mjs` 9 and 56-76 (`DEFAULT_MAX_PROGRESS_LINES=4`) and 165-169. `lib/codex.mjs` 390-449 (`shorten(...,96)`).
- **Proposal:**
  1. `createProgressReporter` also appends each normalized event to `jobs/<id>.events.jsonl` as `{seq, ts, jobId, threadId, turnId, source:'root'|'subagent:<label>', type, phase, data}`. Types include `turn.started`, `command.started`, `command.completed` (full command, cwd, exitCode, durationMs, outputTail ≤ 8KB), `file.changed` (paths, kind, diff or diff-ref), `message.agent`, `reasoning.summary`, `plan.updated`, `tool.call`, `web.search`, `steer.delivered`, `usage.updated` and `turn.completed`. Writes are append-only and flushed per line.
  2. Add `events <id> [--since <seq>] [--follow] [--types a,b] [--json|--compact]`. `--compact` lines are under 200 characters. `--follow` exits after `turn.completed` or a terminal status, with the job's exit code.
  3. Add `logs <id> [--tail N] [--follow] [--json]`, which reads the text log.
  4. Both resolve ids across sessions and workspaces.
- **Acceptance criteria:** A fixture task with 2 commands and 1 file change produces monotonic `seq` values, an untruncated command with exitCode, and `file.changed` with paths. `events --since 3 --json` returns only `seq>3`. `--follow` terminates after `turn.completed` with the right exit code. Every `--compact` line is under 200 characters.

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

### FR-4: A structured, verifiable task result (files, commands, validation, risks) and `--output-schema`
- **Priority:** P1
- **Problem:** `runAppServerTurn` returns `fileChanges`, `commandExecutions` and `turnId`, but the stored payload keeps only `status, threadId, rawOutput, touchedFiles, reasoningSummary, undeliveredMessages`. `renderTaskResult` prints only `rawOutput`, and not even `touchedFiles`. There is no `outputSchema` for tasks, even though the plumbing exists at `lib/codex.mjs` 1319 and adversarial-review uses it. Claude cannot check validation claims, and Workflow scripts cannot validate the result against a schema.
- **Evidence:** E11, E12, E3. `codex-companion.mjs` payload ~744-751 and adversarial outputSchema ~614-625. `lib/codex.mjs` 275-285 (`collectTouchedFiles`), 1337-1350 and `parseStructuredOutput` ~1380. `lib/render.mjs` 356-364.
- **Proposal:**
  1. The payload gains a `report` object made of *harness facts*:
     - `filesChanged[{path, kind, additions, deletions}]`, from fileChange items merged with the git diff of FR-5
     - `commands[{command, cwd, exitCode, durationMs, status, outputTail≤2KB}]`
     - `validation{ran, allPassed, failing[]}`, classified by a heuristic on test, lint and build commands (reuse the existing `verifying` phase regex)
     - `usage`, `elapsedMs`, `turnIds[]`, `rolloutPath` (FR-7), `effectiveRuntime` (BUG-10) and `warnings[]`

     Persist the full command list to `jobs/<id>.commands.jsonl`.
  2. Add `task --output-schema <file|builtin:task-report>`, passed to turn/start `outputSchema` and parsed with `parseStructuredOutput`. `builtin:task-report` is `{summary, filesChanged[], validation[{command, result}], risks[], followUps[]}` and ships as `schemas/task-report.schema.json`. The result is `{ok, data, validationErrors}`. A foreground or attach run exits 2 when the output is invalid, while the job itself is still `completed`, with `reportError` set.
  3. Any claimed validation command that does not appear in `report.commands` is marked `unverified`.
  4. Version `task --json` and `result --json` with `schemaVersion`, and ship `schemas/task-result.schema.json`.
  5. Add `result --report-only`, and a compact **Report** section (files with stats, failed commands, validation) rendered *before* the raw message.
- **Acceptance criteria:**
  - A fixture turn with 2 commandExecutions (`npm test` exits 1) and 1 fileChange touching 2 paths gives `report.commands.length==2` with exitCodes, `validation.ran==true`, `allPassed==false`, and `filesChanged` covering both paths with kind.
  - `--output-schema builtin:task-report` returns schema-valid data. A non-conforming message gives `ok:false` with `validationErrors`, exit 2, and a job that is still `completed`.
  - A claimed-but-unrun validation is marked `unverified`.
  - `task-result.schema.json` validates the completed, failed, cancelled and no-op payloads in tests.

### FR-5: Automatic git snapshots before and after each job, a `diff` subcommand, and no-op and concurrent-change detection
- **Priority:** P1
- **Problem:** Nothing records working-tree state around a task job. A write task that changes nothing looks like success. Edits made through shell commands are invisible, because `touchedFiles` comes only from fileChange items. Edits by other sessions cannot be told apart from Codex's own. `lib/git.mjs` (`getWorkingTreeState` and others) is imported only for reviews.
- **Evidence:** E10, E11. `lib/git.mjs` ~122. `codex-companion.mjs` imports ~27 and `executeTaskRun` ~681-762.
- **Proposal:** For task jobs in a git repo, capture a pre snapshot and a post snapshot: HEAD, `git status --porcelain=v2 -z`, and a content hash of each dirty or untracked file. Compute `report.git = {headBefore, headAfter, newCommits, changedByJob, changedConcurrently, untrackedAdded}`. A file counts as changed by the job if it appears in fileChange items or command-attributed changes. Hash changes during the turn that match neither go to `changedConcurrently`. Write `jobs/<id>.patch`, a diff of the job's paths relative to the pre snapshot. Add `diff <id> [--stat|--name-only|--json]`. A write job with no changes gets a `NO_CHANGES` warning. With `--expect-changes` (or config `defaultExpectChanges`) it exits 2 with status detail `completed-no-changes`.
- **Acceptance criteria:**
  - In a temp repo, a fileChange write to `a.txt` and a shell write to `b.txt` both appear in `changedByJob` and in `diff --name-only`.
  - `jobs/<id>.patch` passes `git apply --check -R` on the post tree.
  - An external edit to `c.txt` during the turn lands in `changedConcurrently`.
  - A no-edit `--write --expect-changes` run exits 2 with `NO_CHANGES`.

### FR-6: Per-job git worktree isolation and a working-tree lease for write jobs
- **Priority:** P1
- **Problem:** Write jobs run in the shared tree named by `--cwd` (E10). The README (225-248) tells users to create their own worktrees, but nothing automates it, detects two writers on one tree, or reports the result. There is a test that parallel background jobs in one workspace all run (`tests/orvex.test.mjs` ~176), so concurrency is by design with no guard.
- **Evidence:** E10. `codex-companion.mjs` `buildTaskRequest` ~840-853 and ~723. `README.md` 225-248. `tests/orvex.test.mjs` ~176.
- **Proposal:**
  1. `task --worktree[=<name>] [--base <ref>]`: run `git worktree add <repoRoot>/.codex-worktrees/<jobId> -b codex/<jobId> <base|HEAD>` (or place it under `<stateDir>/worktrees/`; pick one and document it), then run the job with cwd there. Add `.codex-worktrees/` to `.git/info/exclude` automatically. The job records `worktreePath`, `branch` and `baseRef`, and the result shows a diff stat.
  2. Add `worktree list | merge <jobId> [--ff-only|--squash] | discard <jobId> | pr <jobId>`.
  3. Config `defaultIsolation: none|worktree`. Fan-out (FR-18) defaults to `worktree`.
  4. **Tree lease.** A write-capable job without `--worktree` takes an advisory lease on the tree realpath, `<stateDir>/tree.lease`, with owner job id and heartbeat. A second write job fails fast with `workspace busy: job <id>; use --worktree or --shared-tree`. `--shared-tree` proceeds and records `concurrentJobs`. Read-only jobs are never blocked. Status shows the lease holder.
  5. Job state keys must still group worktree jobs under the parent repo, so `status` in the main tree lists them. Today the state dir is keyed by workspace realpath, so decide on a key and test it.
- **Acceptance criteria:**
  - Two concurrent `--worktree` jobs edit the same file and both succeed on separate branches. The main tree's `git status` is unchanged.
  - `worktree merge --squash` applies the edits. `discard` removes both the directory and the branch.
  - A second shared-tree `--write` job exits non-zero naming the first job. With `--shared-tree` it runs, and both reports list `concurrentJobs`.

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

### FR-9: Interrupt and redirect on the same thread and the same job
- **Priority:** P1
- **Problem:** When plans change mid-task (E6), Claude can steer with `send`, which Codex may absorb late, or cancel, which kills the worker. There is no primitive that interrupts the current turn and immediately starts a new turn on the same thread. The multi-step fallback (`cancel`, then `send <jobId> msg` on the now-finished job) works but is undocumented, creates a new job id, and may fork (BUG-11).
- **Evidence:** E6. `codex-companion.mjs` `handleCancel` ~1441-1501 and `handleSend` ~1146-1195. `lib/codex.mjs` 1109-1149 and 150-232.
- **Proposal:** Add `interrupt <job-id> [--then <message>|--prompt-file f] [--json]`, with the alias `send <job-id> --interrupt <message>`. It uses the BUG-2 control channel (`{op:'interrupt', then}`). The worker calls `turn/interrupt`, waits for the turn to end, and if a message was given, issues `turn/start` on the same threadId with the same runtime, inside the same job. The job gains `turns[]` (`turnId`, `startedAt`, `endedAt`, `status`, `prompt excerpt`), and the result shows every turn. Without `--then` the job ends as `interrupted`, which is a terminal status that can be resumed by id. Expose it as the model-invocable `/codex:interrupt`, and document it in `codex:drive` alongside the `cancel` + `send <id>` fallback. Also generalize the worker so the same job can accept a `{op:'continue', text}` after natural completion, if that is cheap. Otherwise keep follow-up jobs.
- **Acceptance criteria:** On a long fake turn, `interrupt <id> --then 'service already restarted; skip step 3'` produces `turn/interrupt` followed by `turn/start` on the same threadId, under one job id with `turns.length==2`, and `result <id>` shows both. Without `--then`, status is `interrupted`, and `task --resume <id>` resumes the thread.

### FR-10: Reattach after a restart or from another session; SessionStart awareness
- **Priority:** P1
- **Problem:** Id-based access (`status`, `wait`, `cancel`, `result` and `send` with an id) already works across sessions and workspaces. But nothing *lists* other sessions' jobs, adopts a job, follows it, or tells a new session that jobs exist. The SessionStart hook only exports env vars. (It also depends on BUG-3, because today the records are deleted.)
- **Evidence:** E4. `lib/job-control.mjs` 15-25 and 230-255. `codex-companion.mjs` ~505-511. `scripts/session-lifecycle-hook.mjs` 81-91.
- **Proposal:**
  1. `status --all-sessions` (alias `--workspace`) lists every job in the workspace with `sessionId`, owner and lease state, and liveness.
  2. `attach <job-id> [--follow]` sets `job.sessionId` to the current session, takes the owner lease (BUG-1), and streams events until the job is terminal, exiting with the job's code. `adopt <job-id>` does the same without following.
  3. SessionStart emits `hookSpecificOutput.additionalContext` listing this workspace's jobs from prior sessions that are running or finished within the last 24h and unread: id, status, sandbox badge, and `attach`/`result`/`cancel` hints. Keep the hook within its 5s budget: read state files only, no app-server calls.
- **Acceptance criteria:** Create a job in session A, then start session B with a different `CODEX_COMPANION_SESSION_ID`. `status --all-sessions` lists the job. `attach <id>` succeeds, after which a bare `status` and `cancel` in B target it. B's SessionStart output mentions the job id. A resumed Claude session (`claude --resume`/`--continue`, SessionStart `source: "resume"`) that reports the same `session_id` sees its own earlier jobs as its own without `attach`; if the hook input carries a new id, the SessionStart context still lists the old jobs. (Record which of the two Claude Code does in a test fixture; E4 was a process restart and it was unclear which applied.)

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

### FR-12: A `models` subcommand, user aliases and model validation
- **Priority:** P1
- **Problem:** The only alias is `spark → gpt-5.3-codex-spark`, and that target is **not** in the local catalog, so the one built-in alias points at a model this host cannot run. `normalizeRequestedModel` passes anything else through, so a wrong name fails late inside the worker. There is no `model/list` call anywhere. The docs and the rescue agent use `gpt-5.4-mini` as an example (`agents/codex-rescue.md` 32, README.md 158), which is not in the catalog either, and the prompting skill is named after GPT-5.4. **Naming, verified against the local catalog:** `gpt-6-luna` (README.md 56, 115, 226; also the `model` in the user's `~/.codex/config.toml`) and `gpt-5.6-luna` (the consuming repo's CLAUDE.md) are **both real, distinct models**. Neither side is wrong. The user's "Luna 6" most plausibly means `gpt-6-luna`, but it also matches `gpt-5.6-luna`, so a phrase resolver must treat it as ambiguous rather than silently pick one. Re-check with `model/list` at implementation time, because the catalog changes.
- **Evidence:** E5. `codex-companion.mjs` `MODEL_ALIASES` ~78 and `normalizeRequestedModel` ~262-274. `agents/codex-rescue.md` 29-34. `skills/codex-cli-runtime/SKILL.md` ~22. `README.md` 56, 115, 158 and 226.
- **Proposal:** `models [--json] [--all] [--refresh]` calls app-server `model/list`, caches it for 1h keyed by the codex version under the state root, and returns id, display name, isDefault, supportedReasoningEfforts and defaultEffort. Add a `modelAliases` config key (workspace, repo and global), set with `setup --alias luna=<id>` and removed with `setup --alias luna=none`. `task`, `send`, `setup --default-model` and review commands resolve aliases, then match case-insensitively, then validate against the catalog. An unknown model fails **before** any job record or worker is created with `unknown model X; did you mean Y, Z` (exit 2). A natural phrase such as "luna 6" that matches several ids returns an ambiguity error listing them. If the app-server is unreachable, fall back to `codex debug models` (renders the raw catalog as JSON without an app-server) or `~/.codex/models_cache.json`; if all fail, warn and pass the name through. Record both `requestedModel` (the alias) and `model` (the resolved id). When no model is requested, `models` and the setup report show which model will actually run (the config.toml `model`, e.g. `gpt-6-luna`), so "leave model unset" is an informed choice. Add a `/codex:models` command and the MCP tool `codex_models`. Replace the `gpt-5.4-mini` examples with real ids, and drop or re-verify the `spark` alias (validate every built-in alias against the catalog at load; a built-in alias whose target is missing is hidden with a warning).
- **Acceptance criteria:** With a fake `model/list` of `[gpt-6-luna, gpt-5.6-luna, gpt-5.6-terra]`: `--model gpt-7-luna` exits 2, suggests `gpt-6-luna` and `gpt-5.6-luna`, and creates no job record. `--model "luna 6"` exits 2 with an ambiguity error listing both luna ids. With the alias `luna=gpt-5.6-luna` configured, `--model luna` resolves to `gpt-5.6-luna`. `--model spark` against a catalog without `gpt-5.3-codex-spark` fails before a worker spawns. `models --json` lists ids with isDefault and efforts. With the app-server fake unavailable, `models` falls back to `codex debug models` output.

### FR-13: Lane isolation: developer instructions, skill and hook policy, a preamble, and a generic `-c` config passthrough
- **Priority:** P1
- **Problem:** Codex lanes auto-invoke repo skills (such as bmad-build, which then hard-blocks), and session hooks (bd prime, Serena) inject context (E9). Every brief has to carry boilerplate. The only per-thread config the plugin sends is `sandbox_workspace_write.network_access`. `buildThreadParams` already forwards an arbitrary `options.config`, but `executeTaskRun` sets only `buildSandboxConfig(network)`. There is no `developerInstructions`, no `-c key=value`, and no `--codex-profile`.
- **Evidence:** E9. `lib/codex.mjs` 63-86 and 235 (`buildTurnInput`). `codex-companion.mjs` `buildSandboxConfig` ~249-251, ~709-721 and `RUNTIME_VALUE_OPTIONS` ~1002. `lib/app-server-protocol.d.ts` 59-69.
- **Proposal:**
  1. `task|send|review -c key=value` (repeatable, TOML-parsed values) and config `codexConfigOverrides`, **deep-merged** with the sandbox config (never replacing it) into the thread/start, resume and fork `config`. Recorded in `job.runtime.config`. Invalid TOML fails synchronously.
  2. `--codex-profile <name>`, if the app-server supports a profile param; otherwise map it to `-c profile=…`. Verify which.
  3. `--developer-instructions <file>` and config `developerInstructions`, passed on thread/start if `ThreadStartParams` supports it (the probe says it does; verify). Otherwise fall back to a preamble.
  4. `--lane-preamble <file|builtin:delegated-worker>` and config `defaultPreamble`, prepended to the turn input as a `<harness_rules>` block. The built-in text says: you are a delegated worker; do not invoke interactive or orchestration skills; do not run session-start rituals; in a shared working tree (no `--worktree`), never run a bare `git commit`, `git add -A`, `git stash` or `git push`, and commit only with an explicit pathspec when the brief asks for commits (other sessions share the index, E10); report files changed, validation and risks.
  5. `--skills off|allow:<glob>|deny:<glob>`, `--hooks off` and `--no-agents-md`. These are implemented only through per-thread config overrides after the real config keys are verified with `config/read`, `skills/list` and `hooks/list`. **Never** call `skills/config/write` or anything else that mutates user-global Codex config.
  6. `lane-context [--json]` reports the skills, hooks, AGENTS.md files and preamble that a lane would load, with their sources.
- **Acceptance criteria:** A fake-fixture test shows the `codexConfigOverrides` merged with `network_access` in the thread/start params, the configured `developerInstructions` present (or the preamble at the top of the turn input), and `--skills deny:bmad-*` / `--hooks off` producing the verified override keys. `lane-context --json` lists skills and hooks with sources. The RPC trace contains no `skills/config/write`.

### FR-14: More persistent defaults, and named profiles (including `bypass`)
- **Priority:** P2
- **Problem:** Defaults persist only for model, effort, sandbox and network. `setup --global --default-sandbox danger-full-access --default-network on` already removes the need for per-call `--full-access --network` (E8), and `--write` never narrows it. There are still no defaults for resume policy, attach/background, isolation, timeouts, the session-end policy or expect-changes, and no one-shot profile. `/codex:rescue` runs a resume probe plus AskUserQuestion unless `--resume` or `--fresh` is passed.
- **Evidence:** E8. `codex-companion.mjs` `DEFAULT_ENV` ~92-100, ~155-185 and ~288-446. `commands/rescue.md` 22-38. `agents/codex-rescue.md` 35-37. `README.md` 66.
- **Proposal:**
  1. New config keys: `defaultResume: fresh|last|ask`, `defaultLaunch: attach|background|foreground`, `defaultIsolation: none|worktree`, `defaultExpectChanges`, `sendAckTimeoutMs`, `waitTimeoutMs`, `sessionEndPolicy`, `onOwnerExit`, `defaultMaxRuntime`, `defaultPreamble`, `codexConfigOverrides`, `modelAliases`, `reviewModel`, `reviewEffort`, `stopRunningJobs`. The full schema is in §8.4.
  2. Add `permissionProfiles`. Built-ins: `bypass` (danger-full-access, network on, write), `write` (workspace-write, no network) and `readonly`. User-defined profiles are also allowed. Set them with `setup --default-profile <name> [--global]`, `task|send --profile <name>` or env `CODEX_COMPANION_PROFILE`. Profiles expand into the existing keys, with lower precedence than explicit flags. `setup --profile bypass --global` writes the bundle and prints a visible warning.
  3. `rescue.md` and the drive skill consult `defaultResume` (returned by `task-resume-candidate --json`) and never call AskUserQuestion unless it is `ask`.
  4. Every task output echoes one line with the effective runtime and its sources.
- **Acceptance criteria:** After `setup --global --default-profile bypass`, a bare `task "x"` records a thread/start with `danger-full-access`, network access, and a fresh thread, and status shows `profile bypass`. `task --profile readonly` overrides it once. With `defaultResume=fresh`, rescue never calls AskUserQuestion. With `sendAckTimeoutMs=60000`, `send` waits 60s. `setup --json` reports each value with its source.

### FR-15: Config introspection, a repo-level config file, and accurate generated guidance
- **Priority:** P2
- **Problem:** Workspace config lives in `state.json` under a hashed state directory outside the repo, so a team cannot version its defaults. `setup` reports four defaults with their source, but no file paths, no Codex config layer, and no validation. Downstream docs (E7) reference tools that do not exist.
- **Evidence:** E7, E8. `lib/state.mjs` 52-65 and 307-354. `codex-companion.mjs` ~160-181 and ~359. `lib/render.mjs` 220-228.
- **Proposal:**
  1. Read a checked-in `.codex-companion.json` at the repo root as a `repo` layer between workspace and global (schema in §8.4).
  2. `config show [--json]` prints `{key, value, source, path}` for every key, including the `codex-config` layer (BUG-5).
  3. `config set|unset <key> [value] [--global|--repo]`.
  4. `config doctor` validates models, aliases and efforts against `model/list`, flags conflicts (such as network with read-only), and warns when the workspace's CLAUDE.md or AGENTS.md mention `mcp__codex__` while no such server is registered.
  5. `setup --print-claude-md` emits an accurate delegation block that references only commands and tools that exist.
- **Acceptance criteria:** A repo whose `.codex-companion.json` sets `defaultModel` runs tasks on that model, with source `repo`. `config show --json` returns paths. `config doctor` exits non-zero and names the key when `defaultModel` is not in the catalog. The `--print-claude-md` output references only real subcommands and tools; a doc-consistency test checks this.

### FR-16: Hook-injected job events (a completion ledger) for jobs Claude is not following
- **Priority:** P2 (complements BUG-4)
- **Problem:** Jobs started with `--background`/`--detach`, or still running after a restart, finish silently. No hook reports completion.
- **Evidence:** E2, E4. `hooks/hooks.json`. `scripts/stop-review-gate-hook.mjs` 33-38 and 150-183.
- **Proposal:** Add UserPromptSubmit and PostToolUse hooks with a budget of 1s or less. They read state files only (no app-server calls) and emit `additionalContext` for each terminal transition not yet announced, tracked with `notifiedAt` per job, e.g. `Codex job X completed (exit 0): <1-line summary>; files: a, b; see result X`. Each transition is emitted at most once per session. The job must belong to this session or have been adopted. Make it configurable (`notifyVia: hooks|off`). Keep PostToolUse cheap: bail out after a single `stat` of `state.json` if its mtime has not changed.
- **Acceptance criteria:** After a background job completes, the PostToolUse hook's stdout JSON contains the job id once, and the next run prints nothing. The hook stays under 1s with 200 jobs.

### FR-17: Per-job wall-clock budget and idle timeout with automatic interrupt
- **Priority:** P2
- **Problem:** A runaway job can run indefinitely against a live system. The only timeouts are on the caller side (wait at 1h, status `--wait`, steer and import requests).
- **Evidence:** E1. `codex-companion.mjs` ~99-101. `lib/tracked-jobs.mjs` `runTrackedJob` 139-207 (no deadline). `lib/codex.mjs` ~52, ~119 and 532-542.
- **Proposal:** Add `task --max-runtime <dur>` and `--idle-timeout <dur>` (no events for that long), plus `setup --default-max-runtime`. The worker enforces them: at 80% of the budget it delivers a steer through the inbox ("wrap up; N minutes left"). At the limit it interrupts, then runs the BUG-2 escalation, and records `status:'timed-out'` with `cancelReason:'max-runtime'` or `'idle-timeout'`. `wait` and attach exit **4** for a timed-out job, so Claude can tell "the job hit its budget" (4) apart from "the waiter gave up while the job still runs" (124). See the exit-code table in §8.1.
- **Acceptance criteria:** `--max-runtime 5s` on a long fake turn ends as `timed-out` within about 7s, the fixture received `turn/interrupt`, and `wait <id>` exits 4. `wait <other-running-id> --timeout-ms 1000` exits 124 and the job is still running. `--idle-timeout` fires when the fixture goes silent. The 80% wrap-up steer is recorded in the inbox and events.

### FR-18: A parallel fan-out primitive with a concurrency cap and aggregated results
- **Priority:** P2
- **Problem:** Workflow/Ultracode fans out subagents and collects typed results. With Codex, fan-out means N separate `task --background` calls with no cap, no group, and `wait` returning only statuses. All jobs also share one broker, which serves one stream at a time and pushes the rest to direct app-servers.
- **Evidence:** E12. `codex-companion.mjs` ~911-950 and ~1205-1272. `README.md` 222-230. `lib/codex.mjs` 762-791.
- **Proposal:** Add `fanout --spec <file.jsonl|-> [--max-parallel 4] [--group <name>] [--worktree] [--output-schema …] [--attach]`. Each spec line is `{name, prompt|promptFile, model?, effort?, sandbox?, cwd?, outputSchema?}`. Jobs share a `groupId` and are scheduled under the state lock: queued jobs are not launched until a slot is free. Add `wait --group <g> --json`, which returns `[{name, jobId, status, report, exitCode}]`, and `cancel --group <g>`. Attach mode cancels the whole group on SIGTERM. Mirror it as the MCP tool `codex_fanout`. Given the broker's one-stream design, decide whether fan-out jobs should use direct app-servers intentionally (recommended) and record `transport`.
- **Acceptance criteria:** With 6 specs and `--max-parallel 2`, sampling never shows more than 2 running jobs. `wait --group --json` returns 6 entries with reports. Cancelling the group leaves 0 live workers and 0 active turns at the fake. SIGTERM in attach mode cancels the group.

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

### FR-21: An explicit `fork` command
- **Priority:** P2
- **Problem:** There is no user-facing fork for trying alternatives from the same context. The automatic fork is covered in BUG-11.
- **Evidence:** `lib/codex.mjs` 1253-1284.
- **Proposal:** Add `fork <jobId|threadId> [prompt] [--background|--attach] [runtime flags]`, which creates a new job via `thread/fork` with `forkedFromThreadId`. Mirror it as the MCP tool `codex_fork`.
- **Acceptance criteria:** `fork <jobId> 'try B'` produces a job with a different threadId and `forkedFromThreadId` equal to the parent's.

### FR-22: Broker observability and health commands
- **Priority:** P2
- **Problem:** The broker serializes sockets, returns BUSY, is shared across sessions, and can be torn down by any session. Claude sees only `Session runtime: shared session|direct startup` and the endpoint.
- **Evidence:** `app-server-broker.mjs` 85-90 and 171-183. `lib/codex.mjs` `getSessionRuntimeStatus` 1055-1072. `lib/render.mjs` ~370.
- **Proposal:** Add a busy-exempt `broker/status` method in the broker. Add `broker status [--json]` (pid, endpoint, uptime, codex version, `activeStream{jobId, threadId, turnId}`, sockets, busy-rejection count, leases), `broker logs [--tail N]`, `broker restart` and `broker stop [--if-idle]`. Add a broker line to `status` and broker health to `setup --json`.
- **Acceptance criteria:** While a turn streams, `broker status --json` succeeds and `activeStream.threadId` matches the job. `broker stop --if-idle` exits non-zero while streaming. The busy count increments after a second client's `thread/list`.

### FR-23: Cut the Claude-side token cost of dispatch and results
- **Priority:** P2
- **Problem:** One dispatch cost about 13k tokens and 2.5 minutes. The cost comes from the command body, the resume probe plus AskUserQuestion, and a Haiku subagent that preloads two skills. Results come back verbatim with no size bound, and the rescue and result contracts forbid summarizing.
- **Evidence:** E2. `agents/codex-rescue.md` 6-9. `commands/rescue.md` 22-44. `commands/result.md` 10-15. `skills/codex-result-handling/SKILL.md` 10-19.
- **Proposal:**
  - Use the direct path (BUG-4).
  - Add `--format brief|full|json` to task, attach, result and wait. `brief` prints status, a 1-5 line summary (the report summary or the first lines of the final message), files with stats, failed commands, and pointers to `result`, `diff`, `logs` and `transcript`, capped by `--max-chars` (default 6000).
  - Load the prompting skill on demand.
  - Relax the "verbatim, no summarizing" rule when the format is brief.
  - Relax `codex-result-handling`'s "must ask before acting on findings" rule when the user delegated autonomously. Keep it configurable.
- **Acceptance criteria:** Brief output for a fixture with a 20KB final message is at most 6000 characters and includes the pointers. A manual measurement of dispatch plus brief result is 3k Claude tokens or fewer, recorded in the PR.

### FR-24: Tests and CI for lifecycle, cancel, reconciliation, reports and docs
- **Priority:** P2
- **Problem:** Some lifecycle tests exist: cancel happy path (`tests/runtime.test.mjs` 1542 and 1740), cancel scoping (~1637 and ~1692), SessionEnd cleanup (~1804), Stop-hook stderr (~1982), and wait/send (`tests/orvex.test.mjs` 194-342). There are no tests for a failed interrupt, a broker orphan, dead-pid reconciliation, or doc/subcommand consistency. `tests/commands.test.mjs` 77-85 only checks that `send.md` and `wait.md` exist. CI (`.github/workflows/pull-request-ci.yml`) runs only on `pull_request` and installs `@openai/codex` unpinned.
- **Evidence:** As listed.
- **Proposal:** Add a test for every new item (see §9). Run CI on push to `main`/`dev`, on pull requests and nightly. Pin the codex version. Add an auth-gated nightly contract test against the real app-server (`initialize`, `thread/start`, `turn/start`, `turn/steer`, `turn/interrupt`, `model/list`, `config/read`, `thread/read`), skipped without auth. Add a doc-consistency test that fails when any command, skill or README references a subcommand, flag or tool that does not exist.
- **Acceptance criteria:** `npm test` covers each new item. The workflow has `on: [push, pull_request, schedule]`. The contract test file exists and skips cleanly without auth. The doc-consistency test catches an injected bad reference.

### FR-25: Ship bypass as the Orvex fork's out-of-box default
- **Priority:** P1 (lands in M1, only after M0's BUG-1, BUG-2, BUG-3 and BUG-6)
- **Problem:** The user's first goal is "no sandbox, no approval prompts by default, like Claude's bypass-permissions mode". Today that needs either a manual `setup --global --default-sandbox danger-full-access --default-network on` (which the E8 session never ran) or, after BUG-5, a config.toml that already says so. FR-14 adds a `bypass` profile but leaves the fork's built-in default at `read-only` (or at whatever config.toml says). Nothing in the plan makes bypass the default for a fresh install of this fork, and nothing tells Claude which mode a job will run in before it launches.
- **Evidence:** E8, E1. `codex-companion.mjs` `resolveTaskRuntime` ~202-247 (built-in `read-only`). README.md 19 and 56. `lib/render.mjs` ~221.
- **Proposal:**
  1. Change the fork's **built-in** tier (the last one in §8.4) to the `bypass` profile: `danger-full-access`, network on, `approvalPolicy: never`. The codex-config tier (BUG-5) still wins over it, so a user whose config.toml says `workspace-write` keeps that.
  2. Opt-out, available at once: `setup --global --default-sandbox read-only|workspace-write` or env `CODEX_COMPANION_SANDBOX` (both exist today). After FR-14 also `setup --global --default-profile write|readonly` and `CODEX_COMPANION_PROFILE`.
  3. Review, adversarial-review and the stop gate stay forced `read-only` (BUG-8).
  4. Safety coupling: the bypass default is only allowed when the job is owned (`--attach`, foreground, MCP wait, or `--owner-pid`). An unowned `--background` launch with no explicit sandbox flag falls back to `workspace-write` and prints why, unless `--detach` is explicit. Implement this check directly here; WISH-2's `requireLeaseFor` later generalizes it.
  5. Every launch's first line (`CODEX_JOB …`, BUG-4) and the setup report show `sandbox=danger-full-access network=unrestricted approval=never source=built-in:bypass`.
  6. The CHANGELOG and README state the new default prominently, and `setup` prints a one-time notice on first run after the upgrade.
- **Acceptance criteria:**
  - With an empty plugin config and a `CODEX_HOME` whose config.toml sets no sandbox, a bare `task --attach "x"` sends thread/start with `sandbox:'danger-full-access'` and `approvalPolicy:'never'`, and the first stdout line contains `source=built-in:bypass`.
  - With config.toml `sandbox_mode="workspace-write"`, the same call sends no override (or `workspace-write`) and reports source `codex-config`.
  - `review` and the stop gate still send `read-only`.
  - An unowned bare `task --background "x"` runs `workspace-write` and prints the reason; `task --background --detach "x"` runs bypass.
  - `CODEX_COMPANION_SANDBOX=read-only task "x"` runs `read-only` (and, after FR-14, so does `CODEX_COMPANION_PROFILE=readonly`).

### FR-26: Evaluate Codex 0.157's native daemon, `queue` and `exec` surfaces before building parallel machinery
- **Priority:** P1 (a time-boxed spike at the start of M0; its outcome can shrink BUG-1, BUG-3, FR-20 and FR-22)
- **Problem:** The plan builds ownership, steering, broker leases and broker observability on top of the plugin's own per-workspace broker. codex-cli 0.157.0 now ships overlapping native features that the report never considered: `codex agents` ("Browse all agent sessions on the shared local app-server daemon"), a daemon control socket at `~/.codex/app-server-control/app-server-control.sock` (with `~/.codex/app-server-daemon/`), `codex queue --thread <id> --message <text>` ("Queue a message for an existing session"), `codex exec --output-schema <file>`, and `--dangerously-bypass-hook-trust` (relevant to E9's hook injection). If the plugin's jobs ran on the native daemon, sessions would be visible in `codex agents`, steering could reuse `codex queue`, and the plugin's broker (and BUG-3's teardown problem) might go away.
- **Evidence:** E1, E4, E6, E9. `codex --help`, `codex queue --help`, `codex agents --help`, `codex exec --help` on codex-cli 0.157.0. `ls ~/.codex/app-server-control ~/.codex/app-server-daemon`.
- **Proposal:** Before M0 step 3, spend at most one day answering, in `docs/codex-native-surfaces.md`: (1) Can the plugin connect to the native daemon socket and run `thread/start`/`turn/start` there? Does a turn survive client disconnect, and does the daemon offer interrupt-on-disconnect or ownership? (2) Does `codex queue` deliver into a *running* turn (steer) or only queue for the next turn, and does it work on threads started through the app-server? (3) Does `codex agents` list plugin-started threads? (4) What does `--dangerously-bypass-hook-trust` change, and is there a per-thread equivalent that stops Codex hooks from injecting context (E9)? (5) Decision: keep the plugin broker, switch to the native daemon, or support both behind `transport: broker|daemon|direct`. Update BUG-1, BUG-3, FR-13, FR-20 and FR-22 to match the decision.
- **Acceptance criteria:** The spike document exists and answers all five questions with the exact commands and outputs used. Each answer names the report items it changes, and those items are edited in the same PR. If the native daemon is adopted, a fake-fixture test covers the `daemon` transport's connect, interrupt and disconnect behaviour.

### FR-27: Fix downstream delegation docs once the real tools exist
- **Priority:** P2 (follows FR-11 and FR-15)
- **Problem:** E7 was caused by a consuming repo's CLAUDE.md (houston) that tells Claude to call `mcp__codex__codex` and `codex-reply` with a `threadId`, to default to `gpt-5.6-luna`, and to escalate to `gpt-5.6-terra`. None of the tools exist, and nothing in the plan updates or checks that file. FR-15's `config doctor` only *warns*.
- **Evidence:** E7, E5. `/home/crew/workspace/houston/CLAUDE.md` ("Delegating to Codex", "Preserve Codex thread continuity", "Escalation" sections).
- **Proposal:**
  1. After FR-11 ships, `setup --print-claude-md` emits a block that uses the exact registered tool names (`mcp__codex__codex`, `mcp__codex__codex-reply`, `mcp__codex__codex_steer`, …) or, when no MCP server is registered, the `orvex-codex` Bash equivalents (`task --attach`, `send`, `interrupt`, `task --resume <threadId>`).
  2. `setup --install-mcp [--scope user|project]` runs the equivalent of `claude mcp add -s <scope> codex -- orvex-codex mcp`, so the documented names really exist.
  3. The block's model guidance uses aliases (`luna`, `terra`) resolved through FR-12, not hard-coded ids.
  4. File a follow-up in the consuming repo (not in this plugin repo) to replace its hand-written section with the generated block.
- **Acceptance criteria:** In a temp workspace, `setup --install-mcp --scope project` followed by `setup --print-claude-md` produces text in which every `mcp__codex__*` name appears in the server's `tools/list`. Without the MCP server, the block names only existing subcommands (checked by FR-24's doc-consistency test). `config doctor` reports no delegation warnings against the generated block, and warns about each missing `mcp__codex__*` tool against the current houston text.

---

## 6. Wish list

### WISH-1: Log full commands, file paths and failure output tails in the human log
- **Priority:** P3 (a quick win; do it alongside FR-2)
- **Problem:** The same shortened message feeds stderr and the log, so commands appear at 96 characters. File changes are logged as `Applying N file change(s)` with no paths. Failing commands have no duration and no output tail.
- **Evidence:** E3. `lib/codex.mjs` 394-402 and 419-431. `lib/tracked-jobs.mjs` 126-128.
- **Proposal:** Write the full command to the log and keep the short form for stderr and the preview. Log up to 10 paths with their kind (`+N more` beyond that). On a non-zero exit, log the duration and the last 3 output lines.
- **Acceptance criteria:** A 200-character command appears untruncated in the log. A fileChange with 3 paths logs all 3. A failing command's entry includes its output tail.

### WISH-2: Safety rails for live systems: `cancel --all`, a risk badge, a lease requirement and a runtime header
- **Priority:** P2
- **Problem:** With full access and network as defaults, one mis-dispatched job can modify production. `cancel` with no id errors when several jobs are active. The runtime appears only in the single-job view.
- **Evidence:** E1, E8, E10. `lib/job-control.mjs` 302-304. `lib/render.mjs` 124-149.
- **Proposal:** Add `cancel --all [--workspace|--everywhere]`, each cancel verified (BUG-2). Show a `[FULL-ACCESS+NET]`-style badge on status rows, in wait output, on attach heartbeat lines and in the log header. The first log line records the resolved runtime (sandbox, network, model, cwd, git HEAD and branch). Add `setup --require-lease-for full-access`, which rejects a detached full-access job unless `--detach` is explicit.
- **Acceptance criteria:** With 3 active fake jobs, `cancel --all` leaves zero active jobs, each verified. A full-access row shows the badge. With require-lease on, `task --full-access --background` without `--attach` or `--detach` fails with a clear message.

### WISH-3: Reviews: honour `--background`, add `--effort` and `--attach`, allow steering, drop prompts
- **Priority:** P3
- **Problem:** `handleReviewCommand` parses `--background` and `--wait` but always runs in the foreground. It has no `--effort`, and `send` rejects non-task jobs. `review.md` and `adversarial-review.md` ask through AskUserQuestion unless `--wait` or `--background` is given. Reviews are already tracked jobs that can be cancelled by id, and `result --json` returns adversarial findings.
- **Evidence:** `codex-companion.mjs` ~952-1000 and ~1142-1144. `commands/review.md` 18-38. `commands/adversarial-review.md` 21-35.
- **Proposal:** Route reviews through the tracked worker path when `--background` or `--attach` is set, with an inbox and a lease. Allow `send` on adversarial-review jobs, which are ordinary turns. For native `review/start` turns, gate it on whether steering is supported. Add `--effort`. Add the MCP tools `codex_review` and `codex_adversarial_review`, which return the existing review schema. Skip AskUserQuestion when `--wait`, `--background` or `--attach` is present, or when the model invoked the command.
- **Acceptance criteria:** `adversarial-review --background --json` returns a jobId. `send <id> 'focus on auth'` is delivered. `cancel <id>` is verified. `result <id> --json` returns schema-valid findings.

### WISH-4: Escalation ladder (the Luna → Terra rule)
- **Priority:** P3
- **Problem:** The repo policy is to escalate after two failures. You can already escalate by hand without losing context, with `send <job> --model X --effort Y`. There is no failure counting or suggestion.
- **Evidence:** E5. `codex-companion.mjs` `handleSend` ~1119-1190 and `RUNTIME_VALUE_OPTIONS` ~1002.
- **Proposal:** Add config `escalation {ladder[], effortLadder[], afterFailures, mode: suggest|auto}`, validated against `model/list`, with failures counted per `parentJobId` lineage. In `suggest` mode, result and status append `nextStep.escalation`. In `auto` mode, the next send switches to the next rung and records `runtime.escalatedFrom`.
- **Acceptance criteria:** After 2 failed jobs in a lineage, `result --json` includes `nextStep.escalation`. In auto mode the next `send` uses the next rung, and status shows `escalated from`.

### WISH-5: An approval bridge, and logging of rejected server requests
- **Priority:** P3
- **Problem:** `approvalPolicy` is always `never`. Every server-initiated request is answered with `-32601 Unsupported server request`, and nothing is logged.
- **Evidence:** `lib/codex.mjs` 67, 81 and 1278. `lib/app-server.mjs` 156-161.
- **Proposal:** Right away, log `[codex] Rejected server request <method>` to the job log and to events. Later, add an optional bridge: a pending-approvals file, an `awaiting-approval` phase, `approve <job> <reqId> [--deny]`, and a timeout that auto-denies. Add `--approval <mode>`, which rejects anything other than `never` until the bridge exists.
- **Acceptance criteria:** In `never` mode, a fake server request produces the log line. In bridge mode, status shows `awaiting-approval`, `approve` resumes the turn, and the timeout denies.

### WISH-6: A model-agnostic prompting skill, loaded on demand
- **Priority:** P3
- **Problem:** `skills/gpt-5-4-prompting` is titled "GPT-5.4 Prompting" and is preloaded by the forwarder on every dispatch.
- **Evidence:** E5. `skills/gpt-5-4-prompting/SKILL.md` 1-9. `agents/codex-rescue.md` 6-9.
- **Proposal:** Rename it to `codex-prompting` and make it model-agnostic, with per-model notes keyed off `models`. Remove it from the agent frontmatter preloads.
- **Acceptance criteria:** No agent or command preloads it. The skill name encodes no model version.

### WISH-7: Job history retention, archive and `gc`
- **Priority:** P3
- **Problem:** Pruning deletes evidence (BUG-14). There is no `gc`, archive or history command.
- **Evidence:** `lib/state.mjs` 15 and 226-263.
- **Proposal:** Prune by age (`historyDays`, default 14) plus a count cap. Before deleting, archive the report, patch, events and result JSON to `<stateDir>/archive/<yyyy-mm>/<id>.json`. Add `gc [--older-than 7d] [--keep N] [--dry-run] [--json]` and `history [--since] [--json]`. `result <id>` falls back to the archive.
- **Acceptance criteria:** With 201 jobs, the oldest job's report can still be read with `result <id> --json`. `gc --dry-run` deletes nothing and lists the candidates.

---

## 7. Recommended implementation order

Each milestone ends with a green `npm test` and one or more coherent commits. The dependencies are noted.

**M0: Stop the bleeding (safety; do first).**
0. **FR-26** spike (at most one day): decide broker vs native daemon transport before building ownership and leases on the broker.
1. **BUG-6** liveness: `isProcessAlive` export, `workerStartTime`, heartbeat, `reconcileJob`, `.worker.err`. Many later items reuse these.
2. **BUG-2** verified cancel: transport recording, the `control.jsonl` channel in the worker, escalation and verification, exit codes, the rendered report. Depends on 1.
3. **BUG-1** ownership: broker interrupt-on-disconnect, signal handlers, `--attach` / `--detach` / `--owner-pid` / `--on-owner-exit`, the owner lease. Depends on 1 and 2.
4. **BUG-3** SessionEnd: stop deleting records, the policy, broker lease ref-counting, a persistent broker log. Depends on 2.
5. **BUG-14** keep active and unread jobs when pruning.

**M1: Truthful completion and direct dispatch.**
6. **BUG-4**: rescue rewritten to a direct `task --attach` under run_in_background, the `CODEX_JOB` first line, Stop hook JSON output, the shim agent. Depends on M0 step 3.
7. **FR-1**: model-invocable status, result and cancel, plus the `codex:drive` skill. Can land together with step 6.
8. **BUG-5** codex-config layer, **BUG-8** read-only stop gate, **BUG-12** effective network. These are small.
9. **FR-16** hook completion ledger.
9a. **FR-25** bypass as the built-in default, implemented as plain built-in values (`danger-full-access`, network on) with the ownership check done directly in `handleTask`; FR-14 later names it the `bypass` profile and WISH-2 generalizes the check into `requireLeaseFor`. Depends on BUG-5 and on all of M0.

**M2: Visibility.**
10. **FR-2** events.jsonl with `events` and `logs`, plus **WISH-1** log detail.
11. **FR-3** capture deltas, diff, plan and usage (feeds FR-2).
12. **FR-4** structured report, `--output-schema`, and the result schema; **FR-5** git snapshots and `diff` (FR-4 consumes FR-5's data).
13. **FR-7** transcript and rollout path; **FR-8** `result --partial` and `status --lines`.

**M3: Control and continuity.**
14. **BUG-7** `--resume <id>` and `--thread`; **BUG-11** fork visibility and thread unload; **FR-21** fork command.
15. **FR-9** interrupt `--then` (reuses the M0 control channel).
16. **FR-10** reattach, adopt, all-sessions listing, SessionStart context (depends on BUG-3).
17. **FR-20** send semantics; **FR-17** max-runtime and idle timeout (reuses the cancel escalation).

**M4: Models, config and lane hygiene.**
18. **FR-12** models, aliases and validation; **BUG-9** effort validation; **BUG-10** effective runtime.
19. **FR-13** lane isolation (verify the app-server config keys first); **FR-14** defaults and profiles; **FR-15** config show, repo file and doctor.

**M5: Integration surface.**
20. **FR-11** MCP server. It wraps M0-M4 primitives, so do it after they are stable.
21. **FR-19** Workflow lane, **FR-23** brief format and token cost, **FR-18** fan-out, **FR-27** generated delegation docs and `setup --install-mcp`.

**M6: Isolation and operations.**
22. **FR-6** worktrees and the tree lease; **BUG-15** cross-session overlap warnings. FR-6 can move up to M2 if the shared-tree collisions (E10) keep recurring.
23. **FR-22** broker observability, **BUG-13** error surfacing, **WISH-2** safety rails, **FR-24** CI hardening (write tests continuously, but restructure CI here).
24. The remaining wishes: WISH-3, WISH-4, WISH-5, WISH-6, WISH-7.

---

## 8. Proposed target interface

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

### 8.2 Key JSON shapes

```jsonc
// job record additions (jobs/<id>.json)
{
  "schemaVersion": 2,
  "status": "queued|running|completed|failed|cancelled|cancel-pending|cancel-failed|interrupted|timed-out|lost|orphaned",
  "owner": {"kind":"attach|foreground|pid|detached","pid":123,"startTime":"...","heartbeatAt":"...","ttlMs":30000},
  "worker": {"pid":456,"startTime":"...","heartbeatAt":"...","stderrFile":"jobs/<id>.worker.err"},
  "transport": "broker|direct", "transportFallbackReason": null, "brokerEndpoint": "unix:...", "appServerPid": 789,
  "runtime": {"requested":{...}, "effective":{"model":"...","effort":"...","sandbox":"...","network":"unrestricted|on|off|blocked","approvalPolicy":"never"}, "sources":{"model":"codex-config",...}, "profile":"bypass", "config":{...}},
  "threadId":"...", "forkedFromThreadId":null, "resumedFromJobId":null, "turns":[{"turnId":"...","status":"...","startedAt":"...","endedAt":"..."}],
  "worktree": {"path":"...","branch":"codex/<id>","baseRef":"..."} ,
  "cancel": {"requestedAt":"...","reason":"user|owner-lost|session-ended|max-runtime","interruptDelivered":true,"turnConfirmedStopped":true,"workerExited":true,"appServerExited":true,"residualPids":[]},
  "rolloutPath": "...", "usage": {...}, "plan": {...}, "overlapsWith": [], "groupId": null,
  "notifiedAt": null, "resultReadAt": null, "warnings": []
}

// result payload (result --json → storedJob.result)
{
  "schemaVersion": 2, "status": "completed", "threadId": "...", "turnIds": ["..."],
  "rawOutput": "...", "reasoningSummary": "...", "undeliveredMessages": [],
  "report": {
    "filesChanged": [{"path":"a.ts","kind":"modify","additions":3,"deletions":1}],
    "commands": [{"command":"npm test","cwd":"...","exitCode":1,"durationMs":5400,"status":"completed","outputTail":"..."}],
    "validation": {"ran":true,"allPassed":false,"failing":["npm test"]},
    "git": {"headBefore":"...","headAfter":"...","newCommits":[],"changedByJob":["a.ts"],"changedConcurrently":[],"untrackedAdded":[],"patchFile":"jobs/<id>.patch"},
    "usage": {...}, "elapsedMs": 61234, "rolloutPath": "...", "effectiveRuntime": {...}, "warnings": []
  },
  "structured": {"ok":true,"data":{...},"validationErrors":[]}   // only with --output-schema
}
```

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

### 8.4 Config schema (global `~/.config/codex-companion/config.json`, repo `.codex-companion.json`, workspace `state.json.config`)

Precedence: flag > inherited (follow-ups) > env `CODEX_COMPANION_*` > workspace > repo > global > profile > codex-config (`config/read`) > built-in. In this fork the built-in tier is the `bypass` profile (FR-25); reviews and the stop gate are always forced `read-only` regardless of tier.

```jsonc
{
  "defaultProfile": "bypass",                // bypass | write | readonly | <custom>
  "permissionProfiles": { "custom": {"sandbox":"workspace-write","network":true} },
  "defaultModel": "gpt-x", "defaultEffort": "high", "defaultSandbox": "danger-full-access", "defaultNetwork": true,
  "modelAliases": { "luna": "<verified id>", "terra": "<verified id>" },
  "reviewModel": null, "reviewEffort": null,
  "defaultResume": "fresh",                  // fresh | last | ask
  "defaultLaunch": "attach",                 // attach | background | foreground
  "onOwnerExit": "cancel",                   // cancel | continue
  "sessionEndPolicy": "cancel",              // cancel | detach
  "defaultIsolation": "none",                // none | worktree
  "defaultExpectChanges": false,
  "defaultMaxRuntime": null, "defaultIdleTimeout": null,
  "sendAckTimeoutMs": 20000, "waitTimeoutMs": 3600000,
  "defaultPreamble": "builtin:delegated-worker",
  "developerInstructions": null,
  "codexConfigOverrides": { },               // deep-merged into thread config
  "skillsPolicy": null, "hooksPolicy": null, // verified Codex keys only
  "stopReviewGate": false, "stopRunningJobs": "warn",   // block | warn | off
  "notifyVia": "hooks",
  "requireLeaseFor": [],                     // e.g. ["danger-full-access"]
  "historyDays": 14, "maxJobs": 200,
  "escalation": { "ladder": [], "effortLadder": [], "afterFailures": 2, "mode": "suggest" }
}
```

---

## 9. Test plan and risks

### 9.1 Test plan (extend `tests/orvex.test.mjs`, `tests/runtime.test.mjs`, `tests/commands.test.mjs` and the fake-Codex fixture)

Fixture upgrades needed:
- a fake that ignores `turn/interrupt`
- a slow-turn mode
- emission of `outputDelta`, `turn/diff/updated`, `turn/plan/updated` and `tokenUsage`
- `model/list`, `config/read` and `thread/read` responses
- forced active-writer and forced broker-busy modes
- a server-initiated request
- recording of all RPCs, per connection, for assertions

| Area | Tests |
|---|---|
| Ownership (BUG-1) | SIGTERM and SIGKILL of an attach process lead to owner-lost and an interrupt at the fake. SIGKILL of the worker leads to a broker interrupt within 2s. `--detach` survives. `--owner-pid` works. |
| Cancel (BUG-2) | cooperative; non-cooperative (SIGKILL path, or `cancel-failed` with exit 2); direct transport through the control channel; queued job with no turnId; rendered report |
| SessionEnd (BUG-3) | no files removed; policy cancel or detach; broker survives with two leases (update runtime.test ~1804) |
| Liveness (BUG-6) | SIGKILLed worker becomes lost, orphaned or reconciled; `wait` exits 3; `.worker.err` for a crash at startup; pid-reuse guard (fake a start-time mismatch) |
| Completion (BUG-4, FR-16) | rescue makes 0 Agent calls; attach exit codes; Stop hook JSON (update runtime.test ~1982); PostToolUse emits once |
| Runtime (BUG-5, 8, 9, 10, 12) | codex-config layer (update orvex.test 81-83); stop gate read-only; effort catalog validation; effective runtime persisted; network combinations |
| Visibility (FR-2, 3, 4, 5, 7, 8, WISH-1) | seq monotonic; `--since`; `--follow` termination; delta files; report fields; schema validation (valid and invalid); patch `git apply --check -R`; concurrent change detection; transcript `--max-bytes`; partial result mid-turn |
| Control (BUG-7, 11, FR-9, 10, 20, 17) | resume by job and by thread; misparse regression; fork flags; interrupt `--then` on the same job; all-sessions and attach; lost and unsend; max-runtime |
| Models and config (FR-12, 13, 14, 15) | alias resolution; unknown model creates no job; override deep-merge; preamble; profile bypass; repo layer; doctor; `--print-claude-md` doc consistency |
| MCP (FR-11, FR-27) | an MCP client drives `codex{wait}`, `codex-reply`, `codex_steer` and cancellation against the fake; `setup --install-mcp` plus `--print-claude-md` names only registered tools |
| Defaults (FR-25) | bypass built-in on empty config; codex-config wins over it; reviews stay read-only; unowned `--background` falls back to workspace-write; `CODEX_COMPANION_SANDBOX=read-only` opt-out |
| Exit codes (§8.1) | one test per row of the canonical table for `wait`, `attach` and foreground `task` |
| Isolation (FR-6, BUG-15) | two worktree jobs on the same file; lease busy error; `--shared-tree`; merge and discard |
| Docs | every subcommand, flag and tool mentioned in `commands/*.md`, `skills/**`, `agents/**` and `README.md` exists; model-invocation frontmatter assertions (update commands.test 96-114, 135-156, 187-192) |
| CI | push, PR and nightly triggers; pinned codex; nightly auth-gated contract test against the real app-server |

Existing tests that **intentionally lock current behaviour and must be updated**: `tests/commands.test.mjs` 96-114 (Agent routing), 135-156 and 187-192 (disable-model-invocation); `tests/runtime.test.mjs` ~1804 (SessionEnd deletion) and ~1982 (Stop-hook stderr); `tests/orvex.test.mjs` 81-83 (read-only fallback).

### 9.2 Risks and unknowns (verify before building on them)

1. **App-server protocol surface is unverified locally.** The generated types (`.generated/app-server-types`) are not in the checkout. Before building on any of the following, verify it against codex-cli 0.157.0 (write a small probe script, or use the nightly contract test): `model/list`, `config/read` layers, `thread/read` (and whether it returns a rollout path or turn status), `thread/unload` (or an equivalent), `turn/steer` semantics on native review turns, `ThreadStartResponse` fields (effective model and sandbox), `ThreadStartParams.developerInstructions`, the per-thread config keys that disable skills, hooks and AGENTS.md, and whether a missing `sandbox` param falls back to config.toml. Items BUG-5, BUG-10, BUG-11, FR-7, FR-12 and FR-13 depend on these.
2. **Model ids are ambiguous, not conflicting.** The local catalog lists both `gpt-6-luna` and `gpt-5.6-luna` (and `gpt-6-sol`/`gpt-5.6-sol`, `gpt-5.6-terra`); the user's "Luna 6" matches both. The built-in `spark` alias and the `gpt-5.4-mini` examples point at ids that are not in the catalog. Resolve through `model/list` at runtime and never hard-code ids.
12. **Native Codex daemon overlap.** codex-cli 0.157.0 ships a shared app-server daemon (`codex agents`, `~/.codex/app-server-control/`) and `codex queue`. Building leases and observability on the plugin broker may duplicate or fight it. FR-26 decides this first.
13. **Bypass as the built-in default (FR-25)** combined with model-invocable commands (FR-1) and a proactive agent description means Claude can start full-access jobs on its own. FR-25's ownership coupling and BUG-4's removal of "Proactively use" are the mitigations; do not ship FR-25 before M0.
3. **Broker interrupt-on-disconnect** changes semantics for anyone who relied on turns surviving client death. Gate it on the job's `detached` flag, and make sure an intentional `--detach` job is registered with the broker before the worker could die.
4. **Pid reuse and portability.** Use start-time comparison on Linux (`/proc`) and macOS (`ps`). Windows uses `taskkill /T /F` and has no process groups, so keep that path working and test on CI where feasible.
5. **Hook budgets.** SessionEnd and SessionStart have 5s; the new PostToolUse and UserPromptSubmit hooks must stay under about 1s. No app-server calls in hooks. Defer verification to the worker or the next status.
6. **Lock contention.** Heartbeats every 5s from many jobs should go to separate `.hb` files, not through `state.lock`.
7. **Disk growth** from events, command output, patches and archives. Cap per-file sizes (8KB per command in events, 1MB per `.out`, spill large diffs) and rely on WISH-7 gc.
8. **Worktree state keying.** A job running in `.codex-worktrees/<id>` must still be listed from the parent repo, so decide whether the state dir keys on the main repo root.
9. **Safety defaults.** A `bypass` profile plus automatic model invocation (FR-1) increases the blast radius. BUG-1, BUG-2 and WISH-2 must land first, which is why M0 comes before M1.
10. **Backward compatibility.** `--resume` changing from boolean to optional-value must keep a bare `--resume` working. The `--json` payload shapes change, so bump `schemaVersion` and keep the old top-level fields (`status, threadId, rawOutput, touchedFiles, reasoningSummary, undeliveredMessages`).
11. **The shared working tree during implementation.** Several Claude sessions share this repo's tree. Commit with explicit pathspecs.

---

## Appendix A: Considered and dropped items

No items were dropped as already existing or wrong. Several claims made during analysis were **corrected by verification**, and the items above already reflect the corrections. They are listed so the implementer does not rebuild things that already exist:

- **Tasks are not ephemeral.** `executeTaskRun` passes `persistThread:true` → `ephemeral:false`, and resume and fork are also non-ephemeral. Only reviews and the stop gate are ephemeral. Rollouts should therefore exist for tasks (FR-7).
- **Continuing a specific job's thread already works:** `send <finishedJobId> msg` creates a follow-up on that thread and inherits the runtime, including across sessions and workspaces. What is missing is raw-threadId targeting and the fixed `--resume` parse (BUG-7).
- **`wait` already exists** with exit codes 0/1/124, `--any`, multiple ids, and model-invocable guidance to run it under `run_in_background`. The gap is that rescue never uses it (BUG-4).
- **`send` already steers running turns** (turn/steer through the inbox), and `--timeout-ms 0` already returns immediately. E6 was a discoverability failure (FR-1, FR-9).
- **The bypass default is already reachable:** `setup --global --default-sandbox danger-full-access --default-network on`, with `approvalPolicy: never`, and `--write` never downgrades. Profiles and further defaults are an ergonomics improvement (FR-14), and BUG-5 fixes the silent config.toml override.
- **The model-name "conflict" is not a conflict.** Both `gpt-6-luna` and `gpt-5.6-luna` are in the local catalog (FR-12). An earlier draft asked the implementer to decide which side was wrong; neither is.
- **Codex CLI does not provide `mcp__codex__codex`.** codex-cli 0.157.0 has no `mcp-server` subcommand, so FR-11 must be built in the plugin.
- **The automatic fork is not fully silent.** It logs a progress line and CHANGELOG.md:17 documents it. What is missing is structured recording and a policy (BUG-11).
- **Cancel and SessionEnd tests exist** (`tests/runtime.test.mjs` 1542, 1637, 1692, 1740, 1804; `tests/orvex.test.mjs` ~202), but for the happy path or the current deletion semantics only.
- **Reviews are already job-tracked**, can be cancelled by id, and return parsed adversarial findings through `result --json`. `review.md` already skips AskUserQuestion when `--wait` or `--background` is given.
- **`touchedFiles` is already persisted** in the result payload (`result --json` → `storedJob.result.touchedFiles`); it is just not rendered.
- **The README already documents per-job worktrees through `--cwd`** (README.md 225-248). What is missing is automation, the tree lease and diff reporting (FR-6).
- **SessionEnd broker shutdown does kill brokered turns.** The real problem is that it also kills *other sessions'* turns and deletes all records (BUG-3), not that turns keep running after SessionEnd.

---

## Addendum: issues observed after the report was generated (2026-09-25)

### BUG-16: `--help` / unknown flags are sent to Codex as the task prompt
- **Observed:** `codex-companion.mjs task --help` started a real Codex thread (full-access runtime) whose prompt was `--help`; Codex replied "`--help` needs a command to apply to". Any typo'd flag likewise becomes prompt text on a live, privileged job.
- **Proposal:** every subcommand handles `-h/--help` by printing its usage line(s) (already present at `codex-companion.mjs` ~103-119) and exiting 0 without contacting Codex; reject unknown `--flags` before the first positional prompt token with exit 2 and a usage hint (allow `--` to pass literal text).
- **Acceptance:** `task --help`, `send --help`, `status --help` print usage, exit 0, create no job/thread; `task --wirte "x"` exits 2 naming the unknown flag; `task -- --help` sends the literal text.

### BUG-17: Job stays `running` long after Codex's work is done (post-work stall, no final message)
- **Observed:** job `task-mugvt911` finished its edits, restart and validation at 11:37:48, then produced no events for 9+ minutes while status still showed `running` with the same last progress lines; it never emitted its final summary and had to be cancelled. The Claude-side result was therefore lost.
- **Proposal:** covered in part by FR-17 (idle timeout) and FR-8 (partial results). Additionally: record `lastEventAt` in job state and show "idle for Ns" in `status`; after a configurable idle threshold, send an automatic nudge (`send` "Return your final summary now") before interrupting; on cancel/timeout, persist the last agent message and the event log as the job's partial result so `result <id>` still returns something useful.
- **Acceptance:** a fake-codex fixture that goes silent after file changes surfaces `idle` in status, receives one nudge, and on cancel `result <id>` returns the last agent message plus files changed.

### Note: the pattern that worked best in practice
Direct `codex-companion.mjs task --background --prompt-file <brief>` from Bash, followed by `codex-companion.mjs wait <id>` under Bash `run_in_background`, gave Claude a real completion notification with no forwarder hop and no orphan risk. FR-11/FR-19/BUG-4 should make this the documented default path.

### Orchestrator notes for the implementer (priorities in plain terms)
1. **Bypass is already the user's Codex config and the plugin overrides it.** `~/.codex/config.toml` sets `danger-full-access`, `approval_policy = "never"` and model `gpt-6-luna`; the plugin's `read-only` fallback overrides that (BUG-5). This is why every dispatch needed `--write --full-access --network`. Fix together with FR-25 (bypass as the fork default; reviews stay read-only).
2. **Fix orphans before anything else (BUG-1, BUG-2, BUG-3).** Stopping the Claude-side handle leaves the Codex job running, `cancel` does not verify the stop, and SessionEnd deletes the job records. In the live session this left a full-access job editing a production-like system for 11+ minutes.
3. **Visibility is mostly wiring, not new capture.** `captureTurn` already collects full command executions (with exit codes) and file changes, then discards them. Persist them to `events.jsonl` and expose `tail`/`transcript` (FR-2, FR-3, FR-7) so Claude can follow with Monitor.
4. **Spike native Codex 0.157 first (FR-26, ~1 day).** It ships a shared app-server daemon (`codex agents`), `codex queue --thread` and `exec --output-schema`. Decide whether to adopt these before extending the plugin's own broker.
5. **Model naming is ambiguity, not a typo.** Both `gpt-6-luna` and `gpt-5.6-luna` exist in `~/.codex/models_cache.json`; add a `models` subcommand and aliases (FR-12) so "Luna" resolves deterministically.
6. **Make the proven dispatch path the default.** `task --background --prompt-file` + `wait <id>` under Bash `run_in_background` (see Note above) until the MCP surface (FR-11) and Workflow lane (FR-19) exist; retire the forwarder agent's auto-invocation (BUG-4).

### BUG-18: `wait` / `result` report "No job found" for a job that is still running
- **Observed:** job `task-mugwj8mj-gnhojx` was started with `task --background` from Bash. While it was still running (its `jobs/<id>.json` said `status: running` and its log was growing), `wait <id>` exited 0 with `No job found for "task-mugwj8mj-gnhojx"`, and `result <id>` returned the same. The job's `.json` and `.log` were present in `state/<workspace>/jobs/`; only the index in `state.json` had lost the entry (suspected pruning or session-scoped filtering, see BUG-3/BUG-14). Because `wait` exited 0, Claude's completion notification fired while Codex was still editing files.
- **Proposal:** resolve job ids from `jobs/<id>.json` when they're missing from the index, and rebuild the index from the files. Never prune a job whose status isn't terminal. `wait` must exit non-zero (e.g. 3) when a job can't be found, never 0.
- **Acceptance:** after deleting a running job's entry from `state.json`, `status <id>`, `wait <id>` and `result <id>` still resolve it from its job file; `wait` on an unknown id exits non-zero.
