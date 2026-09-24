---
description: Message a Codex job - steer it while it is running, or continue its thread once it has finished
argument-hint: '<job-id> [--background] [--no-follow-up] [--timeout-ms <ms>] <message>'
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" send "$ARGUMENTS"
```

How it behaves:
- If the job is still running, the message is delivered into its active turn and the command returns once Codex has accepted it (it waits up to 20 seconds; `--timeout-ms` changes that).
- If the job has finished, the command starts a follow-up job on the same Codex thread. The follow-up inherits the job's sandbox, network access, model and reasoning effort unless you pass new ones.
- `--background` runs a follow-up as a detached job; check it with `/codex:status` and `/codex:result`.
- `--no-follow-up` only ever steers a running job and never starts a follow-up.

Output rules:
- Present the command stdout to the user verbatim.
- If the command reports the message is still queued, tell the user it will be delivered when the running turn picks it up.
