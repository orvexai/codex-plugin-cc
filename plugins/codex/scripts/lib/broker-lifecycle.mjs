import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createBrokerEndpoint, parseBrokerEndpoint } from "./broker-endpoint.mjs";
import { resolveStateDir } from "./state.mjs";
import { isSameProcess, readProcessStartTime, terminateProcessTree } from "./process.mjs";

export const PID_FILE_ENV = "CODEX_COMPANION_APP_SERVER_PID_FILE";
export const LOG_FILE_ENV = "CODEX_COMPANION_APP_SERVER_LOG_FILE";
const BROKER_STATE_FILE = "broker.json";
const BROKER_LOCK_FILE = "broker.lock";
const BROKER_LOCK_TIMEOUT_MS = 15000;
const BROKER_LOCK_STALE_MS = 30000;
const BROKER_LOG_FILE = "broker.log";
const BROKER_LOG_MAX_BYTES = 5 * 1024 * 1024;
const brokerLockSleepCell = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms) {
  Atomics.wait(brokerLockSleepCell, 0, 0, ms);
}

export function createBrokerSessionDir(prefix = "cxc-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function connectToEndpoint(endpoint) {
  const target = parseBrokerEndpoint(endpoint);
  return net.createConnection({ path: target.path });
}

export async function waitForBrokerEndpoint(endpoint, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ready = await new Promise((resolve) => {
      const socket = connectToEndpoint(endpoint);
      socket.on("connect", () => {
        socket.end();
        resolve(true);
      });
      socket.on("error", () => resolve(false));
    });
    if (ready) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

export async function sendBrokerShutdown(endpoint) {
  await new Promise((resolve) => {
    const socket = connectToEndpoint(endpoint);
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ id: 1, method: "broker/shutdown", params: {} })}\n`);
    });
    socket.on("data", () => {
      socket.end();
      resolve();
    });
    socket.on("error", resolve);
    socket.on("close", resolve);
  });
}

export function spawnBrokerProcess({ scriptPath, cwd, endpoint, pidFile, logFile, env = process.env }) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  rotateBrokerLog(logFile);
  const logFd = fs.openSync(logFile, "a");
  const child = spawn(process.execPath, [scriptPath, "serve", "--endpoint", endpoint, "--cwd", cwd, "--pid-file", pidFile], {
    cwd,
    env,
    detached: true,
    stdio: ["ignore", logFd, logFd]
  });
  child.unref();
  fs.closeSync(logFd);
  return child;
}

function rotateBrokerLog(logFile) {
  try {
    if (fs.statSync(logFile).size < BROKER_LOG_MAX_BYTES) return;
    const previous = `${logFile}.1`;
    if (fs.existsSync(previous)) fs.unlinkSync(previous);
    fs.renameSync(logFile, previous);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function resolveBrokerStateFile(cwd) {
  return path.join(resolveStateDir(cwd), BROKER_STATE_FILE);
}

function resolveBrokerLockFile(cwd) {
  return path.join(resolveStateDir(cwd), BROKER_LOCK_FILE);
}

function readBrokerLockOwner(lockFile) {
  try {
    const owner = JSON.parse(fs.readFileSync(lockFile, "utf8"));
    return owner && typeof owner === "object" ? owner : null;
  } catch {
    return null;
  }
}

function brokerLockAgeMs(lockFile) {
  try { return Date.now() - fs.statSync(lockFile).mtimeMs; } catch { return 0; }
}

function findStaleBrokerLockToken(lockFile) {
  const owner = readBrokerLockOwner(lockFile);
  if (owner?.pid) return isSameProcess({ pid: owner.pid, startTime: owner.startTime ?? null }) ? null : String(owner.token ?? "");
  return brokerLockAgeMs(lockFile) > BROKER_LOCK_STALE_MS ? "" : null;
}

function reclaimStaleBrokerLock(lockFile, staleToken) {
  const guardFile = `${lockFile}.reclaim`;
  let guard;
  try { guard = fs.openSync(guardFile, "wx"); }
  catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const guardOwner = readBrokerLockOwner(guardFile);
    const abandoned = guardOwner?.pid
      ? !isSameProcess({ pid: guardOwner.pid, startTime: guardOwner.startTime ?? null })
      : brokerLockAgeMs(guardFile) > BROKER_LOCK_STALE_MS;
    if (abandoned) fs.rmSync(guardFile, { force: true });
    return false;
  }
  try {
    fs.writeSync(guard, JSON.stringify({ pid: process.pid, startTime: readProcessStartTime(process.pid), createdAt: new Date().toISOString() }));
    if (findStaleBrokerLockToken(lockFile) === staleToken) {
      fs.rmSync(lockFile, { force: true });
      return true;
    }
    return false;
  } finally {
    fs.closeSync(guard);
    fs.rmSync(guardFile, { force: true });
  }
}

function withBrokerSessionLock(cwd, callback) {
  const lockFile = resolveBrokerLockFile(cwd);
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  const token = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  const timeoutMs = Number(process.env.CODEX_COMPANION_LOCK_TIMEOUT_MS) || BROKER_LOCK_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fd = fs.openSync(lockFile, "wx");
      try {
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, startTime: readProcessStartTime(process.pid), token, createdAt: new Date().toISOString() }));
      } finally {
        fs.closeSync(fd);
      }
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const staleToken = findStaleBrokerLockToken(lockFile);
      if (staleToken !== null && reclaimStaleBrokerLock(lockFile, staleToken)) continue;
      if (Date.now() > deadline) throw new Error(`Timed out waiting for the Codex companion broker lock at ${lockFile}.`);
      sleepSync(5 + Math.floor(Math.random() * 20));
    }
  }
  try {
    return callback();
  } finally {
    if (String(readBrokerLockOwner(lockFile)?.token ?? "") === token) fs.rmSync(lockFile, { force: true });
  }
}

export function loadBrokerSession(cwd) {
  const stateFile = resolveBrokerStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    return null;
  }
}

export function saveBrokerSession(cwd, session) {
  return withBrokerSessionLock(cwd, () => writeBrokerSessionUnlocked(cwd, session));
}

function writeBrokerSessionUnlocked(cwd, session) {
  const stateFile = resolveBrokerStateFile(cwd);
  const tempFile = `${stateFile}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(tempFile, `${JSON.stringify(session, null, 2)}\n`, "utf8");
  fs.renameSync(tempFile, stateFile);
  return session;
}

function addLeaseToSession(session, { sessionId, pid = null }) {
  if (!sessionId) return session;
  const now = new Date().toISOString();
  const startTime = Number.isInteger(Number(pid)) && Number(pid) > 0 ? readProcessStartTime(pid) : null;
  const leases = Array.isArray(session.leases) ? session.leases : [];
  const existing = leases.find((lease) => lease.sessionId === sessionId);
  const nextLease = {
    sessionId,
    pid: Number.isInteger(Number(pid)) && Number(pid) > 0 ? Number(pid) : null,
    startTime,
    addedAt: existing?.addedAt ?? now,
    touchedAt: now
  };
  return { ...session, leases: [...leases.filter((lease) => lease.sessionId !== sessionId), nextLease] };
}

export function addBrokerLease(cwd, { sessionId, pid = null } = {}) {
  if (!sessionId) return loadBrokerSession(cwd);
  return withBrokerSessionLock(cwd, () => {
    const session = loadBrokerSession(cwd);
    return session ? writeBrokerSessionUnlocked(cwd, addLeaseToSession(session, { sessionId, pid })) : null;
  });
}

export function removeBrokerLease(cwd, sessionId) {
  return withBrokerSessionLock(cwd, () => {
    const session = loadBrokerSession(cwd);
    if (!session) return null;
    const next = { ...session, leases: (Array.isArray(session.leases) ? session.leases : []).filter((lease) => lease.sessionId !== sessionId) };
    return writeBrokerSessionUnlocked(cwd, next);
  });
}

export function claimBrokerSessionForShutdown(cwd) {
  return withBrokerSessionLock(cwd, () => {
    const session = loadBrokerSession(cwd);
    if (!session) return { session: null, shouldShutdown: false };
    const now = Date.now();
    const liveLeases = (Array.isArray(session.leases) ? session.leases : []).filter((lease) => {
      if (Number.isInteger(Number(lease.pid)) && Number(lease.pid) > 0) {
        return isSameProcess({ pid: Number(lease.pid), startTime: lease.startTime ?? null });
      }
      const touchedAt = Date.parse(lease.touchedAt ?? "");
      return Number.isFinite(touchedAt) && now - touchedAt < 24 * 60 * 60 * 1000;
    });
    if (liveLeases.length > 0) return { session, shouldShutdown: false };
    deleteBrokerSessionUnlocked(cwd);
    return { session, shouldShutdown: true };
  });
}

export function listLiveBrokerLeases(cwd, { now = Date.now() } = {}) {
  const session = loadBrokerSession(cwd);
  const leases = Array.isArray(session?.leases) ? session.leases : [];
  return leases.filter((lease) => {
    if (Number.isInteger(Number(lease.pid)) && Number(lease.pid) > 0) {
      return isSameProcess({ pid: Number(lease.pid), startTime: lease.startTime ?? null });
    }
    const touchedAt = Date.parse(lease.touchedAt ?? "");
    return Number.isFinite(touchedAt) && now - touchedAt < 24 * 60 * 60 * 1000;
  });
}

export function clearBrokerSession(cwd) {
  return withBrokerSessionLock(cwd, () => {
    const stateFile = resolveBrokerStateFile(cwd);
    if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile);
  });
}

function deleteBrokerSessionUnlocked(cwd) {
  const stateFile = resolveBrokerStateFile(cwd);
  if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile);
}

function sameBrokerSession(left, right) {
  return (left?.endpoint ?? null) === (right?.endpoint ?? null)
    && (left?.pid ?? null) === (right?.pid ?? null)
    && (left?.sessionDir ?? null) === (right?.sessionDir ?? null);
}

async function isBrokerEndpointReady(endpoint) {
  if (!endpoint) {
    return false;
  }
  try {
    return await waitForBrokerEndpoint(endpoint, 150);
  } catch {
    return false;
  }
}

export async function ensureBrokerSession(cwd, options = {}) {
  const killBrokerProcess = options.killProcess ?? terminateProcessTree;
  const existing = loadBrokerSession(cwd);
  if (existing && (await isBrokerEndpointReady(existing.endpoint))) {
    const current = withBrokerSessionLock(cwd, () => {
      const latest = loadBrokerSession(cwd);
      if (!sameBrokerSession(latest, existing)) return null;
      const next = addCurrentSessionLeaseToSession(latest, options);
      return options.env?.CODEX_COMPANION_SESSION_ID || process.env.CODEX_COMPANION_SESSION_ID
        ? writeBrokerSessionUnlocked(cwd, next)
        : next;
    });
    return current ?? ensureBrokerSession(cwd, options);
  }

  const sessionDir = createBrokerSessionDir();
  const endpointFactory = options.createBrokerEndpoint ?? createBrokerEndpoint;
  const endpoint = endpointFactory(sessionDir, options.platform);
  const pidFile = path.join(sessionDir, "broker.pid");
  const logFile = path.join(resolveStateDir(cwd), BROKER_LOG_FILE);
  const scriptPath =
    options.scriptPath ??
    fileURLToPath(new URL("../app-server-broker.mjs", import.meta.url));

  const child = spawnBrokerProcess({
    scriptPath,
    cwd,
    endpoint,
    pidFile,
    logFile,
    env: options.env ?? process.env
  });

  const ready = await waitForBrokerEndpoint(endpoint, options.timeoutMs ?? 2000);
  if (!ready) {
    teardownBrokerSession({
      endpoint,
      pidFile,
      logFile,
      sessionDir,
      pid: child.pid ?? null,
      killProcess: killBrokerProcess
    });
    return null;
  }

  const createdSession = {
    endpoint,
    pidFile,
    logFile,
    sessionDir,
    pid: child.pid ?? null
  };
  for (;;) {
    const observed = loadBrokerSession(cwd);
    const observedReady = observed ? await isBrokerEndpointReady(observed.endpoint) : false;
    const result = withBrokerSessionLock(cwd, () => {
      const latest = loadBrokerSession(cwd);
      if (!sameBrokerSession(latest, observed)) return { retry: true };
      if (latest && observedReady) {
        const leased = addCurrentSessionLeaseToSession(latest, options);
        return {
          session: options.env?.CODEX_COMPANION_SESSION_ID || process.env.CODEX_COMPANION_SESSION_ID
            ? writeBrokerSessionUnlocked(cwd, leased)
            : leased,
          adopted: true
        };
      }
      if (latest) {
        teardownBrokerSession({
          endpoint: latest.endpoint ?? null,
          pidFile: latest.pidFile ?? null,
          logFile: latest.logFile ?? null,
          sessionDir: latest.sessionDir ?? null,
          pid: latest.pid ?? null,
          killProcess: killBrokerProcess
        });
      }
      const next = addCurrentSessionLeaseToSession(createdSession, options);
      return { session: writeBrokerSessionUnlocked(cwd, next), adopted: false };
    });
    if (result.retry) continue;
    if (result.adopted) {
      teardownBrokerSession({ endpoint, pidFile, logFile, sessionDir, pid: child.pid ?? null, killProcess: killBrokerProcess });
    }
    return result.session;
  }
}

function addCurrentSessionLeaseToSession(session, options) {
  const env = options.env ?? process.env;
  const sessionId = env.CODEX_COMPANION_SESSION_ID;
  return sessionId ? addLeaseToSession(session, { sessionId, pid: process.ppid }) : session;
}

export function teardownBrokerSession({ endpoint = null, pidFile, logFile, sessionDir = null, pid = null, killProcess = null }) {
  if (Number.isFinite(pid) && killProcess) {
    try {
      killProcess(pid);
    } catch {
      // Ignore missing or already-exited broker processes.
    }
  }

  if (pidFile && fs.existsSync(pidFile)) {
    fs.unlinkSync(pidFile);
  }

  if (endpoint) {
    try {
      const target = parseBrokerEndpoint(endpoint);
      if (target.kind === "unix" && fs.existsSync(target.path)) {
        fs.unlinkSync(target.path);
      }
    } catch {
      // Ignore malformed or already-removed broker endpoints during teardown.
    }
  }

  const resolvedSessionDir = sessionDir ?? (pidFile ? path.dirname(pidFile) : null);
  if (resolvedSessionDir && fs.existsSync(resolvedSessionDir)) {
    try {
      fs.rmdirSync(resolvedSessionDir);
    } catch {
      // Ignore non-empty or missing directories.
    }
  }
}
