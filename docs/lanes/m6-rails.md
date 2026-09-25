# Lane `m6-rails`: Safety rails (`cancel --all`, badges, runtime header, lease requirement) and the escalation ladder wiring (WISH-2, WISH-4)

- **Beads:** `codex-plugin-cc-22z.5`, `codex-plugin-cc-22z.8`
- **Report items:** WISH-2, WISH-4. **Scope in this lane:** all of WISH-2 and the **wiring half** of WISH-4 on top of `lib/escalation.mjs`.
- **Milestone / wave:** M6, wave 4. **Depends on:** wave 3 (`m6-ops` merged). **Runs concurrently with:** none (runs alone).

## Goal

With full access and network as defaults, one mis-dispatched job can modify production. Add a verified stop-everything command, make the risk visible everywhere a job appears, record the resolved runtime at the top of every log, let users require an owner for full-access jobs, and turn repeated failures into a concrete model-escalation suggestion (or an automatic escalation when configured).

## Ground rules (non-negotiable)

- **Worktree:** you work in your **own git worktree**, created by the orchestrator from branch `orvex/improvement-report` after the previous wave was merged (normally `/home/crew/workspace/codex-plugin-cc-lanes/m6-rails` on branch `lane/m6-rails`; use the path you were given). Paths below are relative to your worktree root, and `plugins/codex/scripts/` holds the runtime. The other lanes of your wave run at the same time in their own worktrees, and the orchestrator merges every lane of the wave afterwards. **File ownership is what keeps those merges conflict-free**, so respect it exactly.
- **Beads:** run `bd` from the main checkout: `cd /home/crew/workspace/codex-plugin-cc && bd update <id> --claim` for each bead listed above. If a bead is already claimed (another lane of the same item claimed it), skip the claim and still add your note. At the end, run `bd note <id> "<one paragraph: lane m6-rails; what changed, tests added, npm test result, open risks>"` for each bead. **Never** run `bd close`: the orchestrator closes beads after review.
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
- `plugins/codex/scripts/lib/render.mjs`
- `plugins/codex/scripts/lib/job-control.mjs`
- `plugins/codex/scripts/lib/tracked-jobs.mjs`
- `plugins/codex/scripts/lib/escalation.mjs`
- `plugins/codex/scripts/lib/config.mjs`
- `plugins/codex/scripts/lib/mcp-tools.mjs`
- `plugins/codex/skills/codex-drive/SKILL.md`
- `tests/fake-codex-fixture.mjs`
- `tests/helpers.mjs`
- `tests/rails.test.mjs` (new)
- `tests/escalation.test.mjs` (new)

## Do not touch

- No lane runs concurrently with you in this wave.
- Any existing test file not listed under "Files you own" (add your tests in your own new test files).

## Design decisions binding on this lane

- **`cancel --all [--workspace|--everywhere] [--force] [--json]`:** `--all` alone = active jobs of the current session; `--workspace` = every session in this workspace; `--everywhere` = every workspace under the state root. Each job goes through the verified `cancelJob` (in parallel, bounded to 4); the report lists each job's outcome; exit 2 if any ends `cancel-failed`. `cancel --all` is also exposed as `codex_cancel {all:true}` in `lib/mcp-tools.mjs`.
- **Badges:** `formatRuntimeBadge` (from M2) on status rows (already), in `wait` output lines, on attach heartbeat/progress lines, and in the log header.
- **Runtime header:** the first line of every job log (`createJobLogFile`) records the resolved runtime: sandbox, network, approval, model, effort (effective when known, else requested), cwd, git HEAD and branch (best effort, 2s timeout), profile, and worktree if any.
- **`setup --require-lease-for <full-access|write|none> [--global]`** → config `requireLeaseFor` (array; `CONFIG_KEYS`). When it covers the job's effective sandbox, a `--background` launch without `--attach` or an explicit `--detach` fails with `full-access jobs require an owner: use --attach, or --detach to accept an unowned job` (exit 2, no job). This generalises FR-25's check: the FR-25 unowned fallback stays the behaviour when `requireLeaseFor` is empty.
- **WISH-4 wiring:** config `escalation` (validated with `validateEscalationConfig` in `setup`/`config set` and `config doctor`). In `suggest` mode, `result` and `status` for a failed job append `nextStep.escalation` (JSON) and a one-line suggestion (text) from `buildEscalationSuggestion`. In `auto` mode, the next `send` follow-up in that lineage switches to the next rung automatically (unless `--model`/`--effort` are given) and records `runtime.escalatedFrom = {model, effort, failures}`; `status` shows `escalated from <model>`.

## Implementation guide

- `codex-companion.mjs`: `handleCancel`, `handleWait`, the attach watcher, `handleResult`, `handleStatus`, `handleSend`, `handleSetup`, `printUsage`. `lib/tracked-jobs.mjs`: `createJobLogFile`. `lib/render.mjs`: rows and wait output.

## Fake-Codex fixture

The fixture API from lane `m0-fixture` (plan D2), in short: `installFakeCodex(binDir, behavior, options)`; `setFakeCodexOptions(binDir, patch)`; `options.turnScript` steps (`command`, `fileChange` with `writeFiles`, `agentMessage`, `reasoning`, `plan`, `diff`, `usage`, `delay`, `silence`, `serverRequest`); `options.interrupt: "cooperate"|"ignore"|"ack-only"`; `options.ignoreSigterm`; `options.delays.{initialize,threadStart,turnStart}`; `options.models`, `options.config`, `options.writeRollout`, `options.forceActiveWriter`, `options.turnStatus`; methods `model/list`, `config/read`, `thread/read`; `readFakeRpcLog(binDir, {method, conn, dir})`, `fakeConnections(binDir)`; `occupyBroker(endpoint, {holdMs})`; `startFakeAppServer(binDir)`; helpers `spawnStubborn()`, `waitFor()`, `isPidAlive()`, `makeCompanionWorkspace()`. M0/M1 lanes extended it further, so **read the fixture source for the exact signatures** before writing tests. Note: the fixture answers `thread/unload`, but the real codex-cli 0.157 app-server does **not** have it (probe §6), so plugin code must never call it.

**You own the fixture files in this wave.** If you need a capability that is missing, add it **additively** (new options, new turnScript step types, new helpers) and keep every existing behaviour string and option working. Where the fixture's shapes differ from `docs/app-server-probe.md` ("Fixture shapes"), make the fixture match the probe for the methods you touch.

## Tests to write first

`tests/rails.test.mjs`:
1. With 3 active fake jobs (slow turns), `cancel --all` leaves zero active jobs, each verified (`cancel.turnConfirmedStopped`), across two sessions with `--workspace`.
2. A full-access status row, wait line and attach progress line show the badge; the log's first line has sandbox, network, model, cwd, HEAD and branch.
3. With `setup --require-lease-for full-access`, `task --full-access --background` without `--attach`/`--detach` fails with the clear message and no job; with `--detach` it runs.
`tests/escalation.test.mjs`:
4. After 2 failed jobs in a lineage (`turnStatus:"failed"`), `result --json` includes `nextStep.escalation`.
5. In auto mode the next `send` uses the next rung (`thread/resume`/`turn/start` model in the RPC log) and status shows `escalated from`.

## Requirements from the report (verbatim)

The text below is copied verbatim from `docs/IMPROVEMENT-REPORT.md`. Line numbers in it predate M0/M1. The "Probe adjustments" and "Design decisions" sections of this brief override it where they differ.

### WISH-2: Safety rails for live systems: `cancel --all`, a risk badge, a lease requirement and a runtime header
- **Priority:** P2
- **Problem:** With full access and network as defaults, one mis-dispatched job can modify production. `cancel` with no id errors when several jobs are active. The runtime appears only in the single-job view.
- **Evidence:** E1, E8, E10. `lib/job-control.mjs` 302-304. `lib/render.mjs` 124-149.
- **Proposal:** Add `cancel --all [--workspace|--everywhere]`, each cancel verified (BUG-2). Show a `[FULL-ACCESS+NET]`-style badge on status rows, in wait output, on attach heartbeat lines and in the log header. The first log line records the resolved runtime (sandbox, network, model, cwd, git HEAD and branch). Add `setup --require-lease-for full-access`, which rejects a detached full-access job unless `--detach` is explicit.
- **Acceptance criteria:** With 3 active fake jobs, `cancel --all` leaves zero active jobs, each verified. A full-access row shows the badge. With require-lease on, `task --full-access --background` without `--attach` or `--detach` fails with a clear message.

### WISH-4: Escalation ladder (the Luna → Terra rule)
- **Priority:** P3
- **Problem:** The repo policy is to escalate after two failures. You can already escalate by hand without losing context, with `send <job> --model X --effort Y`. There is no failure counting or suggestion.
- **Evidence:** E5. `codex-companion.mjs` `handleSend` ~1119-1190 and `RUNTIME_VALUE_OPTIONS` ~1002.
- **Proposal:** Add config `escalation {ladder[], effortLadder[], afterFailures, mode: suggest|auto}`, validated against `model/list`, with failures counted per `parentJobId` lineage. In `suggest` mode, result and status append `nextStep.escalation`. In `auto` mode, the next send switches to the next rung and records `runtime.escalatedFrom`.
- **Acceptance criteria:** After 2 failed jobs in a lineage, `result --json` includes `nextStep.escalation`. In auto mode the next `send` uses the next rung, and status shows `escalated from`.

## Probe adjustments and scope narrowing (binding; they override the verbatim text above)

- Ladder model ids are validated against `model/list` (probe §1) via FR-12's resolver.

## Acceptance checklist (report PASS/FAIL per line)

- [ ] WISH-2: with 3 active fake jobs, `cancel --all` leaves zero active jobs, each verified
- [ ] WISH-2: a full-access row shows the badge (also in wait output, attach lines and the log header)
- [ ] WISH-2: with require-lease on, `task --full-access --background` without `--attach` or `--detach` fails with a clear message
- [ ] WISH-2: the first log line records the resolved runtime (sandbox, network, model, cwd, git HEAD and branch)
- [ ] WISH-4: after 2 failed jobs in a lineage, `result --json` includes `nextStep.escalation`
- [ ] WISH-4: in auto mode the next `send` uses the next rung, and status shows `escalated from`
- [ ] `npm test` green in your worktree; no existing test edited except where this brief allows it

## Required final report (your last message; use exactly these sections)

```
## Lane m6-rails report
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
