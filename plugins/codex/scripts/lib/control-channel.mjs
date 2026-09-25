import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { isSafeJobId, resolveJobsDir } from "./state.mjs";

function controlPath(workspaceRoot, jobId, suffix) {
  if (!isSafeJobId(jobId)) throw new Error("Invalid job id.");
  return path.join(resolveJobsDir(workspaceRoot), `${jobId}.control${suffix}`);
}

export function resolveControlFile(workspaceRoot, jobId) {
  return controlPath(workspaceRoot, jobId, ".jsonl");
}

export function appendControlOp(workspaceRoot, jobId, { op, reason, then } = {}) {
  if (op !== "interrupt" && op !== "cancel") throw new Error("Invalid control operation.");
  const entry = { id: `ctl-${crypto.randomUUID()}`, op, reason: reason ?? "user", then: then ?? null, at: new Date().toISOString() };
  const file = resolveControlFile(workspaceRoot, jobId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, "utf8");
  return { id: entry.id };
}

export function readControlOps(file, offset = 0) {
  let contents;
  try { contents = fs.readFileSync(file, "utf8"); } catch { return []; }
  const entries = [];
  let cursor = offset;
  for (;;) {
    const newline = contents.indexOf("\n", cursor);
    if (newline < 0) break;
    const line = contents.slice(cursor, newline);
    cursor = newline + 1;
    try {
      const value = JSON.parse(line);
      if (value && ["interrupt", "cancel"].includes(value.op) && typeof value.id === "string") entries.push({ ...value, end: cursor });
    } catch { /* Ignore malformed complete lines. */ }
  }
  return entries;
}

export function ackControlOp(workspaceRoot, jobId, id, result = {}) {
  const file = controlPath(workspaceRoot, jobId, ".acks.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify({ id, ...result, at: new Date().toISOString() })}\n`, "utf8");
}

export function readControlAck(workspaceRoot, jobId, id) {
  const file = controlPath(workspaceRoot, jobId, ".acks.jsonl");
  try {
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      if (!line) continue;
      try { const value = JSON.parse(line); if (value.id === id) return value; } catch { /* Ignore malformed lines. */ }
    }
  } catch { /* Not acknowledged yet. */ }
  return null;
}

export async function waitForControlAck(workspaceRoot, jobId, id, timeoutMs, pollMs = 100) {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  do {
    const ack = readControlAck(workspaceRoot, jobId, id);
    if (ack) return ack;
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(1, deadline - Date.now()))));
  } while (Date.now() <= deadline);
  return null;
}
