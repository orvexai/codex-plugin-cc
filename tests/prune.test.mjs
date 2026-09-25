import "./_isolation.mjs";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import {
  MAX_JOBS,
  listJobs,
  markResultRead,
  resolveJobFile,
  resolveJobInboxFile,
  resolveJobLogFile,
  resolveStateDir,
  resolveStateFile,
  saveState,
  upsertJob,
  writeJobFile
} from "../plugins/codex/scripts/lib/state.mjs";

function datedJob(id, updatedAt, fields = {}) {
  return { id, status: "completed", updatedAt, createdAt: updatedAt, ...fields };
}

function saveJobs(workspace, jobs) {
  return saveState(workspace, { version: 1, config: {}, jobs });
}

test("pruning preserves the oldest running job and its json, log and inbox files", () => {
  const workspace = makeTempDir();
  const oldestAt = "2026-01-01T00:00:00.000Z";
  const jobs = Array.from({ length: MAX_JOBS }, (_, index) => {
    const id = index === 0 ? "old-running" : `job-${index}`;
    const updatedAt = index === 0 ? oldestAt : new Date(Date.UTC(2026, 0, 2, 0, index)).toISOString();
    const job = datedJob(id, updatedAt, index === 0 ? { status: "running" } : {});
    fs.writeFileSync(resolveJobFile(workspace, id), JSON.stringify(job));
    fs.writeFileSync(resolveJobLogFile(workspace, id), `log for ${id}`);
    fs.writeFileSync(resolveJobInboxFile(workspace, id), `inbox for ${id}`);
    return job;
  });
  saveJobs(workspace, jobs);

  upsertJob(workspace, { id: "newest-job", status: "completed" });

  assert.equal(listJobs(workspace).some((job) => job.id === "old-running"), true);
  assert.equal(fs.existsSync(resolveJobFile(workspace, "old-running")), true);
  assert.equal(fs.existsSync(resolveJobLogFile(workspace, "old-running")), true);
  assert.equal(fs.existsSync(resolveJobInboxFile(workspace, "old-running")), true);
});

test("recent unread completed jobs survive a full set of newer read jobs, while read jobs prune", () => {
  const recentWorkspace = makeTempDir();
  const now = Date.now();
  const unread = datedJob("unread-recent", new Date(now - 1000).toISOString(), { completedAt: new Date(now - 1000).toISOString() });
  const readJobs = Array.from({ length: MAX_JOBS }, (_, index) =>
    datedJob(`read-${index}`, new Date(now + index).toISOString(), {
      resultReadAt: new Date(now - 500).toISOString()
    })
  );
  saveJobs(recentWorkspace, [unread, ...readJobs]);
  assert.equal(listJobs(recentWorkspace).some((job) => job.id === unread.id), true);

  const readWorkspace = makeTempDir();
  const markedRead = { ...unread, id: "marked-read", resultReadAt: new Date(now - 500).toISOString() };
  saveJobs(readWorkspace, [markedRead, ...readJobs]);
  assert.equal(listJobs(readWorkspace).some((job) => job.id === markedRead.id), false);
});

test("unread completed jobs older than 24 hours are prunable", () => {
  const workspace = makeTempDir();
  const oldAt = "2026-04-01T00:00:00.000Z";
  const oldUnread = datedJob("unread-old", oldAt, { completedAt: oldAt });
  const newer = Array.from({ length: MAX_JOBS }, (_, index) =>
    datedJob(`new-${index}`, new Date(Date.parse(oldAt) + 25 * 60 * 60 * 1000 + index).toISOString(), {
      resultReadAt: oldAt
    })
  );

  saveJobs(workspace, [oldUnread, ...newer]);

  assert.equal(listJobs(workspace).some((job) => job.id === oldUnread.id), false);
});

test("more than 200 active jobs are all retained", () => {
  const workspace = makeTempDir();
  const jobs = Array.from({ length: MAX_JOBS + 5 }, (_, index) =>
    datedJob(`active-${index}`, new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(), { status: "running" })
  );

  saveJobs(workspace, jobs);

  assert.equal(listJobs(workspace).length, MAX_JOBS + 5);
});

test("markResultRead updates the job file and index and ignores unknown jobs", () => {
  const workspace = makeTempDir();
  const job = { id: "read-me", status: "completed", marker: "preserved" };
  upsertJob(workspace, job);
  writeJobFile(workspace, job.id, job);
  const at = "2026-05-01T12:34:56.000Z";

  markResultRead(workspace, job.id, { at });
  markResultRead(workspace, "missing-job", { at });

  assert.equal(JSON.parse(fs.readFileSync(resolveJobFile(workspace, job.id), "utf8")).resultReadAt, at);
  assert.equal(JSON.parse(fs.readFileSync(resolveJobFile(workspace, job.id), "utf8")).marker, "preserved");
  assert.equal(listJobs(workspace).find((entry) => entry.id === job.id).resultReadAt, at);
  assert.equal(fs.existsSync(resolveJobFile(workspace, "missing-job")), false);
});

test("markResultRead does not resurrect a job removed while waiting for the state lock", async (t) => {
  const workspace = makeTempDir();
  const job = { id: "race-job", status: "completed", updatedAt: new Date().toISOString() };
  saveJobs(workspace, [job]);
  writeJobFile(workspace, job.id, job);

  const lockFile = path.join(resolveStateDir(workspace), "state.lock");
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, token: "test-owner", createdAt: new Date().toISOString() }));

  const child = spawn(process.execPath, [
    "--input-type=module",
    "-e",
    `import { markResultRead } from ${JSON.stringify(new URL("../plugins/codex/scripts/lib/state.mjs", import.meta.url).href)};\nprocess.stdout.write("ready\\n");\nmarkResultRead(${JSON.stringify(workspace)}, "${job.id}", { at: "2026-05-01T12:34:56.000Z" });`
  ], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CODEX_COMPANION_LOCK_TIMEOUT_MS: "3000" } });
  t.after(() => {
    if (child.exitCode == null) {
      child.kill("SIGKILL");
    }
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.stdout.on("data", () => {
      if (stdout.includes("ready\n")) resolve();
    });
    child.once("exit", (code) => reject(new Error(`markResultRead child exited early (${code}): ${stderr}`)));
  });
  await new Promise((resolve) => setTimeout(resolve, 100));

  const stateFile = resolveStateFile(workspace);
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  state.jobs = state.jobs.filter((entry) => entry.id !== job.id);
  fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
  fs.rmSync(resolveJobFile(workspace, job.id), { force: true });
  fs.rmSync(lockFile, { force: true });

  const exit = await new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  assert.deepEqual(exit, { code: 0, signal: null }, stderr);
  assert.equal(listJobs(workspace).some((entry) => entry.id === job.id), false);
  assert.equal(fs.existsSync(resolveJobFile(workspace, job.id)), false);
});

test("unknown job statuses are treated as active during pruning", () => {
  const workspace = makeTempDir();
  const jobs = [
    datedJob("unknown-status", "2020-01-01T00:00:00.000Z", { status: "weird" }),
    ...Array.from({ length: MAX_JOBS }, (_, index) =>
      datedJob(`terminal-${index}`, new Date(Date.UTC(2026, 0, 2, 0, index)).toISOString(), {
        resultReadAt: "2026-01-01T00:00:00.000Z"
      })
    )
  ];

  saveJobs(workspace, jobs);

  assert.equal(listJobs(workspace).some((job) => job.id === "unknown-status"), true);
});
