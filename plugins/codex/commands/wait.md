---
description: Wait for one or more Codex jobs to finish (default - every active job in this session)
argument-hint: '[job-id ...] [--any] [--timeout-ms <ms>]'
allowed-tools: Bash(node:*)
---

Run this with `Bash(..., run_in_background: true)` so the session stays responsive, and report back when it exits:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" wait "$ARGUMENTS"
```

- With no job ids it waits for every active job started in this session.
- `--any` returns as soon as one of the jobs finishes.
- The default timeout is 60 minutes. Exit code 0 means every job completed, 1 means at least one failed or was cancelled, 124 means the timeout was reached first.

Output rules:
- Present the command stdout to the user verbatim.
- Point the user at `/codex:result <job-id>` for each finished job.
