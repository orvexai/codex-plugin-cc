#!/usr/bin/env node
// Detached per-sandbox watchdog started by scripts/test-sandbox.mjs.
// Usage: test-sandbox-watchdog.mjs --owner <pid> --owner-start <starttime> --root <sandbox>
// Polls the owner; once it is gone (or its pid was recycled) reaps every
// process referencing the sandbox root (except itself), removes the sandbox and
// exits. The owner kills this watchdog itself on a clean exit.
import fs from "node:fs";
import process from "node:process";

import { readStartTime, reapSandboxProcesses } from "./test-sandbox.mjs";

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? "" : "";
}

const ownerPid = Number(arg("--owner"));
const ownerStart = arg("--owner-start") || null;
const root = arg("--root");
if (!Number.isInteger(ownerPid) || ownerPid <= 0 || !root || root.length < 8) {
  process.exit(2);
}

function ownerAlive() {
  try {
    process.kill(ownerPid, 0);
  } catch (error) {
    if (error.code !== "EPERM") return false;
  }
  if (ownerStart == null) return true;
  const current = readStartTime(ownerPid);
  return current == null || current === ownerStart;
}

// Ignore terminal signals aimed at a group we might still share; the owner
// stops us with SIGTERM/SIGKILL explicitly.
process.on("SIGINT", () => {});
process.on("SIGHUP", () => {});

const timer = setInterval(() => {
  if (ownerAlive()) return;
  clearInterval(timer);
  try {
    reapSandboxProcesses(root, { excludePids: [process.pid] });
  } finally {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // Best effort.
    }
    process.exit(0);
  }
}, 200);
