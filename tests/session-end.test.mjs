import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { makeCompanionWorkspace, run, waitFor } from "./helpers.mjs";
import { readFakeRpcLog } from "./fake-codex-fixture.mjs";
import { spawnBrokerProcess } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { isProcessAlive } from "../plugins/codex/scripts/lib/process.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SESSION_HOOK = path.join(ROOT, "plugins/codex/scripts/session-lifecycle-hook.mjs");

function runSessionEnd(ws, sessionId) {
  return run(process.execPath, [SESSION_HOOK, "SessionEnd"], {
    cwd: ws.repo,
    env: { ...ws.env, CODEX_COMPANION_SESSION_ID: sessionId },
    input: JSON.stringify({ session_id: sessionId, cwd: ws.repo })
  });
}

function stateDir(ws) {
  const root = fs.realpathSync.native(ws.repo);
  const slug = path.basename(root).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(root).digest("hex").slice(0, 16);
  return path.join(ws.home, "plugin-data", "state", `${slug}-${hash}`);
}

test("SessionEnd preserves job artifacts, cancels active work, and writes a non-job summary", async (t) => {
  const ws = await makeCompanionWorkspace("interruptible-slow-task", { fakeOptions: { turnScript: [{ type: "silence" }] } });
  t.after(ws.close);
  const sessionId = "session-end-a";
  const env = { CODEX_COMPANION_SESSION_ID: sessionId };
  const running = ws.companion(["task", "--background", "--json", "running work"], { env });
  assert.equal(running.status, 0, running.stderr);
  const runningId = JSON.parse(running.stdout).jobId;
  await waitFor(() => {
    const job = JSON.parse(ws.companion(["status", runningId, "--json"], { env }).stdout).job;
    return job?.status === "running" && job.turnId ? job : null;
  }, { timeoutMs: 8000, intervalMs: 25 });
  const completedId = addCompletedJob(ws, "completed-fixture", sessionId);
  const jobsDir = path.join(stateDir(ws), "jobs");
  const before = fs.readdirSync(jobsDir).sort();
  const ended = runSessionEnd(ws, sessionId);
  assert.equal(ended.status, 0, ended.stderr);
  const after = fs.readdirSync(jobsDir).sort();
  assert.ok(before.every((name) => after.includes(name)), "SessionEnd removed a pre-existing jobs artifact");
  for (const id of [runningId, completedId]) {
    assert.ok(fs.existsSync(path.join(jobsDir, `${id}.json`)));
    assert.ok(fs.existsSync(path.join(jobsDir, `${id}.log`)));
    assert.equal(ws.companion(["status", id, "--json"], { env }).status, 0);
  }
  const immediate = JSON.parse(ws.companion(["status", runningId, "--json"], { env }).stdout).job;
  assert.ok(["cancel-pending", "cancelled"].includes(immediate.status));
  assert.equal(immediate.cancelReason, "session-ended");
  const summaryFile = path.join(jobsDir, `session-end-${sessionId}.json`);
  assert.ok(fs.existsSync(summaryFile));
  const summary = JSON.parse(fs.readFileSync(summaryFile, "utf8"));
  assert.deepEqual(summary.jobs.map((job) => job.id).sort(), [runningId, completedId].sort());
  const statusAll = ws.companion(["status", "--all", "--json"], { env });
  assert.equal(statusAll.status, 0, statusAll.stderr);
  assert.equal(JSON.stringify(JSON.parse(statusAll.stdout)).includes(`session-end-${sessionId}`), false);
  await waitFor(() => JSON.parse(ws.companion(["status", runningId, "--json"], { env }).stdout).job?.status === "cancelled", { timeoutMs: 4000, intervalMs: 50 });
  assert.ok(readFakeRpcLog(ws.binDir, { method: "turn/interrupt" }).length > 0);
});

test("SessionEnd removes only its lease while another session keeps the shared broker alive", async (t) => {
  const ws = await makeCompanionWorkspace("interruptible-slow-task", { fakeOptions: { turnScript: [{ type: "silence" }] } });
  t.after(ws.close);
  const b = { CODEX_COMPANION_SESSION_ID: "lease-b" };
  const launch = ws.companion(["task", "--background", "--json", "session B work"], { env: b });
  assert.equal(launch.status, 0, launch.stderr);
  const id = JSON.parse(launch.stdout).jobId;
  const job = await waitFor(() => {
    const current = JSON.parse(ws.companion(["status", id, "--json"], { env: b }).stdout).job;
    return current?.status === "running" && current.turnId ? current : null;
  }, { timeoutMs: 8000, intervalMs: 25 });
  const broker = JSON.parse(fs.readFileSync(path.join(stateDir(ws), "broker.json"), "utf8"));
  const ended = runSessionEnd(ws, "lease-a");
  assert.equal(ended.status, 0, ended.stderr);
  assert.doesNotThrow(() => process.kill(broker.pid, 0));
  assert.equal(JSON.parse(ws.companion(["status", id, "--json"], { env: b }).stdout).job.status, "running");
  assert.ok(JSON.parse(fs.readFileSync(path.join(stateDir(ws), "broker.json"), "utf8")).leases.some((lease) => lease.sessionId === "lease-b"));
  assert.ok(job);
});

test("SessionEnd detaches opted-out jobs and keeps the shared broker available", async (t) => {
  const ws = await makeCompanionWorkspace("interruptible-slow-task", { fakeOptions: { turnScript: [{ type: "silence" }] } });
  t.after(ws.close);
  const env = { CODEX_COMPANION_SESSION_ID: "detach-a" };
  const launch = ws.companion(["task", "--background", "--json", "detached work"], { env });
  assert.equal(launch.status, 0, launch.stderr);
  const id = JSON.parse(launch.stdout).jobId;
  await waitFor(() => JSON.parse(ws.companion(["status", id, "--json"], { env }).stdout).job?.turnId, { timeoutMs: 8000, intervalMs: 25 });
  const broker = JSON.parse(fs.readFileSync(path.join(stateDir(ws), "broker.json"), "utf8"));
  const jobsDir = path.join(stateDir(ws), "jobs");
  const jobFile = path.join(jobsDir, `${id}.json`);
  const job = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  const stateFile = path.join(stateDir(ws), "state.json");
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  state.config.sessionEndPolicy = "detach";
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  const ended = runSessionEnd(ws, "detach-a");
  assert.equal(ended.status, 0, ended.stderr);
  const updated = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  assert.equal(updated.endedWithSession, true);
  assert.ok(updated.sessionEndedAt);
  assert.equal(updated.status, "running");
  assert.ok(fs.existsSync(path.join(stateDir(ws), "broker.log")));
  assert.ok(fs.existsSync(path.join(stateDir(ws), "broker.json")));
  assert.ok(broker);
});

test("SessionEnd handles twenty completed jobs under two seconds", async (t) => {
  const ws = await makeCompanionWorkspace();
  t.after(ws.close);
  for (let i = 0; i < 20; i++) addCompletedJob(ws, `fast-${i}`, "fast-session");
  const started = Date.now();
  const ended = runSessionEnd(ws, "fast-session");
  assert.equal(ended.status, 0, ended.stderr);
  assert.ok(Date.now() - started < 2000);
});

test("SessionEnd writes an empty summary for a workspace without job state", async (t) => {
  const ws = await makeCompanionWorkspace();
  t.after(ws.close);
  const ended = runSessionEnd(ws, "first-session");
  assert.equal(ended.status, 0, ended.stderr);
  const summaryFile = path.join(stateDir(ws), "jobs", "session-end-first-session.json");
  assert.deepEqual(JSON.parse(fs.readFileSync(summaryFile, "utf8")).jobs, []);
});

test("SessionEnd rejects traversal session ids before writing a summary", async (t) => {
  const ws = await makeCompanionWorkspace();
  t.after(ws.close);
  const sessionId = "../../../../session-end-traversal-check";
  const jobsDir = path.join(stateDir(ws), "jobs");
  const escapedSummary = path.resolve(jobsDir, `session-end-${sessionId}.json`);
  assert.equal(escapedSummary.startsWith(`${jobsDir}${path.sep}`), false);
  assert.equal(fs.existsSync(escapedSummary), false);
  const ended = runSessionEnd(ws, sessionId);
  assert.equal(ended.status, 0, ended.stderr);
  assert.equal(fs.existsSync(escapedSummary), false, "untrusted session id created a file outside jobs/");
  assert.equal(fs.existsSync(path.join(jobsDir, `session-end-${sessionId}.json`)), false);
});

test("broker lease mutations serialize across processes and preserve concurrent updates", async (t) => {
  const ws = await makeCompanionWorkspace();
  t.after(ws.close);
  const directory = stateDir(ws);
  fs.mkdirSync(directory, { recursive: true });
  const brokerFile = path.join(directory, "broker.json");
  const lockFile = path.join(directory, "broker.lock");
  fs.writeFileSync(brokerFile, JSON.stringify({ endpoint: "test-endpoint", pid: 123, leases: [] }));

  const moduleUrl = pathToFileURL(path.join(ROOT, "plugins/codex/scripts/lib/broker-lifecycle.mjs")).href;
  const runLeaseAction = (action, sessionId) => {
    const args = action === "addBrokerLease"
      ? `addBrokerLease(process.cwd(), { sessionId: ${JSON.stringify(sessionId)}, pid: null });`
      : `removeBrokerLease(process.cwd(), ${JSON.stringify(sessionId)});`;
    return spawn(process.execPath, ["--input-type=module", "-e", `import { ${action} } from ${JSON.stringify(moduleUrl)}; ${args}`], {
    cwd: ws.repo,
    env: ws.env,
    stdio: "ignore"
    });
  };

  const lockFd = fs.openSync(lockFile, "wx");
  fs.writeSync(lockFd, JSON.stringify({ pid: process.pid, token: "test-lock", createdAt: new Date().toISOString() }));
  const waiting = runLeaseAction("addBrokerLease", "waited-session");
  t.after(() => { try { process.kill(waiting.pid, "SIGKILL"); } catch {} });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(waiting.exitCode, null, "lease mutation bypassed the broker state lock");
  fs.closeSync(lockFd);
  fs.unlinkSync(lockFile);
  await waitFor(() => waiting.exitCode !== null, { timeoutMs: 3000, intervalMs: 20 });
  assert.equal(waiting.exitCode, 0);

  const sessionIds = Array.from({ length: 8 }, (_, index) => `parallel-${index}`);
  const additions = sessionIds.map((id) => runLeaseAction("addBrokerLease", id));
  const removals = [];
  for (const child of additions) {
    t.after(() => { try { process.kill(child.pid, "SIGKILL"); } catch {} });
    await waitFor(() => child.exitCode !== null, { timeoutMs: 3000, intervalMs: 20 });
    assert.equal(child.exitCode, 0);
  }
  const afterAdds = JSON.parse(fs.readFileSync(brokerFile, "utf8"));
  assert.deepEqual(afterAdds.leases.map((lease) => lease.sessionId).sort(), ["waited-session", ...sessionIds].sort());

  for (const id of sessionIds) {
    const child = runLeaseAction("removeBrokerLease", id);
    removals.push(child);
    t.after(() => { try { process.kill(child.pid, "SIGKILL"); } catch {} });
  }
  for (const child of removals) {
    await waitFor(() => child.exitCode !== null, { timeoutMs: 3000, intervalMs: 20 });
    assert.equal(child.exitCode, 0);
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(brokerFile, "utf8")).leases.map((lease) => lease.sessionId), ["waited-session"]);
});

test("concurrent ensureBrokerSession calls keep one broker record and both leases", async (t) => {
  const ws = await makeCompanionWorkspace();
  t.after(ws.close);
  const directory = stateDir(ws);
  fs.mkdirSync(directory, { recursive: true });
  const brokerScript = path.join(directory, "test-broker-server.mjs");
  const readyDir = path.join(directory, "ensure-ready");
  const gateFile = path.join(directory, "ensure-go");
  const brokerPidsFile = path.join(directory, "test-broker-pids.jsonl");
  fs.mkdirSync(readyDir);
  fs.writeFileSync(brokerScript, `import net from "node:net";
import fs from "node:fs";
const endpoint = process.argv[process.argv.indexOf("--endpoint") + 1];
fs.appendFileSync(${JSON.stringify(brokerPidsFile)}, JSON.stringify({ pid: process.pid, endpoint }) + "\\n");
const server = net.createServer((socket) => {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\\n");
      if (newline < 0) break;
      const request = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      socket.write(JSON.stringify({ id: request.id, result: {} }) + "\\n");
      if (request.method === "broker/shutdown") server.close();
    }
  });
});
server.listen(endpoint.startsWith("unix:") ? endpoint.slice(5) : endpoint);
`);
  const moduleUrl = pathToFileURL(path.join(ROOT, "plugins/codex/scripts/lib/broker-lifecycle.mjs")).href;
  const startEnsure = (sessionId) => spawn(process.execPath, ["--input-type=module", "-e", `import fs from "node:fs"; import { ensureBrokerSession } from ${JSON.stringify(moduleUrl)}; fs.writeFileSync(${JSON.stringify(path.join(readyDir, `${sessionId}.ready`))}, "ready"); while (!fs.existsSync(${JSON.stringify(gateFile)})) await new Promise((resolve) => setTimeout(resolve, 5)); await ensureBrokerSession(process.cwd(), { scriptPath: ${JSON.stringify(brokerScript)}, timeoutMs: 1500 });`], {
    cwd: ws.repo,
    env: { ...ws.env, CODEX_COMPANION_SESSION_ID: sessionId },
    stdio: "ignore"
  });
  const children = [startEnsure("ensure-a"), startEnsure("ensure-b")];
  for (const child of children) {
    t.after(() => { try { process.kill(child.pid, "SIGKILL"); } catch {} });
  }
  await waitFor(() => fs.readdirSync(readyDir).length === children.length, { timeoutMs: 3000, intervalMs: 10 });
  fs.writeFileSync(gateFile, "go");
  for (const child of children) {
    await waitFor(() => child.exitCode !== null, { timeoutMs: 5000, intervalMs: 20 });
    assert.equal(child.exitCode, 0);
  }
  const broker = JSON.parse(fs.readFileSync(path.join(directory, "broker.json"), "utf8"));
  assert.ok(broker.endpoint);
  assert.ok(broker.pid);
  assert.deepEqual(broker.leases.map((lease) => lease.sessionId).sort(), ["ensure-a", "ensure-b"]);
  assert.ok(isProcessAlive(broker.pid));
  const brokerPids = fs.readFileSync(brokerPidsFile, "utf8").trim().split("\n").map((line) => JSON.parse(line).pid);
  assert.equal(brokerPids.length, 2, "both concurrent ensure calls should start candidate brokers");
  for (const pid of brokerPids) t.after(() => { try { process.kill(pid, "SIGKILL"); } catch {} });
  await waitFor(() => brokerPids.filter((pid) => isProcessAlive(pid)).length === 1, { timeoutMs: 2000, intervalMs: 20 });
  assert.deepEqual(brokerPids.filter((pid) => isProcessAlive(pid)), [broker.pid], "the losing candidate broker process should exit");
});

test("the final idle lease shuts down its broker but preserves its log", async (t) => {
  const ws = await makeCompanionWorkspace();
  t.after(ws.close);
  const directory = stateDir(ws);
  fs.mkdirSync(directory, { recursive: true });
  const pidFile = path.join(directory, "test-broker.pid");
  const logFile = path.join(directory, "broker.log");
  fs.writeFileSync(logFile, "broker history\n");
  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  t.after(() => { try { process.kill(sleeper.pid, "SIGKILL"); } catch {} });
  fs.writeFileSync(path.join(directory, "broker.json"), JSON.stringify({ pid: sleeper.pid, pidFile, logFile, leases: [{ sessionId: "last-lease", pid: null, touchedAt: new Date().toISOString() }] }));
  const ended = runSessionEnd(ws, "last-lease");
  assert.equal(ended.status, 0, ended.stderr);
  assert.ok(fs.existsSync(logFile));
  await waitFor(() => {
    return !isProcessAlive(sleeper.pid);
  }, { timeoutMs: 2000, intervalMs: 20 });
  assert.equal(fs.existsSync(path.join(directory, "broker.json")), false);
});

test("broker spawn rotates a log at five megabytes", async (t) => {
  const ws = await makeCompanionWorkspace();
  const directory = stateDir(ws);
  fs.mkdirSync(directory, { recursive: true });
  const script = path.join(directory, "broker-placeholder.mjs");
  const endpoint = path.join(directory, "unused.sock");
  const pidFile = path.join(directory, "placeholder.pid");
  const logFile = path.join(directory, "broker.log");
  fs.writeFileSync(script, "setInterval(() => {}, 1000);\n");
  fs.writeFileSync(logFile, Buffer.alloc(5 * 1024 * 1024 + 1, 65));
  const broker = spawnBrokerProcess({ scriptPath: script, cwd: ws.repo, endpoint, pidFile, logFile });
  t.after(() => { try { process.kill(broker.pid, "SIGKILL"); } catch {} ws.close(); });
  await waitFor(() => fs.existsSync(`${logFile}.1`), { timeoutMs: 1000, intervalMs: 20 });
  assert.equal(fs.statSync(`${logFile}.1`).size, 5 * 1024 * 1024 + 1);
});

function addCompletedJob(ws, id, sessionId) {
  ws.companion(["status", "--json"]);
  const workspaceStateDir = stateDir(ws);
  fs.mkdirSync(path.join(workspaceStateDir, "jobs"), { recursive: true });
  const jobsDir = path.join(workspaceStateDir, "jobs");
  const job = { id, status: "completed", sessionId, logFile: path.join(jobsDir, `${id}.log`) };
  fs.writeFileSync(path.join(jobsDir, `${id}.json`), JSON.stringify(job));
  fs.writeFileSync(job.logFile, "done\n");
  const stateFile = path.join(workspaceStateDir, "state.json");
  const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : { version: 1, config: {}, jobs: [] };
  state.jobs.push(job);
  fs.writeFileSync(stateFile, JSON.stringify(state));
  return id;
}
