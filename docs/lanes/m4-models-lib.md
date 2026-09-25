# Lane `m4-models-lib`: Model catalog, alias resolution and effort validation library (FR-12, BUG-9)

- **Beads:** `codex-plugin-cc-wn9.1`, `codex-plugin-cc-wn9.2`
- **Report items:** FR-12, BUG-9. **Scope in this lane:** the **library halves** of FR-12 and BUG-9: `lib/models.mjs` (catalog fetch with cache and fallbacks, alias and phrase resolution, suggestions, effort validation) with unit tests. The `models` subcommand, flag validation in `task`/`send`/`setup`/reviews and the doc fixes are lane `m4-models` (wave 2).
- **Milestone / wave:** M4, wave 1. **Depends on:** all of M3 merged. **Runs concurrently with:** `m4-lane-lib`, `m4-config-lib`, `m4-effective`.

## Goal

The plugin cannot list, alias or validate models: a wrong name fails late inside a background worker, the one built-in alias points at a model this host does not have, and the effort list is hard-coded and wrong (`max`/`ultra` rejected, `none`/`minimal` accepted). Build the pure resolution layer from the real `model/list` catalog, with deterministic handling of ambiguous phrases like "luna 6".

## Ground rules (non-negotiable)

- **Worktree:** you work in your **own git worktree**, created by the orchestrator from branch `orvex/improvement-report` after the previous wave was merged (normally `/home/crew/workspace/codex-plugin-cc-lanes/m4-models-lib` on branch `lane/m4-models-lib`; use the path you were given). Paths below are relative to your worktree root, and `plugins/codex/scripts/` holds the runtime. The other lanes of your wave run at the same time in their own worktrees, and the orchestrator merges every lane of the wave afterwards. **File ownership is what keeps those merges conflict-free**, so respect it exactly.
- **Beads:** run `bd` from the main checkout: `cd /home/crew/workspace/codex-plugin-cc && bd update <id> --claim` for each bead listed above. If a bead is already claimed (another lane of the same item claimed it), skip the claim and still add your note. At the end, run `bd note <id> "<one paragraph: lane m4-models-lib; what changed, tests added, npm test result, open risks>"` for each bead. **Never** run `bd close`: the orchestrator closes beads after review.
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

- `plugins/codex/scripts/lib/models.mjs` (new)
- `tests/models-lib.test.mjs` (new)

## Do not touch

- Lane `m4-lane-lib` runs at the same time and owns: `plugins/codex/scripts/lib/lane-config.mjs`, `plugins/codex/prompts/delegated-worker.md`, `tests/lane-config.test.mjs`.
- Lane `m4-config-lib` runs at the same time and owns: `plugins/codex/scripts/lib/config.mjs`, `tests/config-lib.test.mjs`.
- Lane `m4-effective` runs at the same time and owns: `plugins/codex/scripts/lib/codex.mjs`, `plugins/codex/scripts/lib/tracked-jobs.mjs`, `plugins/codex/scripts/lib/render.mjs`, `tests/fake-codex-fixture.mjs`, `tests/helpers.mjs`, `tests/effective-runtime.test.mjs`.
- Any existing test file not listed under "Files you own" (add your tests in your own new test files).

## Design decisions binding on this lane

- **Catalog shape (normalised, binding):** `{id, model, displayName, hidden, isDefault, efforts:[string], defaultEffort, upgrade}` from `model/list` rows (`supportedReasoningEfforts[].reasoningEffort`, `defaultReasoningEffort`).
- **`fetchModelCatalog({listModels, codexVersion, cacheFile, ttlMs = 3600000, refresh = false, now, fallbacks:{runDebugModels, cacheJsonFile}})`** → `{models, source:"app-server"|"cache"|"codex-debug-models"|"models-cache-json"|"unavailable", fetchedAt, warnings}`. `listModels(params)` is an injected async function that performs one `model/list` request; loop over `nextCursor` with `{limit:100, cursor}` until null. Cache in `cacheFile` as `{codexVersion, fetchedAt, models}`; a cache entry is valid only for the same `codexVersion` and within `ttlMs` unless `refresh`. Fallback order when the app-server call fails: `runDebugModels()` (injected; returns the stdout of `codex debug models`), then `cacheJsonFile` (`~/.codex/models_cache.json`, read-only). You may run `codex debug models` and read `~/.codex/models_cache.json` **read-only** once to learn their JSON shapes (the report says the cache uses `supported_reasoning_levels`); write synthetic fixtures for the tests.
- **`resolveModel(input, {catalog, aliases = {}, builtinAliases = BUILTIN_MODEL_ALIASES})`** → `{ok:true, id, requestedModel: input, via:"alias"|"exact"|"case-insensitive"|"passthrough", warning?}` or `{ok:false, code:"unknown-model"|"ambiguous-model", message, suggestions}`. Order: user alias → built-in alias (only if its target is in the catalog) → exact id → case-insensitive id or `displayName` → **phrase match**: tokenise input and ids on `-`, `.`, spaces and letter/digit boundaries (`gpt-5.6-luna` → gpt, 5, 6, luna); candidates are ids containing every input token; exactly one → ok (`via:"phrase"`), several → `ambiguous-model` listing them (so "luna 6" matches both `gpt-6-luna` and `gpt-5.6-luna`). Unknown → `unknown model X; did you mean Y, Z` with up to 3 suggestions ranked by shared tokens then Levenshtein distance. `catalog` null (unavailable) → `{ok:true, id: input, via:"passthrough", warning:"model catalog unavailable; passing X through unchanged"}`.
- **`BUILTIN_MODEL_ALIASES`** starts as `{spark: "gpt-5.3-codex-spark"}`; `visibleBuiltinAliases(catalog)` → `{aliases, hidden:[{alias, target, warning}]}` hides aliases whose target is missing.
- **`validateEffort(effort, {modelId, catalog, defaultModelId})`** → `{ok:true}` or `{ok:false, message, validEfforts}`; with `modelId` null use `defaultModelId` (the config.toml model, supplied by the caller) else the catalog's `isDefault` model; catalog unavailable → `{ok:true, warning}`. Efforts are case-sensitive lower-case.
- **`describeModel(model)`** helper for rendering (`id  displayName  default  efforts: low,medium,…`).

## Implementation guide

- No app-server or state imports: every I/O function is injected. `m4-models` wires `listModels` to `client.request("model/list", params)` and `cacheFile` to `<stateRoot>/models-cache.json`.

## Fake-Codex fixture

The fixture API from lane `m0-fixture` (plan D2), in short: `installFakeCodex(binDir, behavior, options)`; `setFakeCodexOptions(binDir, patch)`; `options.turnScript` steps (`command`, `fileChange` with `writeFiles`, `agentMessage`, `reasoning`, `plan`, `diff`, `usage`, `delay`, `silence`, `serverRequest`); `options.interrupt: "cooperate"|"ignore"|"ack-only"`; `options.ignoreSigterm`; `options.delays.{initialize,threadStart,turnStart}`; `options.models`, `options.config`, `options.writeRollout`, `options.forceActiveWriter`, `options.turnStatus`; methods `model/list`, `config/read`, `thread/read`; `readFakeRpcLog(binDir, {method, conn, dir})`, `fakeConnections(binDir)`; `occupyBroker(endpoint, {holdMs})`; `startFakeAppServer(binDir)`; helpers `spawnStubborn()`, `waitFor()`, `isPidAlive()`, `makeCompanionWorkspace()`. M0/M1 lanes extended it further, so **read the fixture source for the exact signatures** before writing tests. Note: the fixture answers `thread/unload`, but the real codex-cli 0.157 app-server does **not** have it (probe §6), so plugin code must never call it.

**You do not own the fixture files in this wave** (lane `m4-effective` does). Do not edit `tests/fake-codex-fixture.mjs` or `tests/helpers.mjs`. If you need something the fixture lacks, write a small local helper inside your own test file, or record the gap as a follow-up.

## Tests to write first

`tests/models-lib.test.mjs` (catalog built from the probe's `model/list` rows, trimmed to `gpt-6-luna`, `gpt-5.6-luna`, `gpt-5.6-terra`, plus a variant with `gpt-6-astra` default):
1. `gpt-7-luna` → `unknown-model`, suggestions include `gpt-6-luna` and `gpt-5.6-luna`.
2. `"luna 6"` → `ambiguous-model` listing both luna ids.
3. Alias `luna=gpt-5.6-luna` → `gpt-5.6-luna`, `requestedModel:"luna"`.
4. `spark` with a catalog lacking `gpt-5.3-codex-spark` → not resolved; `visibleBuiltinAliases` hides it with a warning.
5. `GPT-6-LUNA` → case-insensitive match.
6. Pagination: an injected `listModels` returning two pages is fully consumed.
7. Cache: a second call within TTL does not call `listModels`; a different `codexVersion` or `refresh` does.
8. Fallbacks: `listModels` throws → `runDebugModels` output used; that throws too → `models_cache.json` shape used; all fail → `source:"unavailable"` and passthrough resolution with a warning.
9. `validateEffort`: `max` ok for `gpt-6-luna`; `ultra` rejected for `gpt-6-luna` with the valid list; `minimal` rejected everywhere; default-model path.

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

- Use the real `model/list` response shape from probe §1: `data[]` plus nullable `nextCursor` (cursor-paginated); each row has `id`, `model`, `displayName`, `hidden`, `supportedReasoningEfforts[{reasoningEffort, description}]`, `defaultReasoningEffort`, `isDefault`, `upgrade`/`upgradeInfo`.
- Probe §1 on this host: `gpt-6-astra` is the catalog default (`isDefault:true`); `gpt-6-luna` and `gpt-5.6-luna` support up to `max`; `ultra` exists for `gpt-6-astra`, `gpt-6-sol`, `gpt-5.6-sol`, `gpt-5.6-terra`; `gpt-5.5` stops at `xhigh`. No model supports `none` or `minimal`. Do not hard-code these facts in the library; they belong in test fixtures.

## Acceptance checklist (report PASS/FAIL per line)

- [ ] With a catalog of `[gpt-6-luna, gpt-5.6-luna, gpt-5.6-terra]`: `gpt-7-luna` is unknown and suggests `gpt-6-luna` and `gpt-5.6-luna` (library level)
- [ ] `"luna 6"` is an ambiguity error listing both luna ids
- [ ] The alias `luna=gpt-5.6-luna` resolves to `gpt-5.6-luna`
- [ ] `spark` against a catalog without `gpt-5.3-codex-spark` does not resolve, and the built-in alias is hidden with a warning
- [ ] BUG-9: effort validation uses the target model's `supportedReasoningEfforts`; unavailable catalog → accept with a warning
- [ ] Catalog fetch paginates, caches for 1h keyed by codex version, and falls back to `codex debug models`, then `models_cache.json`
- [ ] `npm test` green in your worktree; no existing test edited except where this brief allows it

## Required final report (your last message; use exactly these sections)

```
## Lane m4-models-lib report
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
