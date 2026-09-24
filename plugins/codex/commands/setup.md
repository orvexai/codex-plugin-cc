---
description: Check whether the local Codex CLI is ready and optionally toggle the stop-time review gate
argument-hint: '[--enable-review-gate|--disable-review-gate] [--default-model <model|none>] [--default-effort <effort|none>] [--default-sandbox <read-only|workspace-write|danger-full-access|none>] [--default-network <on|off|none>] [--global] [--install-cli [--bin-dir <dir>]]'
allowed-tools: Bash(node:*), Bash(npm:*), AskUserQuestion
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" setup --json $ARGUMENTS
```

If the result says Codex is unavailable and npm is available:
- Use `AskUserQuestion` exactly once to ask whether Claude should install Codex now.
- Put the install option first and suffix it with `(Recommended)`.
- Use these two options:
  - `Install Codex (Recommended)`
  - `Skip for now`
- If the user chooses install, run:

```bash
npm install -g @openai/codex
```

- Then rerun:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" setup --json $ARGUMENTS
```

If Codex is already installed or npm is unavailable:
- Do not ask about installation.

Defaults and launcher:
- `--default-model`, `--default-effort`, `--default-sandbox` and `--default-network` store task defaults for this repository; add `--global` to store them for every repository. `none` clears a default.
- `--install-cli` installs the stable `orvex-codex` launcher (default `~/.local/bin`), so scripts and permission rules can call `orvex-codex task ...` instead of a versioned plugin path.

Output rules:
- Present the final setup output to the user.
- If installation was skipped, present the original setup output.
- If Codex is installed but not authenticated, preserve the guidance to run `!codex login`.
