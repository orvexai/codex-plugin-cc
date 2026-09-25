# Lane `m6-reviews`: Tracked background reviews with steering, `--attach`, MCP review tools, and the approval CLI (WISH-3, WISH-5)

- **Beads:** `codex-plugin-cc-22z.7`, `codex-plugin-cc-22z.9`
- **Report items:** WISH-3, WISH-5. **Scope in this lane:** all of WISH-3 and the **CLI half** of WISH-5 (`approve`, `--approval`, status display) on top of the wave-2 bridge.
- **Milestone / wave:** M6, wave 5. **Depends on:** wave 4 (`m6-rails` merged). **Runs concurrently with:** none (runs alone).

## Goal

Reviews parse `--background`/`--wait` but always run in the foreground, cannot be steered and ask questions even when the caller already said how to run. Route background and attached reviews through the tracked worker (inbox, lease, events, verified cancel), allow steering where Codex supports it, expose reviews over MCP, and finish the approval bridge with its user-facing commands.

## Ground rules (non-negotiable)

- **Worktree:** you work in your **own git worktree**, created by the orchestrator from branch `orvex/improvement-report` after the previous wave was merged (normally `/home/crew/workspace/codex-plugin-cc-lanes/m6-reviews` on branch `lane/m6-reviews`; use the path you were given). Paths below are relative to your worktree root, and `plugins/codex/scripts/` holds the runtime. The other lanes of your wave run at the same time in their own worktrees, and the orchestrator merges every lane of the wave afterwards. **File ownership is what keeps those merges conflict-free**, so respect it exactly.
- **Beads:** run `bd` from the main checkout: `cd /home/crew/workspace/codex-plugin-cc && bd update <id> --claim` for each bead listed above. If a bead is already claimed (another lane of the same item claimed it), skip the claim and still add your note. At the end, run `bd note <id> "<one paragraph: lane m6-reviews; what changed, tests added, npm test result, open risks>"` for each bead. **Never** run `bd close`: the orchestrator closes beads after review.
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
- `plugins/codex/scripts/lib/job-api.mjs`
- `plugins/codex/scripts/lib/codex.mjs`
- `plugins/codex/scripts/lib/tracked-jobs.mjs`
- `plugins/codex/scripts/lib/approvals.mjs`
- `plugins/codex/scripts/lib/mcp-tools.mjs`
- `plugins/codex/scripts/lib/render.mjs`
- `plugins/codex/commands/review.md`
- `plugins/codex/commands/adversarial-review.md`
- `plugins/codex/skills/codex-drive/SKILL.md`
- `tests/commands.test.mjs` (only the review and adversarial-review command tests, currently around lines 14-70)
- `tests/fake-codex-fixture.mjs`
- `tests/helpers.mjs`
- `tests/reviews.test.mjs` (new)
- `tests/approvals.test.mjs` (new)

## Do not touch

- No lane runs concurrently with you in this wave.
- Any existing test file not listed under "Files you own" (add your tests in your own new test files).

## Design decisions binding on this lane

- **Review routing:** `review` and `adversarial-review` with `--background` or `--attach` enqueue a tracked worker job (`jobClass:"review"`, the existing review request) using the same worker, owner lease, events and `CODEX_JOB` launch line as tasks; `--wait` (and the default) keep today's foreground path. Reviews stay **forced read-only** and `approvalPolicy:"never"` whatever the defaults (BUG-8). `--effort`/`--model` already exist (M1); make sure they flow into the worker path.
- **Steering:** `send <id> 'focus on auth'` works for **adversarial-review** jobs (ordinary turns, so `turn/steer` applies). For native `review/start` jobs, `send` fails fast with `native review turns cannot be steered (codex-cli 0.157); use adversarial-review for steerable reviews` (exit 2) — see probe adjustments.
- **Cancel/result:** `cancel <id>` is the verified cancel; `result <id> --json` returns the parsed, schema-valid adversarial findings (validate against `schemas/review-output.schema.json` with the M2 validator and include `structured.ok`).
- **MCP:** `codex_review {target?, base?, wait=true, model?, effort?}` and `codex_adversarial_review {focus?, base?, wait=true, model?, effort?}` in `lib/mcp-tools.mjs`, returning the existing review schema in `structuredContent`; owned like `codex` jobs.
- **Commands:** `commands/review.md` and `commands/adversarial-review.md` skip AskUserQuestion when `--wait`, `--background` or `--attach` is present in the arguments, and document `--attach`. The "model invoked the command" case cannot be detected from inside a command body: document that model-initiated calls must pass `--wait` or `--background` (scope narrowing). Keep `disable-model-invocation` as it is.
- **WISH-5 CLI:** `task|send|fork --approval <policy>`: `never` (default) or the policy names from the generated types (e.g. `on-request`); any non-`never` policy turns on the bridge (`approvalBridge:true`) — the report's "reject anything other than `never` until the bridge exists" is satisfied because the bridge now exists; an unknown policy → exit 2. Reviews reject `--approval`. `approve <job> <reqId> [--deny] [--json]` → `recordApprovalDecision`; exit 0 `recorded`, 1 `already-decided`, 2 `unknown-request`. `status` shows `awaiting-approval` with the pending request summary and the exact `approve` command; `approvals <job>` is **not** required (list pending ones in `status <id>`).

## Implementation guide

- `codex-companion.mjs`: `handleReviewCommand`, `handleReview`, `executeReviewRun`, `handleTaskWorker` (review requests), `handleSend` (the non-task rejection), `handleStatus`, `printUsage`, `main` (`approve`). `lib/codex.mjs`: `runAppServerReview` (worker-hosted), the adversarial turn path. `lib/tracked-jobs.mjs`: worker request kinds.

## Fake-Codex fixture

The fixture API from lane `m0-fixture` (plan D2), in short: `installFakeCodex(binDir, behavior, options)`; `setFakeCodexOptions(binDir, patch)`; `options.turnScript` steps (`command`, `fileChange` with `writeFiles`, `agentMessage`, `reasoning`, `plan`, `diff`, `usage`, `delay`, `silence`, `serverRequest`); `options.interrupt: "cooperate"|"ignore"|"ack-only"`; `options.ignoreSigterm`; `options.delays.{initialize,threadStart,turnStart}`; `options.models`, `options.config`, `options.writeRollout`, `options.forceActiveWriter`, `options.turnStatus`; methods `model/list`, `config/read`, `thread/read`; `readFakeRpcLog(binDir, {method, conn, dir})`, `fakeConnections(binDir)`; `occupyBroker(endpoint, {holdMs})`; `startFakeAppServer(binDir)`; helpers `spawnStubborn()`, `waitFor()`, `isPidAlive()`, `makeCompanionWorkspace()`. M0/M1 lanes extended it further, so **read the fixture source for the exact signatures** before writing tests. Note: the fixture answers `thread/unload`, but the real codex-cli 0.157 app-server does **not** have it (probe §6), so plugin code must never call it.

**You own the fixture files in this wave.** If you need a capability that is missing, add it **additively** (new options, new turnScript step types, new helpers) and keep every existing behaviour string and option working. Where the fixture's shapes differ from `docs/app-server-probe.md` ("Fixture shapes"), make the fixture match the probe for the methods you touch.

Make sure the fake's `review/start` rejects `turn/steer` with the probe's error (`cannot steer a review turn`, `activeTurnNotSteerable`) and that adversarial-review turns accept steering.

## Tests to write first

`tests/reviews.test.mjs`:
1. `adversarial-review --background --json` returns a jobId; `send <id> 'focus on auth'` is delivered (`turn/steer` in the RPC log); `cancel <id>` is verified; on a completed run, `result <id> --json` returns schema-valid findings.
2. `review --attach` streams and exits 0; the review's `thread/start` has `sandbox:"read-only"` even with `defaultSandbox=danger-full-access`.
3. `send` to a native review job exits 2 with the clear message.
4. The MCP `codex_adversarial_review{wait:true}` returns findings in `structuredContent`.
5. Command docs skip AskUserQuestion when `--wait`/`--background`/`--attach` is present (update the tests at lines ~14-70 accordingly).
`tests/approvals.test.mjs`:
6. `never` mode: a fake server request produces the log line (regression of wave 2).
7. `task --approval on-request` (the real policy name) with a scripted approval request → `status <id> --json` shows phase `awaiting-approval` and the pending request; `approve <id> <reqId>` resumes the turn to completion.
8. Timeout (`CODEX_COMPANION_APPROVAL_TIMEOUT_MS=500`) denies; `approve` afterwards returns `already-decided`.
9. `review --approval on-request` exits 2.

## Requirements from the report (verbatim)

The text below is copied verbatim from `docs/IMPROVEMENT-REPORT.md`. Line numbers in it predate M0/M1. The "Probe adjustments" and "Design decisions" sections of this brief override it where they differ.

### WISH-3: Reviews: honour `--background`, add `--effort` and `--attach`, allow steering, drop prompts
- **Priority:** P3
- **Problem:** `handleReviewCommand` parses `--background` and `--wait` but always runs in the foreground. It has no `--effort`, and `send` rejects non-task jobs. `review.md` and `adversarial-review.md` ask through AskUserQuestion unless `--wait` or `--background` is given. Reviews are already tracked jobs that can be cancelled by id, and `result --json` returns adversarial findings.
- **Evidence:** `codex-companion.mjs` ~952-1000 and ~1142-1144. `commands/review.md` 18-38. `commands/adversarial-review.md` 21-35.
- **Proposal:** Route reviews through the tracked worker path when `--background` or `--attach` is set, with an inbox and a lease. Allow `send` on adversarial-review jobs, which are ordinary turns. For native `review/start` turns, gate it on whether steering is supported. Add `--effort`. Add the MCP tools `codex_review` and `codex_adversarial_review`, which return the existing review schema. Skip AskUserQuestion when `--wait`, `--background` or `--attach` is present, or when the model invoked the command.
- **Acceptance criteria:** `adversarial-review --background --json` returns a jobId. `send <id> 'focus on auth'` is delivered. `cancel <id>` is verified. `result <id> --json` returns schema-valid findings.

### WISH-5: An approval bridge, and logging of rejected server requests
- **Priority:** P3
- **Problem:** `approvalPolicy` is always `never`. Every server-initiated request is answered with `-32601 Unsupported server request`, and nothing is logged.
- **Evidence:** `lib/codex.mjs` 67, 81 and 1278. `lib/app-server.mjs` 156-161.
- **Proposal:** Right away, log `[codex] Rejected server request <method>` to the job log and to events. Later, add an optional bridge: a pending-approvals file, an `awaiting-approval` phase, `approve <job> <reqId> [--deny]`, and a timeout that auto-denies. Add `--approval <mode>`, which rejects anything other than `never` until the bridge exists.
- **Acceptance criteria:** In `never` mode, a fake server request produces the log line. In bridge mode, status shows `awaiting-approval`, `approve` resumes the turn, and the timeout denies.

## Probe adjustments and scope narrowing (binding; they override the verbatim text above)

- **Probe §7:** native review turns reject `turn/steer` (`cannot steer a review turn`, `activeTurnNotSteerable {turnKind:"review"}`). WISH-3's "for native `review/start` turns, gate it on whether steering is supported" resolves to **not supported** in 0.157: only adversarial-review jobs are steerable.
- Approval policy names and request/response shapes come from the generated types (the probe only used `never`).

## Acceptance checklist (report PASS/FAIL per line)

- [ ] WISH-3: `adversarial-review --background --json` returns a jobId. `send <id> 'focus on auth'` is delivered. `cancel <id>` is verified. `result <id> --json` returns schema-valid findings
- [ ] WISH-3: reviews honour `--background` and `--attach`, stay read-only, and native review jobs refuse steering with a clear message (probe-narrowed)
- [ ] WISH-3: MCP tools `codex_review` and `codex_adversarial_review` exist; review commands skip AskUserQuestion when a run-mode flag is present
- [ ] WISH-5: in `never` mode, a fake server request produces the log line
- [ ] WISH-5: in bridge mode, status shows `awaiting-approval`, `approve` resumes the turn, and the timeout denies
- [ ] `npm test` green in your worktree; no existing test edited except where this brief allows it

## Required final report (your last message; use exactly these sections)

```
## Lane m6-reviews report
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
