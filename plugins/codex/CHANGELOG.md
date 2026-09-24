# Changelog

## 1.0.6-orvex.1

Orvex flavour, forked from openai/codex-plugin-cc 1.0.6.

- `task`: `--sandbox <read-only|workspace-write|danger-full-access>`, `--full-access`, `--read-only`, `--network`/`--no-network` and `--name <label>`. `--write` never narrows a configured full-access default.
- `send <job-id>`: steers a running job's active turn through `turn/steer`, or continues a finished job's thread in a follow-up job that inherits its runtime.
- `wait [job-id...]`: waits for several jobs (or every active job in the session); exits 0, 1 on failure or cancellation, 124 on timeout.
- `result --output <file>` writes a job's raw final output to a file.
- `setup --default-model/--default-effort/--default-sandbox/--default-network`, per repository or `--global`, with `CODEX_COMPANION_*` environment overrides.
- `setup --install-cli` installs the stable `orvex-codex` launcher; session start keeps it pointed at the current plugin version.
- Job state: a cross-process lock and atomic writes, so parallel jobs no longer overwrite each other's status; history kept for 200 jobs; job ids resolve across workspaces.
- Broker: a failed mid-turn request no longer orphans the running turn's notifications.
- Follow-ups: when another Codex process still holds a finished job's thread (the shared broker keeps threads loaded), `send` continues on a `thread/fork` of it, so no history is lost.
- The `codex:codex-rescue` forwarder runs on Haiku.
- `npm test` scrubs Claude Code session variables so the suite passes inside a Claude Code session.

## 1.0.0

- Initial version of the Codex plugin for Claude Code
