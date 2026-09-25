# Lane `m4-effective`: Record and render the effective runtime from thread responses (BUG-10)

- **Beads:** `codex-plugin-cc-wn9.3`
- **Report items:** BUG-10. **Scope in this lane:** all of BUG-10.
- **Milestone / wave:** M4, wave 1. **Depends on:** all of M3 merged. **Runs concurrently with:** `m4-models-lib`, `m4-lane-lib`, `m4-config-lib`.

## Goal

`job.runtime` records what the plugin *requested*; when `--model`/`--effort` are absent they are null, so Claude never learns which model actually ran, or what a fork inherited. The real `thread/start` response carries the effective values. Record them on every job, as early as the thread exists, and show them with their source.

## Ground rules (non-negotiable)

- **Worktree:** you work in your **own git worktree**, created by the orchestrator from branch `orvex/improvement-report` after the previous wave was merged (normally `/home/crew/workspace/codex-plugin-cc-lanes/m4-effective` on branch `lane/m4-effective`; use the path you were given). Paths below are relative to your worktree root, and `plugins/codex/scripts/` holds the runtime. The other lanes of your wave run at the same time in their own worktrees, and the orchestrator merges every lane of the wave afterwards. **File ownership is what keeps those merges conflict-free**, so respect it exactly.
- **Beads:** run `bd` from the main checkout: `cd /home/crew/workspace/codex-plugin-cc && bd update <id> --claim` for each bead listed above. If a bead is already claimed (another lane of the same item claimed it), skip the claim and still add your note. At the end, run `bd note <id> "<one paragraph: lane m4-effective; what changed, tests added, npm test result, open risks>"` for each bead. **Never** run `bd close`: the orchestrator closes beads after review.
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

- `plugins/codex/scripts/lib/codex.mjs`
- `plugins/codex/scripts/lib/tracked-jobs.mjs`
- `plugins/codex/scripts/lib/render.mjs`
- `tests/fake-codex-fixture.mjs`
- `tests/helpers.mjs`
- `tests/effective-runtime.test.mjs` (new)

## Do not touch

- Lane `m4-models-lib` runs at the same time and owns: `plugins/codex/scripts/lib/models.mjs`, `tests/models-lib.test.mjs`.
- Lane `m4-lane-lib` runs at the same time and owns: `plugins/codex/scripts/lib/lane-config.mjs`, `plugins/codex/prompts/delegated-worker.md`, `tests/lane-config.test.mjs`.
- Lane `m4-config-lib` runs at the same time and owns: `plugins/codex/scripts/lib/config.mjs`, `tests/config-lib.test.mjs`.
- `codex-companion.mjs` (lane `m4-models` owns it next wave; you should not need it: persist through the progress updater and `runTrackedJob`).
- Any existing test file not listed under "Files you own" (add your tests in your own new test files).

## Design decisions binding on this lane

- **Normalise responses:** `effectiveFromThreadResponse(response)` in `lib/codex.mjs` → `{model, effort: reasoningEffort, sandbox, network, approvalPolicy, cwd, modelProvider}` where `sandbox.type` `readOnly|workspaceWrite|dangerFullAccess` maps to `read-only|workspace-write|danger-full-access`, and `network` = `"unrestricted"` for danger-full-access, `"on"|"off"` from `sandbox.networkAccess` for workspace-write, `"blocked"` for read-only (same vocabulary as BUG-12's `computeEffectiveNetwork`). Apply it to `thread/start`, `thread/resume` and `thread/fork` responses (all three; resume and fork share the shape; verify with the generated types).
- **Persist early:** `runAppServerTurn` emits the effective runtime in the "Thread ready" progress payload and returns it as `effectiveRuntime`. `createJobProgressUpdater` merges it into `job.runtime.effective` and records `job.runtime.sources` for values the plugin did not request as `codex-config` (label `codex config.toml`) and for requested ones keeps the existing source; converge the record on report §8.2 `runtime: {requested, effective, sources}` while **keeping** the flat fields earlier lanes use (read the merged `m1-runtime`/`m1-bypass` shape first).
- **Result:** `runTrackedJob` adds `effectiveRuntime` (= `job.runtime.effective`) to the stored result payload, so `result --json` has it. A forked follow-up records **its own** effective runtime from the fork response.
- **Render:** `formatRuntime` shows the effective model and effort with their source, e.g. `model gpt-6-luna (codex config.toml) · effort high (codex config.toml) · sandbox danger-full-access (built-in:bypass)`; never print `(Codex default)`.
- **Precedence of sources for display:** thread-response values are the truth for `effective`; `config/read` values (from `m1-runtime`) are only a fallback when the response lacks a field.

## Implementation guide

- `lib/codex.mjs`: `startThread`, `resumeThread`, the fork call in `runAppServerTurn`, `buildThreadParams`, `buildResumeParams`.
- `lib/tracked-jobs.mjs`: `createJobProgressUpdater`, `runTrackedJob`. `lib/render.mjs`: `formatRuntime`, `renderJobStatusReport`, `renderStoredJobResult`.

## Fake-Codex fixture

The fixture API from lane `m0-fixture` (plan D2), in short: `installFakeCodex(binDir, behavior, options)`; `setFakeCodexOptions(binDir, patch)`; `options.turnScript` steps (`command`, `fileChange` with `writeFiles`, `agentMessage`, `reasoning`, `plan`, `diff`, `usage`, `delay`, `silence`, `serverRequest`); `options.interrupt: "cooperate"|"ignore"|"ack-only"`; `options.ignoreSigterm`; `options.delays.{initialize,threadStart,turnStart}`; `options.models`, `options.config`, `options.writeRollout`, `options.forceActiveWriter`, `options.turnStatus`; methods `model/list`, `config/read`, `thread/read`; `readFakeRpcLog(binDir, {method, conn, dir})`, `fakeConnections(binDir)`; `occupyBroker(endpoint, {holdMs})`; `startFakeAppServer(binDir)`; helpers `spawnStubborn()`, `waitFor()`, `isPidAlive()`, `makeCompanionWorkspace()`. M0/M1 lanes extended it further, so **read the fixture source for the exact signatures** before writing tests. Note: the fixture answers `thread/unload`, but the real codex-cli 0.157 app-server does **not** have it (probe §6), so plugin code must never call it.

**You own the fixture files in this wave.** If you need a capability that is missing, add it **additively** (new options, new turnScript step types, new helpers) and keep every existing behaviour string and option working. Where the fixture's shapes differ from `docs/app-server-probe.md` ("Fixture shapes"), make the fixture match the probe for the methods you touch.

Make `thread/start`, `thread/resume` and `thread/fork` responses carry the probe's `ThreadStartResponse` fields (`model`, `modelProvider`, `reasoningEffort`, `sandbox:{type, networkAccess}`, `approvalPolicy`, `cwd`, `thread`), derived from the request when given and otherwise from `options.effectiveDefaults = {model, reasoningEffort, sandbox}` (default `gpt-6-luna`, `high`, from `options.config`'s `sandbox_mode` when present). Keep existing behaviours working.

## Tests to write first

`tests/effective-runtime.test.mjs`:
1. A fake `thread/start` response containing `model: gpt-6-luna` is persisted in `job.runtime.effective.model` while the turn runs (poll during a `delay`) and rendered by `status`.
2. A task without `--model` shows the resolved model and its source (`codex-config`) in `status` and `result`; `result --json` has `effectiveRuntime`.
3. With `--model gpt-5.6-terra`, effective shows the requested model with source `flag`.
4. `forceActiveWriter` follow-up → the forked job records its own effective runtime from the fork response.
5. Sandbox mapping: `workspaceWrite` + `networkAccess:true` → `workspace-write` / `on`; `dangerFullAccess` → `unrestricted`.

## Requirements from the report (verbatim)

The text below is copied verbatim from `docs/IMPROVEMENT-REPORT.md`. Line numbers in it predate M0/M1. The "Probe adjustments" and "Design decisions" sections of this brief override it where they differ.

### BUG-10: Status and results record the *requested* runtime, not the effective one
- **Priority:** P1
- **Problem:** `job.runtime` stores what `resolveTaskRuntime` chose. When `--model` or `--effort` is absent those values are null, and `formatRuntime` omits them. The thread/start, resume and fork responses are used only for `thread.id`. So Claude never learns which model actually ran (E5), and it cannot see what a fork inherited.
- **Evidence:** E5. `codex-companion.mjs` ~244-245 and ~1031. `lib/render.mjs` `formatRuntime` 124-139. `lib/codex.mjs` 882-883, 1259, 1284, 1294.
- **Proposal:** Capture the effective `model`, `reasoningEffort`, `sandbox`, `approvalPolicy` and `cwd` from the thread responses if the schema carries them. The generated `ThreadStartResponse` types are not in the checkout, so check the real response. Otherwise fall back to `config/read`. Persist `job.runtime = {requested, effective, sources}`. Render e.g. `model gpt-x (codex default)`, and add `effectiveRuntime` to `result --json`.
- **Acceptance criteria:** A fake thread/start response containing a model is persisted and rendered. A task run without `--model` shows the resolved model and its source in status and result. A forked follow-up records its own effective runtime.

## Probe adjustments and scope narrowing (binding; they override the verbatim text above)

- **Probe §4 and "Fixture shapes":** the real `ThreadStartResponse` carries `model`, `modelProvider`, `reasoningEffort`, `sandbox {type, networkAccess, …}`, `approvalPolicy`, `cwd`, `instructionSources` and `thread {id, path, ephemeral}`. BUG-10's "if the schema carries them" is therefore confirmed: read them from the response; `config/read` is only the fallback.
- **Probe §6:** a resumed thread may report a different effective sandbox than it was started with (read-only → dangerFullAccess under this host's config). Record what the resume response says; do not assume the original.

## Acceptance checklist (report PASS/FAIL per line)

- [ ] A fake thread/start response containing a model is persisted and rendered
- [ ] A task run without `--model` shows the resolved model and its source in status and result
- [ ] A forked follow-up records its own effective runtime
- [ ] `job.runtime = {requested, effective, sources}` is persisted (old flat fields kept) and `result --json` has `effectiveRuntime`
- [ ] `npm test` green in your worktree; no existing test edited except where this brief allows it

## Required final report (your last message; use exactly these sections)

```
## Lane m4-effective report
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
