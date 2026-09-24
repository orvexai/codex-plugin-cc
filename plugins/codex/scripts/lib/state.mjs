import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveWorkspaceRoot } from "./workspace.mjs";

const STATE_VERSION = 1;
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const GLOBAL_CONFIG_ENV = "CODEX_COMPANION_CONFIG";
const FALLBACK_STATE_ROOT_DIR = path.join(os.tmpdir(), "codex-companion");
const STATE_FILE_NAME = "state.json";
const LOCK_FILE_NAME = "state.lock";
const JOBS_DIR_NAME = "jobs";
export const MAX_JOBS = 200;
const LOCK_TIMEOUT_MS = 15000;
const LOCK_STALE_MS = 30000;

const sleepCell = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms) {
  Atomics.wait(sleepCell, 0, 0, ms);
}

function nowIso() {
  return new Date().toISOString();
}

function defaultState() {
  return {
    version: STATE_VERSION,
    config: {
      stopReviewGate: false
    },
    jobs: []
  };
}

// Write-then-rename so concurrent readers never observe a half-written file.
export function writeFileAtomic(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  fs.writeFileSync(tempPath, contents, "utf8");
  fs.renameSync(tempPath, filePath);
}

export function resolveStateRootDir() {
  const pluginDataDir = process.env[PLUGIN_DATA_ENV];
  return pluginDataDir ? path.join(pluginDataDir, "state") : FALLBACK_STATE_ROOT_DIR;
}

export function resolveStateDir(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonicalWorkspaceRoot = workspaceRoot;
  try {
    canonicalWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonicalWorkspaceRoot = workspaceRoot;
  }

  const slugSource = path.basename(workspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonicalWorkspaceRoot).digest("hex").slice(0, 16);
  return path.join(resolveStateRootDir(), `${slug}-${hash}`);
}

export function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), STATE_FILE_NAME);
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
}

export function ensureStateDir(cwd) {
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true });
}

function readLockOwner(lockFile) {
  try {
    const owner = JSON.parse(fs.readFileSync(lockFile, "utf8"));
    return owner && typeof owner === "object" ? owner : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

// A lock is stale only when its owner process is gone. A lock whose owner has
// not been written yet (or is unreadable) is stale only once clearly abandoned.
function findStaleLockToken(lockFile) {
  const owner = readLockOwner(lockFile);
  if (owner?.pid) {
    return isProcessAlive(owner.pid) ? null : String(owner.token ?? "");
  }
  try {
    return Date.now() - fs.statSync(lockFile).mtimeMs > LOCK_STALE_MS ? "" : null;
  } catch {
    return null;
  }
}

function removeLockIfOwnedBy(lockFile, token) {
  const owner = readLockOwner(lockFile);
  if (String(owner?.token ?? "") === token) {
    fs.rmSync(lockFile, { force: true });
  }
}

function lockFileAgeMs(filePath) {
  try {
    return Date.now() - fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

// Reclaims a dead owner's lock. Reclaimers serialise on a guard file and
// re-check the lock under it: while the stale lock exists nobody can acquire a
// new one, and no other reclaimer can act, so the lock removed here is always
// the dead owner's and never a live replacement.
function reclaimStaleLock(lockFile, staleToken) {
  const guardFile = `${lockFile}.reclaim`;
  let guard;
  try {
    guard = fs.openSync(guardFile, "wx");
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw error;
    }
    const guardOwner = readLockOwner(guardFile);
    const abandoned = guardOwner?.pid ? !isProcessAlive(guardOwner.pid) : lockFileAgeMs(guardFile) > LOCK_STALE_MS;
    if (abandoned) {
      fs.rmSync(guardFile, { force: true });
    }
    return false;
  }
  try {
    fs.writeSync(guard, JSON.stringify({ pid: process.pid, createdAt: nowIso() }));
    if (findStaleLockToken(lockFile) === staleToken) {
      fs.rmSync(lockFile, { force: true });
      return true;
    }
    return false;
  } finally {
    fs.closeSync(guard);
    fs.rmSync(guardFile, { force: true });
  }
}

// Serialises read-modify-write cycles on state.json across processes. Parallel
// background jobs in one workspace otherwise overwrite each other's updates.
// The lock records its owner so it is only ever broken when the owner is dead,
// and only ever released by the process that holds it.
function withStateLock(cwd, fn) {
  ensureStateDir(cwd);
  const lockFile = path.join(resolveStateDir(cwd), LOCK_FILE_NAME);
  const token = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  const timeoutMs = Number(process.env.CODEX_COMPANION_LOCK_TIMEOUT_MS) || LOCK_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fd = fs.openSync(lockFile, "wx");
      try {
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, token, createdAt: nowIso() }));
      } finally {
        fs.closeSync(fd);
      }
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      const staleToken = findStaleLockToken(lockFile);
      if (staleToken !== null && reclaimStaleLock(lockFile, staleToken)) {
        continue;
      }
      // Waiting on a live owner, or on another process's reclaim: back off.
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for the Codex companion state lock at ${lockFile}.`);
      }
      sleepSync(5 + Math.floor(Math.random() * 20));
    }
  }

  try {
    return fn();
  } finally {
    removeLockIfOwnedBy(lockFile, token);
  }
}

export function loadState(cwd) {
  const stateFile = resolveStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return defaultState();
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return {
      ...defaultState(),
      ...parsed,
      config: {
        ...defaultState().config,
        ...(parsed.config ?? {})
      },
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : []
    };
  } catch {
    return defaultState();
  }
}

function pruneJobs(jobs) {
  return [...jobs]
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")))
    .slice(0, MAX_JOBS);
}

function removeFileIfExists(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

function saveStateUnlocked(cwd, state) {
  const previousJobs = loadState(cwd).jobs;
  ensureStateDir(cwd);
  const nextJobs = pruneJobs(state.jobs ?? []);
  const nextState = {
    version: STATE_VERSION,
    config: {
      ...defaultState().config,
      ...(state.config ?? {})
    },
    jobs: nextJobs
  };

  const retainedIds = new Set(nextJobs.map((job) => job.id));
  for (const job of previousJobs) {
    if (retainedIds.has(job.id)) {
      continue;
    }
    removeJobFile(resolveJobFile(cwd, job.id));
    removeFileIfExists(job.logFile);
    removeFileIfExists(resolveJobInboxFile(cwd, job.id));
    removeFileIfExists(`${resolveJobInboxFile(cwd, job.id)}.closed`);
  }

  writeFileAtomic(resolveStateFile(cwd), `${JSON.stringify(nextState, null, 2)}\n`);
  return nextState;
}

export function saveState(cwd, state) {
  return withStateLock(cwd, () => saveStateUnlocked(cwd, state));
}

export function updateState(cwd, mutate) {
  return withStateLock(cwd, () => {
    const state = loadState(cwd);
    mutate(state);
    return saveStateUnlocked(cwd, state);
  });
}

export function generateJobId(prefix = "job") {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function upsertJob(cwd, jobPatch) {
  return updateState(cwd, (state) => {
    const timestamp = nowIso();
    const existingIndex = state.jobs.findIndex((job) => job.id === jobPatch.id);
    if (existingIndex === -1) {
      state.jobs.unshift({
        createdAt: timestamp,
        updatedAt: timestamp,
        ...jobPatch
      });
      return;
    }
    state.jobs[existingIndex] = {
      ...state.jobs[existingIndex],
      ...jobPatch,
      updatedAt: timestamp
    };
  });
}

export function listJobs(cwd) {
  return loadState(cwd).jobs;
}

export function setConfig(cwd, key, value) {
  return updateState(cwd, (state) => {
    const nextConfig = { ...state.config };
    if (value == null) {
      delete nextConfig[key];
    } else {
      nextConfig[key] = value;
    }
    state.config = nextConfig;
  });
}

export function getConfig(cwd) {
  return loadState(cwd).config;
}

// User-level defaults shared by every workspace (model, effort, sandbox, network).
export function resolveGlobalConfigFile() {
  if (process.env[GLOBAL_CONFIG_ENV]) {
    return path.resolve(process.env[GLOBAL_CONFIG_ENV]);
  }
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(configHome, "codex-companion", "config.json");
}

export function getGlobalConfig() {
  const configFile = resolveGlobalConfigFile();
  if (!fs.existsSync(configFile)) {
    return {};
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(configFile, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function setGlobalConfig(key, value) {
  const nextConfig = { ...getGlobalConfig() };
  if (value == null) {
    delete nextConfig[key];
  } else {
    nextConfig[key] = value;
  }
  writeFileAtomic(resolveGlobalConfigFile(), `${JSON.stringify(nextConfig, null, 2)}\n`);
  return nextConfig;
}

export function writeJobFile(cwd, jobId, payload) {
  ensureStateDir(cwd);
  const jobFile = resolveJobFile(cwd, jobId);
  writeFileAtomic(jobFile, `${JSON.stringify(payload, null, 2)}\n`);
  return jobFile;
}

export function readJobFile(jobFile) {
  return JSON.parse(fs.readFileSync(jobFile, "utf8"));
}

function removeJobFile(jobFile) {
  if (fs.existsSync(jobFile)) {
    fs.unlinkSync(jobFile);
  }
}

export function resolveJobLogFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.log`);
}

export function resolveJobFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.json`);
}

export function resolveJobInboxFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.inbox.jsonl`);
}

// Job ids are unique across workspaces, so a job launched with --cwd <other>
// can still be inspected, awaited or messaged from anywhere.
export function findJobAcrossWorkspaces(jobId) {
  if (!jobId) {
    return null;
  }
  const roots = [...new Set([resolveStateRootDir(), FALLBACK_STATE_ROOT_DIR])];
  for (const root of roots) {
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const jobFile = path.join(root, entry.name, JOBS_DIR_NAME, `${jobId}.json`);
      if (!fs.existsSync(jobFile)) {
        continue;
      }
      try {
        const job = readJobFile(jobFile);
        if (job?.workspaceRoot) {
          return job;
        }
      } catch {
        // A partially written or corrupt record is not a match.
      }
    }
  }
  return null;
}
