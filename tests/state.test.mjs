import "./_isolation.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import { spawnSync } from "node:child_process";

import { MAX_JOBS, listJobs, resolveJobFile, resolveJobLogFile, resolveStateDir, resolveStateFile, saveState, upsertJob } from "../plugins/codex/scripts/lib/state.mjs";

test("resolveStateDir uses a temp-backed per-workspace directory", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);

  assert.equal(stateDir.startsWith(os.tmpdir()), true);
  assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
  assert.match(stateDir, new RegExp(`^${os.tmpdir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

test("resolveStateDir uses CLAUDE_PLUGIN_DATA when it is provided", () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;

  try {
    const stateDir = resolveStateDir(workspace);

    assert.equal(stateDir.startsWith(path.join(pluginDataDir, "state")), true);
    assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
    assert.match(
      stateDir,
      new RegExp(`^${path.join(pluginDataDir, "state").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
    );
  } finally {
    if (previousPluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }
});

test("saveState prunes dropped job artifacts when indexed jobs exceed the cap", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });

  const jobs = Array.from({ length: MAX_JOBS + 1 }, (_, index) => {
    const jobId = `job-${index}`;
    const updatedAt = new Date(Date.UTC(2026, 0, 1, 0, index, 0)).toISOString();
    const logFile = resolveJobLogFile(workspace, jobId);
    const jobFile = resolveJobFile(workspace, jobId);
    fs.writeFileSync(logFile, `log ${jobId}\n`, "utf8");
    fs.writeFileSync(jobFile, JSON.stringify({ id: jobId, status: "completed" }, null, 2), "utf8");
    return {
      id: jobId,
      status: "completed",
      logFile,
      updatedAt,
      createdAt: updatedAt
    };
  });

  fs.writeFileSync(
    stateFile,
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  saveState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs
  });

  const prunedJobFile = resolveJobFile(workspace, "job-0");
  const prunedLogFile = resolveJobLogFile(workspace, "job-0");
  const retainedJobFile = resolveJobFile(workspace, `job-${MAX_JOBS}`);
  const retainedLogFile = resolveJobLogFile(workspace, `job-${MAX_JOBS}`);
  const jobsDir = path.dirname(prunedJobFile);

  assert.equal(fs.existsSync(retainedJobFile), true);
  assert.equal(fs.existsSync(retainedLogFile), true);

  const savedState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(savedState.jobs.length, MAX_JOBS);
  assert.deepEqual(
    savedState.jobs.map((job) => job.id),
    Array.from({ length: MAX_JOBS }, (_, index) => `job-${MAX_JOBS - index}`)
  );
  assert.deepEqual(
    fs.readdirSync(jobsDir).sort(),
    Array.from({ length: MAX_JOBS }, (_, index) => `job-${index + 1}`)
      .flatMap((jobId) => [`${jobId}.json`, `${jobId}.log`])
      .sort()
  );
});

test("state updates break a lock whose owner process has exited", () => {
  const workspace = makeTempDir();
  const lockFile = path.join(resolveStateDir(workspace), "state.lock");
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  const exited = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  fs.writeFileSync(lockFile, JSON.stringify({ pid: exited.pid, token: "dead-owner", createdAt: new Date().toISOString() }));

  upsertJob(workspace, { id: "job-after-stale-lock", status: "queued" });

  assert.equal(fs.existsSync(lockFile), false);
  assert.equal(listJobs(workspace)[0].id, "job-after-stale-lock");
});

function withLockTimeout(ms, fn) {
  const previous = process.env.CODEX_COMPANION_LOCK_TIMEOUT_MS;
  process.env.CODEX_COMPANION_LOCK_TIMEOUT_MS = String(ms);
  try {
    return fn();
  } finally {
    if (previous === undefined) {
      delete process.env.CODEX_COMPANION_LOCK_TIMEOUT_MS;
    } else {
      process.env.CODEX_COMPANION_LOCK_TIMEOUT_MS = previous;
    }
  }
}

test("state updates never break a lock whose owner is still alive", () => {
  const workspace = makeTempDir();
  const lockFile = path.join(resolveStateDir(workspace), "state.lock");
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  const liveLock = JSON.stringify({ pid: process.pid, token: "live-owner", createdAt: new Date().toISOString() });
  fs.writeFileSync(lockFile, liveLock);

  withLockTimeout(300, () => {
    assert.throws(() => upsertJob(workspace, { id: "blocked", status: "queued" }), /Timed out waiting for the Codex companion state lock/);
  });
  assert.equal(fs.readFileSync(lockFile, "utf8"), liveLock);
});

test("stale-lock reclamation waits for a live reclaimer and clears an abandoned one", () => {
  const workspace = makeTempDir();
  const lockFile = path.join(resolveStateDir(workspace), "state.lock");
  const guardFile = `${lockFile}.reclaim`;
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  const exited = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  fs.writeFileSync(lockFile, JSON.stringify({ pid: exited.pid, token: "dead-owner", createdAt: new Date().toISOString() }));

  fs.writeFileSync(guardFile, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
  withLockTimeout(300, () => {
    assert.throws(() => upsertJob(workspace, { id: "waits-for-reclaimer", status: "queued" }), /Timed out/);
  });
  assert.equal(fs.existsSync(lockFile), true);

  fs.writeFileSync(guardFile, JSON.stringify({ pid: exited.pid, createdAt: new Date().toISOString() }));
  upsertJob(workspace, { id: "after-abandoned-reclaimer", status: "queued" });
  assert.equal(fs.existsSync(lockFile), false);
  assert.equal(fs.existsSync(guardFile), false);
  assert.equal(listJobs(workspace)[0].id, "after-abandoned-reclaimer");
});
