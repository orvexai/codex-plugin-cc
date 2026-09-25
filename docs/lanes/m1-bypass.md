# Lane `m1-bypass`: Bypass as the fork's out-of-box default, coupled to ownership (FR-25)

- **Beads:** `codex-plugin-cc-8kj.7`
- **Report items:** FR-25
- **Wave:** 7. **Depends on:** `m1-runtime`, `m1-ledger`, all of M0. **Runs concurrently with:** none (runs alone).

## Goal

The user's first goal (G1): no sandbox and no approval prompts by default, like Claude's bypass mode. Change the fork's **built-in** tier to bypass (`danger-full-access`, network on, `approvalPolicy: never`), still below the codex-config tier. Allow it only for **owned** jobs: an unowned `--background` launch with no explicit sandbox falls back to `workspace-write` and says why. Show the mode and its source on every launch line and in setup. Reviews stay read-only.

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
- `plugins/codex/scripts/lib/render.mjs`
- `README.md`
- `plugins/codex/CHANGELOG.md`
- `tests/fake-codex-fixture.mjs`
- `tests/helpers.mjs`
- `tests/bypass.test.mjs`
- `tests/orvex.test.mjs`

## Do not touch

No concurrent lane. Still, do not edit `lib/codex.mjs` (it already omits unset values after `m1-runtime`; if you find you need a change there, report it), `commands/**`, `agents/**`, `skills/**`, the hooks, broker files, or other existing test files.

## Design decisions binding on this lane

- **Built-in tier = bypass:** in `resolveTaskRuntime`, when no flag, inherited, env, workspace, global or **codex-config** value exists, use `sandbox:"danger-full-access"`, `network:true` with source `built-in:bypass`. The codex-config tier (BUG-5) still wins, so a config.toml `sandbox_mode="workspace-write"` keeps that.
- **Ownership coupling (implemented here, directly in `handleTask`):** the bypass built-in applies only when the job is owned: `--attach`, foreground, or `--owner-pid` (MCP wait comes later). For `--background` **without** `--detach` and without any explicit sandbox source (flag, env, workspace or global config), use `workspace-write` with source `built-in:unowned-fallback`, and print to stderr: `Bypass default not applied: job is unowned. Use --attach, or --detach to accept an unowned full-access job.` With an explicit `--detach`, bypass applies.
- **Reviews:** unchanged, forced `read-only` (BUG-8).
- **Launch line and setup:** the launch line gains `approval=never source=<sandbox source>`, e.g. `sandbox=danger-full-access network=unrestricted approval=never source=built-in:bypass`. The setup report shows the same, plus a **one-time notice** on the first `setup` after upgrade (`Default runtime is now bypass: danger-full-access, network on, approval never. Opt out: setup --global --default-sandbox workspace-write`), tracked with the global config key `bypassNoticeShownAt` (via `setGlobalConfig`).
- **Opt-out that works today:** `setup --global --default-sandbox read-only|workspace-write` and env `CODEX_COMPANION_SANDBOX`. (`--default-profile` and `CODEX_COMPANION_PROFILE` come with FR-14; do not add them.)
- **Docs:** state the new default prominently in `README.md` (near the top) and in `CHANGELOG.md` under a new version entry. Do not bump package versions (the orchestrator does releases).

## Implementation guide

`codex-companion.mjs`: `resolveTaskRuntime`, `handleTask`, `handleSend` (follow-ups inherit; they are owned when attached), `buildSetupReport`, `handleSetup`; `lib/render.mjs`: launch line, runtime formatting. Update `tests/orvex.test.mjs` where it asserts the pre-bypass default, and explain each change.

## Fake-Codex fixture API (from lane `m0-fixture`)

The fixture API from lane `m0-fixture` (see `docs/IMPLEMENTATION-PLAN.md` D2), in short: `installFakeCodex(binDir, behavior, options)`; `setFakeCodexOptions(binDir, patch)`; `options.turnScript` steps (`command`, `fileChange`, `agentMessage`, `reasoning`, `plan`, `diff`, `usage`, `delay`, `silence`, `serverRequest`); `options.interrupt: "cooperate"|"ignore"|"ack-only"`; `options.ignoreSigterm`; `options.delays.{initialize,threadStart,turnStart}`; `options.models`, `options.config`, `options.forceActiveWriter`; `readFakeRpcLog(binDir, {method, conn})`, `fakeConnections(binDir)`; `occupyBroker(endpoint, {holdMs})`; helpers `spawnStubborn()`, `waitFor()`, `isPidAlive()`, `makeCompanionWorkspace()`, `startFakeAppServer()`. Read the fixture source for the exact signatures before writing tests. If you need a fixture capability that is missing, add it **additively** (this lane owns the fixture files in this wave) and keep every existing behaviour string working.

## Tests to write first

`tests/bypass.test.mjs`:
1. Empty plugin config, fixture config with no sandbox → `task --attach "x"`: the fake's `thread/start` has `sandbox:"danger-full-access"` and `approvalPolicy:"never"`, and the first stdout line contains `source=built-in:bypass`.
2. Fixture config `sandbox_mode="workspace-write"` → no override sent (or `workspace-write`), source `codex-config`.
3. `review` and the stop gate still send `read-only`.
4. Unowned bare `task --background "x"` runs `workspace-write` and prints the reason; `task --background --detach "x"` runs bypass.
5. `CODEX_COMPANION_SANDBOX=read-only task "x"` runs `read-only`.
6. Foreground `task "x"` runs bypass (owned).
7. The setup notice appears once, then never again.

## Requirements from the report (verbatim)

The text below is copied verbatim from `docs/IMPROVEMENT-REPORT.md`. You do not need to read the rest of the report.

### FR-25: Ship bypass as the Orvex fork's out-of-box default
- **Priority:** P1 (lands in M1, only after M0's BUG-1, BUG-2, BUG-3 and BUG-6)
- **Problem:** The user's first goal is "no sandbox, no approval prompts by default, like Claude's bypass-permissions mode". Today that needs either a manual `setup --global --default-sandbox danger-full-access --default-network on` (which the E8 session never ran) or, after BUG-5, a config.toml that already says so. FR-14 adds a `bypass` profile but leaves the fork's built-in default at `read-only` (or at whatever config.toml says). Nothing in the plan makes bypass the default for a fresh install of this fork, and nothing tells Claude which mode a job will run in before it launches.
- **Evidence:** E8, E1. `codex-companion.mjs` `resolveTaskRuntime` ~202-247 (built-in `read-only`). README.md 19 and 56. `lib/render.mjs` ~221.
- **Proposal:**
  1. Change the fork's **built-in** tier (the last one in §8.4) to the `bypass` profile: `danger-full-access`, network on, `approvalPolicy: never`. The codex-config tier (BUG-5) still wins over it, so a user whose config.toml says `workspace-write` keeps that.
  2. Opt-out, available at once: `setup --global --default-sandbox read-only|workspace-write` or env `CODEX_COMPANION_SANDBOX` (both exist today). After FR-14 also `setup --global --default-profile write|readonly` and `CODEX_COMPANION_PROFILE`.
  3. Review, adversarial-review and the stop gate stay forced `read-only` (BUG-8).
  4. Safety coupling: the bypass default is only allowed when the job is owned (`--attach`, foreground, MCP wait, or `--owner-pid`). An unowned `--background` launch with no explicit sandbox flag falls back to `workspace-write` and prints why, unless `--detach` is explicit. Implement this check directly here; WISH-2's `requireLeaseFor` later generalizes it.
  5. Every launch's first line (`CODEX_JOB …`, BUG-4) and the setup report show `sandbox=danger-full-access network=unrestricted approval=never source=built-in:bypass`.
  6. The CHANGELOG and README state the new default prominently, and `setup` prints a one-time notice on first run after the upgrade.
- **Acceptance criteria:**
  - With an empty plugin config and a `CODEX_HOME` whose config.toml sets no sandbox, a bare `task --attach "x"` sends thread/start with `sandbox:'danger-full-access'` and `approvalPolicy:'never'`, and the first stdout line contains `source=built-in:bypass`.
  - With config.toml `sandbox_mode="workspace-write"`, the same call sends no override (or `workspace-write`) and reports source `codex-config`.
  - `review` and the stop gate still send `read-only`.
  - An unowned bare `task --background "x"` runs `workspace-write` and prints the reason; `task --background --detach "x"` runs bypass.
  - `CODEX_COMPANION_SANDBOX=read-only task "x"` runs `read-only` (and, after FR-14, so does `CODEX_COMPANION_PROFILE=readonly`).

| G1: no sandbox and no approval prompts by default, like Claude's bypass mode | BUG-5, FR-14, FR-25, BUG-8 (reviews stay read-only), WISH-2 | On a fresh install with no flags and no plugin config, a bare `task "x"` runs `danger-full-access` with network and `approvalPolicy: never`, and prints that runtime on its first line. Review paths still run read-only. |

### 8.4 Config schema (global `~/.config/codex-companion/config.json`, repo `.codex-companion.json`, workspace `state.json.config`)

Precedence: flag > inherited (follow-ups) > env `CODEX_COMPANION_*` > workspace > repo > global > profile > codex-config (`config/read`) > built-in. In this fork the built-in tier is the `bypass` profile (FR-25); reviews and the stop gate are always forced `read-only` regardless of tier.

## Acceptance checklist (report PASS/FAIL per line)

- [ ] With an empty plugin config and a `CODEX_HOME` whose config.toml sets no sandbox, a bare `task --attach "x"` sends thread/start with `sandbox:'danger-full-access'` and `approvalPolicy:'never'`, and the first stdout line contains `source=built-in:bypass`
- [ ] With config.toml `sandbox_mode="workspace-write"`, the same call sends no override (or `workspace-write`) and reports source `codex-config`
- [ ] `review` and the stop gate still send `read-only`
- [ ] An unowned bare `task --background "x"` runs `workspace-write` and prints the reason; `task --background --detach "x"` runs bypass
- [ ] `CODEX_COMPANION_SANDBOX=read-only task "x"` runs `read-only` (the FR-14 profile variant is deferred)
- [ ] README and CHANGELOG state the new default; setup prints a one-time notice
- [ ] `npm test` green

## Required final report (your last message; use exactly these sections)

```
## Lane m1-bypass report
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
