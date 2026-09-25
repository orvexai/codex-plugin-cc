import fs from "node:fs";
import path from "node:path";

import { isSameProcess, readProcessStartTime } from "./process.mjs";
import { TERMINAL_STATUSES } from "./exit-codes.mjs";
import { isSafeJobId, resolveJobsDir, updateJobRecord, writeFileAtomic } from "./state.mjs";
import { CodexAppServerClient } from "./app-server.mjs";
import { upsertJobRecord } from "./state.mjs";

export const HEARTBEAT_STALE_MS = Number(process.env.CODEX_COMPANION_HEARTBEAT_STALE_MS) || 30000;

export function resolveHeartbeatFile(workspaceRoot, jobId, kind = "worker") {
  if (!isSafeJobId(jobId)) throw new Error("Invalid job id.");
  const suffix = kind === "owner" ? ".owner.hb" : ".hb";
  return path.join(resolveJobsDir(workspaceRoot), `${jobId}${suffix}`);
}

export function startHeartbeat(file, { intervalMs } = {}) {
  const interval = Number(intervalMs) || Number(process.env.CODEX_COMPANION_HEARTBEAT_MS) || 5000;
  const beat = () => {
    const payload = { pid: process.pid, startTime: readProcessStartTime(process.pid), at: new Date().toISOString() };
    writeFileAtomic(file, `${JSON.stringify(payload)}\n`);
  };
  beat();
  const timer = setInterval(beat, interval);
  timer.unref?.();
  return { stop() { clearInterval(timer); } };
}

export function readHeartbeat(file) {
  try {
    const heartbeat = JSON.parse(fs.readFileSync(file, "utf8"));
    return heartbeat && typeof heartbeat === "object" ? heartbeat : null;
  } catch { return null; }
}

export function assessOwner(workspaceRoot, job, { now = Date.now() } = {}) {
  const owner = job?.owner;
  if (!owner || owner.kind === "detached") return { alive: false, reason: owner?.kind === "detached" ? "detached" : "owner-missing" };
  const alive = isSameProcess({ pid: Number(owner.pid), startTime: owner.startTime ?? null });
  if (!alive) return { alive: false, reason: "owner-dead" };
  const heartbeatFile = resolveHeartbeatFile(workspaceRoot, job.id, "owner");
  const heartbeat = readHeartbeat(heartbeatFile);
  const heartbeatAt = Date.parse(heartbeat?.at ?? owner.heartbeatAt ?? "");
  if (Number.isFinite(heartbeatAt) && now - heartbeatAt > Number(owner.ttlMs || 30000)) {
    return { alive: false, reason: "owner-heartbeat-stale" };
  }
  return { alive: true, reason: null };
}

export function assessJobLiveness(workspaceRoot, job, { now = Date.now() } = {}) {
  const worker = job.worker ?? {};
  const pid = worker.pid ?? job.pid;
  const startTime = job.schemaVersion >= 2 ? worker.startTime ?? job.workerStartTime : null;
  const alive = Number.isInteger(Number(pid)) && Number(pid) > 0 && isSameProcess({ pid: Number(pid), startTime });
  const heartbeatFile = resolveHeartbeatFile(workspaceRoot, job.id);
  const heartbeat = readHeartbeat(heartbeatFile);
  const heartbeatAt = Date.parse(heartbeat?.at ?? "");
  const heartbeatAgeSec = Number.isFinite(heartbeatAt) ? Math.max(0, (now - heartbeatAt) / 1000) : null;
  let reason = null;
  if (pid && !alive) reason = startTime && readProcessStartTime(pid) != null ? "pid-reused" : "worker-dead";
  else if (job.schemaVersion >= 2 && heartbeatAgeSec != null && now - heartbeatAt > HEARTBEAT_STALE_MS) reason = "heartbeat-stale";
  else if (job.status === "queued" && !alive && now - Date.parse(job.createdAt ?? "") > 60000) reason = "queued-without-worker";
  return { alive: alive && reason !== "pid-reused", reason, heartbeatAgeSec };
}

function appendCrashEvidence(workspaceRoot, job) {
  const logFile = job.logFile ?? path.join(resolveJobsDir(workspaceRoot), `${job.id}.log`);
  const worker = job.worker ?? {};
  try {
    if (fs.existsSync(logFile)) {
      const log = fs.readFileSync(logFile, "utf8");
      const tail = log.split(/\r?\n/).filter(Boolean).slice(-40).join("\n");
      if (tail) fs.appendFileSync(logFile, `\nWorker exited. Recent job log:\n${tail}\n`);
    }
    const stderrFile = worker.stderrFile ?? path.join(resolveJobsDir(workspaceRoot), `${job.id}.worker.err`);
    if (fs.existsSync(stderrFile)) {
      const stderr = fs.readFileSync(stderrFile, "utf8").trim();
      if (stderr) fs.appendFileSync(logFile, `\nWorker stderr (${stderrFile}):\n${stderr.slice(-8000)}\n`);
    }
  } catch { /* Preserve reconciliation even if diagnostic append fails. */ }
}

export function reconcileJob(workspaceRoot, job, { now = Date.now(), beforeCommitForTest = null } = {}) {
  if (!job || TERMINAL_STATUSES.has(job.status)) return job;
  const assessment = assessJobLiveness(workspaceRoot, job, { now });
  if (!assessment.reason) return job;
  const completedAt = new Date(now).toISOString();
  const updated = {
    ...job,
    status: "lost",
    phase: "worker-exited",
    errorMessage: "worker exited without completion record",
    completedAt,
    reconciledAt: completedAt
  };
  beforeCommitForTest?.();
  return updateJobRecord(workspaceRoot, job.id, (stored) => {
    if (TERMINAL_STATUSES.has(stored?.status)) return stored;
    appendCrashEvidence(workspaceRoot, stored ?? job);
    return {
      ...stored,
      status: updated.status,
      phase: updated.phase,
      errorMessage: updated.errorMessage,
      completedAt: updated.completedAt,
      reconciledAt: updated.reconciledAt
    };
  }) ?? updated;
}

function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function reconcileJobDeep(workspaceRoot, job) {
  if (!job || !["lost", "orphaned", "running", "queued"].includes(job.status) || !job.threadId || job.transport !== "broker" || !job.brokerEndpoint) return job;
  const liveness = assessJobLiveness(workspaceRoot, job);
  if (job.status !== "lost" && liveness.alive) return job;
  let client;
  try {
    client = await withTimeout(
      CodexAppServerClient.connect(job.cwd ?? workspaceRoot, { brokerEndpoint: job.brokerEndpoint, noSpawn: true }),
      3000,
      "app-server connect"
    );
    const response = await withTimeout(
      client.request("thread/read", { threadId: job.threadId, includeTurns: true }),
      3000,
      "thread/read"
    );
    const thread = response?.thread;
    if (!thread || !Array.isArray(thread.turns)) return job;
    const turns = thread.turns;
    const active = turns.find((turn) => ["inProgress", "running"].includes(turn.status)) || thread.status?.type === "active";
    let status = "orphaned";
    let result = {};
    if (!active) {
      const last = turns.at(-1);
      if (!last || !["completed", "failed", "interrupted"].includes(last.status)) return job;
      status = last.status === "failed" ? "failed" : "completed";
      const items = last.items ?? [];
      const finalMessage = [...items].reverse().find((item) => item.type === "agentMessage" && item.phase === "final_answer")?.text;
      if (typeof finalMessage === "string") result = { result: { rawOutput: finalMessage } };
    }
    return upsertJobRecord(workspaceRoot, job.id, (stored) => ({
      ...stored,
      ...result,
      status,
      phase: status === "orphaned" ? "orphaned" : "done",
      reconciled: status !== "orphaned",
      reconciledAt: new Date().toISOString(),
      ...(status === "orphaned" ? { errorMessage: "Worker exited while the broker still reports an active turn; cancel the orphaned turn." } : {}),
      completedAt: status === "orphaned" ? stored?.completedAt : new Date().toISOString()
    }));
  } catch { return job; }
  finally { await client?.close().catch(() => {}); }
}
