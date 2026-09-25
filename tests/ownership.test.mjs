import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

import { makeCompanionWorkspace, waitFor, isPidAlive } from "./helpers.mjs";
import { readFakeRpcLog } from "./fake-codex-fixture.mjs";
import { enrichJob } from "../plugins/codex/scripts/lib/job-control.mjs";

const LONG_TURN = [{ type: "delay", ms: 30000 }];
const LEASE_ENV = {
  CODEX_COMPANION_OWNER_TTL_MS: "1500",
  CODEX_COMPANION_OWNER_POLL_MS: "200",
  CODEX_COMPANION_HEARTBEAT_MS: "200",
  CODEX_COMPANION_CANCEL_GRACE_MS: "500",
  CODEX_COMPANION_CONTROL_ACK_MS: "500"
};

function json(result) {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function jobStatus(workspace, id) {
  return json(workspace.companion(["status", id, "--json"], { env: LEASE_ENV })).job;
}

function readBrokerLog(job) {
  const logFile = path.join(path.dirname(path.dirname(job.logFile)), "broker.log");
  try {
    return fs.readFileSync(logFile, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

function workspaceJobFile(workspace, id) {
  const root = path.join(workspace.home, "plugin-data", "state");
  const stateName = fs.readdirSync(root).find((name) => fs.existsSync(path.join(root, name, "jobs", `${id}.json`)));
  assert.ok(stateName, `missing state directory for job ${id}`);
  return path.join(root, stateName, "jobs", `${id}.json`);
}

async function waitTerminal(workspace, id, timeoutMs = 6000) {
  await waitFor(() => {
    const job = jobStatus(workspace, id);
    return ["completed", "failed", "cancelled", "cancel-failed", "lost", "orphaned"].includes(job.status);
  }, { timeoutMs, intervalMs: 50 });
  return jobStatus(workspace, id);
}

async function cleanWorkspace(workspace) {
  for (const job of json(workspace.companion(["status", "--all", "--json"], { env: LEASE_ENV })).running ?? []) {
    if (job.worker?.pid && isPidAlive(job.worker.pid)) {
      try { process.kill(job.worker.pid, "SIGKILL"); } catch {}
    }
  }
  workspace.close();
}

function ensureKilledAfterTest(t, child) {
  t.after(() => { if (child?.pid) { try { process.kill(child.pid, "SIGKILL"); } catch {} } });
}

test("task --attach prints its launch line, follows completion, and uses broker transport", async (t) => {
  const workspace = await makeCompanionWorkspace("review-ok", { fakeOptions: { turnScript: [{ type: "delay", ms: 100 }] } });
  t.after(() => cleanWorkspace(workspace));
  const child = workspace.spawnCompanion(["task", "--attach", "--full-access", "ownership result"], { env: LEASE_ENV });
  ensureKilledAfterTest(t, child);
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code));
  });
  assert.equal(exitCode, 0, stderr);
  assert.match(stdout.split(/\r?\n/)[0], /^CODEX_JOB /);
  assert.match(stdout, /Handled the requested task\./);
  const status = json(workspace.companion(["status", "--all", "--json"], { env: LEASE_ENV }));
  assert.equal(status.latestFinished?.transport ?? status.recent?.[0]?.transport, "broker");
  assert.ok(readFakeRpcLog(workspace.binDir, { method: "turn/start" }).length > 0);
});

test("SIGTERM of an attach process cancels the broker turn and records ownership cancellation", async (t) => {
  const workspace = await makeCompanionWorkspace("review-ok", { fakeOptions: { turnScript: LONG_TURN } });
  t.after(() => cleanWorkspace(workspace));
  let shell;
  t.after(() => { if (shell?.pid) { try { process.kill(-shell.pid, "SIGKILL"); } catch {} } });
  const scriptPath = path.resolve(new URL("../plugins/codex/scripts/codex-companion.mjs", import.meta.url).pathname);
  shell = spawn("sh", ["-c", `exec "${process.execPath}" "${scriptPath}" task --attach --full-access 'stop on owner exit'`], {
    cwd: workspace.repo,
    env: { ...workspace.env, ...LEASE_ENV },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const child = shell;
  ensureKilledAfterTest(t, child);
  child.stdout.setEncoding("utf8");
  let stdout = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  await waitFor(() => stdout.includes("CODEX_JOB "), { timeoutMs: 5000 });
  const id = stdout.match(/^CODEX_JOB (\S+)/m)?.[1];
  assert.ok(id);
  await waitFor(() => Boolean(jobStatus(workspace, id).threadId), { timeoutMs: 5000 });
  const workerPid = jobStatus(workspace, id).worker.pid;
  assert.ok(workerPid);
  process.kill(-shell.pid, "SIGTERM");
  await new Promise((resolve) => child.once("close", resolve));
  const job = await waitTerminal(workspace, id);
  assert.equal(job.status, "cancelled");
  assert.ok(["user", "attach-signal", "signal", "owner-lost"].includes(job.cancelReason));
  assert.ok(readFakeRpcLog(workspace.binDir, { method: "turn/interrupt" }).length > 0);
  assert.equal(job.transport, "broker");
  assert.equal(job.worker.pid, null);
  assert.equal(isPidAlive(workerPid), false, `worker ${workerPid} remained alive after cancellation`);
});

test("attach SIGTERM returns usage when cancellation cannot be verified", async (t) => {
  const workspace = await makeCompanionWorkspace("review-ok", {
    fakeOptions: { interrupt: "ignore", ignoreSigterm: true, turnScript: LONG_TURN }
  });
  t.after(() => cleanWorkspace(workspace));
  const env = {
    ...LEASE_ENV,
    CODEX_COMPANION_CONTROL_POLL_MS: "10",
    CODEX_COMPANION_CONTROL_ACK_MS: "100",
    CODEX_COMPANION_CANCEL_GRACE_MS: "100",
    CODEX_COMPANION_KILL_WAIT_MS: "100",
    CODEX_COMPANION_KILL_VERIFY_MS: "500"
  };
  const child = workspace.spawnCompanion(["task", "--attach", "--full-access", "unverified attach cancel"], { env });
  ensureKilledAfterTest(t, child);
  const closePromise = new Promise((resolve) => child.once("close", resolve));
  child.stdout.setEncoding("utf8");
  let stdout = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  await waitFor(() => stdout.includes("CODEX_JOB "), { timeoutMs: 5000 });
  const id = stdout.match(/^CODEX_JOB (\S+)/m)?.[1];
  await waitFor(() => Boolean(jobStatus(workspace, id).turnId), { timeoutMs: 5000 });
  child.kill("SIGTERM");
  const exitCode = await closePromise;
  const job = jobStatus(workspace, id);
  assert.equal(exitCode, 2);
  assert.equal(job.status, "cancel-failed");
});

test("background task with an owner PID does not detach its broker turn", async (t) => {
  const workspace = await makeCompanionWorkspace("review-ok", { fakeOptions: { turnScript: LONG_TURN } });
  t.after(() => cleanWorkspace(workspace));
  const sleep = (await import("node:child_process")).spawn("sleep", ["30"], { stdio: "ignore" });
  t.after(() => { try { sleep.kill("SIGKILL"); } catch {} });
  const launched = workspace.companion(["task", "--background", "--owner-pid", String(sleep.pid), "--json", "pid owner"], { env: LEASE_ENV });
  assert.equal(launched.status, 0, launched.stderr);
  const id = JSON.parse(launched.stdout).jobId;
  await waitFor(() => Boolean(jobStatus(workspace, id).threadId), { timeoutMs: 6000 });
  const job = jobStatus(workspace, id);
  assert.equal(job.owner.kind, "pid");
  assert.notEqual(job.owner.brokerDetached, true);
  const brokerLog = readBrokerLog(job);
  assert.doesNotMatch(brokerLog, new RegExp(`Marked broker thread ${job.threadId} detached\\.`));
  const starts = readFakeRpcLog(workspace.binDir, { method: "turn/start", dir: "out" });
  assert.ok(starts.length > 0);
  assert.equal(starts.some((entry) => entry.params?.brokerDetached === true), false);
});

test("attach signal handles a cancel rejection without an unhandled rejection", async (t) => {
  const workspace = await makeCompanionWorkspace("review-ok", { fakeOptions: { turnScript: LONG_TURN } });
  t.after(() => cleanWorkspace(workspace));
  const child = workspace.spawnCompanion(["task", "--attach", "--full-access", "cancel reject"], { env: LEASE_ENV });
  ensureKilledAfterTest(t, child);
  const closePromise = new Promise((resolve) => child.once("close", resolve));
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  await waitFor(() => stdout.includes("CODEX_JOB "), { timeoutMs: 5000 });
  const id = stdout.match(/^CODEX_JOB (\S+)/m)?.[1];
  await waitFor(() => Boolean(jobStatus(workspace, id).threadId), { timeoutMs: 5000 });
  const controlFile = path.join(path.dirname(jobStatus(workspace, id).logFile), `${id}.control.jsonl`);
  fs.mkdirSync(controlFile);
  child.kill("SIGTERM");
  const exitCode = await closePromise;
  fs.rmSync(controlFile, { recursive: true, force: true });
  assert.equal(exitCode, 2);
  assert.match(stderr, /Cancel failed for .*EISDIR/);
  assert.doesNotMatch(stderr, /Unhandled|uncaught exception/i);
});

test("ownerless active jobs are not reported as orphaned", () => {
  const job = enrichJob({
    id: "review-job",
    status: "running",
    createdAt: new Date().toISOString(),
    workspaceRoot: process.cwd()
  });
  assert.equal(job.owner, null);
  assert.equal(job.ownerAlive, false);
  assert.equal(job.orphaned, false);
});

test("worker detects a SIGKILLed attach owner through its lease heartbeat", async (t) => {
  const workspace = await makeCompanionWorkspace("review-ok", { fakeOptions: { turnScript: LONG_TURN } });
  t.after(() => cleanWorkspace(workspace));
  const child = workspace.spawnCompanion(["task", "--attach", "--full-access", "kill owner"], { env: LEASE_ENV });
  ensureKilledAfterTest(t, child);
  child.stdout.setEncoding("utf8");
  let stdout = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  await waitFor(() => stdout.includes("CODEX_JOB "), { timeoutMs: 5000 });
  const id = stdout.match(/^CODEX_JOB (\S+)/m)?.[1];
  await waitFor(() => Boolean(jobStatus(workspace, id).threadId), { timeoutMs: 5000 });
  child.kill("SIGKILL");
  await new Promise((resolve) => child.once("close", resolve));
  const job = await waitTerminal(workspace, id, 7000);
  assert.equal(job.status, "cancelled");
  assert.equal(job.cancelReason, "owner-lost");
  assert.equal(job.worker.pid, null);
  assert.ok(readFakeRpcLog(workspace.binDir, { method: "turn/interrupt" }).length > 0);
});

test("owner poll swallows transient job-file errors without killing the worker", async (t) => {
  const workspace = await makeCompanionWorkspace("review-ok", { fakeOptions: { turnScript: LONG_TURN } });
  t.after(() => cleanWorkspace(workspace));
  const env = { ...LEASE_ENV, CODEX_COMPANION_OWNER_POLL_MS: "50" };
  const child = workspace.spawnCompanion(["task", "--attach", "--full-access", "owner read error"], { env });
  ensureKilledAfterTest(t, child);
  const closePromise = new Promise((resolve) => child.once("close", resolve));
  child.stdout.setEncoding("utf8");
  let stdout = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  await waitFor(() => stdout.includes("CODEX_JOB "), { timeoutMs: 5000 });
  const id = stdout.match(/^CODEX_JOB (\S+)/m)?.[1];
  await waitFor(() => Boolean(jobStatus(workspace, id).threadId), { timeoutMs: 5000 });
  const running = jobStatus(workspace, id);
  const workerPid = running.worker.pid;
  const jobFile = path.join(path.dirname(running.logFile), `${id}.json`);
  const originalJob = fs.readFileSync(jobFile, "utf8");
  fs.writeFileSync(jobFile, "{transient invalid json");
  try {
    await new Promise((resolve) => setTimeout(resolve, 150));
  } finally {
    fs.writeFileSync(jobFile, originalJob);
  }
  assert.equal(isPidAlive(workerPid), true, `worker ${workerPid} exited after a transient owner-check read error`);
  child.kill("SIGKILL");
  await closePromise;
  const job = await waitTerminal(workspace, id, 6000);
  assert.equal(job.status, "cancelled");
  assert.equal(job.cancelReason, "owner-lost");
  assert.ok(readFakeRpcLog(workspace.binDir, { method: "turn/interrupt" }).length > 0);
});

test("broker interrupts a turn when its worker socket disconnects", async (t) => {
  const workspace = await makeCompanionWorkspace("review-ok", { fakeOptions: { turnScript: LONG_TURN } });
  t.after(() => cleanWorkspace(workspace));
  const child = workspace.spawnCompanion(["task", "--attach", "--full-access", "kill worker"], { env: LEASE_ENV });
  ensureKilledAfterTest(t, child);
  child.stdout.setEncoding("utf8");
  let stdout = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  await waitFor(() => stdout.includes("CODEX_JOB "), { timeoutMs: 5000 });
  const id = stdout.match(/^CODEX_JOB (\S+)/m)?.[1];
  await waitFor(() => Boolean(jobStatus(workspace, id).threadId), { timeoutMs: 5000 });
  const workerPid = jobStatus(workspace, id).worker.pid;
  process.kill(workerPid, "SIGKILL");
  await waitFor(() => readFakeRpcLog(workspace.binDir, { method: "turn/interrupt" }).length > 0, { timeoutMs: 2000 });
  child.kill("SIGKILL");
});

test("unowned background worker disconnect keeps broker interruption enabled", async (t) => {
  const workspace = await makeCompanionWorkspace("review-ok", { fakeOptions: { turnScript: LONG_TURN } });
  t.after(() => cleanWorkspace(workspace));
  const launched = workspace.companion(["task", "--background", "--json", "kill unowned worker"], { env: LEASE_ENV });
  assert.equal(launched.status, 0, launched.stderr);
  const id = JSON.parse(launched.stdout).jobId;
  await waitFor(() => Boolean(jobStatus(workspace, id).turnId), { timeoutMs: 6000 });
  const job = jobStatus(workspace, id);
  assert.equal(job.owner.kind, "none");
  assert.ok(job.worker.pid);
  process.kill(job.worker.pid, "SIGKILL");
  await waitFor(() => readFakeRpcLog(workspace.binDir, { method: "turn/interrupt" }).length > 0, { timeoutMs: 2000 });
});

test("broker interrupts a turn when the worker dies while turn/start is pending", async (t) => {
  const workspace = await makeCompanionWorkspace("review-ok", {
    fakeOptions: { delays: { turnStart: 500 }, turnScript: LONG_TURN }
  });
  t.after(() => cleanWorkspace(workspace));
  const child = workspace.spawnCompanion(["task", "--attach", "--full-access", "pending turn start"], { env: LEASE_ENV });
  ensureKilledAfterTest(t, child);
  child.stdout.setEncoding("utf8");
  let stdout = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  await waitFor(() => stdout.includes("CODEX_JOB "), { timeoutMs: 5000 });
  const id = stdout.match(/^CODEX_JOB (\S+)/m)?.[1];
  await waitFor(() => readFakeRpcLog(workspace.binDir, { method: "turn/start", dir: "in" }).length > 0, { timeoutMs: 6000 });
  const start = readFakeRpcLog(workspace.binDir, { method: "turn/start", dir: "in" })[0];
  const threadId = start.params.threadId;
  const turnId = JSON.parse(fs.readFileSync(path.join(workspace.binDir, "fake-codex-state.json"), "utf8")).lastTurnStart.turnId;
  const workerPid = jobStatus(workspace, id).worker.pid;
  assert.ok(workerPid);
  process.kill(workerPid, "SIGKILL");
  await waitFor(() => readFakeRpcLog(workspace.binDir, { method: "turn/interrupt", dir: "in" })
    .some((entry) => entry.params?.threadId === threadId && entry.params?.turnId === turnId), { timeoutMs: 2000 });
  child.kill("SIGKILL");
});

test("attach combined with background remains broker-owned", async (t) => {
  const workspace = await makeCompanionWorkspace("review-ok", { fakeOptions: { turnScript: [{ type: "delay", ms: 100 }] } });
  t.after(() => cleanWorkspace(workspace));
  const child = workspace.spawnCompanion(["task", "--attach", "--background", "--full-access", "attach background"], { env: LEASE_ENV });
  ensureKilledAfterTest(t, child);
  let stdout = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  assert.equal(exitCode, 0);
  const id = stdout.match(/^CODEX_JOB (\S+)/m)?.[1];
  assert.ok(id);
  const job = jobStatus(workspace, id);
  assert.equal(job.owner.kind, "attach");
  const brokerLog = readBrokerLog(job);
  assert.doesNotMatch(brokerLog, new RegExp(`Marked broker thread ${job.threadId} detached\\.`));
  const starts = readFakeRpcLog(workspace.binDir, { method: "turn/start", dir: "out" });
  assert.ok(starts.length > 0);
  assert.equal(starts.some((entry) => entry.params?.brokerDetached === true), false);
});

test("attach signal after completion preserves the completed exit code", async (t) => {
  const workspace = await makeCompanionWorkspace("review-ok", { fakeOptions: { turnScript: [{ type: "delay", ms: 1200 }] } });
  t.after(() => cleanWorkspace(workspace));
  const child = workspace.spawnCompanion(["task", "--attach", "--full-access", "completed before signal"], { env: LEASE_ENV });
  ensureKilledAfterTest(t, child);
  let stdout = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  await waitFor(() => stdout.includes("CODEX_JOB "), { timeoutMs: 10000 });
  const id = stdout.match(/^CODEX_JOB (\S+)/m)?.[1];
  assert.ok(id);
  const running = await waitFor(() => {
    const job = jobStatus(workspace, id);
    return job.status === "running" && job.threadId ? job : null;
  }, { timeoutMs: 15000, intervalMs: 50 });
  const jobFile = workspaceJobFile(workspace, id);
  process.kill(child.pid, "SIGSTOP");
  try {
    await waitFor(() => {
      try {
        return JSON.parse(fs.readFileSync(jobFile, "utf8")).status === "completed";
      } catch (error) {
        if (error.code === "ENOENT") return false;
        throw error;
      }
    }, { timeoutMs: 15000, intervalMs: 50 });
    child.kill("SIGTERM");
  } finally {
    process.kill(child.pid, "SIGCONT");
  }
  const exitCode = await new Promise((resolve) => child.once("close", resolve));
  assert.equal(exitCode, 0);
  assert.equal(jobStatus(workspace, id).status, "completed");
});

test("background task with an explicit owner PID does not print the unowned warning", async (t) => {
  const workspace = await makeCompanionWorkspace("review-ok", { fakeOptions: { turnScript: LONG_TURN } });
  t.after(() => cleanWorkspace(workspace));
  const sleep = (await import("node:child_process")).spawn("sleep", ["30"], { stdio: "ignore" });
  t.after(() => { try { sleep.kill("SIGKILL"); } catch {} });
  const launched = workspace.companion(["task", "--background", "--owner-pid", String(sleep.pid), "--full-access", "pid owned warning"], { env: LEASE_ENV });
  assert.equal(launched.status, 0, launched.stderr);
  assert.doesNotMatch(launched.stderr, /is unowned \(use --attach\)/);
  const id = launched.stdout.match(/^CODEX_JOB_QUEUED id=(\S+)/m)?.[1];
  assert.ok(id);
  assert.equal(jobStatus(workspace, id).owner.kind, "pid");
});

test("setup default-on-detach configures the owner-exit policy for owned jobs", async (t) => {
  const workspace = await makeCompanionWorkspace("review-ok", { fakeOptions: { turnScript: LONG_TURN } });
  t.after(() => cleanWorkspace(workspace));
  const setup = workspace.companion(["setup", "--default-on-detach", "continue", "--json"], { env: LEASE_ENV });
  assert.equal(setup.status, 0, setup.stderr);
  const owner = spawn("sleep", ["30"], { stdio: "ignore" });
  t.after(() => { try { owner.kill("SIGKILL"); } catch {} });
  const launched = workspace.companion(["task", "--background", "--owner-pid", String(owner.pid), "--full-access", "configured owner exit"], { env: LEASE_ENV });
  assert.equal(launched.status, 0, launched.stderr);
  const id = launched.stdout.match(/^CODEX_JOB_QUEUED id=(\S+)/m)?.[1];
  assert.ok(id);
  const job = jobStatus(workspace, id);
  assert.equal(job.owner.kind, "pid");
  assert.equal(job.onOwnerExit, "continue");
});

test("detached background task completes and reports an inactive detached owner", async (t) => {
  const workspace = await makeCompanionWorkspace("review-ok", { fakeOptions: { turnScript: [{ type: "delay", ms: 100 }] } });
  t.after(() => cleanWorkspace(workspace));
  const launched = workspace.companion(["task", "--background", "--detach", "--full-access", "detached"], { env: LEASE_ENV });
  assert.equal(launched.status, 0, launched.stderr);
  assert.match(launched.stdout.split(/\r?\n/)[0], /^CODEX_JOB_QUEUED /);
  const id = launched.stdout.match(/^CODEX_JOB_QUEUED id=(\S+)/m)?.[1];
  assert.ok(id);
  const queued = jobStatus(workspace, id);
  assert.equal(queued.owner.kind, "detached");
  assert.equal(queued.onOwnerExit, "continue");
  assert.equal(queued.ownerAlive, false);
  assert.equal(queued.orphaned, false);
  const finished = await waitTerminal(workspace, id, 10000);
  assert.equal(finished.status, "completed");
  const brokerLog = readBrokerLog(finished);
  assert.match(brokerLog, new RegExp(`Marked broker thread ${finished.threadId} detached\\.`));
});

test("--owner-pid loss cancels a foreground task", async (t) => {
  const workspace = await makeCompanionWorkspace("review-ok", { fakeOptions: { turnScript: LONG_TURN } });
  t.after(() => cleanWorkspace(workspace));
  const sleep = (await import("node:child_process")).spawn("sleep", ["30"], { stdio: "ignore" });
  t.after(() => { try { sleep.kill("SIGKILL"); } catch {} });
  const child = workspace.spawnCompanion(["task", "--owner-pid", String(sleep.pid), "--full-access", "external owner"], { env: LEASE_ENV });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  await waitFor(() => readFakeRpcLog(workspace.binDir, { method: "turn/start" }).length > 0, { timeoutMs: 6000 });
  sleep.kill("SIGKILL");
  const code = await new Promise((resolve) => child.once("close", resolve));
  assert.equal(code, 130, `${stderr}\nstdout=${stdout}\nstatus=${JSON.stringify(json(workspace.companion(["status", "--all", "--json"], { env: LEASE_ENV })))}`);
  const summary = json(workspace.companion(["status", "--all", "--json"], { env: LEASE_ENV }));
  const job = summary.latestFinished;
  assert.equal(job.status, "cancelled");
  assert.equal(job.cancelReason, "owner-lost");
  assert.ok(readFakeRpcLog(workspace.binDir, { method: "turn/interrupt" }).length > 0);
  assert.match(stdout, /Codex did not return a final message\./);
});

test("attach exit codes cover failed and cancelled jobs; timeout releases ownership without detaching", async (t) => {
  const failed = await makeCompanionWorkspace("review-ok", { fakeOptions: { turnScript: [], turnStatus: "failed" } });
  t.after(() => cleanWorkspace(failed));
  const failedRun = failed.companion(["task", "--attach", "failure"], { env: LEASE_ENV });
  assert.equal(failedRun.status, 1);
  assert.match(failedRun.stdout, /^CODEX_JOB /);

  const long = await makeCompanionWorkspace("review-ok", { fakeOptions: { turnScript: LONG_TURN } });
  t.after(() => cleanWorkspace(long));
  const timeoutRun = long.companion(["task", "--attach", "--timeout-ms", "500", "--full-access", "timeout"], { env: LEASE_ENV });
  assert.equal(timeoutRun.status, 124, timeoutRun.stderr);
  const id = timeoutRun.stdout.match(/^CODEX_JOB (\S+)/m)?.[1];
  assert.ok(id);
  const job = jobStatus(long, id);
  assert.equal(job.status, "running");
  assert.equal(job.owner.kind, "none");
  assert.equal(job.onOwnerExit, "cancel");
  const brokerLog = readBrokerLog(job);
  assert.doesNotMatch(brokerLog, new RegExp(`Marked broker thread ${job.threadId} detached\\.`));

  const cancelled = await makeCompanionWorkspace("review-ok", { fakeOptions: { turnScript: LONG_TURN } });
  t.after(() => cleanWorkspace(cancelled));
  const child = cancelled.spawnCompanion(["task", "--attach", "--full-access", "cancel from elsewhere"], { env: LEASE_ENV });
  ensureKilledAfterTest(t, child);
  child.stdout.setEncoding("utf8");
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  await waitFor(() => output.includes("CODEX_JOB "), { timeoutMs: 5000 });
  const cancelId = output.match(/^CODEX_JOB (\S+)/m)?.[1];
  await waitFor(() => Boolean(jobStatus(cancelled, cancelId).threadId), { timeoutMs: 5000 });
  const cancelResult = cancelled.companion(["cancel", cancelId, "--json"], { env: LEASE_ENV });
  assert.equal(cancelResult.status, 0, cancelResult.stderr);
  const attachCode = await new Promise((resolve) => child.once("close", resolve));
  assert.equal(attachCode, 130);
});

test("attach timeout preserves worker thread and transport metadata", async (t) => {
  const workspace = await makeCompanionWorkspace("review-ok", { fakeOptions: { turnScript: LONG_TURN } });
  t.after(() => cleanWorkspace(workspace));
  const child = workspace.spawnCompanion(["task", "--attach", "--timeout-ms", "3000", "--full-access", "preserve timeout metadata"], { env: LEASE_ENV });
  ensureKilledAfterTest(t, child);
  let stdout = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  await waitFor(() => stdout.includes("CODEX_JOB "), { timeoutMs: 5000 });
  const id = stdout.match(/^CODEX_JOB (\S+)/m)?.[1];
  await waitFor(() => Boolean(jobStatus(workspace, id).threadId), { timeoutMs: 8000 });
  const exitCode = await new Promise((resolve) => child.once("close", resolve));
  assert.equal(exitCode, 124);
  const job = jobStatus(workspace, id);
  assert.equal(job.status, "running");
  assert.ok(job.threadId);
  assert.equal(job.transport, "broker");
  assert.equal(job.owner.kind, "none");
  assert.equal(job.onOwnerExit, "cancel");
});

test("external cancellation keeps the fast control poll when owner polling is slow", async (t) => {
  const workspace = await makeCompanionWorkspace("review-ok", { fakeOptions: { turnScript: LONG_TURN } });
  t.after(() => cleanWorkspace(workspace));
  const env = {
    ...LEASE_ENV,
    CODEX_COMPANION_OWNER_POLL_MS: "2000",
    CODEX_COMPANION_CONTROL_POLL_MS: "50",
    CODEX_COMPANION_CANCEL_GRACE_MS: "1200",
    CODEX_COMPANION_CONTROL_ACK_MS: "300"
  };
  const child = workspace.spawnCompanion(["task", "--full-access", "fast external cancel"], { env });
  ensureKilledAfterTest(t, child);
  let id;
  await waitFor(() => {
    const summary = json(workspace.companion(["status", "--all", "--json"], { env }));
    id = summary.running?.[0]?.id;
    return Boolean(id);
  }, { timeoutMs: 5000 });
  await waitFor(() => Boolean(jobStatus(workspace, id).threadId), { timeoutMs: 5000 });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const startedAt = Date.now();
  const cancelResult = workspace.companion(["cancel", id, "--json"], { env });
  assert.equal(cancelResult.status, 0, cancelResult.stderr);
  assert.ok(Date.now() - startedAt < 1800, `cancel took ${Date.now() - startedAt}ms with a 50ms control poll`);
  await new Promise((resolve) => child.once("close", resolve));
  assert.equal((await waitTerminal(workspace, id)).status, "cancelled");
});

test("unowned background warns, and foreground SIGTERM interrupts its turn", async (t) => {
  const workspace = await makeCompanionWorkspace("review-ok", { fakeOptions: { turnScript: LONG_TURN } });
  t.after(() => cleanWorkspace(workspace));
  const launched = workspace.companion(["task", "--background", "--full-access", "unowned"], { env: LEASE_ENV });
  assert.equal(launched.status, 0, launched.stderr);
  assert.match(launched.stderr, /Warning: job .* is unowned \(use --attach\)\. Stop it with: node scripts\/codex-companion\.mjs cancel /);
  assert.match(launched.stdout.split(/\r?\n/)[0], /^CODEX_JOB_QUEUED /);
  const id = launched.stdout.match(/^CODEX_JOB_QUEUED id=(\S+)/m)?.[1];
  assert.ok(id);
  await waitFor(() => Boolean(jobStatus(workspace, id).threadId), { timeoutMs: 6000 });
  const unowned = jobStatus(workspace, id);
  assert.equal(unowned.owner.kind, "none");
  assert.equal(unowned.onOwnerExit, "cancel");
  assert.equal(unowned.status, "running", "unowned jobs have no owner-liveness check");
  const brokerLog = readBrokerLog(unowned);
  assert.doesNotMatch(brokerLog, new RegExp(`Marked broker thread ${unowned.threadId} detached\\.`));

  const foregroundWorkspace = await makeCompanionWorkspace("review-ok", { fakeOptions: { turnScript: LONG_TURN } });
  t.after(() => cleanWorkspace(foregroundWorkspace));
  const foreground = foregroundWorkspace.spawnCompanion(["task", "--full-access", "foreground signal"], { env: LEASE_ENV });
  ensureKilledAfterTest(t, foreground);
  await waitFor(() => readFakeRpcLog(foregroundWorkspace.binDir, { method: "turn/start" }).length > 0, { timeoutMs: 6000 });
  foreground.kill("SIGTERM");
  const code = await new Promise((resolve) => foreground.once("close", resolve));
  assert.equal(code, 130);
  assert.ok(readFakeRpcLog(foregroundWorkspace.binDir, { method: "turn/interrupt" }).length > 0);
});
