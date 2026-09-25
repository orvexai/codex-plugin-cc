import "./_isolation.mjs";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeCompanionWorkspace, waitFor, isPidAlive, run } from "./helpers.mjs";
import { setFakeCodexOptions } from "./fake-codex-fixture.mjs";
import { EXIT, TERMINAL_STATUSES, exitCodeForJob, isActiveJobStatus } from "../plugins/codex/scripts/lib/exit-codes.mjs";
import { readHeartbeat, resolveHeartbeatFile, startHeartbeat } from "../plugins/codex/scripts/lib/job-liveness.mjs";
import { resolveCancelableJob, resolveResultJob } from "../plugins/codex/scripts/lib/job-control.mjs";
import { reconcileJob } from "../plugins/codex/scripts/lib/job-liveness.mjs";
import { readJobFile, resolveJobFile, resolveJobLogFile, resolveStateFile, upsertJob, writeJobFile } from "../plugins/codex/scripts/lib/state.mjs";
import { readProcessStartTime } from "../plugins/codex/scripts/lib/process.mjs";
import { recordTaskRunning, recordTaskWorker, spawnTaskWorker } from "../plugins/codex/scripts/lib/tracked-jobs.mjs";

function useWorkspaceStateEnv(t, ws) {
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = ws.env.CLAUDE_PLUGIN_DATA;
  t.after(() => { if (previous == null) delete process.env.CLAUDE_PLUGIN_DATA; else process.env.CLAUDE_PLUGIN_DATA = previous; });
}

function killPid(pid) { try { if (pid) process.kill(Number(pid), "SIGKILL"); } catch {} }

test("exitCodeForJob covers every terminal status and mode", () => {
  const expected = {
    completed: [0, 0, 0], failed: [1, 1, 1], cancelled: [1, 130, 130], interrupted: [1, 130, 130],
    lost: [3, 3, 3], orphaned: [3, 3, 3], "timed-out": [4, 4, 4], "cancel-failed": [2, 2, 2]
  };
  for (const [status, values] of Object.entries(expected)) {
    for (const [index, mode] of ["wait", "attach", "task"].entries()) assert.equal(exitCodeForJob(status, { mode }), values[index]);
  }
  assert.equal(EXIT.WAITER_TIMEOUT, 124);
  assert.equal(TERMINAL_STATUSES.size, Object.keys(expected).length);
  assert.equal(isActiveJobStatus("future-status"), true);
  assert.equal(isActiveJobStatus("lost"), false);
  assert.equal(exitCodeForJob("queued", { mode: "wait" }), EXIT.OK);
});

test("heartbeat writes immediately, refreshes, and can be stopped", async (t) => {
  const workspace = await makeCompanionWorkspace();
  t.after(() => workspace.close());
  useWorkspaceStateEnv(t, workspace);
  const file = resolveHeartbeatFile(workspace.repo, "job-heartbeat");
  const heartbeat = startHeartbeat(file, { intervalMs: 25 });
  t.after(() => heartbeat.stop());
  const first = readHeartbeat(file);
  assert.equal(first.pid, process.pid);
  assert.ok(first.startTime);
  await waitFor(() => readHeartbeat(file)?.at !== first.at, { timeoutMs: 1000, intervalMs: 10 });
  heartbeat.stop();
});

test("status and wait reconcile a SIGKILLed background worker to orphaned", async (t) => {
  const ws = await makeCompanionWorkspace("review-ok", { fakeOptions: { turnScript: [{ type: "delay", ms: 60000 }] } });
  t.after(() => ws.close());
  useWorkspaceStateEnv(t, ws);
  const launched = ws.companion(["task", "--background", "--detach", "--json", "slow liveness task"], { env: { CODEX_COMPANION_HEARTBEAT_MS: "100", CODEX_COMPANION_HEARTBEAT_STALE_MS: "1500" } });
  assert.equal(launched.status, 0, launched.stderr);
  const id = JSON.parse(launched.stdout).jobId;
  let job;
  await waitFor(() => {
    const current = ws.companion(["status", id, "--json"], { env: { CODEX_COMPANION_HEARTBEAT_MS: "100", CODEX_COMPANION_HEARTBEAT_STALE_MS: "1500" } });
    job = JSON.parse(current.stdout).job;
    return Boolean(job.threadId && job.worker?.pid);
  }, { timeoutMs: 15000, intervalMs: 50 });
  assert.ok(job.worker?.pid);
  try { process.kill(job.worker.pid, "SIGKILL"); } catch {}
  await waitFor(() => !isPidAlive(job.worker.pid), { timeoutMs: 15000, intervalMs: 50 });
  const waited = ws.companion(["wait", id, "--json", "--poll-interval-ms", "100"], { env: { CODEX_COMPANION_HEARTBEAT_MS: "100", CODEX_COMPANION_HEARTBEAT_STALE_MS: "1500" } });
  assert.equal(waited.status, EXIT.LOST, waited.stdout + waited.stderr);
  assert.equal(JSON.parse(waited.stdout).jobs[0].status, "orphaned");
  const lost = await waitFor(() => {
    const result = ws.companion(["status", id, "--json"], { env: { CODEX_COMPANION_HEARTBEAT_MS: "100", CODEX_COMPANION_HEARTBEAT_STALE_MS: "1500" } });
    const finalJob = JSON.parse(result.stdout).job;
    return result.status === 0 && finalJob.status === "orphaned" && finalJob.threadId === job.threadId;
  }, { timeoutMs: 15000, intervalMs: 50 });
  assert.equal(lost, true);
});

test("missing index entries resolve from job files and unknown wait exits lost", async (t) => {
  const ws = await makeCompanionWorkspace("review-ok", { fakeOptions: { turnScript: [{ type: "delay", ms: 60000 }] } });
  t.after(() => ws.close());
  useWorkspaceStateEnv(t, ws);
  const launched = ws.companion(["task", "--background", "--json", "index recovery task"]);
  assert.equal(launched.status, 0, launched.stderr);
  const id = JSON.parse(launched.stdout).jobId;
  const jobFile = resolveJobFile(ws.repo, id);
  const stored = readJobFile(jobFile);
  t.after(() => killPid(stored.worker?.pid));
  const index = resolveStateFile(ws.repo);
  const state = JSON.parse(fs.readFileSync(index, "utf8"));
  state.jobs = state.jobs.filter((item) => item.id !== id);
  fs.writeFileSync(index, JSON.stringify(state, null, 2));
  const status = ws.companion(["status", id, "--json"]);
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).job.id, id);
  assert.ok(JSON.parse(fs.readFileSync(index, "utf8")).jobs.some((item) => item.id === id));
  const waiting = ws.companion(["wait", id, "--json", "--timeout-ms", "500", "--poll-interval-ms", "100"]);
  assert.equal(waiting.status, EXIT.WAITER_TIMEOUT, waiting.stderr);
  assert.equal(JSON.parse(waiting.stdout).jobs[0].status, "running");
  const result = ws.companion(["result", id, "--json"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /still queued|still running/);
  assert.doesNotMatch(result.stderr, /No job found/);
  const unknown = ws.companion(["wait", "no-such-id", "--json"]);
  assert.equal(unknown.status, EXIT.LOST);
  assert.ok(stored.request);
});

test("result and cancel reconcile unindexed dead workers before using their status", async (t) => {
  const ws = await makeCompanionWorkspace("review-ok", { fakeOptions: { turnScript: [{ type: "delay", ms: 60000 }] } });
  t.after(() => ws.close());
  useWorkspaceStateEnv(t, ws);
  const ids = [];
  const workers = [];
  t.after(() => workers.forEach(killPid));

  for (const label of ["result", "cancel"]) {
    const launched = ws.companion(["task", "--background", "--json", `${label} dead unindexed worker`]);
    assert.equal(launched.status, 0, launched.stderr);
    const id = JSON.parse(launched.stdout).jobId;
    ids.push(id);
    let job;
    await waitFor(() => {
      const status = ws.companion(["status", id, "--json"]);
      job = JSON.parse(status.stdout).job;
      return Boolean(job.threadId && job.worker?.pid);
    }, { timeoutMs: 5000, intervalMs: 50 });
    workers.push(job.worker.pid);
    try { process.kill(job.worker.pid, "SIGKILL"); } catch {}

    const index = resolveStateFile(ws.repo);
    const state = JSON.parse(fs.readFileSync(index, "utf8"));
    state.jobs = state.jobs.filter((item) => item.id !== id);
    fs.writeFileSync(index, JSON.stringify(state, null, 2));
  }

  const result = resolveResultJob(ws.repo, ids[0]);
  assert.equal(result.job.status, "lost");
  assert.equal(readJobFile(resolveJobFile(ws.repo, ids[0])).status, "lost");

  assert.throws(() => resolveCancelableJob(ws.repo, ids[1]), /No active job found/);
  const cancelledTarget = readJobFile(resolveJobFile(ws.repo, ids[1]));
  assert.equal(cancelledTarget.status, "lost");
  assert.equal(cancelledTarget.phase, "worker-exited");
  assert.ok(cancelledTarget.reconciledAt);
});

test("reconciliation preserves a completion written after its liveness assessment", async (t) => {
  const ws = await makeCompanionWorkspace();
  t.after(() => ws.close());
  useWorkspaceStateEnv(t, ws);
  const id = "task-reconcile-completion-race";
  const job = {
    id,
    schemaVersion: 2,
    status: "running",
    workspaceRoot: ws.repo,
    jobClass: "task",
    createdAt: new Date().toISOString(),
    worker: { pid: 99999999, startTime: "missing-process" }
  };
  writeJobFile(ws.repo, id, job);
  upsertJob(ws.repo, job);
  const logFile = resolveJobLogFile(ws.repo, id);
  fs.writeFileSync(logFile, "worker started\n");

  const completed = {
    ...job,
    status: "completed",
    phase: "done",
    completedAt: new Date().toISOString(),
    result: { finalMessage: "real result" }
  };
  // This seam deterministically writes the worker's terminal record after the
  // stale assessment and immediately before reconciliation acquires the lock.
  reconcileJob(ws.repo, job, { beforeCommitForTest: () => writeJobFile(ws.repo, id, completed) });

  const stored = readJobFile(resolveJobFile(ws.repo, id));
  assert.equal(stored.status, "completed");
  assert.deepEqual(stored.result, { finalMessage: "real result" });
});

test("result and cancel prefix matching filters by relevant job status first", async (t) => {
  const ws = await makeCompanionWorkspace();
  t.after(() => ws.close());
  useWorkspaceStateEnv(t, ws);
  const active = { id: "task-prefix-active", status: "queued", workspaceRoot: ws.repo, createdAt: new Date().toISOString() };
  const finished = { id: "task-prefix-finished", status: "completed", workspaceRoot: ws.repo, createdAt: new Date().toISOString() };
  for (const job of [active, finished]) {
    writeJobFile(ws.repo, job.id, job);
    upsertJob(ws.repo, job);
  }

  assert.equal(resolveCancelableJob(ws.repo, "task-prefix-").job.id, active.id);
  assert.equal(resolveResultJob(ws.repo, "task-prefix-").job.id, finished.id);
});

test("parent worker metadata patch preserves a worker's already-written running state", async (t) => {
  const ws = await makeCompanionWorkspace();
  t.after(() => ws.close());
  useWorkspaceStateEnv(t, ws);
  const id = "task-worker-metadata-race";
  const queued = { id, status: "queued", phase: "queued", workspaceRoot: ws.repo, createdAt: new Date().toISOString() };
  writeJobFile(ws.repo, id, queued);
  upsertJob(ws.repo, queued);

  // The detached worker can publish running before the parent stores spawn metadata.
  writeJobFile(ws.repo, id, { ...queued, status: "running", phase: "starting", startedAt: new Date().toISOString() });
  const worker = { pid: process.pid, startTime: readProcessStartTime(process.pid), stderrFile: `${resolveJobFile(ws.repo, id)}.worker.err` };
  const recorded = recordTaskWorker(ws.repo, id, worker);

  assert.equal(recorded.status, "running");
  assert.equal(recorded.phase, "starting");
  assert.deepEqual(recorded.worker, worker);
  assert.equal(recorded.pid, worker.pid);
});

test("worker running transition preserves parent metadata written first", async (t) => {
  const ws = await makeCompanionWorkspace();
  t.after(() => ws.close());
  useWorkspaceStateEnv(t, ws);
  const id = "task-worker-running-race";
  const queued = { id, status: "queued", phase: "queued", workspaceRoot: ws.repo, createdAt: new Date().toISOString() };
  writeJobFile(ws.repo, id, queued);
  upsertJob(ws.repo, queued);
  const worker = { pid: process.pid, startTime: readProcessStartTime(process.pid), stderrFile: `${resolveJobFile(ws.repo, id)}.worker.err` };
  recordTaskWorker(ws.repo, id, worker);

  // The worker starts with its pre-spawn snapshot, while the parent patch is
  // already persisted; its locked status transition must merge from disk.
  const running = recordTaskRunning(ws.repo, { ...queued, status: "running", phase: "starting" }, {
    pid: worker.pid,
    startTime: worker.startTime,
    stderrFile: null
  });

  assert.equal(running.status, "running");
  assert.deepEqual(running.worker, worker);
  assert.equal(running.pid, worker.pid);
});

test("v2 records carry worker heartbeat age and stale heartbeats reconcile", async (t) => {
  const ws = await makeCompanionWorkspace();
  t.after(() => ws.close());
  useWorkspaceStateEnv(t, ws);
  const stubborn = (await import("./helpers.mjs")).spawnStubborn();
  const pid = await stubborn.ready;
  t.after(() => stubborn.kill());
  const id = "task-stale-heartbeat";
  const job = { id, schemaVersion: 2, status: "running", workspaceRoot: ws.repo, jobClass: "task", createdAt: new Date().toISOString(), worker: { pid, startTime: readProcessStartTime(pid) } };
  writeJobFile(ws.repo, id, job);
  const heartbeatFile = resolveHeartbeatFile(ws.repo, id);
  fs.writeFileSync(heartbeatFile, JSON.stringify({ pid, startTime: readProcessStartTime(pid), at: new Date(Date.now() - 100000).toISOString() }));
  const result = ws.companion(["status", id, "--json"], { env: { CODEX_COMPANION_HEARTBEAT_STALE_MS: "1500" } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).job.status, "lost");
  assert.ok(JSON.parse(result.stdout).job.heartbeatAgeSec > 1.5);
  assert.ok(isPidAlive(pid));
  const reusedId = "task-reused-pid";
  writeJobFile(ws.repo, reusedId, { id: reusedId, schemaVersion: 2, status: "running", workspaceRoot: ws.repo, jobClass: "task", createdAt: new Date().toISOString(), worker: { pid, startTime: "bogus" } });
  const reused = ws.companion(["status", reusedId, "--json"]);
  assert.equal(reused.status, 0, reused.stderr);
  assert.equal(JSON.parse(reused.stdout).job.status, "lost");
  const legacyId = "task-live-v1";
  writeJobFile(ws.repo, legacyId, { id: legacyId, status: "running", workspaceRoot: ws.repo, createdAt: new Date().toISOString(), worker: { pid, startTime: "bogus" } });
  const legacy = ws.companion(["status", legacyId, "--json"]);
  assert.equal(legacy.status, 0, legacy.stderr);
  assert.equal(JSON.parse(legacy.stdout).job.status, "running");
});

test("worker errors before runTrackedJob are captured and referenced by status", async (t) => {
  const ws = await makeCompanionWorkspace();
  t.after(() => ws.close());
  useWorkspaceStateEnv(t, ws);
  const id = "task-broken-worker";
  writeJobFile(ws.repo, id, { id, schemaVersion: 2, status: "queued", workspaceRoot: ws.repo, jobClass: "task", createdAt: new Date().toISOString() });
  const scriptPath = new URL("../plugins/codex/scripts/codex-companion.mjs", import.meta.url).pathname;
  const worker = spawnTaskWorker({ scriptPath, cwd: ws.repo, workspaceRoot: ws.repo, jobId: id, env: ws.env });
  writeJobFile(ws.repo, id, { ...readJobFile(resolveJobFile(ws.repo, id)), worker, pid: worker.pid });
  await waitFor(() => !isPidAlive(worker.pid), { timeoutMs: 3000, intervalMs: 25 });
  const stderrFile = resolveJobFile(ws.repo, id).replace(/\.json$/, ".worker.err");
  assert.match(fs.readFileSync(stderrFile, "utf8"), /missing its task request payload/);
  const json = ws.companion(["status", id, "--json"]);
  assert.equal(json.status, 0, json.stderr);
  assert.equal(JSON.parse(json.stdout).job.status, "lost");
  assert.equal(JSON.parse(json.stdout).job.worker.stderrFile, stderrFile);
  const text = ws.companion(["status", id]);
  assert.match(text.stdout, /\.worker\.err/);
});

test("orphaned task send returns orphaned without follow-up and continues the same thread otherwise", async (t) => {
  const ws = await makeCompanionWorkspace("review-ok", { fakeOptions: { turnScript: [{ type: "delay", ms: 60000 }] } });
  t.after(() => ws.close());
  const launched = ws.companion(["task", "--background", "--detach", "--json", "slow task for send"]);
  assert.equal(launched.status, 0, launched.stderr);
  const id = JSON.parse(launched.stdout).jobId;
  let job;
  let followupPid;
  t.after(() => { killPid(job?.worker?.pid); killPid(followupPid); });
  await waitFor(() => {
    const result = ws.companion(["status", id, "--json"]);
    job = JSON.parse(result.stdout).job;
    return Boolean(job.threadId);
  }, { timeoutMs: 15000, intervalMs: 50 });
  try { process.kill(job.worker.pid, "SIGKILL"); } catch {}
  await waitFor(() => !isPidAlive(job.worker.pid), { timeoutMs: 15000, intervalMs: 50 });
  await waitFor(() => JSON.parse(ws.companion(["status", id, "--json"]).stdout).job.status === "orphaned", { timeoutMs: 15000, intervalMs: 50 });
  const noFollow = ws.companion(["send", id, "message", "--no-follow-up", "--json"]);
  assert.equal(noFollow.status, EXIT.LOST, noFollow.stderr);
  assert.equal(JSON.parse(noFollow.stdout).status, "orphaned");
  const continued = ws.companion(["send", id, "continue thread", "--background", "--json"]);
  assert.equal(continued.status, 0, continued.stderr);
  const result = JSON.parse(continued.stdout);
  assert.equal(result.parentJobId, id);
  assert.equal(result.threadId, job.threadId);
  const followupStatus = ws.companion(["status", result.jobId, "--json"]);
  if (followupStatus.status === 0) followupPid = JSON.parse(followupStatus.stdout).job.worker?.pid;
});

test("Stop hook does not report a reconciled lost job as running", async (t) => {
  const ws = await makeCompanionWorkspace("review-ok", { fakeOptions: { turnScript: [{ type: "delay", ms: 60000 }] } });
  t.after(() => ws.close());
  const launched = ws.companion(["task", "--background", "--json", "slow task for hook"]);
  assert.equal(launched.status, 0, launched.stderr);
  const id = JSON.parse(launched.stdout).jobId;
  const job = JSON.parse(ws.companion(["status", id, "--json"]).stdout).job;
  t.after(() => killPid(job.worker?.pid));
  try { process.kill(job.worker.pid, "SIGKILL"); } catch {}
  const hook = new URL("../plugins/codex/scripts/stop-review-gate-hook.mjs", import.meta.url).pathname;
  const result = run(process.execPath, [hook], { cwd: ws.repo, env: ws.env, input: JSON.stringify({ cwd: ws.repo }) });
  assert.doesNotMatch(result.stderr, /still running/);
});

test("result marks a terminal job as read", async (t) => {
  const ws = await makeCompanionWorkspace();
  t.after(() => ws.close());
  useWorkspaceStateEnv(t, ws);
  const launched = ws.companion(["task", "result-read task"]);
  assert.equal(launched.status, 0, launched.stderr);
  const id = JSON.parse(ws.companion(["status", "--json"]).stdout).latestFinished.id;
  const result = ws.companion(["result", id, "--json"]);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(JSON.parse(result.stdout).storedJob.resultReadAt);
});

test("result without an id chooses the newest terminal job when a newer job is active", async (t) => {
  const ws = await makeCompanionWorkspace();
  t.after(() => ws.close());
  const older = ws.companion(["task", "completed result to keep"]);
  assert.equal(older.status, 0, older.stderr);
  const olderId = JSON.parse(ws.companion(["status", "--json"]).stdout).latestFinished.id;
  setFakeCodexOptions(ws.binDir, { turnScript: [{ type: "delay", ms: 60000 }] });
  const newer = ws.companion(["task", "--background", "--json", "new active task"]);
  assert.equal(newer.status, 0, newer.stderr);
  const newerId = JSON.parse(newer.stdout).jobId;
  const active = JSON.parse(ws.companion(["status", newerId, "--json"]).stdout).job;
  t.after(() => killPid(active.worker?.pid));
  const result = ws.companion(["result", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).job.id, olderId);
});

test("traversal job references are rejected without reading files outside jobs", async (t) => {
  const ws = await makeCompanionWorkspace();
  t.after(() => ws.close());
  const outside = fs.mkdtempSync(`${ws.home}/outside-`);
  const planted = `${outside}/leak.json`;
  fs.writeFileSync(planted, JSON.stringify({ id: "planted", status: "completed", secretToken: "TOP-SECRET-VALUE" }));
  const relative = planted.slice(0, -5);
  ws.companion(["status", "seed-state-dir"]);
  const stateRoot = `${ws.env.CLAUDE_PLUGIN_DATA}/state`;
  const workspaceState = fs.readdirSync(stateRoot)[0];
  const jobsDir = `${stateRoot}/${workspaceState}/jobs`;
  const reference = path.relative(jobsDir, relative);
  assert.match(reference, /\.\./);
  const result = ws.companion(["status", reference, "--json"]);
  assert.equal(result.status, EXIT.LOST);
  assert.match(result.stderr, /No job found/);
  assert.doesNotMatch(result.stdout + result.stderr, /TOP-SECRET-VALUE/);
});

test("heartbeat paths distinguish worker and owner", () => {
  assert.match(resolveHeartbeatFile("/tmp/work", "abc"), /abc\.hb$/);
  assert.match(resolveHeartbeatFile("/tmp/work", "abc", "owner"), /abc\.owner\.hb$/);
});
