import fs from "node:fs";
import path from "node:path";

import { getSessionRuntimeStatus } from "./codex.mjs";
import { findJobAcrossWorkspaces, getConfig, isSafeJobId, listJobs, readJobFile, resolveJobFile, resolveJobsDir, upsertJob } from "./state.mjs";
import { SESSION_ID_ENV } from "./tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";
import { reconcileJob, assessJobLiveness } from "./job-liveness.mjs";
import { isActiveJobStatus, TERMINAL_STATUSES } from "./exit-codes.mjs";

export const DEFAULT_MAX_STATUS_JOBS = 8;
export const DEFAULT_MAX_PROGRESS_LINES = 4;

export function sortJobsNewestFirst(jobs) {
  return [...jobs].sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")));
}

function getCurrentSessionId(options = {}) {
  return options.env?.[SESSION_ID_ENV] ?? process.env[SESSION_ID_ENV] ?? null;
}

function filterJobsForCurrentSession(jobs, options = {}) {
  const sessionId = getCurrentSessionId(options);
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

function getJobTypeLabel(job) {
  if (typeof job.kindLabel === "string" && job.kindLabel) {
    return job.kindLabel;
  }
  if (job.kind === "adversarial-review") {
    return "adversarial-review";
  }
  if (job.jobClass === "review") {
    return "review";
  }
  if (job.jobClass === "task") {
    return "rescue";
  }
  if (job.kind === "review") {
    return "review";
  }
  if (job.kind === "task") {
    return "rescue";
  }
  return "job";
}

function stripLogPrefix(line) {
  return line.replace(/^\[[^\]]+\]\s*/, "").trim();
}

function isProgressBlockTitle(line) {
  return (
    ["Final output", "Assistant message", "Reasoning summary", "Review output"].includes(line) ||
    /^Subagent .+ message$/.test(line) ||
    /^Subagent .+ reasoning summary$/.test(line)
  );
}

export function readJobProgressPreview(logFile, maxLines = DEFAULT_MAX_PROGRESS_LINES) {
  if (!logFile || !fs.existsSync(logFile)) {
    return [];
  }

  const lines = fs
    .readFileSync(logFile, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .filter((line) => line.startsWith("["))
    .map(stripLogPrefix)
    .filter((line) => line && !isProgressBlockTitle(line));

  return lines.slice(-maxLines);
}

function formatElapsedDuration(startValue, endValue = null) {
  const start = Date.parse(startValue ?? "");
  if (!Number.isFinite(start)) {
    return null;
  }

  const end = endValue ? Date.parse(endValue) : Date.now();
  if (!Number.isFinite(end) || end < start) {
    return null;
  }

  const totalSeconds = Math.max(0, Math.round((end - start) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function looksLikeVerificationCommand(line) {
  return /\b(test|tests|lint|build|typecheck|type-check|check|verify|validate|pytest|jest|vitest|cargo test|npm test|pnpm test|yarn test|go test|mvn test|gradle test|tsc|eslint|ruff)\b/i.test(
    line
  );
}

function inferLegacyJobPhase(job, progressPreview = []) {
  switch (job.status) {
    case "queued":
      return "queued";
    case "cancelled":
      return "cancelled";
    case "failed":
      return "failed";
    case "completed":
      return "done";
    default:
      break;
  }

  for (let index = progressPreview.length - 1; index >= 0; index -= 1) {
    const line = progressPreview[index].toLowerCase();
    if (line.startsWith("starting codex") || line.startsWith("thread ready") || line.startsWith("turn started")) {
      return "starting";
    }
    if (line.startsWith("reviewer started") || line.includes("review mode")) {
      return "reviewing";
    }
    if (line.startsWith("searching:") || line.startsWith("calling ") || line.startsWith("running tool:")) {
      return "investigating";
    }
    if (line.startsWith("starting collaboration tool:")) {
      return "investigating";
    }
    if (line.startsWith("running command:")) {
      return looksLikeVerificationCommand(line)
        ? "verifying"
        : job.jobClass === "review"
          ? "reviewing"
          : "investigating";
    }
    if (line.startsWith("command completed:")) {
      return looksLikeVerificationCommand(line) ? "verifying" : "running";
    }
    if (line.startsWith("applying ") || line.startsWith("file changes ")) {
      return "editing";
    }
    if (line.startsWith("turn completed")) {
      return "finalizing";
    }
    if (line.startsWith("codex error:") || line.startsWith("failed:")) {
      return "failed";
    }
  }

  return job.jobClass === "review" ? "reviewing" : "running";
}

export function enrichJob(job, options = {}) {
  const maxProgressLines = options.maxProgressLines ?? DEFAULT_MAX_PROGRESS_LINES;
  const finalJob = {
    ...job,
    kindLabel: getJobTypeLabel(job),
    progressPreview:
      job.status === "queued" || job.status === "running" || job.status === "failed"
        ? readJobProgressPreview(job.logFile, maxProgressLines)
        : [],
    elapsed: formatElapsedDuration(job.startedAt ?? job.createdAt, job.completedAt ?? null),
    duration:
      job.status === "completed" || job.status === "failed" || job.status === "cancelled"
        ? formatElapsedDuration(job.startedAt ?? job.createdAt, job.completedAt ?? job.updatedAt)
        : null
  };

  const workspaceRoot = job.workspaceRoot;
  const liveness = workspaceRoot ? assessJobLiveness(workspaceRoot, job) : { heartbeatAgeSec: null };
  const stderrFile = job.worker?.stderrFile;
  const stderrPresent = stderrFile && fs.existsSync(stderrFile) && fs.statSync(stderrFile).size > 0;
  if (job.status === "lost" && stderrPresent) finalJob.progressPreview = [`Worker stderr: ${stderrFile}`];
  Object.assign(finalJob, {
    phase: finalJob.phase ?? inferLegacyJobPhase(finalJob, finalJob.progressPreview),
    heartbeatAgeSec: liveness.heartbeatAgeSec,
    worker: { ...(job.worker ?? {}), ...(stderrPresent ? { stderrFile } : { stderrFile: undefined }) }
  });
  if (job.status === "lost" && stderrPresent) finalJob.errorMessage = `${job.errorMessage ?? "worker exited without completion record"} Worker stderr: ${stderrFile}`;
  return finalJob;
}

export function readStoredJob(workspaceRoot, jobId) {
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  return readJobFile(jobFile);
}

function matchJobReference(jobs, reference, predicate = () => true) {
  const filtered = jobs.filter(predicate);
  if (!reference) {
    return filtered[0] ?? null;
  }

  const exact = filtered.find((job) => job.id === reference);
  if (exact) {
    return exact;
  }

  const prefixMatches = filtered.filter((job) => job.id.startsWith(reference));
  if (prefixMatches.length === 1) {
    return prefixMatches[0];
  }
  if (prefixMatches.length > 1) {
    throw new Error(`Job reference "${reference}" is ambiguous. Use a longer job id.`);
  }

  const error = new Error(`No job found for "${reference}"`);
  error.exitCode = 3;
  throw error;
}

function reconcileJobs(workspaceRoot, jobs) {
  return jobs.map((job) => reconcileJob(workspaceRoot, job));
}

function isInsideJobsDir(jobsDir, candidate) {
  const resolvedJobsDir = path.resolve(jobsDir);
  const resolvedCandidate = path.resolve(candidate);
  if (!resolvedCandidate.startsWith(`${resolvedJobsDir}${path.sep}`)) return false;
  try {
    const realJobsDir = fs.realpathSync.native(resolvedJobsDir);
    const realCandidate = fs.realpathSync.native(resolvedCandidate);
    return realCandidate.startsWith(`${realJobsDir}${path.sep}`);
  } catch { return false; }
}

function fileJobMatch(workspaceRoot, reference, predicate = () => true) {
  if (!isSafeJobId(reference)) return null;
  const jobsDir = resolveJobsDir(workspaceRoot);
  const exactFile = resolveJobFile(workspaceRoot, reference);
  if (isInsideJobsDir(jobsDir, exactFile) && fs.existsSync(exactFile)) {
    const job = readJobFile(exactFile);
    if (job?.id === reference && predicate(job)) return job;
  }
  const matches = [];
  for (const name of fs.readdirSync(jobsDir).filter((entry) => entry.endsWith(".json") && entry.slice(0, -5).startsWith(reference))) {
    const candidate = `${jobsDir}/${name}`;
    if (!isInsideJobsDir(jobsDir, candidate)) continue;
    try {
      const job = readJobFile(candidate);
      if (job?.id === name.slice(0, -5) && predicate(job)) matches.push(job);
    } catch { /* Ignore malformed records during prefix lookup. */ }
  }
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new Error(`Job reference "${reference}" is ambiguous. Use a longer job id.`);
  return null;
}

function resolveIndexedOrFileJob(workspaceRoot, jobs, reference, predicate = () => true) {
  try { return matchJobReference(jobs, reference, predicate); } catch (error) {
    if (error?.exitCode !== 3) throw error;
    const fromFile = fileJobMatch(workspaceRoot, reference, predicate);
    if (fromFile) { upsertJob(workspaceRoot, fromFile); return fromFile; }
    const across = findJobAcrossWorkspaces(reference);
    if (across && predicate(across)) { upsertJob(across.workspaceRoot, across); return across; }
    throw error;
  }
}

function matchesLocalJob(jobs, reference) {
  return jobs.some((job) => job.id === reference || job.id.startsWith(reference));
}

// A job id that is not known in the current workspace may belong to a job that
// was launched with a different --cwd. Resolve it to its own workspace.
export function resolveJobWorkspace(cwd, reference) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  if (!reference || matchesLocalJob(listJobs(workspaceRoot), reference) || fileJobMatch(workspaceRoot, reference)) {
    return workspaceRoot;
  }
  return findJobAcrossWorkspaces(reference)?.workspaceRoot ?? workspaceRoot;
}

export function buildStatusSnapshot(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);
  const jobs = sortJobsNewestFirst(filterJobsForCurrentSession(reconcileJobs(workspaceRoot, listJobs(workspaceRoot)), options));
  const maxJobs = options.maxJobs ?? DEFAULT_MAX_STATUS_JOBS;
  const maxProgressLines = options.maxProgressLines ?? DEFAULT_MAX_PROGRESS_LINES;

  const running = jobs
    .filter((job) => isActiveJobStatus(job.status))
    .map((job) => enrichJob(job, { maxProgressLines }));

  const latestFinishedRaw = jobs.find((job) => !isActiveJobStatus(job.status)) ?? null;
  const latestFinished = latestFinishedRaw ? enrichJob(latestFinishedRaw, { maxProgressLines }) : null;

  const recent = (options.all ? jobs : jobs.slice(0, maxJobs))
    .filter((job) => !isActiveJobStatus(job.status) && job.id !== latestFinished?.id)
    .map((job) => enrichJob(job, { maxProgressLines }));

  return {
    workspaceRoot,
    config,
    sessionRuntime: getSessionRuntimeStatus(options.env, workspaceRoot),
    running,
    latestFinished,
    recent,
    needsReview: Boolean(config.stopReviewGate)
  };
}

export function buildSingleJobSnapshot(cwd, reference, options = {}) {
  const workspaceRoot = resolveJobWorkspace(cwd, reference);
  const jobs = sortJobsNewestFirst(reconcileJobs(workspaceRoot, listJobs(workspaceRoot)));
  const selected = resolveIndexedOrFileJob(workspaceRoot, jobs, reference);
  const reconciled = reconcileJob(workspaceRoot, selected);

  return {
    workspaceRoot,
    job: enrichJob(reconciled, { maxProgressLines: options.maxProgressLines })
  };
}

export function resolveResultJob(cwd, reference) {
  const workspaceRoot = resolveJobWorkspace(cwd, reference);
  const jobs = sortJobsNewestFirst(reconcileJobs(workspaceRoot, reference ? listJobs(workspaceRoot) : filterJobsForCurrentSession(listJobs(workspaceRoot))));
  let candidate = null;
  let resolutionError = null;
  if (reference) {
    try {
      candidate = resolveIndexedOrFileJob(workspaceRoot, jobs, reference, (job) => TERMINAL_STATUSES.has(job.status));
    } catch (error) {
      if (error?.exitCode !== 3) throw error;
      resolutionError = error;
      try {
        candidate = resolveIndexedOrFileJob(workspaceRoot, jobs, reference, (job) => isActiveJobStatus(job.status));
      } catch (activeError) {
        if (activeError?.exitCode !== 3) throw activeError;
        resolutionError = activeError;
      }
    }
    if (candidate) candidate = reconcileJob(workspaceRoot, candidate);
  }
  const selected = reference
    ? candidate && TERMINAL_STATUSES.has(candidate.status) ? candidate : null
    : jobs.find((job) => TERMINAL_STATUSES.has(job.status)) ?? null;

  if (selected) {
    return { workspaceRoot, job: selected };
  }

  const active = reference
    ? candidate && isActiveJobStatus(candidate.status) ? candidate : null
    : jobs.find((job) => isActiveJobStatus(job.status)) ?? null;
  if (active) {
    throw new Error(`Job ${active.id} is still ${active.status}. Check /codex:status and try again once it finishes.`);
  }

  if (reference) {
    if (resolutionError) throw resolutionError;
    throw new Error(`No finished job found for "${reference}". Run /codex:status to inspect active jobs.`);
  }

  throw new Error("No finished Codex jobs found for this repository yet.");
}

export function resolveCancelableJob(cwd, reference, options = {}) {
  const workspaceRoot = resolveJobWorkspace(cwd, reference);
  const jobs = sortJobsNewestFirst(reconcileJobs(workspaceRoot, listJobs(workspaceRoot)));
  const activeJobs = jobs.filter((job) => isActiveJobStatus(job.status));

  if (reference) {
    const selected = reconcileJob(workspaceRoot, resolveIndexedOrFileJob(workspaceRoot, jobs, reference, (job) => isActiveJobStatus(job.status)));
    if (!isActiveJobStatus(selected.status)) throw new Error(`No active job found for "${reference}".`);
    return { workspaceRoot, job: selected };
  }

  const sessionScopedActiveJobs = filterJobsForCurrentSession(activeJobs, options);

  if (sessionScopedActiveJobs.length === 1) {
    return { workspaceRoot, job: sessionScopedActiveJobs[0] };
  }
  if (sessionScopedActiveJobs.length > 1) {
    throw new Error("Multiple Codex jobs are active. Pass a job id to /codex:cancel.");
  }

  if (getCurrentSessionId(options)) {
    throw new Error("No active Codex jobs to cancel for this session.");
  }

  throw new Error("No active Codex jobs to cancel.");
}
