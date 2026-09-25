// Imported FIRST by every tests/*.test.mjs (tests/isolation.test.mjs checks
// this). Plugin modules read os.tmpdir()/os.homedir()/process.env at load
// time, so this must be evaluated before any of them.
//
// Gives this test process its own sandbox (HOME, CODEX_HOME, XDG_*, TMPDIR,
// plugin config, launcher bin dir), strips inherited Claude/companion session
// variables, shadows the real `codex` with a guard that exits 97, and reaps
// every process referencing the sandbox when the file's tests finish and when
// the process exits. Works under `npm test` (nested inside the runner's
// sandbox) and under a bare `node --test tests/<file>`.
import fs from "node:fs";
import os from "node:os";
import process from "node:process";
import { after } from "node:test";

import {
  applySandboxEnv,
  assertRealCodexUnreachable,
  createSandbox,
  reapSandboxProcesses,
  startWatchdog
} from "../scripts/test-sandbox.mjs";

const sandbox = createSandbox({ parent: os.tmpdir() });
applySandboxEnv(process.env, sandbox);
assertRealCodexUnreachable(sandbox);
// Backstop for deaths where no hook here runs (SIGKILL, node --test tearing
// the process down on Ctrl-C): reaps the sandbox once this process is gone.
const watchdogPid = startWatchdog(sandbox.root);

let removed = false;
function reap({ keepWatchdog = false } = {}) {
  const { survivors } = reapSandboxProcesses(sandbox.root, { excludePids: keepWatchdog && watchdogPid ? [watchdogPid] : [] });
  if (survivors.length > 0) {
    process.stderr.write(`[test-isolation] ${survivors.length} process(es) survived reaping in ${sandbox.root}:\n${survivors.map((p) => `  ${p.pid} ${p.args}`).join("\n")}\n`);
  }
  return survivors;
}

function reapAndRemove() {
  if (removed) return;
  removed = true;
  const survivors = reap();
  if (survivors.length === 0) {
    try {
      fs.rmSync(sandbox.root, { recursive: true, force: true });
    } catch {
      // Best effort; the runner removes its whole tree anyway.
    }
  }
}

after(() => {
  reap({ keepWatchdog: true });
});
process.once("exit", reapAndRemove);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, () => {
    reapAndRemove();
    process.exit(128 + (os.constants.signals[signal] ?? 1));
  });
}

export const testSandbox = sandbox;
export const testWatchdogPid = watchdogPid;
export default sandbox;
