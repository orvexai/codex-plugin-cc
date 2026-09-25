# Lane `m4-models`: `models` subcommand, aliases, model and effort validation, and model-name doc fixes (FR-12, BUG-9)

- **Beads:** `codex-plugin-cc-wn9.1`, `codex-plugin-cc-wn9.2`
- **Report items:** FR-12, BUG-9. **Scope in this lane:** the **CLI and docs halves** of FR-12 and BUG-9 on top of `lib/models.mjs`. The MCP tool `codex_models` is lane `m5-mcp`.
- **Milestone / wave:** M4, wave 2. **Depends on:** wave 1 (`m4-models-lib`, `m4-lane-lib`, `m4-config-lib`, `m4-effective` merged). **Runs concurrently with:** none (runs alone).

## Goal

Make model choice informed and fail-fast: list the real catalog, resolve user aliases and phrases deterministically, reject unknown or ambiguous models and unsupported efforts **before** any job exists, show which model runs when none is requested, and remove hard-coded ids and effort lists from the docs.

## Ground rules (non-negotiable)

- **Worktree:** you work in your **own git worktree**, created by the orchestrator from branch `orvex/improvement-report` after the previous wave was merged (normally `/home/crew/workspace/codex-plugin-cc-lanes/m4-models` on branch `lane/m4-models`; use the path you were given). Paths below are relative to your worktree root, and `plugins/codex/scripts/` holds the runtime. The other lanes of your wave run at the same time in their own worktrees, and the orchestrator merges every lane of the wave afterwards. **File ownership is what keeps those merges conflict-free**, so respect it exactly.
- **Beads:** run `bd` from the main checkout: `cd /home/crew/workspace/codex-plugin-cc && bd update <id> --claim` for each bead listed above. If a bead is already claimed (another lane of the same item claimed it), skip the claim and still add your note. At the end, run `bd note <id> "<one paragraph: lane m4-models; what changed, tests added, npm test result, open risks>"` for each bead. **Never** run `bd close`: the orchestrator closes beads after review.
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
- `plugins/codex/scripts/lib/models.mjs`
- `plugins/codex/scripts/lib/render.mjs`
- `plugins/codex/commands/models.md` (new)
- `plugins/codex/commands/rescue.md`
- `plugins/codex/agents/codex-rescue.md`
- `plugins/codex/skills/codex-cli-runtime/SKILL.md`
- `plugins/codex/skills/codex-drive/SKILL.md`
- `README.md`
- `tests/commands.test.mjs` (only the command-file list, new assertions for `models.md`, and any assertion that pins the old effort list or `gpt-5.4-mini`)
- `tests/fake-codex-fixture.mjs`
- `tests/helpers.mjs`
- `tests/models.test.mjs` (new)

## Do not touch

- No lane runs concurrently with you in this wave.
- Any existing test file not listed under "Files you own" (add your tests in your own new test files).

## Design decisions binding on this lane

- **`models [--json] [--all] [--refresh]`:** `fetchModelCatalog` with `listModels` = `client.request("model/list", params)` over `withAppServer` (broker or direct; busy fallback allowed), `cacheFile` = `<state root>/models-cache.json`, `codexVersion` from `getCodexAvailability`, fallbacks `codex debug models` (spawned with the plugin's codex binary resolution, 10s timeout) and `$CODEX_HOME/models_cache.json` (read-only). `--all` includes hidden models. Output: id, display name, default marker, efforts, default effort, plus a line `Model used when none is requested: <config.toml model> (codex config.toml)` or `<isDefault model> (catalog default)`, read from `config/read`. `--json` → `{schemaVersion:2, source, fetchedAt, models:[…], aliases:{…}, hiddenAliases:[…], defaultModel:{id, source}}`.
- **Aliases:** config key `modelAliases` (workspace and global now; the repo layer arrives with `m4-config`), `setup --alias <name>=<id> [--global]` (validated against the catalog), `setup --alias <name>=none` removes. Replace `MODEL_ALIASES` in the companion with `BUILTIN_MODEL_ALIASES` from the library (hidden when the target is missing).
- **Validation everywhere** — `task`, `send` (runtime overrides and follow-ups), `fork`, `setup --default-model`, `setup --default-review-model`, `review`, `adversarial-review`: resolve with `resolveModel` **before** creating any job record or worker; `unknown-model`/`ambiguous-model` → message on stderr (`unknown model X; did you mean Y, Z` / the ambiguity list), exit 2, JSON `error.code`. Record `runtime.requested.requestedModel` (the alias or phrase) and `model` (the resolved id). Only call the catalog when a model or effort is actually given (cached 1h), so bare launches stay fast.
- **BUG-9 effort:** delete `VALID_REASONING_EFFORTS`; `normalizeReasoningEffort` accepts any lower-case string syntactically, then `validateEffort` checks it against the target model (requested, else the config.toml model from `config/read`, else the catalog default) for `task`, `send` follow-ups, `setup --default-effort` (validated against the default model) and the review commands. Unsupported → exit 2 listing the valid values, before a worker spawns. Catalog unavailable → accept with a warning.
- **Docs:** `/codex:models` (`commands/models.md`, model-invocable); `commands/rescue.md` argument-hint and body say efforts are model-dependent and point to `models`; `skills/codex-cli-runtime/SKILL.md` removes the hard-coded effort list (line ~36) and the `gpt-5.4-mini` example; `agents/codex-rescue.md` and `README.md` replace `gpt-5.4-mini` with a real id from the catalog (e.g. `gpt-6-luna`) and explain aliases; the drive skill gets a `models` row. Update the command-list assertion.

## Implementation guide

- `codex-companion.mjs`: `MODEL_ALIASES`, `normalizeRequestedModel`, `VALID_REASONING_EFFORTS`, `normalizeReasoningEffort`, `handleTask`, `handleSend`, `handleSetup`, `handleReviewCommand`, `buildSetupReport`, `printUsage`, `main` (`models` case), and the `fork` handler from M3.

## Fake-Codex fixture

The fixture API from lane `m0-fixture` (plan D2), in short: `installFakeCodex(binDir, behavior, options)`; `setFakeCodexOptions(binDir, patch)`; `options.turnScript` steps (`command`, `fileChange` with `writeFiles`, `agentMessage`, `reasoning`, `plan`, `diff`, `usage`, `delay`, `silence`, `serverRequest`); `options.interrupt: "cooperate"|"ignore"|"ack-only"`; `options.ignoreSigterm`; `options.delays.{initialize,threadStart,turnStart}`; `options.models`, `options.config`, `options.writeRollout`, `options.forceActiveWriter`, `options.turnStatus`; methods `model/list`, `config/read`, `thread/read`; `readFakeRpcLog(binDir, {method, conn, dir})`, `fakeConnections(binDir)`; `occupyBroker(endpoint, {holdMs})`; `startFakeAppServer(binDir)`; helpers `spawnStubborn()`, `waitFor()`, `isPidAlive()`, `makeCompanionWorkspace()`. M0/M1 lanes extended it further, so **read the fixture source for the exact signatures** before writing tests. Note: the fixture answers `thread/unload`, but the real codex-cli 0.157 app-server does **not** have it (probe §6), so plugin code must never call it.

**You own the fixture files in this wave.** If you need a capability that is missing, add it **additively** (new options, new turnScript step types, new helpers) and keep every existing behaviour string and option working. Where the fixture's shapes differ from `docs/app-server-probe.md` ("Fixture shapes"), make the fixture match the probe for the methods you touch.

Teach the fake `codex` binary `codex debug models` (prints `options.debugModels` as JSON, in the shape you observed from the real command) and add `options.appServerUnavailable: true` that makes `codex app-server` exit immediately with an error (to test the fallback). Make `model/list` honour `limit`/`cursor` pagination when `options.modelsPageSize` is set.

## Tests to write first

`tests/models.test.mjs` (fake `model/list` = `[gpt-6-luna, gpt-5.6-luna, gpt-5.6-terra]` with probe-shaped rows):
1. `task --model gpt-7-luna 'x'` exits 2, suggests `gpt-6-luna` and `gpt-5.6-luna`, and creates no job record (state index and `jobs/` unchanged).
2. `task --model "luna 6" 'x'` exits 2 with an ambiguity error listing both luna ids.
3. `setup --alias luna=gpt-5.6-luna` then `task --model luna 'x'` → `thread/start` has `model:"gpt-5.6-luna"`, job records `requestedModel:"luna"`.
4. `task --model spark --background 'x'` fails before a worker spawns (no worker pid, no job).
5. `models --json` lists ids with `isDefault` and efforts, and the "used when none is requested" model; with `appServerUnavailable`, `models` falls back to `codex debug models` output.
6. BUG-9: `task --effort max` accepted for `gpt-6-luna`; `--effort ultra --model gpt-6-luna` exits 2 listing valid efforts, before a worker spawns; `setup --default-effort max` succeeds.
7. Doc checks: no `gpt-5.4-mini` and no hard-coded `none|minimal|low|medium|high|xhigh` list remain in `commands/`, `agents/`, `skills/` or `README.md`; `models.md` is model-invocable.

## Requirements from the report (verbatim)

The text below is copied verbatim from `docs/IMPROVEMENT-REPORT.md`. Line numbers in it predate M0/M1. The "Probe adjustments" and "Design decisions" sections of this brief override it where they differ.

### FR-12: A `models` subcommand, user aliases and model validation
- **Priority:** P1
- **Problem:** The only alias is `spark → gpt-5.3-codex-spark`, and that target is **not** in the local catalog, so the one built-in alias points at a model this host cannot run. `normalizeRequestedModel` passes anything else through, so a wrong name fails late inside the worker. There is no `model/list` call anywhere. The docs and the rescue agent use `gpt-5.4-mini` as an example (`agents/codex-rescue.md` 32, README.md 158), which is not in the catalog either, and the prompting skill is named after GPT-5.4. **Naming, verified against the local catalog:** `gpt-6-luna` (README.md 56, 115, 226; also the `model` in the user's `~/.codex/config.toml`) and `gpt-5.6-luna` (the consuming repo's CLAUDE.md) are **both real, distinct models**. Neither side is wrong. The user's "Luna 6" most plausibly means `gpt-6-luna`, but it also matches `gpt-5.6-luna`, so a phrase resolver must treat it as ambiguous rather than silently pick one. Re-check with `model/list` at implementation time, because the catalog changes.
- **Evidence:** E5. `codex-companion.mjs` `MODEL_ALIASES` ~78 and `normalizeRequestedModel` ~262-274. `agents/codex-rescue.md` 29-34. `skills/codex-cli-runtime/SKILL.md` ~22. `README.md` 56, 115, 158 and 226.
- **Proposal:** `models [--json] [--all] [--refresh]` calls app-server `model/list`, caches it for 1h keyed by the codex version under the state root, and returns id, display name, isDefault, supportedReasoningEfforts and defaultEffort. Add a `modelAliases` config key (workspace, repo and global), set with `setup --alias luna=<id>` and removed with `setup --alias luna=none`. `task`, `send`, `setup --default-model` and review commands resolve aliases, then match case-insensitively, then validate against the catalog. An unknown model fails **before** any job record or worker is created with `unknown model X; did you mean Y, Z` (exit 2). A natural phrase such as "luna 6" that matches several ids returns an ambiguity error listing them. If the app-server is unreachable, fall back to `codex debug models` (renders the raw catalog as JSON without an app-server) or `~/.codex/models_cache.json`; if all fail, warn and pass the name through. Record both `requestedModel` (the alias) and `model` (the resolved id). When no model is requested, `models` and the setup report show which model will actually run (the config.toml `model`, e.g. `gpt-6-luna`), so "leave model unset" is an informed choice. Add a `/codex:models` command and the MCP tool `codex_models`. Replace the `gpt-5.4-mini` examples with real ids, and drop or re-verify the `spark` alias (validate every built-in alias against the catalog at load; a built-in alias whose target is missing is hidden with a warning).
- **Acceptance criteria:** With a fake `model/list` of `[gpt-6-luna, gpt-5.6-luna, gpt-5.6-terra]`: `--model gpt-7-luna` exits 2, suggests `gpt-6-luna` and `gpt-5.6-luna`, and creates no job record. `--model "luna 6"` exits 2 with an ambiguity error listing both luna ids. With the alias `luna=gpt-5.6-luna` configured, `--model luna` resolves to `gpt-5.6-luna`. `--model spark` against a catalog without `gpt-5.3-codex-spark` fails before a worker spawns. `models --json` lists ids with isDefault and efforts. With the app-server fake unavailable, `models` falls back to `codex debug models` output.

### BUG-9: Effort validation rejects real efforts (`max`, `ultra`) and accepts efforts that current models do not support
- **Priority:** P1
- **Problem:** `VALID_REASONING_EFFORTS` is hard-coded to `none|minimal|low|medium|high|xhigh`. The local catalog (`~/.codex/models_cache.json`, codex-cli 0.157.0) confirms that every listed model supports `low|medium|high|xhigh`; all except `gpt-5.5` also support `max`; `gpt-6-astra`, `gpt-6-sol`, `gpt-5.6-sol` and `gpt-5.6-terra` also support `ultra`; and **no** listed model supports `none` or `minimal`. So `--effort max` fails synchronously, while `minimal` passes validation and then fails late inside a background worker. The stale list is repeated in the docs.
- **Evidence:** `codex-companion.mjs` 77 and `normalizeReasoningEffort` ~276-290, usage ~110. `skills/codex-cli-runtime/SKILL.md` 36. `commands/rescue.md` 3 (argument-hint). `~/.codex/models_cache.json` `supported_reasoning_levels`.
- **Proposal:** Validate against the target model's `supportedReasoningEfforts` from `model/list` (cached by FR-12). If the catalog is unavailable, accept any string with a warning. Apply this to `task`, `send` follow-ups and `setup --default-effort`. The docs say efforts are model-dependent and point to `models`.
- **Acceptance criteria:** `task --effort max` is accepted when the fake `model/list` lists `max`. An unsupported effort fails before a worker spawns and lists the valid values. `setup --default-effort max` succeeds. The docs no longer hard-code the list.

## Probe adjustments and scope narrowing (binding; they override the verbatim text above)

- `model/list` shape and pagination from probe §1 (`data`, `nextCursor`). `config/read` (probe §2) gives the config.toml `model` used when none is requested; on this host that is `gpt-6-luna`, while the catalog default is `gpt-6-astra`: show the config.toml value with source `codex config.toml` when present.
- `codex debug models` is a read-only CLI command that renders the catalog without an app-server; you may run it once to learn its output shape.

## Acceptance checklist (report PASS/FAIL per line)

- [ ] With a fake `model/list` of `[gpt-6-luna, gpt-5.6-luna, gpt-5.6-terra]`: `--model gpt-7-luna` exits 2, suggests `gpt-6-luna` and `gpt-5.6-luna`, and creates no job record
- [ ] `--model "luna 6"` exits 2 with an ambiguity error listing both luna ids
- [ ] With the alias `luna=gpt-5.6-luna` configured, `--model luna` resolves to `gpt-5.6-luna`
- [ ] `--model spark` against a catalog without `gpt-5.3-codex-spark` fails before a worker spawns
- [ ] `models --json` lists ids with isDefault and efforts
- [ ] With the app-server fake unavailable, `models` falls back to `codex debug models` output
- [ ] BUG-9: `task --effort max` is accepted when the fake `model/list` lists `max`. An unsupported effort fails before a worker spawns and lists the valid values. `setup --default-effort max` succeeds. The docs no longer hard-code the list
- [ ] `/codex:models` exists; `gpt-5.4-mini` examples are replaced with real ids; `requestedModel` and `model` are both recorded
- [ ] `npm test` green in your worktree; no existing test edited except where this brief allows it

## Required final report (your last message; use exactly these sections)

```
## Lane m4-models report
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
