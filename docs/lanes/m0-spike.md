# Lane `m0-spike`: App-server protocol probe and native-daemon spike (PROBE + FR-26)

- **Beads:** `codex-plugin-cc-1mh.1`, `codex-plugin-cc-1mh.3`
- **Report items:** PROBE (report §9.2 risk 1), FR-26
- **Wave:** 1. **Depends on:** none. **Runs concurrently with:** `m0-fixture`, `m0-cli-hygiene`, `m0-prune`.

## Goal

Replace guesses with verified facts about codex-cli 0.157.0. You deliver two documents and a probe script. You change **no plugin code and no tests**. Your findings decide (a) whether the plugin keeps its own broker or moves to the native daemon (plan decision D1 currently says keep the broker and reserve a `daemon` transport), and (b) the exact request and response shapes later lanes and the fake fixture must mirror (BUG-5, BUG-10, BUG-11, FR-7, FR-12, FR-13).

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

- `docs/app-server-probe.md`
- `docs/codex-native-surfaces.md`
- `scripts/probe-app-server.mjs`

## Do not touch

- Everything under `plugins/` and `tests/` (other lanes own them in this wave).
- `docs/IMPROVEMENT-REPORT.md` and `docs/IMPLEMENTATION-PLAN.md`. Do **not** edit them. Put proposed amendments to report items in your spike document (see below); the orchestrator applies them.
- The user's Codex configuration: never write `~/.codex/config.toml`, never call `skills/config/write` or any other `*/write` config method, and never run `codex login`/`logout`.
- The user's live native daemon: you may connect to it and list, read and start **your own** threads, but never stop, restart or reconfigure it, and never interrupt or steer a thread you did not create.

## Design decisions binding on this lane

- Probe threads must be cheap and harmless: `cwd` = a fresh temp dir, `sandbox: "read-only"`, `approvalPolicy: "never"`, prompts like `Reply with exactly: OK`. Use `ephemeral: true` unless the question needs persistence (rollout path, `codex queue`). Run at most about 10 turns in total.
- Primary source of truth for shapes: generate the protocol types with `codex app-server generate-ts --out <tmpdir>` (the same command as `npm run prebuild`, but into a temp dir; do **not** write into `plugins/codex/.generated`). Cite the relevant type definitions (`ThreadStartParams`, `ThreadStartResponse`, `ThreadReadResponse`, model/list, config/read, `thread/unload` if present, `TurnSteerParams`, notification param types) in `docs/app-server-probe.md`, then confirm them live.
- If Codex auth is unavailable, the script must still run the static parts (help output, generate-ts), mark the live parts `SKIPPED (no auth)`, and exit 0.

## Implementation guide

1. Write `scripts/probe-app-server.mjs` (plain Node, no dependencies). It spawns `codex app-server` over stdio JSON-RPC (see `plugins/codex/scripts/lib/app-server.mjs` for the initialize handshake the plugin uses: read it, do not edit it), runs each probe step, and prints a JSON report (`--json`) or markdown. Each step records `{question, request, response|error, verdict}`.
2. Probe steps (PROBE bead): `model/list` (full response); `config/read` (what layers or origins it reports, and whether it shows `sandbox_mode`, `model`, `approval_policy` from `config.toml`); `thread/start` **without** `sandbox` and without `model`: is it accepted, and what does the response report as the effective sandbox and model? Also `thread/start` with explicit values. `ThreadStartResponse` fields (effective model, reasoningEffort, sandbox, approvalPolicy, cwd); `ThreadStartParams.developerInstructions` (accepted, and visible in the turn?); `thread/read` (does it return `path` = rollout path, turn list, and turn status while a turn is running?); `thread/unload` or an equivalent (does it exist, and does a resume on another app-server then work without "active writer"?); `turn/steer` on a native `review/start` turn (accepted or rejected); per-thread `config` keys that disable skills, hooks and AGENTS.md loading (inspect `skills/list`, `hooks/list` and the config schema; test one candidate key per feature); whether `turn/interrupt` on an unknown turn errors.
3. Native surfaces (FR-26): run and capture `codex --help`, `codex agents --help`, `codex queue --help`, `codex exec --help`, and `ls -la ~/.codex/app-server-control ~/.codex/app-server-daemon`. Then answer the five FR-26 questions below with live evidence: connect to the control socket (read how `codex agents` talks to it, e.g. with `strace -f -e trace=connect` if available, or from the generated types); try `initialize` + `thread/start` + `turn/start` on it; disconnect mid-turn (use a prompt that takes a few seconds) and check with `thread/read` from a new connection whether the turn continued or was interrupted; `codex queue --thread <your thread> --message "..."` during a running turn vs after it; `codex agents` listing (non-interactive flags only) before and after a plugin-style thread is started on the daemon; `--dangerously-bypass-hook-trust` semantics and any per-thread equivalent.
4. Write `docs/app-server-probe.md`: one section per PROBE question, with the exact command or request, the trimmed response (JSON), and a one-line verdict. End with a **"Fixture shapes"** section: copy-paste-ready JSON examples for `model/list`, `config/read`, `thread/read`, `ThreadStartResponse` and the notifications `item/commandExecution/outputDelta`, `turn/diff/updated`, `turn/plan/updated`, `thread/tokenUsage/updated`, so the fixture can mirror them.
5. Write `docs/codex-native-surfaces.md`: the five FR-26 answers, each with commands and outputs; then **Decision** (keep broker / switch to daemon / support both behind `transport: broker|daemon|direct`) with reasoning measured against plan D1; then **"Changes to report items"**, a bullet per affected item (BUG-1, BUG-3, BUG-5, BUG-10, BUG-11, FR-7, FR-12, FR-13, FR-20, FR-22) saying what changes. (Deviation from the report's FR-26 acceptance text: you do not edit the report; the orchestrator applies these changes.)

## Tests to write first

No new tests in `tests/` (you own none). Verify that `node scripts/probe-app-server.mjs --json` exits 0 and prints valid JSON, and that `npm test` is still green (nothing you touch is in its path).

## Requirements from the report (verbatim)

The text below is copied verbatim from `docs/IMPROVEMENT-REPORT.md`. You do not need to read the rest of the report.

1. **App-server protocol surface is unverified locally.** The generated types (`.generated/app-server-types`) are not in the checkout. Before building on any of the following, verify it against codex-cli 0.157.0 (write a small probe script, or use the nightly contract test): `model/list`, `config/read` layers, `thread/read` (and whether it returns a rollout path or turn status), `thread/unload` (or an equivalent), `turn/steer` semantics on native review turns, `ThreadStartResponse` fields (effective model and sandbox), `ThreadStartParams.developerInstructions`, the per-thread config keys that disable skills, hooks and AGENTS.md, and whether a missing `sandbox` param falls back to config.toml. Items BUG-5, BUG-10, BUG-11, FR-7, FR-12 and FR-13 depend on these.

### FR-26: Evaluate Codex 0.157's native daemon, `queue` and `exec` surfaces before building parallel machinery
- **Priority:** P1 (a time-boxed spike at the start of M0; its outcome can shrink BUG-1, BUG-3, FR-20 and FR-22)
- **Problem:** The plan builds ownership, steering, broker leases and broker observability on top of the plugin's own per-workspace broker. codex-cli 0.157.0 now ships overlapping native features that the report never considered: `codex agents` ("Browse all agent sessions on the shared local app-server daemon"), a daemon control socket at `~/.codex/app-server-control/app-server-control.sock` (with `~/.codex/app-server-daemon/`), `codex queue --thread <id> --message <text>` ("Queue a message for an existing session"), `codex exec --output-schema <file>`, and `--dangerously-bypass-hook-trust` (relevant to E9's hook injection). If the plugin's jobs ran on the native daemon, sessions would be visible in `codex agents`, steering could reuse `codex queue`, and the plugin's broker (and BUG-3's teardown problem) might go away.
- **Evidence:** E1, E4, E6, E9. `codex --help`, `codex queue --help`, `codex agents --help`, `codex exec --help` on codex-cli 0.157.0. `ls ~/.codex/app-server-control ~/.codex/app-server-daemon`.
- **Proposal:** Before M0 step 3, spend at most one day answering, in `docs/codex-native-surfaces.md`: (1) Can the plugin connect to the native daemon socket and run `thread/start`/`turn/start` there? Does a turn survive client disconnect, and does the daemon offer interrupt-on-disconnect or ownership? (2) Does `codex queue` deliver into a *running* turn (steer) or only queue for the next turn, and does it work on threads started through the app-server? (3) Does `codex agents` list plugin-started threads? (4) What does `--dangerously-bypass-hook-trust` change, and is there a per-thread equivalent that stops Codex hooks from injecting context (E9)? (5) Decision: keep the plugin broker, switch to the native daemon, or support both behind `transport: broker|daemon|direct`. Update BUG-1, BUG-3, FR-13, FR-20 and FR-22 to match the decision.
- **Acceptance criteria:** The spike document exists and answers all five questions with the exact commands and outputs used. Each answer names the report items it changes, and those items are edited in the same PR. If the native daemon is adopted, a fake-fixture test covers the `daemon` transport's connect, interrupt and disconnect behaviour.

## Acceptance checklist (report PASS/FAIL per line)

- [ ] `docs/app-server-probe.md` answers every PROBE question (model/list; config/read layers; thread/read rollout path + turn status; thread/unload or equivalent; turn/steer on native review turns; ThreadStartResponse fields; ThreadStartParams.developerInstructions; per-thread config keys for skills/hooks/AGENTS.md; missing-sandbox fallback to config.toml), each with an exact command/request and output
- [ ] `docs/app-server-probe.md` has a "Fixture shapes" section with real JSON examples
- [ ] `docs/codex-native-surfaces.md` answers all five FR-26 questions with exact commands and outputs
- [ ] A Decision section with a recommendation relative to plan D1, plus a "Changes to report items" list naming each affected item
- [ ] `scripts/probe-app-server.mjs` runs non-interactively, degrades to SKIPPED without auth, and exits 0
- [ ] No plugin, test, report or plan file changed; the user Codex config is untouched; no daemon restart
- [ ] `npm test` green

## Required final report (your last message; use exactly these sections)

```
## Lane m0-spike report
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
