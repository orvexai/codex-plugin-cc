import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { appendControlOp, ackControlOp, readControlAck, readControlOps, resolveControlFile, waitForControlAck } from "../plugins/codex/scripts/lib/control-channel.mjs";
import { makeTempDir, spawnStubborn, waitFor, isPidAlive } from "./helpers.mjs";
import { readProcessStartTime, terminateProcessTreeVerified } from "../plugins/codex/scripts/lib/process.mjs";
import { makeCompanionWorkspace } from "./helpers.mjs";
import { fakeConnections, occupyBroker, readFakeRpcLog } from "./fake-codex-fixture.mjs";
import { renderCancelReport } from "../plugins/codex/scripts/lib/render.mjs";
import { reconcileJob, reconcileJobDeep } from "../plugins/codex/scripts/lib/job-liveness.mjs";

function workspaceJobFile(workspace, id) {
  const root = path.join(workspace.home, "plugin-data", "state");
  const stateName = fs.readdirSync(root).find((name) => fs.existsSync(path.join(root, name, "jobs", `${id}.json`)));
  return path.join(root, stateName, "jobs", `${id}.json`);
}
function jobStateDir(workspace, id) { return path.dirname(path.dirname(workspaceJobFile(workspace, id))); }

function findNamedFile(root, name) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isFile() && entry.name === name) return file;
    if (entry.isDirectory()) { const found = findNamedFile(file, name); if (found) return found; }
  }
  return null;
}

test("control channel reads only complete lines and persists acknowledgements", async () => {
  const root = makeTempDir("codex-control-");
  const first = appendControlOp(root, "job-1", { op: "cancel", reason: "session-ended" });
  const file = resolveControlFile(root, "job-1");
  fs.appendFileSync(file, '{"op":"cancel"');
  const entries = readControlOps(file, 0);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].op, "cancel");
  assert.equal(entries[0].id, first.id);
  ackControlOp(root, "job-1", first.id, { turnConfirmedStopped: true });
  assert.equal(readControlAck(root, "job-1", first.id).turnConfirmedStopped, true);
  assert.equal((await waitForControlAck(root, "job-1", first.id, 20, 1)).turnConfirmedStopped, true);
});

test("interrupt control op is delivered and acknowledged without cancelling the job", async (t) => {
  const workspace = await makeCompanionWorkspace("review-ok", { fakeOptions: { turnScript: [{ type: "delay", ms: 30000 }] } });
  t.after(() => workspace.close());
  const launched = workspace.companion(["task", "--background", "--json", "interrupt control op"]);
  assert.equal(launched.status, 0, launched.stderr);
  const id = JSON.parse(launched.stdout).jobId;
  const jobFile = workspaceJobFile(workspace, id);
  await waitFor(() => { try { return JSON.parse(fs.readFileSync(jobFile, "utf8")).turnId; } catch { return false; } }, { timeoutMs: 8000 });
  const oldPluginData = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = path.join(workspace.home, "plugin-data");
  let operation;
  let ack;
  try {
    operation = appendControlOp(workspace.repo, id, { op: "interrupt", reason: "owner-yield" });
    ack = await waitForControlAck(workspace.repo, id, operation.id, 1500, 20);
  }
  finally { if (oldPluginData === undefined) delete process.env.CLAUDE_PLUGIN_DATA; else process.env.CLAUDE_PLUGIN_DATA = oldPluginData; }
  assert.ok(ack, "interrupt control op should be acknowledged");
  assert.equal(ack.interruptDelivered, true);
  assert.equal(ack.turnConfirmedStopped, true);
  await waitFor(() => { try { return ["completed", "failed"].includes(JSON.parse(fs.readFileSync(jobFile, "utf8")).status); } catch { return false; } }, { timeoutMs: 5000 });
  assert.notEqual(JSON.parse(fs.readFileSync(jobFile, "utf8")).status, "cancelled");
});

test("verified process termination escalates when SIGTERM is ignored", async (t) => {
  const stubborn = spawnStubborn();
  t.after(() => stubborn.kill());
  const pid = await stubborn.ready;
  const result = await terminateProcessTreeVerified(pid, { group: false, graceMs: 20, killWaitMs: 500 });
  assert.equal(result.delivered, true);
  assert.equal(result.exited, true);
  assert.equal(result.escalated, true);
  await waitFor(() => !result.residualPids.includes(pid), { timeoutMs: 100, intervalMs: 5 });
});

test("cooperative background cancel verifies the turn and stops further command output", async (t) => {
  const workspace = await makeCompanionWorkspace("review-ok", { fakeOptions: {
    turnScript: [{ type: "command", command: "before cancel" }, { type: "delay", ms: 5000 }, { type: "command", command: "after cancel" }]
  } });
  t.after(() => workspace.close());
  const short = { CODEX_COMPANION_CONTROL_POLL_MS: "20", CODEX_COMPANION_CONTROL_ACK_MS: "2000", CODEX_COMPANION_CANCEL_GRACE_MS: "2500", CODEX_COMPANION_KILL_WAIT_MS: "1000" };
  const launched = workspace.companion(["task", "--background", "--json", "slow cancellation test"], { env: short });
  assert.equal(launched.status, 0, launched.stderr);
  const jobId = JSON.parse(launched.stdout).jobId;
  const stateDir = path.join(workspace.home, "plugin-data", "state", fs.readdirSync(path.join(workspace.home, "plugin-data", "state"))[0]);
  const jobFile = path.join(stateDir, "jobs", `${jobId}.json`);
  await waitFor(() => {
    try { const job = JSON.parse(fs.readFileSync(jobFile, "utf8")); return job.turnId ? job : null; } catch { return null; }
  }, { timeoutMs: 10000 });
  const running = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  assert.equal(running.transport === "broker" || running.transport === "direct", true, JSON.stringify(running));
  const cancelled = workspace.companion(["cancel", jobId, "--json"], { env: short });
  assert.equal(cancelled.status, 0, cancelled.stderr);
  const cancel = JSON.parse(cancelled.stdout).cancel;
  assert.equal(JSON.parse(cancelled.stdout).status, "cancelled");
  assert.equal(cancel.turnConfirmedStopped, true);
  assert.equal(cancel.detail, "Turn stop and worker exit verified.");
  const log = fs.readFileSync(running.logFile, "utf8");
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.equal(fs.readFileSync(running.logFile, "utf8").includes("after cancel"), false);
  const turnStart = readFakeRpcLog(workspace.binDir, { method: "turn/start", dir: "out" })[0];
  const turnInterrupt = readFakeRpcLog(workspace.binDir, { method: "turn/interrupt", dir: "out" })[0];
  assert.ok(turnInterrupt);
  assert.equal(turnInterrupt.conn, turnStart.conn);
  assert.ok(fakeConnections(workspace.binDir).length > 0);
  assert.match(log, /before cancel/);
  const textReport = workspace.companion(["cancel", jobId]).stdout;
  assert.match(textReport, /Interrupt: delivered \(Turn stop and worker exit verified\.\)/);
  assert.match(textReport, /Verification: verified stopped/);
});

test("queued cancellation is acknowledged before thread/start and never starts a turn", async (t) => {
  const workspace = await makeCompanionWorkspace("review-ok", { fakeOptions: { delays: { threadStart: 3000 } } });
  t.after(() => workspace.close());
  const launched = workspace.companion(["task", "--background", "--json", "queued cancel"]);
  assert.equal(launched.status, 0, launched.stderr);
  const id = JSON.parse(launched.stdout).jobId;
  const cancelled = workspace.companion(["cancel", id, "--json"], { env: { CODEX_COMPANION_CONTROL_ACK_MS: "500", CODEX_COMPANION_KILL_WAIT_MS: "500" } });
  assert.equal(cancelled.status, 0, cancelled.stderr);
  assert.equal(JSON.parse(cancelled.stdout).status, "cancelled");
  const textReport = workspace.companion(["cancel", id]).stdout;
  assert.match(textReport, /Interrupt: not confirmed/);
  assert.match(textReport, /Verification: verified stopped/);
  const starts = readFakeRpcLog(workspace.binDir, { method: "turn/start", dir: "out" });
  assert.equal(starts.length, 0);
});

test("cancel does not report the shared broker as a process residual", async (t) => {
  const workspace = await makeCompanionWorkspace("review-ok", { fakeOptions: {
    interrupt: "ignore",
    ignoreSigterm: true,
    turnScript: [{ type: "delay", ms: 30000 }]
  } });
  t.after(() => workspace.close());
  const short = { CODEX_COMPANION_CONTROL_POLL_MS: "10", CODEX_COMPANION_CONTROL_ACK_MS: "100", CODEX_COMPANION_CANCEL_GRACE_MS: "100", CODEX_COMPANION_KILL_WAIT_MS: "100", CODEX_COMPANION_KILL_VERIFY_MS: "500" };
  const launched = workspace.companion(["task", "--background", "--json", "ignore interruption"], { env: short });
  assert.equal(launched.status, 0, launched.stderr);
  const id = JSON.parse(launched.stdout).jobId;
  const jobFile = workspaceJobFile(workspace, id);
  await waitFor(() => { try { const job = JSON.parse(fs.readFileSync(jobFile, "utf8")); return job.turnId ? job : null; } catch { return false; } }, { timeoutMs: 8000 });
  const brokerFile = findNamedFile(jobStateDir(workspace, id), "broker.json");
  const broker = JSON.parse(fs.readFileSync(brokerFile, "utf8"));
  const cancelled = workspace.companion(["cancel", id, "--json", "--force"], { env: short });
  const payload = JSON.parse(cancelled.stdout);
  assert.equal(cancelled.status, 2, cancelled.stdout + cancelled.stderr);
  assert.equal(payload.status, "cancel-failed");
  assert.equal(payload.cancel.workerExited, true);
  assert.equal(payload.cancel.escalated, true);
  assert.equal(payload.error.code, "cancel-failed");
  assert.equal(payload.cancel.residualPids.includes(broker.pid), false, JSON.stringify(payload.cancel));
  assert.ok(payload.cancel.residualTurns.length > 0, JSON.stringify(payload.cancel));
  assert.deepEqual(payload.cancel.residualTurns, [{ threadId: JSON.parse(fs.readFileSync(jobFile, "utf8")).threadId, turnId: JSON.parse(fs.readFileSync(jobFile, "utf8")).turnId, brokerEndpoint: JSON.parse(fs.readFileSync(jobFile, "utf8")).brokerEndpoint }]);
});

test("ignored interrupt plus ignored SIGTERM verifies a direct worker after SIGKILL", async (t) => {
  const workspace = await makeCompanionWorkspace("review-ok", { fakeOptions: {
    interrupt: "ignore",
    ignoreSigterm: true,
    turnScript: [{ type: "delay", ms: 30000 }]
  } });
  t.after(() => workspace.close());
  const short = { CODEX_COMPANION_CONTROL_POLL_MS: "10", CODEX_COMPANION_CONTROL_ACK_MS: "100", CODEX_COMPANION_CANCEL_GRACE_MS: "100", CODEX_COMPANION_KILL_WAIT_MS: "100", CODEX_COMPANION_KILL_VERIFY_MS: "500" };
  const unavailableEndpoint = `unix:${path.join(workspace.home, "missing-broker.sock")}`;
  const launched = workspace.companion(["task", "--background", "--json", "ignore direct interruption"], { env: { ...short, CODEX_COMPANION_APP_SERVER_ENDPOINT: unavailableEndpoint } });
  assert.equal(launched.status, 0, launched.stderr);
  const id = JSON.parse(launched.stdout).jobId;
  const jobFile = workspaceJobFile(workspace, id);
  await waitFor(() => { try { const job = JSON.parse(fs.readFileSync(jobFile, "utf8")); return job.transport === "direct" && job.turnId ? job : false; } catch { return false; } }, { timeoutMs: 8000 });
  const job = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  const cancelled = workspace.companion(["cancel", id, "--json", "--force"], { env: short });
  const payload = JSON.parse(cancelled.stdout);
  assert.equal(payload.cancel.escalated, true);
  assert.equal(payload.cancel.workerExited, true);
  if (cancelled.status === 0) {
    assert.equal(payload.status, "cancelled", cancelled.stdout);
    assert.equal(payload.cancel.turnConfirmedStopped, true);
    assert.equal(payload.cancel.appServerExited, true);
    assert.deepEqual(payload.cancel.residualPids, []);
  } else {
    assert.equal(cancelled.status, 2, cancelled.stderr || cancelled.stdout);
    assert.equal(payload.status, "cancel-failed", cancelled.stdout);
    assert.equal(payload.error.code, "cancel-failed");
    assert.equal(payload.cancel.turnConfirmedStopped, false);
    assert.equal(payload.cancel.appServerExited, false);
    assert.ok(payload.cancel.residualPids.length > 0, JSON.stringify(payload.cancel));
    assert.ok(payload.cancel.residualPids.includes(job.appServerPid), JSON.stringify(payload.cancel));
  }
  assert.equal(readFakeRpcLog(workspace.binDir, { method: "turn/interrupt", dir: "in" }).some((entry) => entry.params?.threadId === job.threadId), true);
});

test("direct cancellation reports an app-server PID that survives worker SIGKILL", async (t) => {
  const workspace = await makeCompanionWorkspace("review-ok", { fakeOptions: {
    interrupt: "ignore",
    ignoreSigterm: true,
    turnScript: [{ type: "delay", ms: 30000 }]
  } });
  const stubborn = spawnStubborn();
  t.after(() => { stubborn.kill(); workspace.close(); });
  const survivorPid = await stubborn.ready;
  const short = { CODEX_COMPANION_CONTROL_POLL_MS: "10", CODEX_COMPANION_CONTROL_ACK_MS: "100", CODEX_COMPANION_CANCEL_GRACE_MS: "100", CODEX_COMPANION_KILL_WAIT_MS: "100", CODEX_COMPANION_KILL_VERIFY_MS: "500" };
  const unavailableEndpoint = `unix:${path.join(workspace.home, "missing-broker.sock")}`;
  const launched = workspace.companion(["task", "--background", "--json", "force residual pid evidence"], { env: { ...short, CODEX_COMPANION_APP_SERVER_ENDPOINT: unavailableEndpoint } });
  assert.equal(launched.status, 0, launched.stderr);
  const id = JSON.parse(launched.stdout).jobId;
  const jobFile = workspaceJobFile(workspace, id);
  await waitFor(() => { try { const job = JSON.parse(fs.readFileSync(jobFile, "utf8")); return job.transport === "direct" && job.turnId ? job : false; } catch { return false; } }, { timeoutMs: 8000 });
  const job = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  fs.writeFileSync(jobFile, JSON.stringify({ ...job, appServerPid: survivorPid, appServerStartTime: readProcessStartTime(survivorPid) }, null, 2));
  const cancelled = workspace.companion(["cancel", id, "--json", "--force"], { env: short });
  const payload = JSON.parse(cancelled.stdout);
  assert.equal(cancelled.status, 2, cancelled.stdout + cancelled.stderr);
  assert.equal(payload.status, "cancel-failed");
  assert.equal(payload.cancel.workerExited, true);
  assert.equal(payload.cancel.appServerExited, false);
  assert.ok(payload.cancel.residualPids.includes(survivorPid), JSON.stringify(payload.cancel));
});

test("cancel renderer reports delivered, not-delivered, and missing-broker interrupts", async (t) => {
  const cases = [
    [{ id: "delivered", status: "cancelled", cancel: { interruptDelivered: true, turnConfirmedStopped: true, workerExited: true } }, /Interrupt: delivered/, /Verification: verified stopped/],
    [{ id: "undelivered", status: "cancel-failed", cancel: { interruptDelivered: false, turnConfirmedStopped: false, workerExited: true } }, /Interrupt: not confirmed/, /Verification: not verified/],
    [{ id: "broker-gone", status: "cancel-failed", cancel: { interruptDelivered: false, turnConfirmedStopped: false, workerExited: true, detail: "broker-not-found" } }, /Interrupt: not confirmed \(broker-not-found\)/, /Verification: not verified/]
  ];
  for (const [job, interruptLine, verificationLine] of cases) {
    const report = renderCancelReport(job);
    assert.match(report, interruptLine);
    assert.match(report, verificationLine);
  }
  const workspace = await makeCompanionWorkspace("review-ok", { fakeOptions: { turnScript: [{ type: "delay", ms: 30000 }] } });
  t.after(() => workspace.close());
  const launched = workspace.companion(["task", "--background", "--json", "render missing broker outcome"]);
  assert.equal(launched.status, 0, launched.stderr);
  const id = JSON.parse(launched.stdout).jobId;
  const jobFile = workspaceJobFile(workspace, id);
  await waitFor(() => { try { return JSON.parse(fs.readFileSync(jobFile, "utf8")).turnId; } catch { return false; } }, { timeoutMs: 8000 });
  const job = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  const brokerFile = findNamedFile(jobStateDir(workspace, id), "broker.json");
  const broker = JSON.parse(fs.readFileSync(brokerFile, "utf8"));
  try { process.kill(job.worker.pid, "SIGKILL"); } catch {}
  try { process.kill(broker.pid, "SIGKILL"); } catch {}
  const text = workspace.companion(["cancel", id]).stdout;
  assert.match(text, /Interrupt: not confirmed \(broker-not-found\)/);
  assert.match(text, /Verification: not verified/);
});

test("broker-busy direct worker receives interrupt on its own connection", async (t) => {
  const workspace = await makeCompanionWorkspace("interruptible-slow-task");
  t.after(() => workspace.close());
  const bootstrap = workspace.companion(["task", "--background", "--json", "start broker"]);
  assert.equal(bootstrap.status, 0, bootstrap.stderr);
  const bootstrapId = JSON.parse(bootstrap.stdout).jobId;
  const bootstrapFile = workspaceJobFile(workspace, bootstrapId);
  await waitFor(() => { try { return JSON.parse(fs.readFileSync(bootstrapFile, "utf8")).status === "completed"; } catch { return false; } }, { timeoutMs: 10000 });
  const brokerFile = findNamedFile(jobStateDir(workspace, bootstrapId), "broker.json");
  assert.ok(brokerFile);
  const broker = JSON.parse(fs.readFileSync(brokerFile, "utf8"));
  const occupying = await occupyBroker(broker.endpoint, { holdMs: 500 });
  t.after(() => occupying.release());
  const launched = workspace.companion(["task", "--background", "--json", "force direct fallback"]);
  assert.equal(launched.status, 0, launched.stderr);
  const id = JSON.parse(launched.stdout).jobId;
  const jobFile = workspaceJobFile(workspace, id);
  await waitFor(() => { try { const job = JSON.parse(fs.readFileSync(jobFile, "utf8")); return job.transport === "direct" && job.turnId ? job : false; } catch { return false; } }, { timeoutMs: 5000 });
  const job = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  assert.equal(job.transport, "direct");
  assert.ok(Object.hasOwn(job, "brokerEndpoint"));
  assert.ok(Number(job.appServerPid) > 0);
  const cancelled = workspace.companion(["cancel", id, "--json"], { env: { CODEX_COMPANION_CONTROL_ACK_MS: "500", CODEX_COMPANION_CANCEL_GRACE_MS: "100", CODEX_COMPANION_KILL_WAIT_MS: "100" } });
  assert.equal(cancelled.status, 0, cancelled.stderr);
  assert.equal(JSON.parse(cancelled.stdout).status, "cancelled");
  const start = readFakeRpcLog(workspace.binDir, { method: "turn/start", dir: "in" }).find((entry) => entry.params?.threadId === job.threadId);
  const interrupt = readFakeRpcLog(workspace.binDir, { method: "turn/interrupt", dir: "in" }).find((entry) => entry.params?.threadId === job.threadId && entry.params?.turnId === job.turnId);
  assert.ok(start);
  assert.ok(interrupt);
  assert.equal(interrupt.conn, start.conn);
  occupying.release();
});

test("control-op reason is persisted as cancelReason", async (t) => {
  const workspace = await makeCompanionWorkspace("review-ok", { fakeOptions: { turnScript: [{ type: "delay", ms: 30000 }] } });
  t.after(() => workspace.close());
  const launched = workspace.companion(["task", "--background", "--json", "cancel reason propagation"]);
  assert.equal(launched.status, 0, launched.stderr);
  const id = JSON.parse(launched.stdout).jobId;
  const jobFile = workspaceJobFile(workspace, id);
  await waitFor(() => { try { return JSON.parse(fs.readFileSync(jobFile, "utf8")).turnId; } catch { return false; } }, { timeoutMs: 8000 });
  const job = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  const oldPluginData = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = path.join(workspace.home, "plugin-data");
  let opId;
  try { ({ id: opId } = appendControlOp(workspace.repo, id, { op: "cancel", reason: "session-ended" })); }
  finally { if (oldPluginData === undefined) delete process.env.CLAUDE_PLUGIN_DATA; else process.env.CLAUDE_PLUGIN_DATA = oldPluginData; }
  const opsFile = path.join(jobStateDir(workspace, id), "jobs", `${id}.control.jsonl`);
  assert.equal(readControlOps(opsFile, 0).find((entry) => entry.id === opId)?.reason, "session-ended");
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const saved = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  assert.equal(saved.status, "cancelled", JSON.stringify(saved));
  assert.equal(saved.cancelReason, "session-ended", JSON.stringify(saved));
  assert.ok(opId);
});

test("cancel preserves a terminal completion written while cancellation is waiting", async (t) => {
  const workspace = await makeCompanionWorkspace("review-ok", { fakeOptions: { interrupt: "ignore", turnScript: [{ type: "silence" }] } });
  t.after(() => workspace.close());
  let workerGroup = null;
  t.after(() => { if (workerGroup) { try { process.kill(-workerGroup, "SIGKILL"); } catch {} } });
  const jobEnv = {
    CODEX_COMPANION_APP_SERVER_ENDPOINT: `unix:${path.join(workspace.home, "missing-broker.sock")}`,
    CODEX_COMPANION_CONTROL_POLL_MS: "5000",
    CODEX_COMPANION_CONTROL_ACK_MS: "100"
  };
  const launched = workspace.companion(["task", "--background", "--json", "finish during cancel"], { env: jobEnv });
  assert.equal(launched.status, 0, launched.stderr);
  const id = JSON.parse(launched.stdout).jobId;
  const jobFile = workspaceJobFile(workspace, id);
  await waitFor(() => { try { const job = JSON.parse(fs.readFileSync(jobFile, "utf8")); return job.transport === "direct" && job.turnId; } catch { return false; } }, { timeoutMs: 8000 });
  const runningJob = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  workerGroup = runningJob.worker.pid;
  const cancel = workspace.spawnCompanion(["cancel", id, "--json"], { env: { ...jobEnv, CODEX_COMPANION_CANCEL_GRACE_MS: "2000", CODEX_COMPANION_KILL_WAIT_MS: "100", CODEX_COMPANION_KILL_VERIFY_MS: "500" } });
  const output = [];
  cancel.stdout.setEncoding("utf8");
  cancel.stdout.on("data", (chunk) => output.push(chunk));
  const controlFile = path.join(path.dirname(jobFile), `${id}.control.jsonl`);
  await waitFor(() => fs.existsSync(controlFile) && fs.readFileSync(controlFile, "utf8").trim(), { timeoutMs: 3000 });
  const competingCompletion = {
    ...JSON.parse(fs.readFileSync(jobFile, "utf8")),
    status: "completed",
    phase: "done",
    completedAt: new Date().toISOString(),
    result: { rawOutput: "Naturally completed before cancel finalized" }
  };
  fs.writeFileSync(jobFile, JSON.stringify(competingCompletion, null, 2));
  const exitCode = await new Promise((resolve, reject) => {
    cancel.once("error", reject);
    cancel.once("close", (code) => resolve(code));
  });
  const payload = JSON.parse(output.join(""));
  const finalJob = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  assert.equal(exitCode, 0);
  assert.equal(payload.status, "completed");
  assert.equal(finalJob.status, "completed");
  assert.equal(finalJob.result?.rawOutput, "Naturally completed before cancel finalized");
});

test("stale broker cancellation reports broker-not-found without starting an app-server", async (t) => {
  const workspace = await makeCompanionWorkspace("review-ok", { fakeOptions: { turnScript: [{ type: "delay", ms: 30000 }] } });
  t.after(() => workspace.close());
  const launched = workspace.companion(["task", "--background", "--json", "stale broker cancel"]);
  assert.equal(launched.status, 0, launched.stderr);
  const id = JSON.parse(launched.stdout).jobId;
  const jobFile = workspaceJobFile(workspace, id);
  await waitFor(() => { try { const job = JSON.parse(fs.readFileSync(jobFile, "utf8")); return job.turnId ? job : false; } catch { return false; } }, { timeoutMs: 8000 });
  const job = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  const brokerFile = findNamedFile(jobStateDir(workspace, id), "broker.json");
  const broker = JSON.parse(fs.readFileSync(brokerFile, "utf8"));
  try { process.kill(job.worker.pid, "SIGKILL"); } catch {}
  try { process.kill(broker.pid, "SIGKILL"); } catch {}
  const before = workspace.fakeState().appServerStarts;
  const startedAt = Date.now();
  const cancelled = workspace.companion(["cancel", id, "--json"]);
  const elapsedMs = Date.now() - startedAt;
  const payload = JSON.parse(cancelled.stdout);
  assert.equal(payload.status, "cancel-failed");
  assert.equal(payload.cancel.detail, "broker-not-found");
  assert.equal(workspace.fakeState().appServerStarts, before);
  assert.ok(elapsedMs < 3000, `stale broker cancellation took ${elapsedMs}ms`);
});

test("status and wait deep reconcile broker turns through the CLI", async (t) => {
  const workspace = await makeCompanionWorkspace("review-ok", { fakeOptions: { turnScript: [{ type: "delay", ms: 5000 }] } });
  t.after(() => workspace.close());
  let workerGroup = null;
  t.after(() => { if (workerGroup) { try { process.kill(-workerGroup, "SIGKILL"); } catch {} } });
  const launched = workspace.companion(["task", "--background", "--detach", "--json", "deep reconcile through CLI"]);
  assert.equal(launched.status, 0, launched.stderr);
  const id = JSON.parse(launched.stdout).jobId;
  const jobFile = workspaceJobFile(workspace, id);
  await waitFor(() => {
    try {
      const job = JSON.parse(fs.readFileSync(jobFile, "utf8"));
      return job.transport === "broker" && job.turnId && job.worker?.pid;
    } catch { return false; }
  }, { timeoutMs: 8000 });
  const job = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  workerGroup = job.worker.pid;
  try { process.kill(job.worker.pid, "SIGKILL"); } catch {}

  const statusStartedAt = Date.now();
  const activeStatus = workspace.companion(["status", id, "--json"]);
  const statusElapsedMs = Date.now() - statusStartedAt;
  assert.equal(activeStatus.status, 0, activeStatus.stderr);
  assert.ok(statusElapsedMs < 2500, `deep status took ${statusElapsedMs}ms`);
  assert.equal(JSON.parse(activeStatus.stdout).job.status, "orphaned");

  const waited = workspace.companion(["wait", id, "--json", "--timeout-ms", "100", "--poll-interval-ms", "50"]);
  assert.equal(waited.status, 3, waited.stderr || waited.stdout);
  assert.equal(JSON.parse(waited.stdout).jobs[0].status, "orphaned");

  await new Promise((resolve) => setTimeout(resolve, 5200));
  const completedStatus = workspace.companion(["status", id, "--json"]);
  assert.equal(completedStatus.status, 0, completedStatus.stderr);
  const completed = JSON.parse(completedStatus.stdout).job;
  assert.equal(completed.status, "completed", completedStatus.stdout);
  assert.equal(completed.reconciled, true);
  assert.match(completed.result?.rawOutput ?? "", /Handled the requested task/);
});

test("deep reconcile helper marks a dead worker orphaned while its broker turn is active", async (t) => {
  const workspace = await makeCompanionWorkspace("review-ok", { fakeOptions: { turnScript: [{ type: "delay", ms: 10000 }] } });
  t.after(() => workspace.close());
  const launched = workspace.companion(["task", "--background", "--detach", "--json", "deep reconcile active turn"]);
  assert.equal(launched.status, 0, launched.stderr);
  const id = JSON.parse(launched.stdout).jobId;
  const jobFile = workspaceJobFile(workspace, id);
  await waitFor(() => { try { const job = JSON.parse(fs.readFileSync(jobFile, "utf8")); return job.transport === "broker" && job.turnId ? job : false; } catch { return false; } }, { timeoutMs: 8000 });
  const job = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  try { process.kill(job.worker.pid, "SIGKILL"); } catch {}
  await waitFor(() => !isPidAlive(job.worker.pid), { timeoutMs: 15000, intervalMs: 50 });
  const oldPluginData = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = path.join(workspace.home, "plugin-data");
  try {
    const lost = reconcileJob(workspace.repo, job);
    await reconcileJobDeep(workspace.repo, lost);
  }
  finally { if (oldPluginData === undefined) delete process.env.CLAUDE_PLUGIN_DATA; else process.env.CLAUDE_PLUGIN_DATA = oldPluginData; }
  assert.equal(JSON.parse(fs.readFileSync(jobFile, "utf8")).status, "orphaned");
});

test("deep reconcile helper recovers a completed broker turn after its worker dies", async (t) => {
  const workspace = await makeCompanionWorkspace("review-ok", { fakeOptions: { turnScript: [{ type: "delay", ms: 1200 }] } });
  t.after(() => workspace.close());
  const launched = workspace.companion(["task", "--background", "--detach", "--json", "deep reconcile completed turn"]);
  assert.equal(launched.status, 0, launched.stderr);
  const id = JSON.parse(launched.stdout).jobId;
  const jobFile = workspaceJobFile(workspace, id);
  await waitFor(() => { try { const job = JSON.parse(fs.readFileSync(jobFile, "utf8")); return job.transport === "broker" && job.turnId ? job : false; } catch { return false; } }, { timeoutMs: 8000 });
  const job = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  try { process.kill(job.worker.pid, "SIGKILL"); } catch {}
  await new Promise((resolve) => setTimeout(resolve, 1700));
  const oldPluginData = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = path.join(workspace.home, "plugin-data");
  try {
    const lost = reconcileJob(workspace.repo, job);
    await reconcileJobDeep(workspace.repo, lost);
  }
  finally { if (oldPluginData === undefined) delete process.env.CLAUDE_PLUGIN_DATA; else process.env.CLAUDE_PLUGIN_DATA = oldPluginData; }
  const reconciled = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  assert.equal(reconciled.status, "completed");
  assert.equal(reconciled.reconciled, true);
  assert.match(reconciled.result?.rawOutput ?? "", /Handled the requested task/);
});
