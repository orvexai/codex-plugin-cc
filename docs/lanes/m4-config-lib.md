# Lane `m4-config-lib`: Layered config resolver, profiles, config introspection and doctor (library) (FR-14, FR-15)

- **Beads:** `codex-plugin-cc-wn9.5`, `codex-plugin-cc-wn9.6`
- **Report items:** FR-14, FR-15. **Scope in this lane:** the **library halves** of FR-14 and FR-15: `lib/config.mjs` (key schema, built-in and custom profiles, repo file, precedence resolution with sources and paths, set/unset helpers, doctor checks). Wiring into the companion is lane `m4-config` (wave 4).
- **Milestone / wave:** M4, wave 1. **Depends on:** all of M3 merged. **Runs concurrently with:** `m4-models-lib`, `m4-lane-lib`, `m4-effective`.

## Goal

Defaults are scattered: the companion reads four keys through ad-hoc code, a team cannot version its defaults, and nobody can see where a value came from. Build one resolver for every key in report §8.4 with the full precedence chain, named permission profiles (including `bypass`), a checked-in repo layer, `{key, value, source, path}` introspection, validated set/unset, and a doctor.

## Ground rules (non-negotiable)

- **Worktree:** you work in your **own git worktree**, created by the orchestrator from branch `orvex/improvement-report` after the previous wave was merged (normally `/home/crew/workspace/codex-plugin-cc-lanes/m4-config-lib` on branch `lane/m4-config-lib`; use the path you were given). Paths below are relative to your worktree root, and `plugins/codex/scripts/` holds the runtime. The other lanes of your wave run at the same time in their own worktrees, and the orchestrator merges every lane of the wave afterwards. **File ownership is what keeps those merges conflict-free**, so respect it exactly.
- **Beads:** run `bd` from the main checkout: `cd /home/crew/workspace/codex-plugin-cc && bd update <id> --claim` for each bead listed above. If a bead is already claimed (another lane of the same item claimed it), skip the claim and still add your note. At the end, run `bd note <id> "<one paragraph: lane m4-config-lib; what changed, tests added, npm test result, open risks>"` for each bead. **Never** run `bd close`: the orchestrator closes beads after review.
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

- `plugins/codex/scripts/lib/config.mjs` (new)
- `tests/config-lib.test.mjs` (new)

## Do not touch

- Lane `m4-models-lib` runs at the same time and owns: `plugins/codex/scripts/lib/models.mjs`, `tests/models-lib.test.mjs`.
- Lane `m4-lane-lib` runs at the same time and owns: `plugins/codex/scripts/lib/lane-config.mjs`, `plugins/codex/prompts/delegated-worker.md`, `tests/lane-config.test.mjs`.
- Lane `m4-effective` runs at the same time and owns: `plugins/codex/scripts/lib/codex.mjs`, `plugins/codex/scripts/lib/tracked-jobs.mjs`, `plugins/codex/scripts/lib/render.mjs`, `tests/fake-codex-fixture.mjs`, `tests/helpers.mjs`, `tests/effective-runtime.test.mjs`.
- `lib/state.mjs` (import `getConfig`, `getGlobalConfig`, `setConfig`, `setGlobalConfig`, `resolveGlobalConfigFile` read-only).
- Any existing test file not listed under "Files you own" (add your tests in your own new test files).

## Design decisions binding on this lane

- **`CONFIG_KEYS`**: a frozen table of every §8.4 key plus the keys earlier lanes added (`stopRunningJobs`, `onOwnerExit`, `sessionEndPolicy`, `notifyVia`, `reviewPersist`, `idleNudgeMs`, `reviewModel`, `reviewEffort`, `defaultMaxRuntime`, `defaultIdleTimeout`, `bypassNoticeShownAt` …; grep the merged code for `getConfig(`/`getGlobalConfig(` to find them all): `{type, allowed?, default, scopes:["workspace","repo","global"], validate?}`. Built-in defaults match today's behaviour (notably `defaultLaunch: "foreground"` and `defaultResume: "ask"`; see probe adjustments).
- **`BUILTIN_PROFILES`** = `bypass {sandbox:"danger-full-access", network:true}`, `write {sandbox:"workspace-write", network:false}`, `readonly {sandbox:"read-only", network:false}`. User profiles come from `permissionProfiles` (same shape; may also set `model`, `effort`). Unknown profile → error `exitCode 2`.
- **`readRepoConfig(repoRoot)`** → `{path, values}` from `<repoRoot>/.codex-companion.json` (missing → empty; invalid JSON → error naming the file).
- **`resolveConfig({flags = {}, inherited = {}, env = process.env, workspace, repo, global, codexConfig = {}, builtins})`** → `{values: {key: {value, source, path}}, profile: {name, source}, warnings}`. Precedence: flag > inherited > env (`CODEX_COMPANION_<SNAKE_KEY>` for the runtime keys that already have env vars; keep existing names) > workspace > repo > global > profile > codex-config > built-in. **Profile placement (binding):** a profile selected by the `--profile` **flag** or `CODEX_COMPANION_PROFILE` expands at the flag/env tier (just below explicit sandbox/network/model flags), so `task --profile readonly` beats a global `defaultSandbox`; a profile from `defaultProfile` config expands at the profile tier. `source` values: `flag|inherited|env|workspace|repo|global|profile:<name>|codex-config|built-in` (FR-25's `built-in:bypass` label stays for the built-in sandbox). `path` is the file for workspace/repo/global/codex-config (from `config/read` origins) and null otherwise.
- **`explainConfig(resolved)`** → rows `[{key, value, source, path}]` sorted by key, for `config show`.
- **`setConfigValue({scope, key, value, workspaceRoot, repoRoot})`** / **`unsetConfigValue(...)`**: validates with `CONFIG_KEYS`; `workspace` → `setConfig`, `global` → `setGlobalConfig`, `repo` → atomic rewrite of `.codex-companion.json` (2-space JSON, trailing newline). `none|unset|default|clear` clear the key (same words the companion accepts today).
- **`doctorConfig({resolved, catalog, aliases, docs:[{path, text}], registeredMcpTools = null})`** → `{ok, problems:[{severity:"error"|"warning", key, message}]}`: `defaultModel`/`reviewModel`/alias targets not in `catalog` (catalog rows `{id, efforts}`) → error; efforts not supported by the resolved model → error; `defaultNetwork:true` with `defaultSandbox:"read-only"` → warning; any `mcp__codex__` mention in `docs` while `registeredMcpTools` is null or empty → warning (FR-27 extends this per tool). `ok` is false when any error exists.

## Implementation guide

- Pure module apart from the state API and file reads. The companion keeps working unchanged in this lane; `m4-config` switches it over.
- Read `readRuntimeDefaults`, `resolveTaskRuntime`, `CLEAR_DEFAULT_VALUES`, `DEFAULT_ENV`, `parseBooleanSetting` and `handleSetup` in the companion to match existing names, env vars and parsing exactly.

## Fake-Codex fixture

The fixture API from lane `m0-fixture` (plan D2), in short: `installFakeCodex(binDir, behavior, options)`; `setFakeCodexOptions(binDir, patch)`; `options.turnScript` steps (`command`, `fileChange` with `writeFiles`, `agentMessage`, `reasoning`, `plan`, `diff`, `usage`, `delay`, `silence`, `serverRequest`); `options.interrupt: "cooperate"|"ignore"|"ack-only"`; `options.ignoreSigterm`; `options.delays.{initialize,threadStart,turnStart}`; `options.models`, `options.config`, `options.writeRollout`, `options.forceActiveWriter`, `options.turnStatus`; methods `model/list`, `config/read`, `thread/read`; `readFakeRpcLog(binDir, {method, conn, dir})`, `fakeConnections(binDir)`; `occupyBroker(endpoint, {holdMs})`; `startFakeAppServer(binDir)`; helpers `spawnStubborn()`, `waitFor()`, `isPidAlive()`, `makeCompanionWorkspace()`. M0/M1 lanes extended it further, so **read the fixture source for the exact signatures** before writing tests. Note: the fixture answers `thread/unload`, but the real codex-cli 0.157 app-server does **not** have it (probe §6), so plugin code must never call it.

**You do not own the fixture files in this wave** (lane `m4-effective` does). Do not edit `tests/fake-codex-fixture.mjs` or `tests/helpers.mjs`. If you need something the fixture lacks, write a small local helper inside your own test file, or record the gap as a follow-up.

## Tests to write first

`tests/config-lib.test.mjs`:
1. Precedence table: one test per tier proving it beats the next.
2. `--profile readonly` flag beats a global `defaultSandbox:"danger-full-access"`; `defaultProfile:"bypass"` config sits below global keys; a custom profile works; unknown → exitCode 2.
3. Repo layer: `.codex-companion.json` `defaultModel` → source `repo` with its path; invalid JSON → error naming the file.
4. `explainConfig` rows carry paths; codex-config rows carry the `config/read` origin file.
5. `setConfigValue` to each scope and `unsetConfigValue`; invalid enum value → error.
6. `doctorConfig`: unknown `defaultModel` → error naming the key; read-only + network → warning; `mcp__codex__codex` mentioned with no server → warning.

## Requirements from the report (verbatim)

The text below is copied verbatim from `docs/IMPROVEMENT-REPORT.md`. Line numbers in it predate M0/M1. The "Probe adjustments" and "Design decisions" sections of this brief override it where they differ.

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

## Probe adjustments and scope narrowing (binding; they override the verbatim text above)

- **codex-config tier (probe §2/§3):** an omitted sandbox inherits `config.toml`, and `config/read` returns `config` plus `origins` (dotted key → `{name:{type, file, profile}}`) and optional `layers`. Use `origins` for the codex-config `path`.
- **Built-in defaults that differ from the §8.4 example** (scope narrowing): §8.4 is an example file, not the defaults table. `defaultLaunch` defaults to `foreground` (today's behaviour; switching every bare `task` to `--attach` is left to the user/rescue docs) and `defaultResume` defaults to `ask` (today's rescue behaviour); `defaultPreamble` defaults to `builtin:delegated-worker` as decided in lane `m4-lane`.

## Acceptance checklist (report PASS/FAIL per line)

- [ ] Every §8.4 key (and every key added by M0-M3) is in the schema with type, allowed values, default and scopes
- [ ] Precedence flag > inherited > env > workspace > repo > global > profile > codex-config > built-in holds, with the flag-selected-profile rule
- [ ] Built-in `bypass`, `write`, `readonly` profiles and user-defined profiles expand into the existing keys
- [ ] The repo layer (`.codex-companion.json`) is read, with source `repo` and its path
- [ ] `explainConfig` returns `{key, value, source, path}` rows
- [ ] `doctorConfig` fails (and names the key) when `defaultModel` is not in the catalog, and warns on conflicts and on `mcp__codex__` mentions without a server
- [ ] `npm test` green in your worktree; no existing test edited except where this brief allows it

## Required final report (your last message; use exactly these sections)

```
## Lane m4-config-lib report
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
