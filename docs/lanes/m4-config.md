# Lane `m4-config`: Profiles, new persistent defaults, `config show|set|unset|doctor`, repo config file and `--print-claude-md` (FR-14, FR-15)

- **Beads:** `codex-plugin-cc-wn9.5`, `codex-plugin-cc-wn9.6`
- **Report items:** FR-14, FR-15. **Scope in this lane:** the **wiring halves** of FR-14 and FR-15 on top of `lib/config.mjs`, plus the setup flags that earlier lanes deferred to FR-14 (`--session-end-policy`, `--notify-via`, and every other key those lanes read directly).
- **Milestone / wave:** M4, wave 4. **Depends on:** wave 3 (`m4-lane` merged). **Runs concurrently with:** none (runs alone).

## Goal

Make every default persistent, sourced and inspectable: one resolver for all keys, named permission profiles including `bypass`, a checked-in `.codex-companion.json`, `config show|set|unset|doctor`, a resume policy that stops the rescue command from asking questions, and a generated CLAUDE.md delegation block that only names things that exist.

## Ground rules (non-negotiable)

- **Worktree:** you work in your **own git worktree**, created by the orchestrator from branch `orvex/improvement-report` after the previous wave was merged (normally `/home/crew/workspace/codex-plugin-cc-lanes/m4-config` on branch `lane/m4-config`; use the path you were given). Paths below are relative to your worktree root, and `plugins/codex/scripts/` holds the runtime. The other lanes of your wave run at the same time in their own worktrees, and the orchestrator merges every lane of the wave afterwards. **File ownership is what keeps those merges conflict-free**, so respect it exactly.
- **Beads:** run `bd` from the main checkout: `cd /home/crew/workspace/codex-plugin-cc && bd update <id> --claim` for each bead listed above. If a bead is already claimed (another lane of the same item claimed it), skip the claim and still add your note. At the end, run `bd note <id> "<one paragraph: lane m4-config; what changed, tests added, npm test result, open risks>"` for each bead. **Never** run `bd close`: the orchestrator closes beads after review.
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
- `plugins/codex/scripts/lib/config.mjs`
- `plugins/codex/scripts/lib/state.mjs`
- `plugins/codex/scripts/lib/render.mjs`
- `plugins/codex/scripts/lib/claude-md.mjs` (new)
- `plugins/codex/scripts/stop-review-gate-hook.mjs`
- `plugins/codex/commands/rescue.md`
- `plugins/codex/commands/setup.md`
- `plugins/codex/skills/codex-drive/SKILL.md`
- `README.md`
- `tests/fake-codex-fixture.mjs`
- `tests/helpers.mjs`
- `tests/config.test.mjs` (new)
- `tests/claude-md.test.mjs` (new)

## Do not touch

- No lane runs concurrently with you in this wave.
- Any existing test file not listed under "Files you own" (add your tests in your own new test files).

## Design decisions binding on this lane

- **Switch the companion to `lib/config.mjs`:** replace `readRuntimeDefaults` and the tier logic in `resolveTaskRuntime` with `resolveConfig`, keeping FR-25 exactly (the built-in tier is the `bypass` profile, source `built-in:bypass`, with the unowned-background fallback to `workspace-write`) and BUG-5 (codex-config tier, nothing sent when unset). Every key other lanes read ad hoc (`getConfig(...).x ?? getGlobalConfig(...).x`) moves to the resolver; grep for them.
- **Profiles:** `task|send|fork --profile <name>`, env `CODEX_COMPANION_PROFILE`, `setup --default-profile <name|none> [--global]`, `setup --profile <name> [--global]` (writes the profile's bundle of keys and prints a visible warning for `bypass`: `Bypass profile: danger-full-access, network on, approval never. Jobs can modify anything this user can.`). Status and the launch line show `profile <name>`.
- **New keys with setup flags** (`setup --<kebab-key> <value|none> [--global]`, validated by `CONFIG_KEYS`): `defaultResume fresh|last|ask`, `defaultLaunch attach|background|foreground`, `defaultIsolation none|worktree` (stored and shown; enforcement arrives with FR-6 in M6 — say so in `--help`), `defaultExpectChanges`, `sendAckTimeoutMs`, `waitTimeoutMs`, `sessionEndPolicy`, `onOwnerExit`, `defaultMaxRuntime`, `defaultIdleTimeout`, `defaultPreamble`, `developerInstructions`, `codexConfigOverrides` (JSON), `modelAliases` (via `--alias`), `reviewModel`, `reviewEffort`, `stopRunningJobs`, `notifyVia`, `reviewPersist`, `idleNudgeMs`, `permissionProfiles` (JSON). `defaultLaunch` applies to a bare `task` with none of `--attach/--background/--detach`. `sendAckTimeoutMs` drives `send`'s ack wait; `waitTimeoutMs` drives `wait`'s default timeout.
- **`task-resume-candidate --json`** returns `defaultResume`; `commands/rescue.md` and the drive skill use it: `fresh` → never ask, start fresh; `last` → resume the last thread without asking; `ask` → today's AskUserQuestion flow. AskUserQuestion is never called unless the policy is `ask`.
- **Effective-runtime echo:** every task output (text launch line and `--json` `launch`) includes each runtime value with its source (`sandbox=… (source) network=… model=… (source) effort=… (source) profile=…`).
- **`config show [--json]`** (`explainConfig` rows, including the codex-config layer read with `config/read` and its origin path), **`config set <key> <value> [--global|--repo]`**, **`config unset <key> [--global|--repo]`**, **`config doctor [--json]`** (`doctorConfig` with the catalog from `lib/models.mjs`, aliases, and the workspace's `CLAUDE.md`/`AGENTS.md` texts; exit 1 when any error). The repo layer file is `<repo root>/.codex-companion.json`.
- **`setup --json`** reports each value with its source (and path).
- **`setup --print-claude-md`** via new `lib/claude-md.mjs`: `generateClaudeMdBlock({scriptPath, shimInstalled, subcommands, mcpTools = null, aliases})` returns a delegation block built **only** from the companion's real subcommand list (export it from the companion's usage table or a shared constant; do not hard-code a second list) and, when `mcpTools` is given, tool names (FR-27 in M5 passes them). Model guidance uses configured aliases, never hard-coded ids. A doc-consistency test checks every subcommand and flag the block mentions against `--help`.
- **Stop gate:** keep `--read-only --no-network` (BUG-8); if the resolver changes how flags are passed, keep the gate's argv test passing.

## Implementation guide

- `codex-companion.mjs`: `readRuntimeDefaults`, `resolveTaskRuntime`, `DEFAULT_ENV`, `CLEAR_DEFAULT_VALUES`, `handleSetup`, `buildSetupReport`, `handleTask`, `handleSend`, `handleWait`, `handleTaskResumeCandidate`, `printUsage`, `main` (`config` case).
- `lib/state.mjs`: only if `setConfig`/`getConfig` need a small extension (e.g. unset); keep the lock semantics.
- `lib/render.mjs`: `renderSetupReport`, `formatRuntime`.

## Fake-Codex fixture

The fixture API from lane `m0-fixture` (plan D2), in short: `installFakeCodex(binDir, behavior, options)`; `setFakeCodexOptions(binDir, patch)`; `options.turnScript` steps (`command`, `fileChange` with `writeFiles`, `agentMessage`, `reasoning`, `plan`, `diff`, `usage`, `delay`, `silence`, `serverRequest`); `options.interrupt: "cooperate"|"ignore"|"ack-only"`; `options.ignoreSigterm`; `options.delays.{initialize,threadStart,turnStart}`; `options.models`, `options.config`, `options.writeRollout`, `options.forceActiveWriter`, `options.turnStatus`; methods `model/list`, `config/read`, `thread/read`; `readFakeRpcLog(binDir, {method, conn, dir})`, `fakeConnections(binDir)`; `occupyBroker(endpoint, {holdMs})`; `startFakeAppServer(binDir)`; helpers `spawnStubborn()`, `waitFor()`, `isPidAlive()`, `makeCompanionWorkspace()`. M0/M1 lanes extended it further, so **read the fixture source for the exact signatures** before writing tests. Note: the fixture answers `thread/unload`, but the real codex-cli 0.157 app-server does **not** have it (probe §6), so plugin code must never call it.

**You own the fixture files in this wave.** If you need a capability that is missing, add it **additively** (new options, new turnScript step types, new helpers) and keep every existing behaviour string and option working. Where the fixture's shapes differ from `docs/app-server-probe.md` ("Fixture shapes"), make the fixture match the probe for the methods you touch.

## Tests to write first

`tests/config.test.mjs`:
1. After `setup --global --default-profile bypass`, a bare `task --attach "x"` records `thread/start` with `danger-full-access`, network access, and a fresh thread; status shows `profile bypass`.
2. `task --profile readonly "x"` overrides it once (read-only on the wire); the next bare task is bypass again.
3. With `defaultResume=fresh`, `task-resume-candidate --json` reports it and the rescue command body instructs no AskUserQuestion (assert on `commands/rescue.md` text and the JSON).
4. With `sendAckTimeoutMs=60000`, `send` waits 60s (assert the computed timeout via `--json` output or a debug field; do not really wait 60s).
5. `setup --json` reports each value with its source.
6. A repo whose `.codex-companion.json` sets `defaultModel` runs tasks on that model, with source `repo`.
7. `config show --json` returns paths; `config set defaultEffort high --repo` writes the repo file; `config unset` removes it.
8. `config doctor` exits non-zero and names the key when `defaultModel` is not in the catalog.
9. FR-25 regression: empty config + config.toml without sandbox → bypass with `source=built-in:bypass`; unowned `--background` → `workspace-write`; reviews and the stop gate still read-only.
`tests/claude-md.test.mjs`:
10. `setup --print-claude-md` output references only real subcommands and flags (checked against `--help`), and uses aliases for model guidance.

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

- codex-config tier and `config/read` origins as in probe §2/§3 (the `path` of codex-config rows comes from `origins`).
- **Scope narrowing:** `defaultIsolation` is stored and reported here but only takes effect once FR-6 lands (M6, `m6-isolation`). `defaultLaunch` defaults to `foreground` (today's behaviour) rather than the §8.4 example value `attach`, to avoid silently changing every bare `task`; users opt in with `setup --default-launch attach`.

## Acceptance checklist (report PASS/FAIL per line)

- [ ] FR-14: after `setup --global --default-profile bypass`, a bare `task "x"` records a thread/start with `danger-full-access`, network access, and a fresh thread, and status shows `profile bypass`
- [ ] FR-14: `task --profile readonly` overrides it once
- [ ] FR-14: with `defaultResume=fresh`, rescue never calls AskUserQuestion
- [ ] FR-14: with `sendAckTimeoutMs=60000`, `send` waits 60s
- [ ] FR-14: `setup --json` reports each value with its source; every task output echoes the effective runtime and its sources
- [ ] FR-15: a repo whose `.codex-companion.json` sets `defaultModel` runs tasks on that model, with source `repo`
- [ ] FR-15: `config show --json` returns paths
- [ ] FR-15: `config doctor` exits non-zero and names the key when `defaultModel` is not in the catalog
- [ ] FR-15: the `--print-claude-md` output references only real subcommands and tools; a doc-consistency test checks this
- [ ] The deferred setup flags from earlier lanes (`--session-end-policy`, `--notify-via`, …) exist
- [ ] `npm test` green in your worktree; no existing test edited except where this brief allows it

## Required final report (your last message; use exactly these sections)

```
## Lane m4-config report
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
