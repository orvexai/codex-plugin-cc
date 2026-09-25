# Lane `m5-workflow`: Workflow integration: `codex:codex-exec` agent and `codex:workflow` skill (FR-19)

- **Beads:** `codex-plugin-cc-qo4.2`
- **Report items:** FR-19. **Scope in this lane:** FR-19 items 1-3 and 5 (docs, agent, example workflow and its tests). Item 4 (`--progress-stderr`) landed in `m5-job-api`.
- **Milestone / wave:** M5, wave 2. **Depends on:** wave 1 merged (`--progress-stderr`, the job API). **Runs concurrently with:** `m5-mcp`, `m5-fanout-brief`.

## Goal

Workflow scripts reach Codex through a Haiku forwarder that returns free text, may complete early, and has no schema. Give them a first-class lane: a minimal `codex:codex-exec` agent that runs one owned, schema-validated Codex job and returns its data, a `codex:workflow` skill with a worked example, and tests proving schema-valid results and clean cancellation.

## Ground rules (non-negotiable)

- **Worktree:** you work in your **own git worktree**, created by the orchestrator from branch `orvex/improvement-report` after the previous wave was merged (normally `/home/crew/workspace/codex-plugin-cc-lanes/m5-workflow` on branch `lane/m5-workflow`; use the path you were given). Paths below are relative to your worktree root, and `plugins/codex/scripts/` holds the runtime. The other lanes of your wave run at the same time in their own worktrees, and the orchestrator merges every lane of the wave afterwards. **File ownership is what keeps those merges conflict-free**, so respect it exactly.
- **Beads:** run `bd` from the main checkout: `cd /home/crew/workspace/codex-plugin-cc && bd update <id> --claim` for each bead listed above. If a bead is already claimed (another lane of the same item claimed it), skip the claim and still add your note. At the end, run `bd note <id> "<one paragraph: lane m5-workflow; what changed, tests added, npm test result, open risks>"` for each bead. **Never** run `bd close`: the orchestrator closes beads after review.
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

- `plugins/codex/agents/codex-exec.md` (new)
- `plugins/codex/skills/codex-workflow/SKILL.md` (new)
- `tests/fixtures/workflow/` (new directory)
- `tests/workflow.test.mjs` (new)

## Do not touch

- Lane `m5-mcp` runs at the same time and owns: `plugins/codex/scripts/mcp-server.mjs`, `plugins/codex/scripts/lib/mcp-tools.mjs`, `plugins/codex/scripts/lib/mcp-protocol.mjs`, `plugins/codex/.mcp.json`, `tests/mcp.test.mjs`.
- Lane `m5-fanout-brief` runs at the same time and owns: `plugins/codex/scripts/codex-companion.mjs`, `plugins/codex/scripts/lib/job-api.mjs`, `plugins/codex/scripts/lib/fanout.mjs`, `plugins/codex/scripts/lib/brief-format.mjs`, `plugins/codex/scripts/lib/codex.mjs`, `plugins/codex/scripts/lib/tracked-jobs.mjs`, `plugins/codex/scripts/lib/render.mjs`, `tests/fake-codex-fixture.mjs`, `tests/helpers.mjs`, `tests/fanout.test.mjs`, `tests/brief.test.mjs`.
- Any existing test file not listed under "Files you own" (add your tests in your own new test files).

## Design decisions binding on this lane

- **`agents/codex-exec.md`:** frontmatter `name: codex-exec`, `description` (not "Proactively"; say it is for Workflow/agent pipelines that need schema-valid Codex output), `model: haiku`, `tools: Bash` (restrict in the body to exactly one command form). Body: run exactly one Bash command, `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task --attach --json --progress-stderr --output-schema <schema file from the caller> [--model/--effort/--profile from the caller] --prompt-file <file>`, in the foreground (the agent itself is the owner; do not use `run_in_background` and never `--background`); on exit 0 return `structured.data` from the JSON verbatim as the final answer; on exit 2 with `reportError` return `CODEX_SCHEMA_INVALID` plus the validation errors; on any other non-zero exit return `CODEX_EXEC_FAILED exit=<n>` plus the last stderr lines. Never summarise, poll, or run a second command. If the codex MCP tools are available to the agent, the skill documents the `codex{wait:true, outputSchema}` alternative (not the agent).
- **`skills/codex-workflow/SKILL.md`:** when to use Codex lanes in a Workflow, the three integration options in order of preference (direct MCP `codex` tool where the runtime can call MCP tools; `agent({agentType:"codex:codex-exec", …})` with a schema; a general agent running `task --attach --output-schema --json`), cancellation semantics (owner lease, MCP cancel, broker interrupt-on-disconnect), and a worked example. Only reference subcommands, flags and tools that exist after M5 wave 1 (check `--help`); do not reference `fanout` or `codex_fanout` here (the fan-out docs are added by `m5-docs`).
- **Example:** `tests/fixtures/workflow/example-workflow.mjs`, a plain Node script that stands in for a Workflow script: it launches 3 lanes in parallel as `task --attach --json --output-schema <schema>` child processes (like 3 codex-exec agents would), collects `structured.data`, validates each against the schema, and prints a JSON summary. It forwards SIGTERM to its children. `tests/fixtures/workflow/lane-schema.json` is the example schema.
- **Token budget:** the FR-19 criterion "Claude-side median ≤ 3k tokens per lane" cannot be measured in `npm test`; keep the agent and skill bodies short (agent body under ~1200 characters) and record the manual measurement as pending for the orchestrator.

## Implementation guide

- Read `agents/codex-rescue.md` (the deprecated shim from M1) for frontmatter conventions, and `tests/commands.test.mjs` for how command/agent frontmatter is parsed in tests (read-only).

## Fake-Codex fixture

The fixture API from lane `m0-fixture` (plan D2), in short: `installFakeCodex(binDir, behavior, options)`; `setFakeCodexOptions(binDir, patch)`; `options.turnScript` steps (`command`, `fileChange` with `writeFiles`, `agentMessage`, `reasoning`, `plan`, `diff`, `usage`, `delay`, `silence`, `serverRequest`); `options.interrupt: "cooperate"|"ignore"|"ack-only"`; `options.ignoreSigterm`; `options.delays.{initialize,threadStart,turnStart}`; `options.models`, `options.config`, `options.writeRollout`, `options.forceActiveWriter`, `options.turnStatus`; methods `model/list`, `config/read`, `thread/read`; `readFakeRpcLog(binDir, {method, conn, dir})`, `fakeConnections(binDir)`; `occupyBroker(endpoint, {holdMs})`; `startFakeAppServer(binDir)`; helpers `spawnStubborn()`, `waitFor()`, `isPidAlive()`, `makeCompanionWorkspace()`. M0/M1 lanes extended it further, so **read the fixture source for the exact signatures** before writing tests. Note: the fixture answers `thread/unload`, but the real codex-cli 0.157 app-server does **not** have it (probe §6), so plugin code must never call it.

**You do not own the fixture files in this wave** (lane `m5-fanout-brief` does). Do not edit `tests/fake-codex-fixture.mjs` or `tests/helpers.mjs`. If you need something the fixture lacks, write a small local helper inside your own test file, or record the gap as a follow-up.

## Tests to write first

`tests/workflow.test.mjs` (fake fixture; each lane's turn ends with a final message conforming to the schema):
1. Running `example-workflow.mjs` yields 3 schema-valid objects and exit 0.
2. Sending SIGTERM to the example script mid-run leaves no active turns at the fake and no live workers (each attach child runs its verified cancel).
3. `agents/codex-exec.md` frontmatter: `model: haiku`, no "Proactively", body references `task --attach`, `--output-schema` and `--json`, never `--background`.
4. Every companion subcommand and flag referenced in `skills/codex-workflow/SKILL.md` and `agents/codex-exec.md` exists (check against `--help` output).

## Requirements from the report (verbatim)

The text below is copied verbatim from `docs/IMPROVEMENT-REPORT.md`. Line numbers in it predate M0/M1. The "Probe adjustments" and "Design decisions" sections of this brief override it where they differ.

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

## Probe adjustments and scope narrowing (binding; they override the verbatim text above)

- `codex exec --output-schema` exists in 0.157 (native surfaces §5) but is a one-shot without the plugin's job record, ownership or events; the lane uses the plugin's `task --attach --output-schema` instead, and the skill says why.

## Acceptance checklist (report PASS/FAIL per line)

- [ ] An example workflow in `tests/fixtures` runs 3 codex-exec-style lanes with a JSON schema and receives schema-valid objects
- [ ] Stopping the workflow mid-run leaves no active turns at the fake
- [ ] `codex:workflow` skill and `codex:codex-exec` agent exist, reference only existing commands and flags, and document direct MCP use
- [ ] The Claude-side median of 3k tokens or fewer per lane: recorded as a manual measurement for the orchestrator (not measurable in `npm test`)
- [ ] `npm test` green in your worktree; no existing test edited except where this brief allows it

## Required final report (your last message; use exactly these sections)

```
## Lane m5-workflow report
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
