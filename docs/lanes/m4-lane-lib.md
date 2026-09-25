# Lane `m4-lane-lib`: Lane-isolation library: `-c` overrides, preamble, developer instructions, advisory skill/hook policy, lane context (FR-13)

- **Beads:** `codex-plugin-cc-wn9.4`
- **Report items:** FR-13. **Scope in this lane:** the **library half** of FR-13: `lib/lane-config.mjs` and `prompts/delegated-worker.md`, unit-tested with stub clients. Flags, config keys and thread wiring are lane `m4-lane` (wave 3).
- **Milestone / wave:** M4, wave 1. **Depends on:** all of M3 merged. **Runs concurrently with:** `m4-models-lib`, `m4-config-lib`, `m4-effective`.

## Goal

Codex lanes auto-invoke repo skills, pick up hook-injected context, and every brief repeats the same boilerplate. Build the pieces a lane needs to control what Codex sees: typed `-c key=value` overrides deep-merged safely with the plugin's sandbox config, a built-in delegated-worker preamble delivered as developer instructions, an honest *advisory* skill/hook/AGENTS.md policy (0.157 has no per-thread switch), and a `lane-context` collector that reports what a lane would load.

## Ground rules (non-negotiable)

- **Worktree:** you work in your **own git worktree**, created by the orchestrator from branch `orvex/improvement-report` after the previous wave was merged (normally `/home/crew/workspace/codex-plugin-cc-lanes/m4-lane-lib` on branch `lane/m4-lane-lib`; use the path you were given). Paths below are relative to your worktree root, and `plugins/codex/scripts/` holds the runtime. The other lanes of your wave run at the same time in their own worktrees, and the orchestrator merges every lane of the wave afterwards. **File ownership is what keeps those merges conflict-free**, so respect it exactly.
- **Beads:** run `bd` from the main checkout: `cd /home/crew/workspace/codex-plugin-cc && bd update <id> --claim` for each bead listed above. If a bead is already claimed (another lane of the same item claimed it), skip the claim and still add your note. At the end, run `bd note <id> "<one paragraph: lane m4-lane-lib; what changed, tests added, npm test result, open risks>"` for each bead. **Never** run `bd close`: the orchestrator closes beads after review.
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

- `plugins/codex/scripts/lib/lane-config.mjs` (new)
- `plugins/codex/prompts/delegated-worker.md` (new)
- `tests/lane-config.test.mjs` (new)

## Do not touch

- Lane `m4-models-lib` runs at the same time and owns: `plugins/codex/scripts/lib/models.mjs`, `tests/models-lib.test.mjs`.
- Lane `m4-config-lib` runs at the same time and owns: `plugins/codex/scripts/lib/config.mjs`, `tests/config-lib.test.mjs`.
- Lane `m4-effective` runs at the same time and owns: `plugins/codex/scripts/lib/codex.mjs`, `plugins/codex/scripts/lib/tracked-jobs.mjs`, `plugins/codex/scripts/lib/render.mjs`, `tests/fake-codex-fixture.mjs`, `tests/helpers.mjs`, `tests/effective-runtime.test.mjs`.
- Any existing test file not listed under "Files you own" (add your tests in your own new test files).

## Design decisions binding on this lane

- **`parseConfigOverride("a.b.c=<value>")`** → `{path:["a","b","c"], value}`. Values are a TOML value subset: basic and literal strings, integers, floats, booleans, arrays, inline tables. For ergonomics like `codex -c`, a value that fails to parse **and** contains none of `"'[]{}=` is taken as a plain string (`model=gpt-6-luna`); anything else that fails → throw `Error` with `exitCode = 2` naming the override. Keys may be quoted (`"a.b"`).
- **`buildOverrideObject(list)`** → nested object (later entries win). **`mergeThreadConfig(sandboxConfig, overrides)`** → deep merge where **plugin sandbox keys win** (`sandbox_workspace_write.network_access` etc.); every conflicting override is dropped and reported in `warnings[]` (`-c sandbox_workspace_write.network_access ignored: set by --network/--no-network`). Also reject (`exitCode 2`) overrides of `sandbox_mode`, `approval_policy` and `sandbox_workspace_write.*` when `{forReview:true}` (reviews stay read-only).
- **`resolvePreamble(spec, {pluginRoot, cwd})`** → `{text, source}`: `builtin:delegated-worker` → `prompts/delegated-worker.md`; `none`/`off` → null; otherwise a file path (relative to `cwd`). **`wrapHarnessRules(text)`** → `<harness_rules>\n…\n</harness_rules>`.
- **`resolveDeveloperInstructions({file, text})`** → string or null (file read, capped at 64KB).
- **`composeDeveloperInstructions({preamble, developerInstructions, lanePolicy})`** → one string (harness rules block first, then user instructions, then the advisory policy lines) or null.
- **`buildLanePolicy({skills, hooks, noAgentsMd})`**: `skills` is `off | allow:<glob> | deny:<glob>` (comma-separated globs allowed), `hooks` is `off` or null. Returns `{record:{skills, hooks, agentsMd: noAgentsMd ? "ignore" : "default", enforcement:"advisory"}, lines:[…]}` where `lines` are plain instructions, e.g. `Do not invoke Codex skills matching bmad-* even if they seem relevant.`, `Ignore context injected by session-start or tool hooks (for example bd prime or Serena onboarding); the task brief is authoritative.`, `Treat AGENTS.md files as background only; these harness rules and the task brief take precedence.` Validate the syntax (`exitCode 2` on bad values).
- **`collectLaneContext(client, {cwd, codexHome, preamble, developerInstructions, lanePolicy, overrides})`** → `{skills:[{name, path, source, policy:"allow"|"deny"|"default"}], hooks:[{name, event, source}], agentsMd:[{path, scope:"global"|"repo"|"dir"}], preamble:{source}, developerInstructions:{source}, overrides, enforcement:"advisory", warnings}` using `skills/list {cwds:[cwd]}`, `hooks/list {cwds:[cwd]}` and `config/read {includeLayers:true, cwd}` on the given client, plus a filesystem walk for `AGENTS.md` (`$CODEX_HOME/AGENTS.md`, then each directory from the repo root down to `cwd`). Parse the `skills/list`/`hooks/list` responses tolerantly: generate the protocol types (`codex app-server generate-ts --out <tmp> --experimental`) and read `SkillsListResponse`/`HooksListResponse` (or the equivalent names) to get the real field names; record them in a comment.
- **`prompts/delegated-worker.md`**: the built-in text from the report's FR-13 item 4 (delegated worker; no interactive or orchestration skills; no session-start rituals; in a shared working tree never run a bare `git commit`, `git add -A`, `git stash` or `git push`, commit only with an explicit pathspec when the brief asks; report files changed, validation and risks). Keep it under 1500 characters.

## Implementation guide

- Pure module; the `client` is injected (`{request(method, params)}`), so tests use a stub.

## Fake-Codex fixture

The fixture API from lane `m0-fixture` (plan D2), in short: `installFakeCodex(binDir, behavior, options)`; `setFakeCodexOptions(binDir, patch)`; `options.turnScript` steps (`command`, `fileChange` with `writeFiles`, `agentMessage`, `reasoning`, `plan`, `diff`, `usage`, `delay`, `silence`, `serverRequest`); `options.interrupt: "cooperate"|"ignore"|"ack-only"`; `options.ignoreSigterm`; `options.delays.{initialize,threadStart,turnStart}`; `options.models`, `options.config`, `options.writeRollout`, `options.forceActiveWriter`, `options.turnStatus`; methods `model/list`, `config/read`, `thread/read`; `readFakeRpcLog(binDir, {method, conn, dir})`, `fakeConnections(binDir)`; `occupyBroker(endpoint, {holdMs})`; `startFakeAppServer(binDir)`; helpers `spawnStubborn()`, `waitFor()`, `isPidAlive()`, `makeCompanionWorkspace()`. M0/M1 lanes extended it further, so **read the fixture source for the exact signatures** before writing tests. Note: the fixture answers `thread/unload`, but the real codex-cli 0.157 app-server does **not** have it (probe §6), so plugin code must never call it.

**You do not own the fixture files in this wave** (lane `m4-effective` does). Do not edit `tests/fake-codex-fixture.mjs` or `tests/helpers.mjs`. If you need something the fixture lacks, write a small local helper inside your own test file, or record the gap as a follow-up.

## Tests to write first

`tests/lane-config.test.mjs`:
1. TOML values: string, literal string, int, float, bool, array, inline table; bare word fallback; `a=[1,` → exitCode 2.
2. `mergeThreadConfig({sandbox_workspace_write:{network_access:true}}, {sandbox_workspace_write:{network_access:false}, model_verbosity:"low"})` keeps `true`, adds `model_verbosity`, and warns.
3. Review mode rejects `sandbox_mode` overrides.
4. `resolvePreamble("builtin:delegated-worker")` loads the prompt file; `wrapHarnessRules` wraps it; `composeDeveloperInstructions` orders the parts.
5. `buildLanePolicy({skills:"deny:bmad-*", hooks:"off", noAgentsMd:true})` → advisory record and three lines; `skills:"maybe"` → exitCode 2.
6. `collectLaneContext` with a stub client and a temp tree containing `AGENTS.md` at two levels → skills/hooks/agentsMd with sources; policy flags a denied skill; the stub records no `skills/config/write` call.

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

- **Probe §4:** `ThreadStartParams.developerInstructions` exists and demonstrably affects the turn. Deliver the preamble and the lane policy through developer instructions (not a turn-input prefix) whenever the thread is started or forked.
- **Probe §8 / native surfaces §4 (scope narrowing):** there is **no verified per-thread key** that disables skills, hooks or AGENTS.md. The candidates `{"skills":{"enabled":false}}`, `{"features":{"hooks":false}}` and `{"project_doc_fallback_filenames":[]}` were accepted by `thread/start` but had no observed effect. Therefore FR-13 item 5 (`--skills`, `--hooks off`, `--no-agents-md` "implemented only through per-thread config overrides after the real config keys are verified") is narrowed to **advisory** enforcement: the policy becomes developer-instruction lines plus a `lanePolicy` record with `enforcement:"advisory"`, and `lane-context` reports what would load. **Never** send the unverified candidate keys on the lane's behalf (a user may still pass them explicitly with `-c`), and never call `skills/config/write` or anything else that mutates user-global Codex config. `--dangerously-bypass-hook-trust` is a CLI flag that bypasses hook *trust*, not hooks, and is not used.
- `skills/list` and `hooks/list` exist (probe §8: 59 skills, 4 hooks for a temp cwd) and are cwd/global inventories, which is what `lane-context` needs.

## Acceptance checklist (report PASS/FAIL per line)

- [ ] `-c key=value` values are TOML-parsed (with the bare-word fallback), invalid TOML fails synchronously (exit code 2), and overrides are deep-merged with the sandbox config without replacing it
- [ ] The built-in `delegated-worker` preamble exists and is composed into developer instructions with user instructions and the advisory policy lines
- [ ] `--skills deny:bmad-*` / `--hooks off` / `--no-agents-md` map to an advisory policy record and instruction lines (probe-narrowed; no unverified config keys are produced)
- [ ] The lane-context collector lists skills and hooks with sources (from `skills/list`/`hooks/list`) and AGENTS.md files, and never calls `skills/config/write`
- [ ] `npm test` green in your worktree; no existing test edited except where this brief allows it

## Required final report (your last message; use exactly these sections)

```
## Lane m4-lane-lib report
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
