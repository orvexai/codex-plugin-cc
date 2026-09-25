# Lane `m2-report-lib`: Task report builder, JSON Schema validator and result schemas (FR-4)

- **Beads:** `codex-plugin-cc-yew.5`
- **Report items:** FR-4. **Scope in this lane:** the **library half** of FR-4: `lib/task-report.mjs`, `lib/json-schema.mjs`, `schemas/task-report.schema.json`, `schemas/task-result.schema.json`, all unit-tested. Wiring (`--output-schema`, the payload, `result --report-only`) is lane `m2-report`.
- **Milestone / wave:** M2, wave 1. **Depends on:** all of M0 and M1 merged. **Runs concurrently with:** `m2-events`, `m2-snapshot-lib`, `m2-transcript-lib`.

## Goal

The stored task payload keeps only free text, so Claude cannot check validation claims and Workflow scripts cannot validate results. Build the pure pieces of a structured, verifiable task result: a report builder made of harness facts, a dependency-free JSON Schema validator, the built-in `task-report` output schema, the versioned result schema, and a compact renderer. Lane `m2-report` wires them in next wave, so the API below is binding.

## Ground rules (non-negotiable)

- **Worktree:** you work in your **own git worktree**, created by the orchestrator from branch `orvex/improvement-report` after the previous wave was merged (normally `/home/crew/workspace/codex-plugin-cc-lanes/m2-report-lib` on branch `lane/m2-report-lib`; use the path you were given). Paths below are relative to your worktree root, and `plugins/codex/scripts/` holds the runtime. The other lanes of your wave run at the same time in their own worktrees, and the orchestrator merges every lane of the wave afterwards. **File ownership is what keeps those merges conflict-free**, so respect it exactly.
- **Beads:** run `bd` from the main checkout: `cd /home/crew/workspace/codex-plugin-cc && bd update <id> --claim` for each bead listed above. If a bead is already claimed (another lane of the same item claimed it), skip the claim and still add your note. At the end, run `bd note <id> "<one paragraph: lane m2-report-lib; what changed, tests added, npm test result, open risks>"` for each bead. **Never** run `bd close`: the orchestrator closes beads after review.
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

- `plugins/codex/scripts/lib/task-report.mjs` (new)
- `plugins/codex/scripts/lib/json-schema.mjs` (new)
- `plugins/codex/schemas/task-report.schema.json` (new)
- `plugins/codex/schemas/task-result.schema.json` (new)
- `tests/task-report.test.mjs` (new)

## Do not touch

- Lane `m2-events` runs at the same time and owns: `plugins/codex/scripts/lib/events.mjs`, `plugins/codex/scripts/lib/tracked-jobs.mjs`, `plugins/codex/scripts/lib/codex.mjs`, `plugins/codex/scripts/codex-companion.mjs`, `plugins/codex/commands/logs.md`, `plugins/codex/skills/codex-drive/SKILL.md`, `tests/commands.test.mjs`, `tests/fake-codex-fixture.mjs`, `tests/helpers.mjs`, `tests/events.test.mjs`.
- Lane `m2-snapshot-lib` runs at the same time and owns: `plugins/codex/scripts/lib/git-snapshot.mjs`, `tests/git-snapshot.test.mjs`.
- Lane `m2-transcript-lib` runs at the same time and owns: `plugins/codex/scripts/lib/transcript.mjs`, `tests/transcript-lib.test.mjs`, `tests/fixtures/rollouts/`.
- `schemas/review-output.schema.json` (read it as the style reference; do not edit).
- Any existing test file not listed under "Files you own" (add your tests in your own new test files).

## Design decisions binding on this lane

- **`lib/json-schema.mjs`:** `validateJsonSchema(schema, value)` → `{valid, errors:[{path, message}], unsupportedKeywords:[]}`. Support: `type` (string or array; `integer`), `properties`, `required`, `additionalProperties` (boolean or schema), `items` (schema), `enum`, `const`, `minItems`/`maxItems`, `minLength`/`maxLength`, `minimum`/`maximum`, `pattern`, `anyOf`/`oneOf`/`allOf`, local `$ref` (`#/definitions/…`, `#/$defs/…`). Unknown keywords are ignored and listed once in `unsupportedKeywords`. Error `path` uses JSON-pointer style (`/validation/0/command`).
- **`schemas/task-report.schema.json`** (`builtin:task-report`): `{summary: string, filesChanged: [{path, kind, note}], validation: [{command, result: "passed"|"failed"|"not-run"}], risks: [string], followUps: [string]}`. It is sent to Codex as `outputSchema`, so it must be **strict** like `schemas/review-output.schema.json`: every object has `additionalProperties: false` and lists **all** its properties in `required` (use `["string","null"]` for optional values). Validate it with your own validator in a test.
- **`schemas/task-result.schema.json`:** the `result --json` payload (report §8.2) with `schemaVersion: 2`, the legacy top-level fields that must stay (`status, threadId, rawOutput, touchedFiles, reasoningSummary, undeliveredMessages`), `turnIds`, `report` (§8.2 shape; `git` nullable; `commands[].outputTail` ≤ 2KB) and optional `structured: {ok, data, validationErrors}`. It must accept completed, failed, cancelled (no turn output, `report` may be null) and no-op payloads (no files changed).
- **`lib/task-report.mjs` exports (binding):**
  - `TASK_RESULT_SCHEMA_VERSION = 2`
  - `buildTaskReport({commandExecutions, fileChanges, git = null, usage = null, turnIds = [], rolloutPath = null, effectiveRuntime = null, startedAt, completedAt, warnings = [], toolCalls = []})` → the §8.2 `report` object. `filesChanged` merges fileChange items with `git.changedByJob` (kind from fileChange, else `"modify"`/`"add"`/`"delete"` inferred from git state) and takes `additions`/`deletions` from `git.fileStats` when present. `commands` = `{command, cwd, exitCode, durationMs, status, outputTail}` (tail ≤ 2KB). `elapsedMs` from the timestamps.
  - `classifyValidation(commands)` → `{ran, allPassed, failing:[command]}` using the same verification regex as the `verifying` phase (import `looksLikeVerificationCommand` from `lib/codex.mjs` or `lib/job-control.mjs` read-only, whichever exports it; if neither exports it, copy the regex and note it).
  - `resolveOutputSchema(spec, {pluginRoot, cwd})` → `{schema, source}`; `builtin:task-report` loads the shipped file; otherwise a JSON file path (relative to `cwd`). Invalid file or JSON throws an `Error` with `exitCode = 2` and a clear message.
  - `evaluateStructuredOutput(rawOutput, schema)` → `{ok, data, validationErrors}` (JSON parse errors become one validation error).
  - `markUnverifiedClaims(structured, report)` → returns a copy of `structured` in which each `data.validation[i]` whose `command` does not match any `report.commands[].command` gets `result:"unverified"`, and appends a warning `validation claim not observed: <command>` to `report.warnings`. Matching normalises whitespace, strips a `bash -lc`/`sh -c` wrapper and quotes, and accepts substring containment either way.
  - `renderReportSection(report, {structured})` → a compact markdown **Report** section: files with `+a -d`, failed commands with exit codes, validation line, warnings. Empty report → a single `No files changed.` line.
  - `writeCommandsJsonl(file, commands)`.

## Implementation guide

- Read `schemas/review-output.schema.json`, `parseStructuredOutput` and `readOutputSchema` in `lib/codex.mjs`, and the adversarial-review path in `codex-companion.mjs` (`outputSchema` on turn/start), to match conventions.
- No imports of job state, broker or app-server modules: this is a pure library.

## Fake-Codex fixture

The fixture API from lane `m0-fixture` (plan D2), in short: `installFakeCodex(binDir, behavior, options)`; `setFakeCodexOptions(binDir, patch)`; `options.turnScript` steps (`command`, `fileChange` with `writeFiles`, `agentMessage`, `reasoning`, `plan`, `diff`, `usage`, `delay`, `silence`, `serverRequest`); `options.interrupt: "cooperate"|"ignore"|"ack-only"`; `options.ignoreSigterm`; `options.delays.{initialize,threadStart,turnStart}`; `options.models`, `options.config`, `options.writeRollout`, `options.forceActiveWriter`, `options.turnStatus`; methods `model/list`, `config/read`, `thread/read`; `readFakeRpcLog(binDir, {method, conn, dir})`, `fakeConnections(binDir)`; `occupyBroker(endpoint, {holdMs})`; `startFakeAppServer(binDir)`; helpers `spawnStubborn()`, `waitFor()`, `isPidAlive()`, `makeCompanionWorkspace()`. M0/M1 lanes extended it further, so **read the fixture source for the exact signatures** before writing tests. Note: the fixture answers `thread/unload`, but the real codex-cli 0.157 app-server does **not** have it (probe §6), so plugin code must never call it.

**You do not own the fixture files in this wave** (lane `m2-events` does). Do not edit `tests/fake-codex-fixture.mjs` or `tests/helpers.mjs`. If you need something the fixture lacks, write a small local helper inside your own test file, or record the gap as a follow-up.

## Tests to write first

`tests/task-report.test.mjs`:
1. Report from 2 commandExecutions (`npm test` exit 1, `ls` exit 0) and 1 fileChange touching 2 paths: `commands.length==2` with exit codes, `validation.ran==true`, `allPassed==false`, `failing==["npm test"]`, `filesChanged` covers both paths with kind.
2. `fileStats` from a git object flow into `additions`/`deletions`; `git.changedByJob` paths without fileChange items appear in `filesChanged`.
3. Validator: pass/fail cases for each supported keyword, `$ref`, and error paths.
4. The shipped `task-report.schema.json` is strict (every object: `additionalProperties:false`, all properties required) and a sample valid object passes.
5. `evaluateStructuredOutput`: valid → `ok:true`; missing field → `ok:false` with `validationErrors`; non-JSON → `ok:false`.
6. `markUnverifiedClaims`: a claimed `npm run lint` not in `report.commands` → `unverified` + warning; `bash -lc 'npm test'` matches `npm test`.
7. `task-result.schema.json` validates sample completed, failed, cancelled and no-op payloads, and rejects one missing `schemaVersion`.
8. `renderReportSection` output for the case in test 1 lists both files and the failed command.

## Requirements from the report (verbatim)

The text below is copied verbatim from `docs/IMPROVEMENT-REPORT.md`. Line numbers in it predate M0/M1. The "Probe adjustments" and "Design decisions" sections of this brief override it where they differ.

### FR-4: A structured, verifiable task result (files, commands, validation, risks) and `--output-schema`
- **Priority:** P1
- **Problem:** `runAppServerTurn` returns `fileChanges`, `commandExecutions` and `turnId`, but the stored payload keeps only `status, threadId, rawOutput, touchedFiles, reasoningSummary, undeliveredMessages`. `renderTaskResult` prints only `rawOutput`, and not even `touchedFiles`. There is no `outputSchema` for tasks, even though the plumbing exists at `lib/codex.mjs` 1319 and adversarial-review uses it. Claude cannot check validation claims, and Workflow scripts cannot validate the result against a schema.
- **Evidence:** E11, E12, E3. `codex-companion.mjs` payload ~744-751 and adversarial outputSchema ~614-625. `lib/codex.mjs` 275-285 (`collectTouchedFiles`), 1337-1350 and `parseStructuredOutput` ~1380. `lib/render.mjs` 356-364.
- **Proposal:**
  1. The payload gains a `report` object made of *harness facts*:
     - `filesChanged[{path, kind, additions, deletions}]`, from fileChange items merged with the git diff of FR-5
     - `commands[{command, cwd, exitCode, durationMs, status, outputTail≤2KB}]`
     - `validation{ran, allPassed, failing[]}`, classified by a heuristic on test, lint and build commands (reuse the existing `verifying` phase regex)
     - `usage`, `elapsedMs`, `turnIds[]`, `rolloutPath` (FR-7), `effectiveRuntime` (BUG-10) and `warnings[]`

     Persist the full command list to `jobs/<id>.commands.jsonl`.
  2. Add `task --output-schema <file|builtin:task-report>`, passed to turn/start `outputSchema` and parsed with `parseStructuredOutput`. `builtin:task-report` is `{summary, filesChanged[], validation[{command, result}], risks[], followUps[]}` and ships as `schemas/task-report.schema.json`. The result is `{ok, data, validationErrors}`. A foreground or attach run exits 2 when the output is invalid, while the job itself is still `completed`, with `reportError` set.
  3. Any claimed validation command that does not appear in `report.commands` is marked `unverified`.
  4. Version `task --json` and `result --json` with `schemaVersion`, and ship `schemas/task-result.schema.json`.
  5. Add `result --report-only`, and a compact **Report** section (files with stats, failed commands, validation) rendered *before* the raw message.
- **Acceptance criteria:**
  - A fixture turn with 2 commandExecutions (`npm test` exits 1) and 1 fileChange touching 2 paths gives `report.commands.length==2` with exitCodes, `validation.ran==true`, `allPassed==false`, and `filesChanged` covering both paths with kind.
  - `--output-schema builtin:task-report` returns schema-valid data. A non-conforming message gives `ok:false` with `validationErrors`, exit 2, and a job that is still `completed`.
  - A claimed-but-unrun validation is marked `unverified`.
  - `task-result.schema.json` validates the completed, failed, cancelled and no-op payloads in tests.

## Probe adjustments and scope narrowing (binding; they override the verbatim text above)

- `outputSchema` on `turn/start` is already used by adversarial review and is unchanged by the probe. `codex exec --output-schema` exists but is a CLI one-shot, not used here (native surfaces §5).

## Acceptance checklist (report PASS/FAIL per line)

- [ ] A fixture-shaped input with 2 commandExecutions (`npm test` exits 1) and 1 fileChange touching 2 paths gives `report.commands.length==2` with exitCodes, `validation.ran==true`, `allPassed==false`, and `filesChanged` covering both paths with kind
- [ ] `builtin:task-report` schema ships, is strict, and valid data passes; non-conforming data gives `ok:false` with `validationErrors` (library level; exit 2 and job status are lane `m2-report`)
- [ ] A claimed-but-unrun validation is marked `unverified`
- [ ] `task-result.schema.json` validates the completed, failed, cancelled and no-op payloads in tests
- [ ] The exported API matches the binding signatures (list them under "Contracts for other lanes")
- [ ] `npm test` green in your worktree; no existing test edited except where this brief allows it

## Required final report (your last message; use exactly these sections)

```
## Lane m2-report-lib report
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
