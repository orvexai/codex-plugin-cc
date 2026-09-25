import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

import { resolveJobFile, resolveJobLogFile, upsertJobRecord } from "./state.mjs";
import { readProcessStartTime } from "./process.mjs";
import { resolveHeartbeatFile, startHeartbeat } from "./job-liveness.mjs";
import { TERMINAL_STATUSES } from "./exit-codes.mjs";

export const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";

export function nowIso() {
  return new Date().toISOString();
}

function normalizeProgressEvent(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return {
      message: String(value.message ?? "").trim(),
      phase: typeof value.phase === "string" && value.phase.trim() ? value.phase.trim() : null,
      threadId: typeof value.threadId === "string" && value.threadId.trim() ? value.threadId.trim() : null,
      turnId: typeof value.turnId === "string" && value.turnId.trim() ? value.turnId.trim() : null,
      stderrMessage: value.stderrMessage == null ? null : String(value.stderrMessage).trim(),
      logTitle: typeof value.logTitle === "string" && value.logTitle.trim() ? value.logTitle.trim() : null,
      logBody: value.logBody == null ? null : String(value.logBody).trimEnd()
    };
  }

  return {
    message: String(value ?? "").trim(),
    phase: null,
    threadId: null,
    turnId: null,
    stderrMessage: String(value ?? "").trim(),
    logTitle: null,
    logBody: null
  };
}

export function appendLogLine(logFile, message) {
  const normalized = String(message ?? "").trim();
  if (!logFile || !normalized) {
    return;
  }
  fs.appendFileSync(logFile, `[${nowIso()}] ${normalized}\n`, "utf8");
}

export function appendLogBlock(logFile, title, body) {
  if (!logFile || !body) {
    return;
  }
  fs.appendFileSync(logFile, `\n[${nowIso()}] ${title}\n${String(body).trimEnd()}\n`, "utf8");
}

export function createJobLogFile(workspaceRoot, jobId, title) {
  const logFile = resolveJobLogFile(workspaceRoot, jobId);
  fs.writeFileSync(logFile, "", "utf8");
  if (title) {
    appendLogLine(logFile, `Starting ${title}.`);
  }
  return logFile;
}

export function createJobRecord(base, options = {}) {
  const env = options.env ?? process.env;
  const sessionId = env[options.sessionIdEnv ?? SESSION_ID_ENV];
  return {
    ...base,
    schemaVersion: 2,
    createdAt: nowIso(),
    ...(sessionId ? { sessionId } : {})
  };
}

export function spawnTaskWorker({ scriptPath, cwd, workspaceRoot, jobId, env = process.env }) {
  const stderrFile = path.join(path.dirname(resolveJobFile(workspaceRoot, jobId)), `${jobId}.worker.err`);
  const stderrFd = fs.openSync(stderrFile, "a");
  let child;
  try {
    child = spawn(process.execPath, [scriptPath, "task-worker", "--cwd", cwd, "--job-id", jobId], {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", "ignore", stderrFd],
      windowsHide: true
    });
  } finally {
    fs.closeSync(stderrFd);
  }
  child.unref();
  return { pid: child.pid ?? null, startTime: readProcessStartTime(child.pid), stderrFile };
}

export function recordTaskWorker(workspaceRoot, jobId, worker) {
  return upsertJobRecord(workspaceRoot, jobId, (stored) => ({
    ...stored,
    pid: worker.pid,
    worker
  }));
}

export function recordTaskRunning(workspaceRoot, runningRecord, worker) {
  return upsertJobRecord(workspaceRoot, runningRecord.id, (stored) => {
    if (stored && TERMINAL_STATUSES.has(stored.status)) return stored;
    const currentWorker = stored?.worker ? { ...worker, ...stored.worker } : worker;
    return {
      ...runningRecord,
      ...stored,
      status: "running",
      startedAt: runningRecord.startedAt,
      phase: runningRecord.phase,
      pid: currentWorker.pid ?? worker.pid,
      worker: currentWorker,
      logFile: runningRecord.logFile ?? stored?.logFile ?? null
    };
  });
}

export function createJobProgressUpdater(workspaceRoot, jobId) {
  let lastPhase = null;
  let lastThreadId = null;
  let lastTurnId = null;

  return (event) => {
    const normalized = normalizeProgressEvent(event);
    const patch = { id: jobId };
    let changed = false;

    if (normalized.phase && normalized.phase !== lastPhase) {
      lastPhase = normalized.phase;
      patch.phase = normalized.phase;
      changed = true;
    }

    if (normalized.threadId && normalized.threadId !== lastThreadId) {
      lastThreadId = normalized.threadId;
      patch.threadId = normalized.threadId;
      changed = true;
    }

    if (normalized.turnId && normalized.turnId !== lastTurnId) {
      lastTurnId = normalized.turnId;
      patch.turnId = normalized.turnId;
      changed = true;
    }

    if (!changed) {
      return;
    }

    upsertJobRecord(workspaceRoot, jobId, (stored) => ({
      ...stored,
      ...patch
    }));
  };
}

export function createProgressReporter({ stderr = false, logFile = null, onEvent = null } = {}) {
  if (!stderr && !logFile && !onEvent) {
    return null;
  }

  return (eventOrMessage) => {
    const event = normalizeProgressEvent(eventOrMessage);
    const stderrMessage = event.stderrMessage ?? event.message;
    if (stderr && stderrMessage) {
      process.stderr.write(`[codex] ${stderrMessage}\n`);
    }
    appendLogLine(logFile, event.message);
    appendLogBlock(logFile, event.logTitle, event.logBody);
    onEvent?.(event);
  };
}

export async function runTrackedJob(job, runner, options = {}) {
  const worker = job.worker ?? { pid: process.pid, startTime: readProcessStartTime(process.pid), stderrFile: null };
  const heartbeat = startHeartbeat(resolveHeartbeatFile(job.workspaceRoot, job.id));
  const runningRecord = {
    ...job,
    status: "running",
    startedAt: nowIso(),
    phase: "starting",
    pid: worker.pid,
    worker,
    logFile: options.logFile ?? job.logFile ?? null
  };
  try {
    const startedRecord = recordTaskRunning(job.workspaceRoot, runningRecord, worker);
    if (!startedRecord || startedRecord.status !== "running") throw new Error(`Job ${job.id} is no longer active.`);
    const execution = await runner();
    const completionStatus = execution.exitStatus === 0 ? "completed" : "failed";
    const completedAt = nowIso();
    // Merge over the stored record: the turn may have added fields while it
    // ran (e.g. deliveredMessageIds from `send`) that the final write must keep.
    const completedRecord = upsertJobRecord(job.workspaceRoot, job.id, (stored) => ({
      ...runningRecord,
      ...stored,
      status: completionStatus,
      threadId: execution.threadId ?? null,
      turnId: execution.turnId ?? null,
      pid: null,
      worker: { ...worker, ...stored?.worker, pid: null },
      phase: completionStatus === "completed" ? "done" : "failed",
      completedAt,
      result: execution.payload,
      rendered: execution.rendered,
      summary: execution.summary
    }));
    if (!completedRecord) throw new Error(`Could not record completion for ${job.id}.`);
    appendLogBlock(options.logFile ?? job.logFile ?? null, "Final output", execution.rendered);
    return execution;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const completedAt = nowIso();
    upsertJobRecord(job.workspaceRoot, job.id, (existing) => {
      if (existing && TERMINAL_STATUSES.has(existing.status)) return existing;
      return {
        ...runningRecord,
        ...existing,
        status: "failed",
        phase: "failed",
        errorMessage,
        pid: null,
        worker: { ...worker, ...existing?.worker, pid: null },
        completedAt,
        logFile: options.logFile ?? job.logFile ?? existing?.logFile ?? null
      };
    });
    throw error;
  } finally {
    heartbeat.stop();
  }
}
