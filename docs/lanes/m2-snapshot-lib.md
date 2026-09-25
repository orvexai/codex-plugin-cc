# Lane `m2-snapshot-lib`: Git snapshot and change-attribution library (FR-5)

- **Beads:** `codex-plugin-cc-yew.4`
- **Report items:** FR-5. **Scope in this lane:** the **library half** of FR-5 only (`lib/git-snapshot.mjs` plus unit tests). Wiring into task runs, `jobs/<id>.patch`, the `diff` subcommand and `--expect-changes` are lane `m2-report` (next wave).
- **Milestone / wave:** M2, wave 1. **Depends on:** all of M0 and M1 merged. **Runs concurrently with:** `m2-events`, `m2-report-lib`, `m2-transcript-lib`.

## Goal

Nothing records working-tree state around a task job, so a no-op write looks like success, shell edits are invisible, and edits by other sessions cannot be told apart from Codex's own. Build a pure, well-tested library that snapshots a git working tree, attributes changes to the job (fileChange items or command windows) versus concurrent writers, computes per-file line stats, and writes a reversible patch. Lane `m2-report` wires it into `executeTaskRun` next wave, so the API below is binding.

## Ground rules (non-negotiable)

- **Worktree:** you work in your **own git worktree**, created by the orchestrator from branch `orvex/improvement-report` after the previous wave was merged (normally `/home/crew/workspace/codex-plugin-cc-lanes/m2-snapshot-lib` on branch `lane/m2-snapshot-lib`; use the path you were given). Paths below are relative to your worktree root, and `plugins/codex/scripts/` holds the runtime. The other lanes of your wave run at the same time in their own worktrees, and the orchestrator merges every lane of the wave afterwards. **File ownership is what keeps those merges conflict-free**, so respect it exactly.
- **Beads:** run `bd` from the main checkout: `cd /home/crew/workspace/codex-plugin-cc && bd update <id> --claim` for each bead listed above. If a bead is already claimed (another lane of the same item claimed it), skip the claim and still add your note. At the end, run `bd note <id> "<one paragraph: lane m2-snapshot-lib; what changed, tests added, npm test result, open risks>"` for each bead. **Never** run `bd close`: the orchestrator closes beads after review.
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

- `plugins/codex/scripts/lib/git-snapshot.mjs` (new)
- `tests/git-snapshot.test.mjs` (new)

## Do not touch

- Lane `m2-events` runs at the same time and owns: `plugins/codex/scripts/lib/events.mjs`, `plugins/codex/scripts/lib/tracked-jobs.mjs`, `plugins/codex/scripts/lib/codex.mjs`, `plugins/codex/scripts/codex-companion.mjs`, `plugins/codex/commands/logs.md`, `plugins/codex/skills/codex-drive/SKILL.md`, `tests/commands.test.mjs`, `tests/fake-codex-fixture.mjs`, `tests/helpers.mjs`, `tests/events.test.mjs`.
- Lane `m2-report-lib` runs at the same time and owns: `plugins/codex/scripts/lib/task-report.mjs`, `plugins/codex/scripts/lib/json-schema.mjs`, `plugins/codex/schemas/task-report.schema.json`, `plugins/codex/schemas/task-result.schema.json`, `tests/task-report.test.mjs`.
- Lane `m2-transcript-lib` runs at the same time and owns: `plugins/codex/scripts/lib/transcript.mjs`, `tests/transcript-lib.test.mjs`, `tests/fixtures/rollouts/`.
- `lib/git.mjs` (import from it read-only; do not edit it; reviews depend on it).
- Any existing test file not listed under "Files you own" (add your tests in your own new test files).

## Design decisions binding on this lane

- **`captureSnapshot(cwd, {maxHashBytes = 5*1024*1024, preCopyDir = null})`** → `{isRepo, repoRoot, head, branch, capturedAt, entries}` where `entries` is a plain object `path → {status, hash, size}` for every dirty or untracked path (from `git status --porcelain=v2 -z --untracked-files=all`, paths relative to `repoRoot`, rename entries split into both paths). `hash` is the sha256 of the file content (null for deleted files; files larger than `maxHashBytes` hash as `size:<n>:mtime:<ms>`). Outside a git repo return `{isRepo:false}` and never throw. When `preCopyDir` is given, copy the **pre-image** of each dirty/untracked file there (for patch generation); clean tracked files do not need a copy because their pre-image is `HEAD:<path>`.
- **`createChangeTracker(cwd, {preCopyDir})`** → `{pre, beginWindow(id), endWindow(id), finish({fileChangePaths = []}) → result}`. `beginWindow`/`endWindow` bracket each command execution (lane `m2-report` calls them from `command.started`/`command.completed` events). A path whose hash changes inside a command window is **command-attributed**. `finish` takes the post snapshot and returns `{headBefore, headAfter, newCommits, changedPaths, changedByJob, changedConcurrently, untrackedAdded, fileStats}`:
  - `changedPaths`: every path whose state differs between pre and post, including paths touched by `newCommits` (`git rev-list headBefore..headAfter`, and `git diff --name-only headBefore headAfter`).
  - `changedByJob`: changed paths that appear in `fileChangePaths` or are command-attributed. `changedConcurrently`: changed paths that are neither. `untrackedAdded`: untracked in post and absent in pre, restricted to `changedByJob`.
  - `fileStats`: `path → {additions, deletions}` for `changedByJob` (from the patch below, `git apply --numstat`, or `git diff --numstat --no-index` on the pre/post images).
  - All arrays sorted; paths relative to `repoRoot`, forward slashes.
- **`writeJobPatch(tracker, paths, patchFile)`** → `{patchFile, bytes}`: a unified diff of exactly `paths` from their pre-image (`HEAD:<path>`, the pre-copy, or `/dev/null` for new files) to the post working file, with `a/` and `b/` prefixes relative to the repo root, such that `git apply --check -R <patchFile>` succeeds on the post tree. Binary files use `--binary`. Use `git diff --no-index --binary` on temp files and rewrite the headers, or an equivalent; do not write objects into the user's repository and never touch its index.
- **Cost bounds:** at most one `git status` per snapshot; window snapshots only hash paths that are dirty at that moment; every git call has a 10s timeout; the whole library never runs `git add`, `commit`, `stash` or `checkout`.
- **Known limit (document it in a comment and in your report):** an external edit made *during* a command window is misattributed to the job. That is acceptable for FR-5.

## Implementation guide

- Read `lib/git.mjs` (`getWorkingTreeState` and helpers) and reuse its git runner if it fits; otherwise use `child_process.spawnSync("git", …, {cwd, encoding:"buffer"})` and parse `-z` output as NUL-separated.
- Keep the module free of job/state imports: it takes paths and returns data. `m2-report` owns wiring.

## Fake-Codex fixture

The fixture API from lane `m0-fixture` (plan D2), in short: `installFakeCodex(binDir, behavior, options)`; `setFakeCodexOptions(binDir, patch)`; `options.turnScript` steps (`command`, `fileChange` with `writeFiles`, `agentMessage`, `reasoning`, `plan`, `diff`, `usage`, `delay`, `silence`, `serverRequest`); `options.interrupt: "cooperate"|"ignore"|"ack-only"`; `options.ignoreSigterm`; `options.delays.{initialize,threadStart,turnStart}`; `options.models`, `options.config`, `options.writeRollout`, `options.forceActiveWriter`, `options.turnStatus`; methods `model/list`, `config/read`, `thread/read`; `readFakeRpcLog(binDir, {method, conn, dir})`, `fakeConnections(binDir)`; `occupyBroker(endpoint, {holdMs})`; `startFakeAppServer(binDir)`; helpers `spawnStubborn()`, `waitFor()`, `isPidAlive()`, `makeCompanionWorkspace()`. M0/M1 lanes extended it further, so **read the fixture source for the exact signatures** before writing tests. Note: the fixture answers `thread/unload`, but the real codex-cli 0.157 app-server does **not** have it (probe §6), so plugin code must never call it.

**You do not own the fixture files in this wave** (lane `m2-events` does). Do not edit `tests/fake-codex-fixture.mjs` or `tests/helpers.mjs`. If you need something the fixture lacks, write a small local helper inside your own test file, or record the gap as a follow-up.

## Tests to write first

`tests/git-snapshot.test.mjs` (temp repos via `initGitRepo` from `tests/helpers.mjs`; no fake Codex needed):
1. Pre snapshot of a repo with a dirty tracked file and an untracked file lists both with hashes; outside a repo → `{isRepo:false}`.
2. Attribution: write `a.txt` and report it via `fileChangePaths`; write `b.txt` between `beginWindow`/`endWindow`; write `c.txt` outside any window → `changedByJob` = [a.txt, b.txt], `changedConcurrently` = [c.txt].
3. A commit made during the tracker's life appears in `newCommits`, and its files in `changedPaths`.
4. `writeJobPatch` for a modified pre-dirty file, a new file and a deleted file: `git apply --check -R` passes on the post tree; after `git apply -R` the three files equal their pre-images.
5. `fileStats` additions/deletions match `git diff --numstat` expectations.
6. Paths with spaces and unicode survive (`-z` parsing).
7. No-op: nothing changed → all arrays empty.

## Requirements from the report (verbatim)

The text below is copied verbatim from `docs/IMPROVEMENT-REPORT.md`. Line numbers in it predate M0/M1. The "Probe adjustments" and "Design decisions" sections of this brief override it where they differ.

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

- Not protocol-dependent.

## Acceptance checklist (report PASS/FAIL per line)

- [ ] In a temp repo, a fileChange write to `a.txt` and a command-window write to `b.txt` both appear in `changedByJob` (library level; the `diff --name-only` half is lane `m2-report`)
- [ ] The generated patch passes `git apply --check -R` on the post tree (library level)
- [ ] An external edit to `c.txt` outside any command window lands in `changedConcurrently`
- [ ] `fileStats`, `newCommits` and `untrackedAdded` are correct; no git write operation touches the user repo's index or object database
- [ ] The exported API matches the binding signatures above (list them under "Contracts for other lanes")
- [ ] `npm test` green in your worktree; no existing test edited except where this brief allows it

## Required final report (your last message; use exactly these sections)

```
## Lane m2-snapshot-lib report
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
