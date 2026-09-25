# Lane `m6-approval-worker`: Log rejected server requests and the approval bridge in the worker (WISH-5)

- **Beads:** `codex-plugin-cc-22z.9`
- **Report items:** WISH-5. **Scope in this lane:** the **worker/transport half** of WISH-5: logging of rejected server requests and the bridge mechanics (pending file, `awaiting-approval` phase, decisions, timeout). The `approve` command and `--approval` flag are lane `m6-reviews` (wave 5).
- **Milestone / wave:** M6, wave 2. **Depends on:** wave 1 merged. **Runs concurrently with:** `m6-isolation`.

## Goal

Every server-initiated request is answered `-32601 Unsupported server request` and nothing is logged. Log each rejection where Claude can see it, and build an optional approval bridge so a job with a non-`never` approval policy can pause in `awaiting-approval` until someone approves or denies, with an automatic deny on timeout.

## Ground rules (non-negotiable)

- **Worktree:** you work in your **own git worktree**, created by the orchestrator from branch `orvex/improvement-report` after the previous wave was merged (normally `/home/crew/workspace/codex-plugin-cc-lanes/m6-approval-worker` on branch `lane/m6-approval-worker`; use the path you were given). Paths below are relative to your worktree root, and `plugins/codex/scripts/` holds the runtime. The other lanes of your wave run at the same time in their own worktrees, and the orchestrator merges every lane of the wave afterwards. **File ownership is what keeps those merges conflict-free**, so respect it exactly.
- **Beads:** run `bd` from the main checkout: `cd /home/crew/workspace/codex-plugin-cc && bd update <id> --claim` for each bead listed above. If a bead is already claimed (another lane of the same item claimed it), skip the claim and still add your note. At the end, run `bd note <id> "<one paragraph: lane m6-approval-worker; what changed, tests added, npm test result, open risks>"` for each bead. **Never** run `bd close`: the orchestrator closes beads after review.
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

- `plugins/codex/scripts/lib/app-server.mjs`
- `plugins/codex/scripts/lib/codex.mjs`
- `plugins/codex/scripts/lib/approvals.mjs` (new)
- `plugins/codex/scripts/app-server-broker.mjs`
- `tests/fake-codex-fixture.mjs`
- `tests/helpers.mjs`
- `tests/approvals-lib.test.mjs` (new)

## Do not touch

- Lane `m6-isolation` runs at the same time and owns: `plugins/codex/scripts/codex-companion.mjs`, `plugins/codex/scripts/lib/job-api.mjs`, `plugins/codex/scripts/lib/job-control.mjs`, `plugins/codex/scripts/lib/render.mjs`, `plugins/codex/scripts/lib/workspace.mjs`, `plugins/codex/scripts/lib/worktree.mjs`, `plugins/codex/scripts/lib/tree-lease.mjs`, `plugins/codex/scripts/lib/tracked-jobs.mjs`, `plugins/codex/scripts/lib/mcp-tools.mjs`, `plugins/codex/skills/codex-drive/SKILL.md`, `README.md`, `tests/orvex.test.mjs`, `tests/isolation.test.mjs`, `tests/overlap.test.mjs`.
- Any existing test file not listed under "Files you own" (add your tests in your own new test files).

## Design decisions binding on this lane

- **Hook in the client:** `CodexAppServerClient` gains `onServerRequest(message) → Promise<{result}|{error}>|undefined`; when unset or it returns undefined, keep today's `-32601` reply. `runAppServerTurn` installs a handler that (a) in `never` mode logs `[codex] Rejected server request <method>` to the job log and emits a `server-request.rejected` event `{method, id}`, then replies `-32601`; (b) in bridge mode handles approval requests.
- **Broker forwarding:** check whether `app-server-broker.mjs` forwards server-initiated requests from the app-server to the stream-owning socket and relays the reply back. If not, implement it (requests go to the active stream's socket; with no active socket, reply `-32601` and log in `broker.log`).
- **`lib/approvals.mjs`:** `resolveApprovalFiles(workspaceRoot, jobId)` → `{pending: jobs/<id>.approvals.jsonl, decisions: jobs/<id>.approvals.decisions.jsonl}`; `recordPendingApproval(ws, jobId, {reqId, method, summary, at})`; `recordApprovalDecision(ws, jobId, {reqId, decision: "approve"|"deny", by, at})` → `{status:"recorded"|"unknown-request"|"already-decided"}`; `waitForApprovalDecision(ws, jobId, reqId, {timeoutMs, pollMs = 250, signal})` → `{decision, timedOut}`; `listApprovals(ws, jobId)`.
- **Bridge in the worker:** when `runAppServerTurn` is called with `approvalPolicy` other than `never` and `approvalBridge:true`, send that `approvalPolicy` on thread/start/resume/fork; on an approval server request (for example `item/commandExecution/requestApproval` and the file-change equivalent; read the generated types for the exact method names and the **response** shapes, e.g. a `decision` field), record it as pending, emit a progress phase `awaiting-approval` (persisted by the existing progress updater) and an `approval.requested` event, wait for a decision (`CODEX_COMPANION_APPROVAL_TIMEOUT_MS`, default 300000; add to `LEAKY_ENV`), reply with the approve/deny payload, set the phase back to `running`, and emit `approval.decided` `{reqId, decision, timedOut}`. Timeout → deny. Non-approval server requests keep the reject-and-log path.
- `approvalPolicy` stays `never` unless explicitly passed (WISH-5, BUG-5); reviews always `never`.

## Implementation guide

- `lib/app-server.mjs`: the server-request branch (report lines ~156-161). `lib/codex.mjs`: `runAppServerTurn`, `buildThreadParams`, `buildResumeParams`. `app-server-broker.mjs`: message routing in `main`.
- Generate the types (`codex app-server generate-ts --out <tmp> --experimental`) and read `ServerRequest.ts` and the approval request/response files; record the names you used.

## Fake-Codex fixture

The fixture API from lane `m0-fixture` (plan D2), in short: `installFakeCodex(binDir, behavior, options)`; `setFakeCodexOptions(binDir, patch)`; `options.turnScript` steps (`command`, `fileChange` with `writeFiles`, `agentMessage`, `reasoning`, `plan`, `diff`, `usage`, `delay`, `silence`, `serverRequest`); `options.interrupt: "cooperate"|"ignore"|"ack-only"`; `options.ignoreSigterm`; `options.delays.{initialize,threadStart,turnStart}`; `options.models`, `options.config`, `options.writeRollout`, `options.forceActiveWriter`, `options.turnStatus`; methods `model/list`, `config/read`, `thread/read`; `readFakeRpcLog(binDir, {method, conn, dir})`, `fakeConnections(binDir)`; `occupyBroker(endpoint, {holdMs})`; `startFakeAppServer(binDir)`; helpers `spawnStubborn()`, `waitFor()`, `isPidAlive()`, `makeCompanionWorkspace()`. M0/M1 lanes extended it further, so **read the fixture source for the exact signatures** before writing tests. Note: the fixture answers `thread/unload`, but the real codex-cli 0.157 app-server does **not** have it (probe §6), so plugin code must never call it.

**You own the fixture files in this wave.** If you need a capability that is missing, add it **additively** (new options, new turnScript step types, new helpers) and keep every existing behaviour string and option working. Where the fixture's shapes differ from `docs/app-server-probe.md` ("Fixture shapes"), make the fixture match the probe for the methods you touch.

The fixture's `serverRequest` step sends a server request and records the client's answer; make it wait for the answer before continuing the script (with `options.serverRequestTimeoutMs`), expose the recorded answer via the RPC log, and support the approval method names from the generated types.

## Tests to write first

`tests/approvals-lib.test.mjs`:
1. `never` mode: a scripted `serverRequest` produces the log line `Rejected server request <method>` and a `server-request.rejected` event; the fake records a `-32601` answer (direct transport and broker transport).
2. Bridge mode (`runAppServerTurn` with `approvalPolicy:"on-request"` — or the policy name the types define — and `approvalBridge:true`, driven through a task worker started with those options via a test-only request field or the library directly): the job phase becomes `awaiting-approval`, a pending entry exists; `recordApprovalDecision(approve)` → the fake receives the approve payload and the turn completes.
3. Timeout (`CODEX_COMPANION_APPROVAL_TIMEOUT_MS=500`) → the fake receives a deny payload; event `approval.decided` has `timedOut:true`.
4. `recordApprovalDecision` statuses (`unknown-request`, `already-decided`).

## Requirements from the report (verbatim)

The text below is copied verbatim from `docs/IMPROVEMENT-REPORT.md`. Line numbers in it predate M0/M1. The "Probe adjustments" and "Design decisions" sections of this brief override it where they differ.

### WISH-5: An approval bridge, and logging of rejected server requests
- **Priority:** P3
- **Problem:** `approvalPolicy` is always `never`. Every server-initiated request is answered with `-32601 Unsupported server request`, and nothing is logged.
- **Evidence:** `lib/codex.mjs` 67, 81 and 1278. `lib/app-server.mjs` 156-161.
- **Proposal:** Right away, log `[codex] Rejected server request <method>` to the job log and to events. Later, add an optional bridge: a pending-approvals file, an `awaiting-approval` phase, `approve <job> <reqId> [--deny]`, and a timeout that auto-denies. Add `--approval <mode>`, which rejects anything other than `never` until the bridge exists.
- **Acceptance criteria:** In `never` mode, a fake server request produces the log line. In bridge mode, status shows `awaiting-approval`, `approve` resumes the turn, and the timeout denies.

## Probe adjustments and scope narrowing (binding; they override the verbatim text above)

- The probe did not exercise approval server requests (all probe threads used `approvalPolicy:"never"`). The method names and response shapes must come from the generated protocol types; list them in your report. `approvalPolicy:"never"` stays the default, as verified in probe §3/§4.

## Acceptance checklist (report PASS/FAIL per line)

- [ ] In `never` mode, a fake server request produces the log line (and an event), over both direct and broker transports
- [ ] In bridge mode, the job phase shows `awaiting-approval`, a decision resumes the turn, and the timeout denies (library/worker level; `approve` CLI and `status` display are lane `m6-reviews`)
- [ ] `npm test` green in your worktree; no existing test edited except where this brief allows it

## Required final report (your last message; use exactly these sections)

```
## Lane m6-approval-worker report
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
