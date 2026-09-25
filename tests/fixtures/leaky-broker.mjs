// Fixture for tests/isolation.test.mjs, run as a child `node --test` process.
// Deliberately leaks a detached broker (and its fake app-server) from a
// companion background task and never cleans up; tests/_isolation.mjs must
// reap them (or, when interrupted mid-run, the runner or watchdog must). Not picked up by `npm test` (not named *.test.mjs).
import "../_isolation.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import { makeCompanionWorkspace, waitFor, isPidAlive } from "../helpers.mjs";

const reportFile = process.env.ISOLATION_FIXTURE_REPORT;
const report = {
  pid: process.pid,
  sandbox: process.env.CODEX_PLUGIN_TEST_SANDBOX,
  home: os.homedir(),
  codexHome: process.env.CODEX_HOME,
  claudePluginData: process.env.CLAUDE_PLUGIN_DATA ?? null,
  sessionId: process.env.CODEX_COMPANION_SESSION_ID ?? null
};

function findNamedFile(root, name) {
  if (!fs.existsSync(root)) return null;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isFile() && entry.name === name) return file;
    if (entry.isDirectory()) {
      const found = findNamedFile(file, name);
      if (found) return found;
    }
  }
  return null;
}

test("leaks a broker from a background task", async () => {
  const workspace = await makeCompanionWorkspace("review-ok", { fakeOptions: { turnScript: [{ type: "delay", ms: 60000 }] } });
  const launched = workspace.companion(["task", "--background", "--json", "leak me"]);
  assert.equal(launched.status, 0, launched.stderr);
  report.jobId = JSON.parse(launched.stdout).jobId;
  const stateRoot = path.join(workspace.home, "plugin-data", "state");
  let brokerFile = null;
  await waitFor(() => (brokerFile = findNamedFile(stateRoot, "broker.json")) !== null, { timeoutMs: 15000 }).catch((error) => {
    const status = workspace.companion(["status", report.jobId, "--json"]);
    throw new Error(`${error.message}; no broker.json under ${stateRoot}; job status: ${status.stdout}${status.stderr}`);
  });
  let broker = null;
  await waitFor(() => { broker = JSON.parse(fs.readFileSync(brokerFile, "utf8")); return Boolean(broker.pid); }, { timeoutMs: 8000 });
  assert.ok(isPidAlive(broker.pid));
  report.brokerPid = broker.pid;
  report.brokerEndpoint = broker.endpoint ?? null;
  fs.writeFileSync(reportFile, JSON.stringify(report));
  // No cleanup on purpose. With ISOLATION_FIXTURE_HANG=1 stay "mid-run" so the
  // caller can interrupt or kill us while the broker is alive.
  if (process.env.ISOLATION_FIXTURE_HANG === "1") await new Promise((resolve) => setTimeout(resolve, 120000));
});
