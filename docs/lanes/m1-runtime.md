# Lane `m1-runtime`: Stop overriding config.toml; read-only reviews; effective network (BUG-5, BUG-8, BUG-12)

- **Beads:** `codex-plugin-cc-8kj.3`, `codex-plugin-cc-8kj.4`, `codex-plugin-cc-8kj.5`
- **Report items:** BUG-5, BUG-8, BUG-12
- **Wave:** 6. **Depends on:** Wave 5; the PROBE findings in `docs/app-server-probe.md` (lane `m0-spike`). **Runs concurrently with:** `m1-ledger`.

## Goal

The plugin silently overrides the user's `~/.codex/config.toml` `sandbox_mode` with `read-only`. On this host config.toml already says `danger-full-access`, which is why every dispatch needed `--full-access`. Add the `codex-config` resolution tier and stop sending plugin-invented values. Force reviews and the stop gate to read-only regardless of defaults. Report the *effective* network instead of a flag that is silently ignored. This lane prepares FR-25 (bypass as the default), which comes next.

## Ground rules (non-negotiable)

- **Repository:** `/home/crew/workspace/codex-plugin-cc`, branch `orvex/improvement-report`. The working tree is **shared** with other lanes and Claude sessions. Paths below are relative to the repo root; `plugins/codex/scripts/` holds the runtime.
- **Beads:** at the start, run `bd update <id> --claim` for each bead listed above. At the end, run `bd note <id> "<one paragraph: what changed, tests added, npm test result, open risks>"` for each bead. **Never** run `bd close`: the orchestrator closes beads after review.
- **Git:** do **not** run `git commit`, `git add`, `git stash`, `git push`, `git reset`, `git checkout -- <path>`, `git restore` or `git clean`. The orchestrator commits with explicit pathspecs. Read-only git (`status`, `diff`, `log`, `show`) is fine.
- **File ownership:** edit **only** the files listed under "Files you own". "Do not touch" lists files owned by lanes that run at the same time as you. If you think a change outside your files is needed, do not make it; describe it under "Risks / follow-ups" in your final report. One standing exception: you may append new `CODEX_COMPANION_*` env var names to the `LEAKY_ENV` array in `scripts/run-tests.mjs`.
- **Tools:** use the Serena MCP tools if they are available (`initial_instructions` first, then `get_symbols_overview`, `find_symbol`, `find_referencing_symbols` and the symbolic edit tools). Function names in this brief are authoritative. Line numbers quoted from the report are approximate (±40 lines).
- **Tests first:** start by writing the new tests in your lane's own test file(s), using the fake-Codex fixture (`tests/fake-codex-fixture.mjs`: `installFakeCodex`, `buildEnv`, and the option and RPC-log helpers added by lane `m0-fixture`) and `tests/helpers.mjs`. Run them and confirm they fail, then implement. Only modify an existing test file where this brief explicitly allows it: those tests intentionally lock the old behaviour. If any other existing test starts failing, your code is wrong, not the test.
- **Test hygiene:** in tests, use short intervals set through env vars; avoid real 5s or 30s waits wherever possible. SIGKILL every process your tests spawn, in `t.after`. Never touch the real `~/.codex` or real plugin state; `scripts/run-tests.mjs` already isolates TMPDIR and config.
- **Definition of done:** `npm test` from the repo root is fully green at the end. It had 112 passing tests before M0, and the count only grows. Paste the final summary lines into your report.
- **Scope:** implement exactly the items below. Do not refactor unrelated code, rename files or reformat. Keep the Windows code paths intact (they are not tested here).
- **Plan authority:** `docs/IMPLEMENTATION-PLAN.md` records the cross-lane decisions (D1-D9). Where this brief narrows or changes the report, the brief wins and says so explicitly.

## Files you own

- `plugins/codex/scripts/codex-companion.mjs`
- `plugins/codex/scripts/lib/codex.mjs`
- `plugins/codex/scripts/lib/render.mjs`
- `plugins/codex/scripts/stop-review-gate-hook.mjs`
- `README.md`
- `tests/fake-codex-fixture.mjs`
- `tests/helpers.mjs`
- `tests/runtime-defaults.test.mjs`
- `tests/orvex.test.mjs (only the read-only-fallback assertion, around lines 81-83)`

## Do not touch

Lane `m1-ledger` runs at the same time and owns: `hooks/hooks.json`, `plugins/codex/scripts/job-ledger-hook.mjs`, `tests/ledger.test.mjs`. Do not edit them. Also do not edit `commands/**`, `agents/**`, `skills/**`, `session-lifecycle-hook.mjs`, `lib/broker-lifecycle.mjs`, `app-server-broker.mjs`, or other existing tests.

## Design decisions binding on this lane

Binding decisions (plan D9). **Read `docs/app-server-probe.md` first.** It answers "does thread/start accept a missing sandbox, and does it then apply config.toml?" and gives the `config/read` shape. Mirror those shapes in the fixture (you own it this wave).

- **Resolution tiers** (report §8.4; profile and repo tiers come later with FR-14/15): flag > inherited (send follow-ups) > env `CODEX_COMPANION_*` > workspace > global > **codex-config** > built-in. `resolveTaskRuntime` returns `{sandbox, network, model, effort, sources: {sandbox, network, model, effort}}`, where source is one of `flag|inherited|env|workspace|global|codex-config|built-in`.
- **When no plugin tier sets sandbox or model:** do **not** send them. Remove the `?? "read-only"` defaults in `buildThreadParams`, `buildResumeParams` and the `thread/fork` call in `runAppServerTurn`, plus the companion's `read-only` fallbacks (search for `"read-only"` in `codex-companion.mjs`, e.g. in `resolveTaskRuntime` and `executeTaskRun`). If the probe says the app-server **rejects** a missing sandbox, send the value read from `config/read` instead, still with source `codex-config`. The built-in tier (used only when config.toml has no value either) stays `read-only` in this lane; FR-25 changes it next.
- **Effective values:** read `config/read` once per task (the call already exists for auth; reuse `getCodexAuthStatusFromClient`'s pattern) to fill `runtime.effective` and `sources` for display. Status and setup show e.g. `sandbox danger-full-access (codex config.toml)`. Remove the `(Codex default)` label from `lib/render.mjs` wherever the plugin actually sends or overrides the value. Fix README.md line ~19 so it describes exactly what is sent.
- **`--write` never narrows** (keep the rank logic); `--write` with no other source gives `workspace-write`, as today.
- **BUG-8:** the stop gate's `runStopReview` spawns `task --json --read-only --no-network <prompt>` (and must not inherit `defaultSandbox`/`defaultNetwork`). New config keys `reviewModel` and `reviewEffort`, set with `setup --default-review-model <m|none>` and `--default-review-effort <e|none>` (`[--global]`), apply to `review`, `adversarial-review` and the gate. `review` and `adversarial-review` accept `--effort` (and `--model` where they do not yet). Reviews still always send `read-only`.
- **BUG-12:** add `computeEffectiveNetwork(sandbox, network)` → `"unrestricted"` for danger-full-access, `"on"|"off"` for workspace-write, `"blocked"` for read-only (flag ignored). Warn on stderr and add to `warnings[]` in JSON when a flag is ignored or moot (`--read-only --network` → "network flag ignored under read-only"; `--full-access --no-network` → "network is unrestricted under danger-full-access; --no-network has no effect"). Render the effective value everywhere (status, setup, launch line `network=`).
- **`approvalPolicy` stays `never`.**

## Implementation guide

- `codex-companion.mjs`: `readRuntimeDefaults`, `resolveTaskRuntime`, `buildSandboxConfig`, `executeTaskRun`, `runtimeFromStoredJob`, `buildSetupReport`, `handleSetup` (review defaults), `handleReviewCommand`/`handleReview`/`executeReviewRun` (effort/model defaults), `printUsage`.
- `lib/codex.mjs`: `buildThreadParams`, `buildResumeParams`, `runAppServerTurn` (fork params), `runAppServerReview` (explicit read-only).
- `lib/render.mjs`: `formatRuntime`, `renderSetupReport` (the `(Codex default)` label).
- `stop-review-gate-hook.mjs`: `runStopReview`.
- `tests/orvex.test.mjs` ~81-83 asserts the read-only fallback: update it to the codex-config semantics and explain.

## Fake-Codex fixture API (from lane `m0-fixture`)

The fixture API from lane `m0-fixture` (see `docs/IMPLEMENTATION-PLAN.md` D2), in short: `installFakeCodex(binDir, behavior, options)`; `setFakeCodexOptions(binDir, patch)`; `options.turnScript` steps (`command`, `fileChange`, `agentMessage`, `reasoning`, `plan`, `diff`, `usage`, `delay`, `silence`, `serverRequest`); `options.interrupt: "cooperate"|"ignore"|"ack-only"`; `options.ignoreSigterm`; `options.delays.{initialize,threadStart,turnStart}`; `options.models`, `options.config`, `options.forceActiveWriter`; `readFakeRpcLog(binDir, {method, conn})`, `fakeConnections(binDir)`; `occupyBroker(endpoint, {holdMs})`; helpers `spawnStubborn()`, `waitFor()`, `isPidAlive()`, `makeCompanionWorkspace()`, `startFakeAppServer()`. Read the fixture source for the exact signatures before writing tests. If you need a fixture capability that is missing, add it **additively** (this lane owns the fixture files in this wave) and keep every existing behaviour string working.

## Tests to write first

`tests/runtime-defaults.test.mjs` (fixture `options.config` mirrors a config.toml with `sandbox_mode`; use a temp `CODEX_HOME` with a real `config.toml` too, if the fake reads it):
1. BUG-5: no plugin defaults + config `sandbox_mode="danger-full-access"` → the fake's recorded `thread/start` has no `sandbox` (or null), and `status --json` shows effective sandbox `danger-full-access` with source `codex-config`. The same for `thread/resume` and `thread/fork` (forceActiveWriter).
2. With an explicit `--sandbox workspace-write`, it is sent with source `flag`. Env and workspace defaults win over codex-config.
3. Review, adversarial-review and the stop gate send `sandbox:"read-only"` even with `defaultSandbox=danger-full-access`; the gate argv contains `--read-only` (inspect the spawn args, or the resulting job's runtime).
4. `setup --default-review-model X` changes the model sent by all three review paths.
5. The setup text never shows `(Codex default)` for a value the plugin overrides.
6. BUG-12: `--read-only --network` warns, and status shows network blocked; `--full-access --no-network` shows unrestricted with a note; `--write --network` shows on. Unit tests of `computeEffectiveNetwork`.

## Requirements from the report (verbatim)

The text below is copied verbatim from `docs/IMPROVEMENT-REPORT.md`. You do not need to read the rest of the report.

### BUG-5: The plugin silently overrides the user's Codex config (`sandbox_mode`) with `read-only`, and mislabels it "(Codex default)"
- **Priority:** P0
- **Problem:** When no flag, env var or plugin default is set, `resolveTaskRuntime` falls back to `'read-only'`, and `buildThreadParams`, `buildResumeParams` and the fork call independently default `sandbox` to `'read-only'`. That overrides `sandbox_mode` in `~/.codex/config.toml` without telling anyone. `model` falls back to `null`, which lets config.toml decide, so the two settings follow inconsistent rules. The setup report prints `(Codex default)` for an unset sandbox, and README.md:19 says "Codex's own defaults unless you pass flags". Both are false. This is the direct cause of E8 on this host: `~/.codex/config.toml` already sets `sandbox_mode = "danger-full-access"` and `approval_policy = "never"`, yet every plugin job without flags ran `read-only`, so every dispatch had to repeat `--full-access`.
- **Evidence:** E8. `lib/codex.mjs` 68, 82, 1279. `codex-companion.mjs` ~191, ~228, ~708 (read-only fallbacks). `lib/render.mjs` ~221. `README.md` 19. `tests/orvex.test.mjs` 81-83 (asserts the read-only fallback).
- **Proposal:**
  1. Add a resolution tier `codex-config` at the bottom of the task precedence chain: flag > inherited > env > workspace > repo (FR-15) > global > profile (FR-14) > **codex-config** > built-in (the same order as §8.4). When nothing plugin-side is set, **omit** `sandbox` (and `model`) from thread/start, resume and fork, so config.toml and its profiles apply. Keep an explicit built-in only if the app-server rejects a missing sandbox (verify this).
  2. Read the effective values through `config/read` (already called for auth around `lib/codex.mjs` 1020) and display them with source `codex config.toml`.
  3. Keep forced `read-only` for review, adversarial-review and the stop gate (BUG-8).
  4. Fix the `(Codex default)` label and README.md:19 so they describe exactly what is sent.
  5. `approvalPolicy` stays `never` (WISH-5).
- **Acceptance criteria:**
  - With no plugin defaults and a temp `CODEX_HOME/config.toml` containing `sandbox_mode="danger-full-access"`, the fake records thread/start with no sandbox (or null), and `status --json` shows the effective sandbox `danger-full-access` with source `codex-config`.
  - `tests/orvex.test.mjs` 81-83 is updated accordingly.
  - Review paths still send `read-only`.
  - The setup text never shows `(Codex default)` for a value the plugin overrides.

### BUG-8: The stop review gate inherits the full-access default, so a "review" runs with write access, network and no sandbox
- **Priority:** P1
- **Problem:** The Stop hook spawns `codex-companion task --json <prompt>` with no sandbox flags. `handleTask` calls `resolveTaskRuntime`, which applies the workspace or global `defaultSandbox`, `defaultNetwork` and `defaultModel`. `STOP_REVIEW_TASK_MARKER` only affects job metadata. So with a bypass default, the stop-time review runs as `danger-full-access`. Separately, `review` and `adversarial-review` ignore the model and effort defaults and accept no `--effort`.
- **Evidence:** `scripts/stop-review-gate-hook.mjs` ~105. `codex-companion.mjs` ~1016, ~775, ~954 (review valueOptions exclude effort), ~579 and ~620.
- **Proposal:** The gate passes `--read-only --no-network` explicitly (later `--profile readonly`, FR-14). Add config keys `reviewModel` and `reviewEffort`, set with `setup --default-review-model/--default-review-effort`, applying to review, adversarial-review and the gate. Add `--effort` to the review commands.
- **Acceptance criteria:**
  - With `defaultSandbox=danger-full-access`, the gate's job records sandbox `read-only`, and the fake's last thread/start has `sandbox:'read-only'`.
  - A test asserts that the gate argv contains `--read-only`.
  - `setup --default-review-model X` changes the model for all three review paths.

### BUG-12: `--network` is silently ignored outside workspace-write, and status still says "network on"
- **Priority:** P2
- **Problem:** `buildSandboxConfig` sets only `sandbox_workspace_write.network_access`. Under `read-only` the flag does nothing. Under `danger-full-access` the network is open whatever the flag says. `formatRuntime` prints `network on` whenever `runtime.network` is true, and prints nothing when it is false.
- **Evidence:** E1. `codex-companion.mjs` `buildSandboxConfig` ~249-251 and ~232-240. `lib/render.mjs` 128-131.
- **Proposal:** Compute `effectiveNetwork`: `unrestricted` for danger-full-access, the flag value for workspace-write, and `blocked (flag ignored)` for read-only. Warn on stderr and in `warnings[]` of the JSON output. Render the effective value everywhere.
- **Acceptance criteria:** `task --read-only --network` warns and status shows network blocked. `--full-access --no-network` shows unrestricted with a note. Unit tests cover all three combinations.

### 8.4 Config schema (global `~/.config/codex-companion/config.json`, repo `.codex-companion.json`, workspace `state.json.config`)

Precedence: flag > inherited (follow-ups) > env `CODEX_COMPANION_*` > workspace > repo > global > profile > codex-config (`config/read`) > built-in. In this fork the built-in tier is the `bypass` profile (FR-25); reviews and the stop gate are always forced `read-only` regardless of tier.

## Acceptance checklist (report PASS/FAIL per line)

- [ ] With no plugin defaults and a temp `CODEX_HOME/config.toml` containing `sandbox_mode="danger-full-access"`, the fake records thread/start with no sandbox (or null), and `status --json` shows the effective sandbox `danger-full-access` with source `codex-config`
- [ ] `tests/orvex.test.mjs` 81-83 is updated accordingly
- [ ] Review paths still send `read-only`
- [ ] The setup text never shows `(Codex default)` for a value the plugin overrides; README line ~19 accurate
- [ ] With `defaultSandbox=danger-full-access`, the gate's job records sandbox `read-only`, and the fake's last thread/start has `sandbox:'read-only'`
- [ ] A test asserts that the gate argv contains `--read-only`
- [ ] `setup --default-review-model X` changes the model for all three review paths
- [ ] `task --read-only --network` warns and status shows network blocked. `--full-access --no-network` shows unrestricted with a note. Unit tests cover all three combinations
- [ ] `npm test` green

## Required final report (your last message; use exactly these sections)

```
## Lane m1-runtime report
### Files changed
- <path>: <one line on what changed>
### Tests added
- <test file>: <test name> (covers <item / criterion>)
### npm test
<paste the final summary lines: tests N, pass N, fail 0, duration>
### Acceptance criteria
- [PASS|FAIL|PARTIAL] <criterion text> (evidence: <test name, command + output, or file:function>)
  ... one line for every criterion in the checklist above ...
### Beads
- <bead id>: claimed, note added (not closed)
### Risks / follow-ups
- <deviations from the brief and why; anything out of scope; any change needed in a file you do not own>
```
