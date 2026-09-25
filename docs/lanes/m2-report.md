# Lane `m2-report`: Structured task report, git snapshots, `diff`, `--output-schema` and `--expect-changes` (wiring) (FR-4, FR-5)

- **Beads:** `codex-plugin-cc-yew.5`, `codex-plugin-cc-yew.4`
- **Report items:** FR-4, FR-5. **Scope in this lane:** the **wiring halves** of FR-4 and FR-5 on top of `lib/task-report.mjs`, `lib/json-schema.mjs` and `lib/git-snapshot.mjs` (built in wave 1).
- **Milestone / wave:** M2, wave 2. **Depends on:** wave 1 (`m2-events`, `m2-snapshot-lib`, `m2-report-lib` merged). **Runs concurrently with:** `m2-capture`.

## Goal

Make every task result a structured, verifiable report built from harness facts (files with diff stats, commands with exit codes, validation, git before/after), write a reversible patch per job, add the `diff` subcommand, let callers demand schema-valid output with `--output-schema`, and flag write jobs that changed nothing.

## Ground rules (non-negotiable)

- **Worktree:** you work in your **own git worktree**, created by the orchestrator from branch `orvex/improvement-report` after the previous wave was merged (normally `/home/crew/workspace/codex-plugin-cc-lanes/m2-report` on branch `lane/m2-report`; use the path you were given). Paths below are relative to your worktree root, and `plugins/codex/scripts/` holds the runtime. The other lanes of your wave run at the same time in their own worktrees, and the orchestrator merges every lane of the wave afterwards. **File ownership is what keeps those merges conflict-free**, so respect it exactly.
- **Beads:** run `bd` from the main checkout: `cd /home/crew/workspace/codex-plugin-cc && bd update <id> --claim` for each bead listed above. If a bead is already claimed (another lane of the same item claimed it), skip the claim and still add your note. At the end, run `bd note <id> "<one paragraph: lane m2-report; what changed, tests added, npm test result, open risks>"` for each bead. **Never** run `bd close`: the orchestrator closes beads after review.
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
- `plugins/codex/scripts/lib/task-report.mjs`
- `plugins/codex/scripts/lib/json-schema.mjs`
- `plugins/codex/scripts/lib/git-snapshot.mjs`
- `plugins/codex/schemas/task-report.schema.json`
- `plugins/codex/schemas/task-result.schema.json`
- `tests/report.test.mjs` (new)

## Do not touch

- Lane `m2-capture` runs at the same time and owns: `plugins/codex/scripts/lib/codex.mjs`, `plugins/codex/scripts/lib/app-server.mjs`, `plugins/codex/scripts/lib/tracked-jobs.mjs`, `plugins/codex/scripts/lib/job-control.mjs`, `plugins/codex/scripts/lib/render.mjs`, `tests/fake-codex-fixture.mjs`, `tests/helpers.mjs`, `tests/capture.test.mjs`.
- `lib/render.mjs` is owned by `m2-capture`: compose the Report section in the companion with `renderReportSection` instead of editing `renderTaskResult`.
- Any existing test file not listed under "Files you own" (add your tests in your own new test files).

## Design decisions binding on this lane

- **Snapshots in `executeTaskRun`.** When the task cwd is inside a git repo, create `createChangeTracker(cwd, {preCopyDir: jobs/<id>.snapshot})` before the turn. Wrap `request.onProgress` so `command.started`/`command.completed` events call `beginWindow(itemId)`/`endWindow(itemId)`. After the turn, `finish({fileChangePaths})` (paths from `result.fileChanges`), write `jobs/<id>.patch` with `writeJobPatch` for `changedByJob`, then delete the `.snapshot` dir. Snapshot failures never fail the job: they add a warning `git snapshot failed: <msg>` and `report.git = null`.
- **Payload** (`executeTaskRun` → stored `result`): keep every legacy field and add `schemaVersion: 2`, `turnIds`, `report` (from `buildTaskReport`, including `git`, `toolCalls` from `result.toolCalls ?? []`, `usage` from the job, `warnings`), and `structured` when `--output-schema` was given. Write `jobs/<id>.commands.jsonl`. Stamp `schemaVersion: 2` on `task --json` and `result --json` output too.
- **Rendering:** the stored `rendered` text becomes `renderReportSection(report, {structured})` + the existing rendered result, so the compact Report (files with stats, failed commands, validation) comes **before** the raw message. `result <id> --report-only` prints only the Report section (text) or `{schemaVersion, jobId, report, structured}` (`--json`).
- **`--output-schema <file|builtin:task-report>`** on `task` (and `send` follow-ups): resolve synchronously with `resolveOutputSchema` **before** creating any job record (bad file → exit 2, no job). Pass the schema to `runAppServerTurn` as `outputSchema` (it already forwards it to `turn/start`). After the turn: `evaluateStructuredOutput`, then `markUnverifiedClaims`. When `ok:false`: the job still ends `completed`, with `reportError: {code:"invalid-structured-output", validationErrors}`; a foreground `task` or `task --attach` exits **2** (make the attach/foreground exit path check `job.reportError` on a completed job). `wait` keeps `exitCodeForJob` (0) but its JSON shows `reportError`.
- **`--expect-changes`** (and config `defaultExpectChanges`, read with `getConfig`/`getGlobalConfig` until `m4-config` centralises config): a write-capable job (effective sandbox not `read-only`) with an empty `changedByJob` always gets warning `NO_CHANGES`; with expect-changes it also gets `statusDetail:"completed-no-changes"`, and foreground/attach exits 2 (status stays `completed`).
- **`diff <id> [--stat|--name-only|--json]`:** reads `jobs/<id>.patch` and `report.git`. `--name-only` lists `changedByJob`; `--stat` uses `fileStats`; `--json` → `{schemaVersion:2, jobId, patchFile, files:[{path, additions, deletions}], changedConcurrently, patch}`; default prints the patch. Resolves ids like `status <id>`. No patch (non-git cwd or running job) → a clear message, exit 0 for running jobs with "no patch yet".
- Add all new flags/subcommands to `printUsage`/`--help`.

## Implementation guide

- `codex-companion.mjs`: `executeTaskRun`, `handleTask`/`buildTaskRequest` (flags), `handleSend` (follow-up flags), `handleResult`, the attach/foreground exit path (from `m0-ownership`/`m1-completion-signal`), `printUsage`, `main` (new `diff` case).
- You own the three wave-1 libraries in this wave: fix bugs there if integration finds them, and list each fix.

## Fake-Codex fixture

The fixture API from lane `m0-fixture` (plan D2), in short: `installFakeCodex(binDir, behavior, options)`; `setFakeCodexOptions(binDir, patch)`; `options.turnScript` steps (`command`, `fileChange` with `writeFiles`, `agentMessage`, `reasoning`, `plan`, `diff`, `usage`, `delay`, `silence`, `serverRequest`); `options.interrupt: "cooperate"|"ignore"|"ack-only"`; `options.ignoreSigterm`; `options.delays.{initialize,threadStart,turnStart}`; `options.models`, `options.config`, `options.writeRollout`, `options.forceActiveWriter`, `options.turnStatus`; methods `model/list`, `config/read`, `thread/read`; `readFakeRpcLog(binDir, {method, conn, dir})`, `fakeConnections(binDir)`; `occupyBroker(endpoint, {holdMs})`; `startFakeAppServer(binDir)`; helpers `spawnStubborn()`, `waitFor()`, `isPidAlive()`, `makeCompanionWorkspace()`. M0/M1 lanes extended it further, so **read the fixture source for the exact signatures** before writing tests. Note: the fixture answers `thread/unload`, but the real codex-cli 0.157 app-server does **not** have it (probe §6), so plugin code must never call it.

**You do not own the fixture files in this wave** (lane `m2-capture` does). Do not edit `tests/fake-codex-fixture.mjs` or `tests/helpers.mjs`. If you need something the fixture lacks, write a small local helper inside your own test file, or record the gap as a follow-up.

Use the `command.writeFiles` and `externalWrite` turnScript steps added by `m2-events` (wave 1) for the attribution tests.

## Tests to write first

`tests/report.test.mjs` (temp git repo from `makeCompanionWorkspace`):
1. A turn with `command` "npm test" (exit 1) that writes `b.txt` (`writeFiles`), a `command` "ls" (exit 0), and a `fileChange` writing `a.txt` and `d.txt` (`writeFiles:true`) → `result --json`: `schemaVersion:2`, `report.commands.length==2` with exit codes, `validation.ran==true`, `allPassed==false`, `filesChanged` covers a.txt, b.txt, d.txt with kinds and stats.
2. `externalWrite` of `c.txt` during a `delay` → `report.git.changedConcurrently` contains `c.txt`; `diff <id> --name-only` lists a, b, d but not c.
3. `jobs/<id>.patch` passes `git apply --check -R` on the post tree.
4. `--output-schema builtin:task-report` with a conforming final agent message → `structured.ok:true`; a non-conforming message → `ok:false`, `validationErrors`, `task` exits 2, job status `completed` with `reportError`.
5. A claimed `npm run lint` in structured validation that never ran → `unverified`.
6. `--write --expect-changes` with no edits → exit 2, warning `NO_CHANGES`, `statusDetail:"completed-no-changes"`; without the flag → exit 0 with the warning.
7. Bad `--output-schema` path → exit 2 and no job record created.
8. `task-result.schema.json` validates real completed, failed, cancelled (cancel a slow job) and no-op payloads produced by the companion.
9. Text result shows the Report section before the raw output; `result --report-only` works.

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

### FR-5: Automatic git snapshots before and after each job, a `diff` subcommand, and no-op and concurrent-change detection
- **Priority:** P1
- **Problem:** Nothing records working-tree state around a task job. A write task that changes nothing looks like success. Edits made through shell commands are invisible, because `touchedFiles` comes only from fileChange items. Edits by other sessions cannot be told apart from Codex's own. `lib/git.mjs` (`getWorkingTreeState` and others) is imported only for reviews.
- **Evidence:** E10, E11. `lib/git.mjs` ~122. `codex-companion.mjs` imports ~27 and `executeTaskRun` ~681-762.
- **Proposal:** For task jobs in a git repo, capture a pre snapshot and a post snapshot: HEAD, `git status --porcelain=v2 -z`, and a content hash of each dirty or untracked file. Compute `report.git = {headBefore, headAfter, newCommits, changedByJob, changedConcurrently, untrackedAdded}`. A file counts as changed by the job if it appears in fileChange items or command-attributed changes. Hash changes during the turn that match neither go to `changedConcurrently`. Write `jobs/<id>.patch`, a diff of the job's paths relative to the pre snapshot. Add `diff <id> [--stat|--name-only|--json]`. A write job with no changes gets a `NO_CHANGES` warning. With `--expect-changes` (or config `defaultExpectChanges`) it exits 2 with status detail `completed-no-changes`.
- **Acceptance criteria:**
  - In a temp repo, a fileChange write to `a.txt` and a shell write to `b.txt` both appear in `changedByJob` and in `diff --name-only`.
  - `jobs/<id>.patch` passes `git apply --check -R` on the post tree.
  - An external edit to `c.txt` during the turn lands in `changedConcurrently`.
  - A no-edit `--write --expect-changes` run exits 2 with `NO_CHANGES`.

## Probe adjustments and scope narrowing (binding; they override the verbatim text above)

- `outputSchema` on `turn/start` works as for adversarial review (unchanged by the probe).

## Acceptance checklist (report PASS/FAIL per line)

- [ ] A fixture turn with 2 commandExecutions (`npm test` exits 1) and 1 fileChange touching 2 paths gives `report.commands.length==2` with exitCodes, `validation.ran==true`, `allPassed==false`, and `filesChanged` covering both paths with kind
- [ ] `--output-schema builtin:task-report` returns schema-valid data. A non-conforming message gives `ok:false` with `validationErrors`, exit 2, and a job that is still `completed`
- [ ] A claimed-but-unrun validation is marked `unverified`
- [ ] `task-result.schema.json` validates the completed, failed, cancelled and no-op payloads in tests
- [ ] In a temp repo, a fileChange write to `a.txt` and a shell write to `b.txt` both appear in `changedByJob` and in `diff --name-only`
- [ ] `jobs/<id>.patch` passes `git apply --check -R` on the post tree
- [ ] An external edit to `c.txt` during the turn lands in `changedConcurrently`
- [ ] A no-edit `--write --expect-changes` run exits 2 with `NO_CHANGES`
- [ ] `result --report-only`, the Report section before the raw message, `schemaVersion` on `task --json`/`result --json`, and `jobs/<id>.commands.jsonl` exist
- [ ] `npm test` green in your worktree; no existing test edited except where this brief allows it

## Required final report (your last message; use exactly these sections)

```
## Lane m2-report report
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
