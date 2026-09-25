# Lane `m4-lane`: Lane isolation wiring: `-c`, developer instructions, preamble, advisory skill/hook policy, `lane-context` (FR-13)

- **Beads:** `codex-plugin-cc-wn9.4`
- **Report items:** FR-13. **Scope in this lane:** the **wiring half** of FR-13 on top of `lib/lane-config.mjs` (probe-narrowed: skill/hook/AGENTS.md controls are advisory).
- **Milestone / wave:** M4, wave 3. **Depends on:** wave 2 (`m4-models` merged). **Runs concurrently with:** none (runs alone).

## Goal

Give every lane control over what Codex receives beyond the prompt: arbitrary typed config overrides, developer instructions, a default delegated-worker preamble, an honest advisory skill/hook/AGENTS.md policy, and a `lane-context` report of what a lane would load.

## Ground rules (non-negotiable)

- **Worktree:** you work in your **own git worktree**, created by the orchestrator from branch `orvex/improvement-report` after the previous wave was merged (normally `/home/crew/workspace/codex-plugin-cc-lanes/m4-lane` on branch `lane/m4-lane`; use the path you were given). Paths below are relative to your worktree root, and `plugins/codex/scripts/` holds the runtime. The other lanes of your wave run at the same time in their own worktrees, and the orchestrator merges every lane of the wave afterwards. **File ownership is what keeps those merges conflict-free**, so respect it exactly.
- **Beads:** run `bd` from the main checkout: `cd /home/crew/workspace/codex-plugin-cc && bd update <id> --claim` for each bead listed above. If a bead is already claimed (another lane of the same item claimed it), skip the claim and still add your note. At the end, run `bd note <id> "<one paragraph: lane m4-lane; what changed, tests added, npm test result, open risks>"` for each bead. **Never** run `bd close`: the orchestrator closes beads after review.
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
- `plugins/codex/scripts/lib/args.mjs`
- `plugins/codex/scripts/lib/lane-config.mjs`
- `plugins/codex/prompts/delegated-worker.md`
- `plugins/codex/skills/codex-drive/SKILL.md`
- `tests/fake-codex-fixture.mjs`
- `tests/helpers.mjs`
- `tests/lane.test.mjs` (new)
- `tests/orvex.test.mjs` (only assertions that deep-compare `thread/start` params and fail solely because of the new `developerInstructions` field)
- `tests/runtime.test.mjs` (same rule as above)

## Do not touch

- No lane runs concurrently with you in this wave.
- Any existing test file not listed under "Files you own" (add your tests in your own new test files).

## Design decisions binding on this lane

- **Flags on `task`, `send` and `fork`:** `-c key=value` (repeatable; teach `lib/args.mjs` repeatable options: `multiValueOptions: ["c"]` collecting an array, and make sure `-c` is not confused with other short flags), `--codex-profile <name>`, `--developer-instructions <file>`, `--lane-preamble <file|builtin:delegated-worker|none>`, `--skills off|allow:<glob>|deny:<glob>`, `--hooks off`, `--no-agents-md`. On `review`/`adversarial-review`: `-c` only, via `mergeThreadConfig(..., {forReview:true})`.
- **Config keys** (read with `getConfig`/`getGlobalConfig`; `m4-config` centralises them next wave): `codexConfigOverrides` (object), `developerInstructions` (file path or text), `defaultPreamble` (default `builtin:delegated-worker`), `skillsPolicy`, `hooksPolicy`, `agentsMdPolicy`.
- **Thread params (`lib/codex.mjs`):** `buildThreadParams`, `buildResumeParams` and the fork call accept `developerInstructions` and send it when non-null; `config` = `mergeThreadConfig(buildSandboxConfig(network), overrides)`. The composed developer instructions (preamble → user developer instructions → advisory policy lines) are sent on `thread/start` and `thread/fork`, and on `thread/resume` **only if** the generated `ThreadResumeParams` type has `developerInstructions` (check with `codex app-server generate-ts`); otherwise, on resume, prepend a `<harness_rules>` block to the turn input instead, and say so in `job.runtime.lane.delivery`.
- **Default preamble:** task jobs get `builtin:delegated-worker` unless `--lane-preamble none` or config says otherwise. Reviews and the stop gate never get it. Existing tests that deep-compare `thread/start` params may fail only because of the new field: update those assertions narrowly (allowed above) and list each one.
- **`--codex-profile <name>`:** check the generated `ThreadStartParams` for a profile field. If it exists, send it; otherwise map it to the `config` override `profile=<name>` and record `runtime.lane.codexProfile = {name, delivery:"config-override", verified:false}` with a stderr note. Report which one you found.
- **Record:** `job.runtime.lane = {preamble:{source}, developerInstructions:{source, bytes}, overrides, policy: lanePolicy.record, delivery}` and `job.runtime.config` (the merged config). Status shows `lane: preamble builtin:delegated-worker · skills deny:bmad-* (advisory)`.
- **`lane-context [--json] [--cwd d] [lane flags]`:** connect (`withAppServer`), run `collectLaneContext`, print skills/hooks/AGENTS.md/preamble/instructions with sources and the advisory note; `--json` → the structure plus `schemaVersion:2`.
- **Warnings:** every advisory flag prints once on stderr: `--skills/--hooks/--no-agents-md are advisory in codex-cli 0.157 (no per-thread switch); they are sent as developer instructions.`
- Drive skill: document the lane flags and `lane-context`.

## Implementation guide

- `codex-companion.mjs`: `handleTask`, `handleSend`, the `fork` handler, `handleReviewCommand`, `executeTaskRun`, `buildSandboxConfig`, `RUNTIME_VALUE_OPTIONS`, `printUsage`, `main` (`lane-context`).
- `lib/codex.mjs`: `buildThreadParams`, `buildResumeParams`, `buildTurnInput`, `runAppServerTurn`, `runAppServerReview`.

## Fake-Codex fixture

The fixture API from lane `m0-fixture` (plan D2), in short: `installFakeCodex(binDir, behavior, options)`; `setFakeCodexOptions(binDir, patch)`; `options.turnScript` steps (`command`, `fileChange` with `writeFiles`, `agentMessage`, `reasoning`, `plan`, `diff`, `usage`, `delay`, `silence`, `serverRequest`); `options.interrupt: "cooperate"|"ignore"|"ack-only"`; `options.ignoreSigterm`; `options.delays.{initialize,threadStart,turnStart}`; `options.models`, `options.config`, `options.writeRollout`, `options.forceActiveWriter`, `options.turnStatus`; methods `model/list`, `config/read`, `thread/read`; `readFakeRpcLog(binDir, {method, conn, dir})`, `fakeConnections(binDir)`; `occupyBroker(endpoint, {holdMs})`; `startFakeAppServer(binDir)`; helpers `spawnStubborn()`, `waitFor()`, `isPidAlive()`, `makeCompanionWorkspace()`. M0/M1 lanes extended it further, so **read the fixture source for the exact signatures** before writing tests. Note: the fixture answers `thread/unload`, but the real codex-cli 0.157 app-server does **not** have it (probe §6), so plugin code must never call it.

**You own the fixture files in this wave.** If you need a capability that is missing, add it **additively** (new options, new turnScript step types, new helpers) and keep every existing behaviour string and option working. Where the fixture's shapes differ from `docs/app-server-probe.md` ("Fixture shapes"), make the fixture match the probe for the methods you touch.

Add `skills/list` and `hooks/list` to the fake (from `options.skills`/`options.hooks`, in the shapes of the generated types) and make sure the RPC log records `thread/start` params including `developerInstructions` and `config`.

## Tests to write first

`tests/lane.test.mjs`:
1. `-c model_verbosity="low" -c 'tools.web_search=true' --network --write` → recorded `thread/start` `config` contains both overrides and `sandbox_workspace_write.network_access:true`; a conflicting `-c sandbox_workspace_write.network_access=false` is dropped with a warning; config `codexConfigOverrides` is merged too.
2. Invalid TOML `-c 'a=[1,'` exits 2 before any job record.
3. Default: `thread/start.developerInstructions` contains the delegated-worker text; `--lane-preamble none` removes it; `--developer-instructions f` appends the file.
4. `--skills deny:bmad-* --hooks off --no-agents-md` → the three advisory lines are in `developerInstructions`, `job.runtime.lane.policy.enforcement == "advisory"`, and `thread/start.config` contains **none** of `skills.enabled`, `features.hooks`, `project_doc_fallback_filenames`.
5. `lane-context --json` lists skills and hooks (from the fake) with sources, and AGENTS.md files in a temp tree.
6. The RPC trace of every test in this file contains no `skills/config/write`.
7. Reviews: `review -c sandbox_mode="danger-full-access"` exits 2; reviews carry no preamble.
8. Resume: developer instructions are delivered per the rule above (assert whichever path your type check selected).

## Requirements from the report (verbatim)

The text below is copied verbatim from `docs/IMPROVEMENT-REPORT.md`. Line numbers in it predate M0/M1. The "Probe adjustments" and "Design decisions" sections of this brief override it where they differ.

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

## Probe adjustments and scope narrowing (binding; they override the verbatim text above)

- **developerInstructions (probe §4):** verified on `thread/start`; deliver the preamble there. Resume support must be checked against the generated types before relying on it.
- **Scope narrowing (probe §8, native surfaces §4):** no verified per-thread key disables skills, hooks or AGENTS.md. `--skills`, `--hooks off` and `--no-agents-md` are **advisory**: sent as developer-instruction lines and recorded with `enforcement:"advisory"`; the report's criterion "`--skills deny:bmad-*` / `--hooks off` producing the verified override keys" becomes "producing the advisory instruction lines and policy record, and **no** unverified override keys". Revisit when a Codex release adds a real per-thread switch (record as a follow-up).
- Never call `skills/config/write` (it mutates user-global Codex config).

## Acceptance checklist (report PASS/FAIL per line)

- [ ] A fake-fixture test shows the `codexConfigOverrides` (and `-c` overrides) merged with `network_access` in the thread/start params; invalid TOML fails synchronously
- [ ] The configured `developerInstructions` (and the default delegated-worker preamble) are present on thread/start (or, where resume lacks the field, the `<harness_rules>` block is at the top of the turn input)
- [ ] `--skills deny:bmad-*` / `--hooks off` produce the advisory instruction lines and policy record, and no unverified override keys (probe-narrowed)
- [ ] `lane-context --json` lists skills and hooks with sources
- [ ] The RPC trace contains no `skills/config/write`
- [ ] `--codex-profile` delivery verified against the generated types and recorded
- [ ] `npm test` green in your worktree; no existing test edited except where this brief allows it

## Required final report (your last message; use exactly these sections)

```
## Lane m4-lane report
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
