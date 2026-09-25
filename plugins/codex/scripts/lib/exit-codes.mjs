export const EXIT = Object.freeze({ OK: 0, JOB_FAILED: 1, USAGE: 2, LOST: 3, TIMED_OUT: 4, WAITER_TIMEOUT: 124, CANCELLED: 130 });
export const ACTIVE_STATUSES = new Set(["queued", "running", "cancel-pending"]);
export const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "cancel-failed", "interrupted", "timed-out", "lost", "orphaned"]);

export function isActiveJobStatus(status) {
  return !TERMINAL_STATUSES.has(status);
}

export function exitCodeForJob(status, { mode = "wait" } = {}) {
  if (status === "completed") return EXIT.OK;
  if (status === "failed") return EXIT.JOB_FAILED;
  if (status === "cancelled" || status === "interrupted") return mode === "wait" ? EXIT.JOB_FAILED : EXIT.CANCELLED;
  if (status === "lost" || status === "orphaned") return EXIT.LOST;
  if (status === "timed-out") return EXIT.TIMED_OUT;
  if (status === "cancel-failed") return EXIT.USAGE;
  return EXIT.OK;
}
