# Codex for Claude Code — Orvex flavour

The Orvex flavour of the Codex plugin lets Claude Code hand work to Codex and keep control of it:
choose how much of the machine Codex may touch, message a job while it runs, run many jobs in
parallel and wait for them together, and set team-wide defaults such as the model.

It is a maintained fork of [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc).
Every upstream command keeps working, under the same `/codex:*` names, so it is a drop-in
replacement.

## What the Orvex flavour adds

| Capability | Upstream | Orvex flavour |
| --- | --- | --- |
| Sandbox | `read-only`, or `workspace-write` with `--write` | Also `danger-full-access`: `--sandbox <mode>`, `--full-access`, `--read-only`, plus `--network` for workspace-write |
| Talking to a job | Resume only the most recent task | `/codex:send <job-id>` steers a running turn, or continues any finished job's thread |
| Parallel work | Parallel jobs in one repo can overwrite each other's status | Locked, atomic job state; `/codex:wait` on many jobs with exit codes; job ids resolve from any directory |
| Labels and output | Summary taken from the prompt | `--name <label>` on tasks; `result --output <file>` saves a job's final output |
| Defaults | Codex's own defaults unless you pass flags | `/codex:setup --default-model/--default-effort/--default-sandbox/--default-network`, per repository or `--global` |
| Scripting | Versioned plugin cache path | Stable `orvex-codex` launcher on your `PATH` |
| Claude-side cost | Rescue forwarder runs on Sonnet | Rescue forwarder runs on Haiku |

## Install

### Requirements

- Claude Code
- Node.js 18.18 or later
- The Codex CLI, logged in: `npm install -g @openai/codex`, then `!codex login` inside Claude Code
  (or `!codex login --device-auth` when a browser login is blocked)
- A ChatGPT plan that includes Codex, or an OpenAI API key

### 1. Remove the upstream plugin, if you have it

Both versions register the same `/codex:*` commands, so run only one of them.

```bash
claude plugin uninstall codex@openai-codex
claude plugin marketplace remove openai-codex
```

### 2. Install the Orvex flavour

```bash
claude plugin marketplace add orvexai/codex-plugin-cc
claude plugin install codex@orvex-codex
```

The same works from inside Claude Code with `/plugin marketplace add orvexai/codex-plugin-cc`
and `/plugin install codex@orvex-codex`. Restart Claude Code afterwards.

### 3. Check the setup and set the Orvex defaults

```text
/codex:setup
/codex:setup --global --default-model gpt-6-luna --install-cli
```

`/codex:setup` checks that Codex is installed and logged in. If Codex is missing and npm is
available, it can offer to install Codex for you. The second line makes `gpt-6-luna` the default
model in every repository and installs the `orvex-codex` launcher in `~/.local/bin`.

Only on machines where Codex may run without a sandbox, such as a disposable development VM, add:

```text
/codex:setup --global --default-sandbox danger-full-access
```

### 4. Allow the launcher in Claude Code auto mode

Auto mode blocks commands it cannot classify. Add the launcher to your allow rules in
`~/.claude/settings.json`:

```json
{
  "permissions": {
    "allow": ["Bash(orvex-codex *)"]
  }
}
```

### Installing for a whole team

Commit this to a repository's `.claude/settings.json` so everyone who trusts the repository gets
the Orvex flavour:

```json
{
  "extraKnownMarketplaces": {
    "orvex-codex": { "source": { "source": "github", "repo": "orvexai/codex-plugin-cc" } }
  },
  "enabledPlugins": { "codex@orvex-codex": true }
}
```

### Updating

```bash
claude plugin marketplace update orvex-codex
claude plugin update codex@orvex-codex
```

Restart Claude Code. The `orvex-codex` launcher re-points itself at the new version when the next
session starts.

## Commands

### `/codex:setup`

Checks that Codex is ready, and manages defaults and the launcher.

```text
/codex:setup --enable-review-gate
/codex:setup --disable-review-gate
/codex:setup --default-model gpt-6-luna --default-effort high
/codex:setup --global --default-sandbox workspace-write --default-network on
/codex:setup --global --default-model none
/codex:setup --install-cli
```

- The review gate makes a stop-time Codex review run before Claude finishes, and blocks on issues.
  It can drain usage limits quickly, so only enable it while you are watching the session.
- Defaults apply in this order: explicit flag, then environment variable (`CODEX_COMPANION_MODEL`,
  `CODEX_COMPANION_EFFORT`, `CODEX_COMPANION_SANDBOX`, `CODEX_COMPANION_NETWORK`), then the
  repository default, then the `--global` default stored in `~/.config/codex-companion/config.json`.
- `none` clears a default.

### `/codex:review`

A normal read-only Codex review of your uncommitted changes, or of your branch with `--base <ref>`.
It maps to Codex's built-in reviewer, so it does not take extra focus text; use
`/codex:adversarial-review` for that.

```text
/codex:review
/codex:review --base main
/codex:review --background
```

### `/codex:adversarial-review`

A steerable, read-only review that questions the chosen design, trade-offs and assumptions. It
uses the same review target selection as `/codex:review`, and takes focus text after the flags.

```text
/codex:adversarial-review --base main challenge whether this was the right caching and retry design
```

### `/codex:rescue`

Hands a task to Codex through the `codex:codex-rescue` subagent: investigate a bug, try a fix,
or continue a previous Codex task.

```text
/codex:rescue investigate why the tests started failing
/codex:rescue --full-access --network fix the failing integration test and run it
/codex:rescue --background --name db-migration port the migration runner to the new schema
/codex:rescue --model gpt-5.4-mini --effort medium diagnose the flaky login test
/codex:rescue --resume apply the top fix from the last run
```

- Runs are write-capable by default. `--write` never narrows a configured full-access default.
- If you do not pass `--model` or `--effort` and have not set defaults, Codex chooses its own.
- If you ask for `spark`, the plugin maps that to `gpt-5.3-codex-spark`.
- `--resume` continues the latest task thread in the repository; `--fresh` starts a new one.

### `/codex:send`

Messages a job by id.

```text
/codex:send task-mfx1-ab12cd also check the retry path in client.ts
/codex:send task-mfx1-ab12cd --background now write the regression test
```

- While the job runs, the message goes into its active turn, and the command confirms delivery.
- Once the job has finished, the command starts a follow-up job on the same Codex thread. The
  follow-up keeps the job's sandbox, network access, model and effort unless you pass new ones.

### `/codex:wait`

Waits for jobs to finish: every active job in the session by default, or the ids you name.

```text
/codex:wait
/codex:wait task-a task-b task-c --timeout-ms 3600000
/codex:wait task-a task-b --any
```

It exits 0 when every job completed, 1 when any failed or was cancelled, and 124 on timeout.

### `/codex:transfer`

Imports the current Claude Code session into a Codex thread with its turn history, so you can
carry on in Codex with `codex resume <session-id>`.

### `/codex:status`

Shows running and recent jobs, with each job's name, runtime (sandbox, network, model, effort)
and follow-up links.

```text
/codex:status
/codex:status task-mfx1-ab12cd
```

### `/codex:result`

Shows a finished job's final output, including the Codex session id for `codex resume`.

```text
/codex:result task-mfx1-ab12cd
/codex:result task-mfx1-ab12cd --output reports/research.md
```

### `/codex:cancel`

Cancels an active background job.

## Scripting with `orvex-codex`

The launcher runs the same runtime as the slash commands, so scripts and orchestrators can drive
Codex directly:

```bash
id=$(orvex-codex task --background --json --name research:linear --model gpt-6-luna \
  --cwd ~/worktrees/feature-x --prompt-file brief.md | jq -r .jobId)
orvex-codex send "$id" "also compare against the cached tickets"
orvex-codex wait "$id" --timeout-ms 3600000
orvex-codex result "$id" --output research-linear.md
```

- Every command accepts `--json`.
- Job ids resolve from any working directory.
- `--cwd` sets the repository Codex works in. It is also the writable root when the sandbox is
  `workspace-write`, so point each writing job at its own worktree.

## Choosing a sandbox

| Mode | Codex can | Use it for |
| --- | --- | --- |
| `read-only` | Read files, run read-only commands | Research, diagnosis, reviews |
| `workspace-write` | Edit files under `--cwd`; add `--network` for package installs and web access | Normal implementation in a worktree |
| `danger-full-access` | Anything your user account can do, including network, other directories and `.git` | Commits, pushes, Docker, cross-repo work on machines you trust |

Codex runs with approval policy `never`, so it never stops to ask for permission. With
`danger-full-access` nothing stands between Codex and your machine. Use it only where that is
acceptable, and prefer one worktree per job.

## Development

```bash
npm install
npm test
```

`npm test` runs the suite with the Claude Code session variables removed, so it passes from inside
a Claude Code session too.

Staying current with upstream:

```bash
git remote add upstream https://github.com/openai/codex-plugin-cc.git
git fetch upstream
git merge upstream/main
npm run bump-version -- <upstream-version>-orvex.1
npm test
```

## License

Apache License 2.0. This is a modified version of
[openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc); see `NOTICE` and
`plugins/codex/CHANGELOG.md` for the Orvex changes.
