#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { refreshCliShim } from "./lib/cli-shim.mjs";
import { terminateProcessTree } from "./lib/process.mjs";
import { BROKER_ENDPOINT_ENV } from "./lib/app-server.mjs";
import {
  addBrokerLease,
  claimBrokerSessionForShutdown,
  LOG_FILE_ENV,
  loadBrokerSession,
  PID_FILE_ENV,
  removeBrokerLease,
  sendBrokerShutdown,
  teardownBrokerSession
} from "./lib/broker-lifecycle.mjs";
import { appendControlOp } from "./lib/control-channel.mjs";
import { reconcileJob } from "./lib/job-liveness.mjs";
import { isActiveJobStatus } from "./lib/exit-codes.mjs";
import { getConfig, getGlobalConfig, isSafeJobId, listJobs, resolveJobsDir, resolveStateFile, updateJobRecord, writeFileAtomic } from "./lib/state.mjs";
import { TRANSCRIPT_PATH_ENV } from "./lib/claude-session-transfer.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

export const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const PLUGIN_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function appendEnvVar(name, value) {
  if (!process.env.CLAUDE_ENV_FILE || value == null || value === "") {
    return;
  }
  fs.appendFileSync(process.env.CLAUDE_ENV_FILE, `export ${name}=${shellEscape(value)}\n`, "utf8");
}

function cleanupSessionJobs(cwd, sessionId) {
  if (!cwd || !sessionId) return { jobs: [], activeJobsRemain: listJobs(cwd || process.cwd()).some((job) => isActiveJobStatus(job.status)) };
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const stateFile = resolveStateFile(workspaceRoot);
  const hasState = fs.existsSync(stateFile);
  const policy = hasState ? (getConfig(workspaceRoot).sessionEndPolicy ?? getGlobalConfig().sessionEndPolicy ?? "cancel") : "cancel";
  const sessionJobs = hasState ? listJobs(workspaceRoot).filter((job) => job.sessionId === sessionId).map((job) => reconcileJob(workspaceRoot, job)) : [];
  const summaryJobs = [];
  for (const job of sessionJobs) {
    let action = "none";
    if (isActiveJobStatus(job.status)) {
      const detach = job.owner?.kind === "detached" || policy === "detach";
      const endedAt = new Date().toISOString();
      if (detach) {
        const updated = updateJobRecord(workspaceRoot, job.id, (stored) => isActiveJobStatus(stored?.status)
          ? { ...stored, endedWithSession: true, sessionEndedAt: endedAt }
          : stored);
        if (isActiveJobStatus(updated?.status)) action = "detached";
      } else {
        let controlWritten = false;
        try {
          appendControlOp(workspaceRoot, job.id, { op: "cancel", reason: "session-ended" });
          controlWritten = true;
        } catch {
          // Legacy records can predate the control channel; fall back to their worker pid.
        }
        const updated = updateJobRecord(workspaceRoot, job.id, (stored) => isActiveJobStatus(stored?.status)
          ? { ...stored, status: "cancel-pending", cancelReason: "session-ended", sessionEndedAt: endedAt }
          : stored);
        if (isActiveJobStatus(updated?.status)) action = "cancel-requested";
        if (action === "cancel-requested" && (!controlWritten || job.schemaVersion == null || job.schemaVersion < 2 || !job.transport) && job.pid) {
          try { terminateProcessTree(job.pid); } catch { /* Best effort during hook shutdown. */ }
        }
      }
    }
    const current = listJobs(workspaceRoot).find((candidate) => candidate.id === job.id) ?? job;
    summaryJobs.push({ id: current.id, status: current.status, action, threadId: current.threadId ?? null });
  }
  const endedAt = new Date().toISOString();
  const summary = { sessionId, endedAt, jobs: summaryJobs };
  if (isSafeJobId(sessionId)) {
    const jobsDir = path.resolve(resolveJobsDir(workspaceRoot));
    const summaryFile = path.resolve(jobsDir, `session-end-${sessionId}.json`);
    if (summaryFile.startsWith(`${jobsDir}${path.sep}`)) {
      writeFileAtomic(summaryFile, `${JSON.stringify(summary, null, 2)}\n`);
    }
  }
  const activeJobsRemain = hasState && listJobs(workspaceRoot).map((job) => reconcileJob(workspaceRoot, job)).some((job) => isActiveJobStatus(job.status));
  return { jobs: summaryJobs, activeJobsRemain };
}

function handleSessionStart(input) {
  const cwd = input.cwd || process.cwd();
  if (input.session_id && loadBrokerSession(cwd)) {
    addBrokerLease(cwd, { sessionId: input.session_id, pid: process.ppid });
  }
  appendEnvVar(SESSION_ID_ENV, input.session_id);
  appendEnvVar(TRANSCRIPT_PATH_ENV, input.transcript_path);
  appendEnvVar(PLUGIN_DATA_ENV, process.env[PLUGIN_DATA_ENV]);
  try {
    // Keep an installed `orvex-codex` launcher pointing at this plugin version.
    refreshCliShim(PLUGIN_ROOT);
  } catch {
    // The launcher is a convenience; never fail session start over it.
  }
}

async function handleSessionEnd(input) {
  const cwd = input.cwd || process.cwd();
  const storedBrokerSession = loadBrokerSession(cwd);
  let brokerSession =
    storedBrokerSession ??
    (process.env[BROKER_ENDPOINT_ENV]
      ? {
          endpoint: process.env[BROKER_ENDPOINT_ENV],
          pidFile: process.env[PID_FILE_ENV] ?? null,
          logFile: process.env[LOG_FILE_ENV] ?? null
        }
      : null);
  const sessionId = input.session_id || process.env[SESSION_ID_ENV];
  const result = cleanupSessionJobs(cwd, sessionId);
  if (sessionId) removeBrokerLease(cwd, sessionId);
  if (result.activeJobsRemain) return;
  if (storedBrokerSession) {
    const claim = claimBrokerSessionForShutdown(cwd);
    if (!claim.shouldShutdown) return;
    brokerSession = claim.session;
  }

  const brokerEndpoint = brokerSession?.endpoint ?? null;
  const pidFile = brokerSession?.pidFile ?? null;
  const logFile = brokerSession?.logFile ?? null;
  const sessionDir = brokerSession?.sessionDir ?? null;
  const pid = brokerSession?.pid ?? null;

  if (brokerEndpoint) {
    await sendBrokerShutdown(brokerEndpoint);
  }

  teardownBrokerSession({
    endpoint: brokerEndpoint,
    pidFile,
    logFile,
    sessionDir,
    pid,
    killProcess: terminateProcessTree
  });
}

async function main() {
  const input = readHookInput();
  const eventName = process.argv[2] ?? input.hook_event_name ?? "";

  if (eventName === "SessionStart") {
    handleSessionStart(input);
    return;
  }

  if (eventName === "SessionEnd") {
    await handleSessionEnd(input);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
