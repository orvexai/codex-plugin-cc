# Lane `m5-docs`: Generated delegation docs, `setup --install-mcp`, `codex_fanout`, and brief-format doc relaxations (FR-27, FR-23, FR-18)

- **Beads:** `codex-plugin-cc-qo4.5`, `codex-plugin-cc-qo4.3`, `codex-plugin-cc-qo4.4`
- **Report items:** FR-27, FR-23, FR-18. **Scope in this lane:** all of FR-27; FR-23's documentation half (rescue/result/result-handling relaxations); FR-18's MCP mirror `codex_fanout` and fan-out docs.
- **Milestone / wave:** M5, wave 3. **Depends on:** wave 2 (`m5-mcp`, `m5-fanout-brief`, `m5-workflow` merged). **Runs concurrently with:** none (runs alone).

## Goal

E7 happened because a consuming repo's CLAUDE.md named tools that did not exist. Now that the MCP server exists, make the documented names real and checkable: install the server under the name downstream docs expect, generate a delegation block from the actual tool and command lists, and let `config doctor` flag every stale reference. Also switch the rescue path to the cheap brief format and relax the result-handling rules where the user delegated autonomously.

## Ground rules (non-negotiable)

- **Worktree:** you work in your **own git worktree**, created by the orchestrator from branch `orvex/improvement-report` after the previous wave was merged (normally `/home/crew/workspace/codex-plugin-cc-lanes/m5-docs` on branch `lane/m5-docs`; use the path you were given). Paths below are relative to your worktree root, and `plugins/codex/scripts/` holds the runtime. The other lanes of your wave run at the same time in their own worktrees, and the orchestrator merges every lane of the wave afterwards. **File ownership is what keeps those merges conflict-free**, so respect it exactly.
- **Beads:** run `bd` from the main checkout: `cd /home/crew/workspace/codex-plugin-cc && bd update <id> --claim` for each bead listed above. If a bead is already claimed (another lane of the same item claimed it), skip the claim and still add your note. At the end, run `bd note <id> "<one paragraph: lane m5-docs; what changed, tests added, npm test result, open risks>"` for each bead. **Never** run `bd close`: the orchestrator closes beads after review.
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
- `plugins/codex/scripts/lib/claude-md.mjs`
- `plugins/codex/scripts/lib/config.mjs`
- `plugins/codex/scripts/lib/mcp-tools.mjs`
- `plugins/codex/commands/rescue.md`
- `plugins/codex/commands/result.md`
- `plugins/codex/skills/codex-result-handling/SKILL.md`
- `plugins/codex/skills/codex-drive/SKILL.md`
- `plugins/codex/skills/codex-workflow/SKILL.md`
- `README.md`
- `tests/fixtures/delegation/` (new directory)
- `tests/commands.test.mjs` (only assertions about `rescue.md`, `result.md` and `codex-result-handling` wording that this lane changes)
- `tests/fake-codex-fixture.mjs`
- `tests/helpers.mjs`
- `tests/claude-md.test.mjs`
- `tests/delegation.test.mjs` (new)

## Do not touch

- No lane runs concurrently with you in this wave.
- Any existing test file not listed under "Files you own" (add your tests in your own new test files).

## Design decisions binding on this lane

- **`setup --install-mcp [--scope user|project]`:** registers the server as `codex` so tools are `mcp__codex__codex`, `mcp__codex__codex-reply`, …. `project` scope writes/merges `<repo root>/.mcp.json` `{"mcpServers":{"codex":{"command": <cmd>, "args": [...]}}}` (atomic, preserving other servers); `user` scope runs `claude mcp add -s user codex -- <cmd> mcp` through the binary named by `CODEX_COMPANION_CLAUDE_BIN` (default `claude`; add to `LEAKY_ENV`), failing with a clear message if it is missing. `<cmd>` is the `orvex-codex` shim when installed (`lib/cli-shim.mjs`), else `node <absolute companion path>`. Idempotent; `--json` output.
- **`setup --print-claude-md`** (generator in `lib/claude-md.mjs` from `m4-config`): detect registration (project `.mcp.json` `mcpServers.codex`, or `~/.claude.json` `mcpServers.codex` read-only, or an explicit `--mcp registered|none`). Registered → the block names the exact tool names `mcp__codex__<tool>` from `buildCodexTools()` (the live list, never a copy) for launch/reply/steer/interrupt/status/cancel/transcript/fanout. Not registered → the `orvex-codex` (or `node …`) Bash equivalents: `task --attach`, `send`, `interrupt --then`, `task --resume <threadId>`, `wait`, `result --format brief`, `cancel`. Model guidance uses aliases (`luna`, `terra`) resolved through FR-12, with a line telling users to define them via `setup --alias`.
- **`config doctor` delegation checks:** extend `doctorConfig` (you own `lib/config.mjs` now): for each `mcp__codex__<name>` mentioned in the workspace's `CLAUDE.md`/`AGENTS.md` (and any `--doc <file>` passed), warn when `<name>` is not in `buildCodexTools()` or the server is not registered; warn on hard-coded model ids that are not in the catalog.
- **`codex_fanout` MCP tool** (§8.3): `{specs[], maxParallel=4, worktree=true, outputSchema?, wait=true}` → `{groupId, results:[{name, jobId, status, report, structured}]}` via `launchFanout`/`waitGroup`; `worktree:true` returns an error until FR-6 exists, so default it to `false` for now and say so in the tool description (M6 flips it).
- **FR-23 docs:** `commands/rescue.md` launches with `--format brief` and tells Claude to fetch `result <id>` only when it needs more; `commands/result.md` and `skills/codex-result-handling/SKILL.md` relax "verbatim, no summarising" when the format is brief, and relax "must ask before acting on findings" when the user delegated autonomously or config `resultHandling` is `autonomous` (new key in `CONFIG_KEYS`, `setup --result-handling ask|autonomous [--global]`, default `ask`). The prompting skill is loaded on demand only (it is no longer preloaded after M1; verify and note).
- **Drive and workflow skills:** add `fanout`/`wait --group`/`cancel --group` rows and the MCP tool names to `skills/codex-drive/SKILL.md`; add the fan-out option to `skills/codex-workflow/SKILL.md`. README: a "Delegating from other repos" section showing `setup --install-mcp` and `--print-claude-md`.
- **Houston follow-up (FR-27 item 4):** do **not** edit `/home/crew/workspace/houston`. Read its `CLAUDE.md` read-only, write a synthetic excerpt with the same tool references to `tests/fixtures/delegation/houston-excerpt.md` (names only, no other content), and list the needed downstream change under "Risks / follow-ups" so the orchestrator files it in that repo.

## Implementation guide

- `codex-companion.mjs`: `handleSetup`, the `config doctor` handler, `printUsage`. `lib/cli-shim.mjs` (read-only) for the shim path. `lib/mcp-tools.mjs`: `buildCodexTools`.

## Fake-Codex fixture

The fixture API from lane `m0-fixture` (plan D2), in short: `installFakeCodex(binDir, behavior, options)`; `setFakeCodexOptions(binDir, patch)`; `options.turnScript` steps (`command`, `fileChange` with `writeFiles`, `agentMessage`, `reasoning`, `plan`, `diff`, `usage`, `delay`, `silence`, `serverRequest`); `options.interrupt: "cooperate"|"ignore"|"ack-only"`; `options.ignoreSigterm`; `options.delays.{initialize,threadStart,turnStart}`; `options.models`, `options.config`, `options.writeRollout`, `options.forceActiveWriter`, `options.turnStatus`; methods `model/list`, `config/read`, `thread/read`; `readFakeRpcLog(binDir, {method, conn, dir})`, `fakeConnections(binDir)`; `occupyBroker(endpoint, {holdMs})`; `startFakeAppServer(binDir)`; helpers `spawnStubborn()`, `waitFor()`, `isPidAlive()`, `makeCompanionWorkspace()`. M0/M1 lanes extended it further, so **read the fixture source for the exact signatures** before writing tests. Note: the fixture answers `thread/unload`, but the real codex-cli 0.157 app-server does **not** have it (probe §6), so plugin code must never call it.

**You own the fixture files in this wave.** If you need a capability that is missing, add it **additively** (new options, new turnScript step types, new helpers) and keep every existing behaviour string and option working. Where the fixture's shapes differ from `docs/app-server-probe.md` ("Fixture shapes"), make the fixture match the probe for the methods you touch.

Add a stub `claude` executable writer (in `tests/helpers.mjs`) that records its argv to a file, for the `--scope user` test.

## Tests to write first

`tests/delegation.test.mjs`:
1. In a temp workspace, `setup --install-mcp --scope project` writes `.mcp.json` with the `codex` server (preserving another server entry); then `setup --print-claude-md` produces text in which every `mcp__codex__*` name appears in the server's `tools/list` (spawn the server and list tools).
2. Without the MCP server registered, the block names only existing subcommands (checked against `--help`).
3. `setup --install-mcp --scope user` calls the stub `claude mcp add -s user codex -- … mcp`.
4. `config doctor` reports no delegation warnings against the generated block, and warns about each missing `mcp__codex__*` tool (e.g. a made-up `mcp__codex__codex_frobnicate`) and each unknown hard-coded model in `houston-excerpt.md`.
5. `codex_fanout` over MCP runs 3 specs with `maxParallel:2` and returns 3 results.
6. `orvex-codex mcp` (or `node codex-companion.mjs mcp`) answers `tools/list` including `codex_fanout`.
`tests/claude-md.test.mjs` (extend): the MCP-aware variant references only registered tool names.
7. Doc assertions: `rescue.md` uses `--format brief`; the relaxed rules are present and conditional.

## Requirements from the report (verbatim)

The text below is copied verbatim from `docs/IMPROVEMENT-REPORT.md`. Line numbers in it predate M0/M1. The "Probe adjustments" and "Design decisions" sections of this brief override it where they differ.

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

### FR-18: A parallel fan-out primitive with a concurrency cap and aggregated results
- **Priority:** P2
- **Problem:** Workflow/Ultracode fans out subagents and collects typed results. With Codex, fan-out means N separate `task --background` calls with no cap, no group, and `wait` returning only statuses. All jobs also share one broker, which serves one stream at a time and pushes the rest to direct app-servers.
- **Evidence:** E12. `codex-companion.mjs` ~911-950 and ~1205-1272. `README.md` 222-230. `lib/codex.mjs` 762-791.
- **Proposal:** Add `fanout --spec <file.jsonl|-> [--max-parallel 4] [--group <name>] [--worktree] [--output-schema …] [--attach]`. Each spec line is `{name, prompt|promptFile, model?, effort?, sandbox?, cwd?, outputSchema?}`. Jobs share a `groupId` and are scheduled under the state lock: queued jobs are not launched until a slot is free. Add `wait --group <g> --json`, which returns `[{name, jobId, status, report, exitCode}]`, and `cancel --group <g>`. Attach mode cancels the whole group on SIGTERM. Mirror it as the MCP tool `codex_fanout`. Given the broker's one-stream design, decide whether fan-out jobs should use direct app-servers intentionally (recommended) and record `transport`.
- **Acceptance criteria:** With 6 specs and `--max-parallel 2`, sampling never shows more than 2 running jobs. `wait --group --json` returns 6 entries with reports. Cancelling the group leaves 0 live workers and 0 active turns at the fake. SIGTERM in attach mode cancels the group.

## Probe adjustments and scope narrowing (binding; they override the verbatim text above)

- The downstream `mcp__codex__codex`/`codex-reply` names come from an old upstream `codex mcp-server`, which 0.157 does not have (report E7); the plugin's server provides them. The native daemon is not involved.

## Acceptance checklist (report PASS/FAIL per line)

- [ ] In a temp workspace, `setup --install-mcp --scope project` followed by `setup --print-claude-md` produces text in which every `mcp__codex__*` name appears in the server's `tools/list`
- [ ] Without the MCP server, the block names only existing subcommands (checked by a doc-consistency test)
- [ ] `config doctor` reports no delegation warnings against the generated block, and warns about each missing `mcp__codex__*` tool against the houston-style text
- [ ] The block's model guidance uses aliases, not hard-coded ids
- [ ] The consuming-repo follow-up is reported (not implemented here)
- [ ] FR-23: rescue uses `--format brief`; the "verbatim" and "ask before acting" rules are relaxed as specified and configurable (`resultHandling`)
- [ ] FR-18: the MCP tool `codex_fanout` exists and works
- [ ] `claude mcp add codex -- orvex-codex mcp` equivalent lists all tools (checked via `node codex-companion.mjs mcp` + `tools/list`)
- [ ] `npm test` green in your worktree; no existing test edited except where this brief allows it

## Required final report (your last message; use exactly these sections)

```
## Lane m5-docs report
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
