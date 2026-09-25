# Lane `m6-ci`: CI triggers, pinned Codex, nightly contract test and doc-consistency test (FR-24)

- **Beads:** `codex-plugin-cc-22z.6`
- **Report items:** FR-24. **Scope in this lane:** all of FR-24's CI and test-infrastructure deliverables. ("A test for every new item" is satisfied by the lanes' own test files.) This lane touches only `.github/`, a repo-root script and new test files, so the orchestrator may also run it in any earlier wave as a filler lane.
- **Milestone / wave:** M6, wave 1. **Depends on:** none strictly (best after M5, so the doc check sees the final docs). **Runs concurrently with:** `m6-worktree-lib`, `m6-broker-lib`, `m6-history-lib`, `m6-prompting`, `m6-escalation-lib`.

## Goal

CI runs only on pull requests, installs an unpinned Codex, and nothing checks that the docs reference commands that exist or that the real app-server still speaks the protocol the plugin assumes. Add push/PR/nightly triggers, pin Codex to the probed version, an auth-gated contract test against the real app-server that skips cleanly without auth, and a doc-consistency checker that catches bad references.

## Ground rules (non-negotiable)

- **Worktree:** you work in your **own git worktree**, created by the orchestrator from branch `orvex/improvement-report` after the previous wave was merged (normally `/home/crew/workspace/codex-plugin-cc-lanes/m6-ci` on branch `lane/m6-ci`; use the path you were given). Paths below are relative to your worktree root, and `plugins/codex/scripts/` holds the runtime. The other lanes of your wave run at the same time in their own worktrees, and the orchestrator merges every lane of the wave afterwards. **File ownership is what keeps those merges conflict-free**, so respect it exactly.
- **Beads:** run `bd` from the main checkout: `cd /home/crew/workspace/codex-plugin-cc && bd update <id> --claim` for each bead listed above. If a bead is already claimed (another lane of the same item claimed it), skip the claim and still add your note. At the end, run `bd note <id> "<one paragraph: lane m6-ci; what changed, tests added, npm test result, open risks>"` for each bead. **Never** run `bd close`: the orchestrator closes beads after review.
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

- `.github/workflows/pull-request-ci.yml`
- `.github/workflows/nightly.yml` (new)
- `scripts/check-doc-consistency.mjs` (new)
- `tests/doc-consistency.test.mjs` (new)
- `tests/contract.test.mjs` (new)
- `tests/fixtures/doc-consistency-allowlist.json` (new)

## Do not touch

- Lane `m6-worktree-lib` runs at the same time and owns: `plugins/codex/scripts/lib/worktree.mjs`, `plugins/codex/scripts/lib/tree-lease.mjs`, `tests/worktree-lib.test.mjs`.
- Lane `m6-broker-lib` runs at the same time and owns: `plugins/codex/scripts/app-server-broker.mjs`, `plugins/codex/scripts/lib/broker-lifecycle.mjs`, `plugins/codex/scripts/lib/app-server.mjs`, `plugins/codex/scripts/lib/codex.mjs`, `plugins/codex/scripts/lib/tracked-jobs.mjs`, `tests/fake-codex-fixture.mjs`, `tests/helpers.mjs`, `tests/broker-lib.test.mjs`, `tests/error-surfacing.test.mjs`.
- Lane `m6-history-lib` runs at the same time and owns: `plugins/codex/scripts/lib/archive.mjs`, `plugins/codex/scripts/lib/state.mjs`, `tests/archive.test.mjs`.
- Lane `m6-prompting` runs at the same time and owns: `plugins/codex/skills/gpt-5-4-prompting/`, `plugins/codex/skills/codex-prompting/`, `plugins/codex/agents/codex-rescue.md`, `plugins/codex/agents/codex-exec.md`, `plugins/codex/commands/rescue.md`, `tests/commands.test.mjs`.
- Lane `m6-escalation-lib` runs at the same time and owns: `plugins/codex/scripts/lib/escalation.mjs`, `tests/escalation-lib.test.mjs`.
- Plugin docs (`commands/**`, `skills/**`, `agents/**`, `README.md`): if the checker finds real inconsistencies, do not fix them here; add each to the allowlist with a reason and list it as a follow-up.
- Any existing test file not listed under "Files you own" (add your tests in your own new test files).

## Design decisions binding on this lane

- **Workflows:** `pull-request-ci.yml` gets `on: push (branches main, dev, orvex/**), pull_request, workflow_dispatch`; `nightly.yml` runs on `schedule` (daily cron) and `workflow_dispatch`, runs `npm test`, then the contract test with `CODEX_CONTRACT_TEST=1` and the auth secret (e.g. `OPENAI_API_KEY` from `secrets`) — skipped when the secret is absent. Both install `@openai/codex@0.157.0` (the probed version). Keep existing steps, actions pins and permissions. The report asks for `on: [push, pull_request, schedule]`: satisfy it across the two files, or put all three triggers in `pull-request-ci.yml` with the contract step conditional on `github.event_name == 'schedule'`; pick one and say which.
- **`tests/contract.test.mjs`:** skipped (`t.skip` with a clear reason) unless `CODEX_CONTRACT_TEST=1` **and** a real `codex` binary is authenticated (`codex login status` exit 0). When enabled it follows the **manual probe safety gate** from `docs/codex-native-surfaces.md` exactly: a fresh temp cwd, `thread/start` with explicit `sandbox:"read-only"`, `approvalPolicy:"never"`; verify the response reports `sandbox.type:"readOnly"`, `approvalPolicy:"never"` and that cwd before **any** turn; then `initialize`, `thread/start`, `turn/start` (a trivial prompt), `turn/steer` (with `expectedTurnId`), `turn/interrupt`, `model/list`, `config/read`, `thread/read`; assert only on shapes recorded in `docs/app-server-probe.md`; delete the thread at the end (`thread/delete`). Never run `codex queue`. It must not use the real `~/.codex` for writes. Note that `scripts/run-tests.mjs` strips some env vars: make sure `CODEX_CONTRACT_TEST` survives (it is not in `LEAKY_ENV`; do not add it).
- **`scripts/check-doc-consistency.mjs`:** exports `checkDocs({pluginRoot, repoRoot, companionHelp, mcpTools, allowlist})` → `{problems:[{file, line, kind, reference}]}` and a CLI. It scans `plugins/codex/commands/*.md`, `skills/**/*.md`, `agents/*.md`, `README.md` for: companion subcommands after `codex-companion.mjs`/`orvex-codex` (must be in the usage list); `--flags` in the same command line/code block (must appear in that subcommand's `--help`); `/codex:<name>` (must have `commands/<name>.md`); `codex:<skill>` skill references (must exist under `skills/`); `mcp__codex__<tool>` and `mcp__plugin_codex_codex__<tool>` (must be in the MCP server's tool list — obtain it by spawning `node plugins/codex/scripts/mcp-server.mjs` and calling `tools/list`, or by importing `buildCodexTools`). Get `companionHelp` by running `codex-companion.mjs <sub> --help` for each subcommand.
- **`tests/doc-consistency.test.mjs`:** (1) the real docs have no problems beyond the allowlist; (2) the checker catches an injected bad reference (a synthetic doc string with `codex-companion.mjs frobnicate`, a bogus `--flag`, `/codex:nope` and `mcp__codex__nope`) — each reported; (3) the allowlist entries each still match something (no stale allowlist).

## Implementation guide

- Read `.github/workflows/pull-request-ci.yml`, `scripts/run-tests.mjs`, `scripts/probe-app-server.mjs` (from `m0-spike`; reuse its safe client helpers if exportable, read-only).

## Fake-Codex fixture

The fixture API from lane `m0-fixture` (plan D2), in short: `installFakeCodex(binDir, behavior, options)`; `setFakeCodexOptions(binDir, patch)`; `options.turnScript` steps (`command`, `fileChange` with `writeFiles`, `agentMessage`, `reasoning`, `plan`, `diff`, `usage`, `delay`, `silence`, `serverRequest`); `options.interrupt: "cooperate"|"ignore"|"ack-only"`; `options.ignoreSigterm`; `options.delays.{initialize,threadStart,turnStart}`; `options.models`, `options.config`, `options.writeRollout`, `options.forceActiveWriter`, `options.turnStatus`; methods `model/list`, `config/read`, `thread/read`; `readFakeRpcLog(binDir, {method, conn, dir})`, `fakeConnections(binDir)`; `occupyBroker(endpoint, {holdMs})`; `startFakeAppServer(binDir)`; helpers `spawnStubborn()`, `waitFor()`, `isPidAlive()`, `makeCompanionWorkspace()`. M0/M1 lanes extended it further, so **read the fixture source for the exact signatures** before writing tests. Note: the fixture answers `thread/unload`, but the real codex-cli 0.157 app-server does **not** have it (probe §6), so plugin code must never call it.

**You do not own the fixture files in this wave** (lane `m6-broker-lib` does). Do not edit `tests/fake-codex-fixture.mjs` or `tests/helpers.mjs`. If you need something the fixture lacks, write a small local helper inside your own test file, or record the gap as a follow-up.

## Tests to write first

As described in the design: `tests/doc-consistency.test.mjs` (3 tests) and `tests/contract.test.mjs` (skips cleanly in `npm test`; verify by running it once with `CODEX_CONTRACT_TEST` unset and reading the skip message). Do **not** run the contract test against the real app-server yourself.

## Requirements from the report (verbatim)

The text below is copied verbatim from `docs/IMPROVEMENT-REPORT.md`. Line numbers in it predate M0/M1. The "Probe adjustments" and "Design decisions" sections of this brief override it where they differ.

### FR-24: Tests and CI for lifecycle, cancel, reconciliation, reports and docs
- **Priority:** P2
- **Problem:** Some lifecycle tests exist: cancel happy path (`tests/runtime.test.mjs` 1542 and 1740), cancel scoping (~1637 and ~1692), SessionEnd cleanup (~1804), Stop-hook stderr (~1982), and wait/send (`tests/orvex.test.mjs` 194-342). There are no tests for a failed interrupt, a broker orphan, dead-pid reconciliation, or doc/subcommand consistency. `tests/commands.test.mjs` 77-85 only checks that `send.md` and `wait.md` exist. CI (`.github/workflows/pull-request-ci.yml`) runs only on `pull_request` and installs `@openai/codex` unpinned.
- **Evidence:** As listed.
- **Proposal:** Add a test for every new item (see §9). Run CI on push to `main`/`dev`, on pull requests and nightly. Pin the codex version. Add an auth-gated nightly contract test against the real app-server (`initialize`, `thread/start`, `turn/start`, `turn/steer`, `turn/interrupt`, `model/list`, `config/read`, `thread/read`), skipped without auth. Add a doc-consistency test that fails when any command, skill or README references a subcommand, flag or tool that does not exist.
- **Acceptance criteria:** `npm test` covers each new item. The workflow has `on: [push, pull_request, schedule]`. The contract test file exists and skips cleanly without auth. The doc-consistency test catches an injected bad reference.

## Probe adjustments and scope narrowing (binding; they override the verbatim text above)

- Pin `@openai/codex@0.157.0`, the version the probe verified. The contract test asserts only the probe-recorded shapes (`model/list` `data`/`nextCursor`; `config/read` `config`/`origins`; `thread/read` `thread.path`/`status`/`turns`; `ThreadStartResponse` fields) and follows the probe safety gate. `thread/unload` does not exist and is not tested.

## Acceptance checklist (report PASS/FAIL per line)

- [ ] The workflow has `on: [push, pull_request, schedule]` (across the CI files, as documented)
- [ ] The codex version is pinned in CI
- [ ] The contract test file exists and skips cleanly without auth; when enabled it follows the probe safety gate
- [ ] The doc-consistency test catches an injected bad reference
- [ ] The real docs pass (allowlisted exceptions listed as follow-ups with reasons)
- [ ] `npm test` green in your worktree; no existing test edited except where this brief allows it

## Required final report (your last message; use exactly these sections)

```
## Lane m6-ci report
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
