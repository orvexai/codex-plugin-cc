# Codex 0.157.0 native daemon, queue, and exec surfaces

Probe date: 2026-09-25. CLI: `codex-cli 0.157.0`. Commands below did not change `~/.codex/config.toml` and did not start, stop, or reconfigure the daemon.

## 1. Can a plugin connect to the native daemon, run app-server turns, and survive disconnect?

Socket inspection:

```sh
ls -la ~/.codex/app-server-control ~/.codex/app-server-daemon
```

Observed: `app-server-control.sock` is a symlink to `/tmp/codex-daemon-1000/f311886fdcb4715687e7c98fcec42168e51a739f432ccc2012b4d4fb95430ed7`; `app-server-daemon/daemon.pid` and `daemon.stderr.log` exist.

```text
/home/crew/.codex/app-server-control:
total 12
drwx------  2 crew crew 4096 Sep 25 08:15 .
drwx------ 17 crew crew 4096 Sep 25 12:38 ..
lrwxrwxrwx  1 crew crew   87 Sep 25 08:15 app-server-control.sock -> /tmp/codex-daemon-1000/f311886fdcb4715687e7c98fcec42168e51a739f432ccc2012b4d4fb95430ed7
-rw-rw-r--  1 crew crew    0 Sep 25 08:15 app-server-startup.lock

/home/crew/.codex/app-server-daemon:
total 28
drwx------  2 crew crew 4096 Sep 25 08:15 .
drwx------ 17 crew crew 4096 Sep 25 12:38 ..
-rw-rw-r--  1 crew crew  151 Sep 25 08:15 daemon-updater.pid
-rw-rw-r--  1 crew crew    0 Sep 25 08:15 daemon-updater.pid.lock
srwxrwxr-x  1 crew crew    0 Sep 25 08:15 daemon-updater.sock
-rw-rw-r--  1 crew crew    0 Sep 25 08:15 daemon-updater.stderr.log
-rw-rw-r--  1 crew crew    0 Sep 25 08:15 daemon.lock
-rw-rw-r--  1 crew crew  301 Sep 25 08:15 daemon.pid
-rw-rw-r--  1 crew crew    0 Sep 25 08:15 daemon.pid.lock
-rw-rw-r--  1 crew crew 9608 Sep 25 11:20 daemon.stderr.log
```

Read-only daemon version command:

```sh
codex app-server daemon version
```

```json
{"status":"running","backend":"pid","managedCodexVersion":"0.157.0","socketPath":"/home/crew/.codex/app-server-control/app-server-control.sock","cliVersion":"0.157.0","appServerVersion":"0.157.0"}
```

The `codex agents` process does connect to that Unix socket. Command used to observe its `connect(2)`:

```sh
timeout 5s script -q -e -c 'timeout 2s strace -f -e trace=connect codex agents --no-alt-screen' /dev/null
```

Relevant output:

```text
connect(36, {sa_family=AF_UNIX, sun_path="/home/crew/.codex/app-server-control/app-server-control.sock"}, 63) = 0
```

I also sent a JSON-RPC `initialize` request to the documented stdio proxy:

```sh
printf '%s\n%s\n' '{"id":1,"method":"initialize","params":{"clientInfo":{"name":"m0-test","title":"M0","version":"1"},"capabilities":{"experimentalApi":true,"requestAttestation":false,"optOutNotificationMethods":[]}}}' '{"method":"initialized","params":{}}' | timeout 5s codex app-server proxy --sock ~/.codex/app-server-control/app-server-control.sock
```

Observed output was empty and exit status was 0. A persistent stdio JSON-RPC client received `failed to relay data between stdio and socket` / `Broken pipe (os error 32)` before an `initialize` response. It could not send `thread/start` or `turn/start` through this socket. Consequently, survival/disconnect behavior of a turn actually started through the native control socket is **not verified** here.

Direct app-server comparison: a persistent thread created with `codex app-server` in a fresh temp cwd ran one read-only turn. After closing that client/server, another `codex app-server` process successfully `thread/resume`d the same ID and read its completed turn and rollout path. This establishes persistence/resume for direct app-server threads; it does not establish native-daemon control-socket behavior.

Verdict: the socket exists and the CLI agents surface connects to it, but the documented proxy could not complete the JSON-RPC handshake from this client. The daemon has no tested interrupt-on-disconnect/ownership contract in this probe. This is a blocking compatibility gap for adopting it as the plugin's app-server transport.

## Manual probe safety gate

This is a mandatory precondition for any future manual reproduction involving `turn/start`, `review/start`, or `codex queue`. Start a new thread using a fresh temporary cwd and an explicit `sandbox: "read-only"`, `approvalPolicy: "never"`, and `ephemeral: false` (persistence is needed for the separate `codex queue` process). Inspect that exact `thread/start` response and proceed only when it reports `sandbox.type: "readOnly"`, `approvalPolicy: "never"`, and the fresh cwd requested. If any value is missing or differs, do not start a turn, run review, or queue a message. Never reuse a thread whose effective sandbox was not verified from its start response.

For example, the app-server request must have this form (with a newly created temporary directory in place of `<fresh-temp-cwd>`):

```json
{"method":"thread/start","params":{"cwd":"<fresh-temp-cwd>","sandbox":"read-only","approvalPolicy":"never","ephemeral":false}}
```

After any queue reproduction, list that thread's queue, delete every probe-created queued submission by its returned ID, and verify the queue is empty. Then delete the probe thread. Do not run `codex queue` against a thread started outside this gate. The scripted probes enforce explicit read-only sandbox values in their `thread/start` helper and skip turns if the effective response sandbox is not read-only.

## 2. Does `codex queue` steer a running turn or queue the next turn?

Help command:

```sh
codex queue --help
```

Relevant output:

```text
Queue a message for an existing session
Usage: codex queue [OPTIONS] --thread <THREAD> --message <TEXT>
```

Safety correction: the original native-surface capture used a thread started without an explicit sandbox. The probe later observed the host's configured `danger-full-access` value for that thread. A native review turn and queue messages were run against it. This violated the lane's read-only probe constraint; the session was subsequently deleted via `thread/delete` after `thread/queue/list` confirmed that no queued items remained. The rollout file no longer exists and `thread/read` now returns `thread not loaded`. An adjacent aborted probe-only rollout from the same originator and fresh temporary cwd had no discoverable sandbox value; its queue was empty and it was also deleted. These observations remain historical protocol evidence only. Do not repeat the commands against either removed thread or any thread that has not passed the manual probe safety gate above.

While a native review turn on the original probe-created app-server thread was active, this command was run:

```sh
codex queue --thread <historical probe thread> --message 'Queue probe during my review turn: reply exactly QUEUED.'
```

```text
Queued message <queue id> for thread <historical probe thread>.
```

`thread/queue/list` then returned that text as a queued submission. `turn/steer` for the active review turn returned `cannot steer a review turn`. After the initial turn completed, this command:

```sh
codex queue --thread <historical probe thread> --message 'After-turn queue probe: reply exactly AFTER-QUEUE.'
```

also returned a queued message ID for `<historical probe thread>`. A subsequent `thread/read` showed the previous turn still completed and `thread/queue/list` contained the new queued submission. Both probe messages were removed with `thread/queue/delete` after capture.

Verdict: `codex queue` accepts a thread created via direct app-server, including while a review is running, but queues a message for a later turn. It does not steer the active turn. It therefore is not a replacement for active-turn cancellation/steering or job ownership.

## 3. Does `codex agents` list plugin-started threads?

Commands:

```sh
codex agents --help
codex agents --no-alt-screen </dev/null
```

The help describes “Browse all agent sessions on the shared local app-server daemon” and exposes no JSON, list, or other non-interactive output flag. The second command returns:

```text
ERROR: stdin is not a terminal
```

The `strace` command in question 1 confirms that `codex agents` connects to the control socket. The proxy failure prevented starting a thread through that socket, and there is no non-interactive listing command with which to compare before/after thread inventories. Thus visibility of a plugin-started daemon thread is **not verified**. `codex queue` reaching the separately created direct app-server thread is evidence that queue lookup can address it, but is not proof that the interactive `agents` browser displays it.

Verdict: daemon-backed browser confirmed; non-interactive listing and plugin-thread visibility remain unverified.

## 4. What does `--dangerously-bypass-hook-trust` change?

Command:

```sh
codex --help
codex exec --help
```

Both help outputs say:

```text
--dangerously-bypass-hook-trust
    Run enabled hooks without requiring persisted hook trust for this invocation. DANGEROUS.
    Intended only for automation that already vets hook sources
```

This bypasses persisted trust gating for enabled hooks for that invocation. It does not disable hooks or suppress their context injection. No per-thread equivalent that disables hooks or AGENTS.md loading was verified: see the candidate `thread/start.config` probes in [app-server-probe.md](app-server-probe.md). `codex exec --help` also exposes `--ignore-user-config` and `--ignore-rules`; those are CLI flags and not per-thread app-server fields.

Verdict: the flag bypasses hook trust, not hook execution; it does not solve the hook-injection issue by itself.

## 5. `codex exec` output-schema and other available overlap

Command:

```sh
codex exec --help
```

Relevant output:

```text
--output-schema <FILE>
    Path to a JSON Schema file describing the model's final response shape
--json
    Print events to stdout as JSONL
--ephemeral
    Run without persisting session files to disk
```

This is useful for constrained one-shot structured output, but does not supply the plugin's persistent asynchronous job record, progress/result lifecycle, or ownership hooks.

## Decision

**Keep the plugin broker and reserve `transport: daemon` as a future option, consistent with plan D1.** The native socket path is discoverable and `codex queue` can append future-turn messages for an app-server-created thread, but the proxy JSON-RPC handshake failed in this environment, `codex agents` cannot be queried non-interactively, queue is not steering, and review turns explicitly reject `turn/steer`. Direct `thread/resume` gives persistent history without a daemon unload operation, but does not resolve the daemon transport compatibility gap. Do not remove broker ownership, cancellation, or health behavior on this evidence. Supporting `direct` remains the current app-server subprocess mode; this probe does not recommend adding `daemon` until the proxy interaction and disconnect contract can be reproduced.

## Changes to report items

These are proposed edits for the orchestrator to apply to the report and plan; this lane does not edit either source document.

- **BUG-1:** Keep broker-owned jobs and cancellation. `codex queue` only schedules a subsequent turn; it does not stop the running turn. No native socket turn/interrupt contract was established.
- **BUG-3:** Keep broker lifecycle ownership. Do not rely on shared daemon shutdown/unload semantics; `thread/unload` is absent and the native proxy behavior remains unresolved.
- **BUG-5:** Omitted-sandbox `thread/start` was verified in isolated scratch `CODEX_HOME` homes: `workspace-write` and `read-only` config values each appeared as the effective response sandbox. On this host, `config/read` separately reports `danger-full-access`; the probe never starts a no-sandbox thread under the user's home. The plugin should not silently force read-only while describing it as Codex default.
- **BUG-10:** The actual `ThreadStartResponse` carries effective `model`, `reasoningEffort`, `sandbox`, `approvalPolicy`, and `cwd`; read them from the response and distinguish requested values from those returned.
- **BUG-11:** Persistent `thread/read` exposes `path` and turn statuses, and `thread/resume` returns the history from another direct app-server process. On this host, resume reported `dangerFullAccess` even though the original thread was explicitly started `read-only`; verify the resumed effective sandbox before any further turn. No unload RPC exists.
- **FR-7:** Use `thread/read` for the nullable rollout `path`; request turns where available and preserve fallback handling because this build rejected `includeTurns:true` before a turn existed.
- **FR-12:** Use `model/list` response `data`, including `id`, `displayName`, `supportedReasoningEfforts`, `defaultReasoningEffort`, and `isDefault`; responses are cursor-paginated.
- **FR-13:** `developerInstructions` is accepted and demonstrably affects the turn. No per-thread disable key for skills, hooks, or AGENTS.md was verified; do not claim the tested config candidates are controls.
- **FR-20:** Describe queue delivery as later-turn scheduling. It worked on a direct app-server-created thread, remained queued after the current turn completed, and did not steer a review turn.
- **FR-22:** Keep broker observability and health commands. `codex agents` has no non-interactive inventory option, and native socket operation was not confirmed through the app-server proxy.
