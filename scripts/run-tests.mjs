#!/usr/bin/env node
// Runs the test suite in a sandbox. When `npm test` is started from inside a
// Claude Code session the plugin's own session variables leak in and redirect
// state directories; worse, tests could reach the user's real HOME, Codex
// credentials or `codex` binary. Everything here lives under one sandbox root
// that is reaped and removed afterwards. Each test file additionally isolates
// and reaps itself through tests/_isolation.mjs (nested inside this sandbox).
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { applySandboxEnv, createSandbox, reapSandboxProcesses, startWatchdog } from "./test-sandbox.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// HOME, CODEX_HOME, XDG_*, TMPDIR, plugin config and launcher dir all point
// into the sandbox; leaky CLAUDE_*/CODEX_COMPANION_* variables are stripped;
// a guard `codex` that exits 97 shadows the real binary on PATH.
const sandbox = createSandbox();
const env = applySandboxEnv({ ...process.env }, sandbox);

const testsDir = path.join(ROOT, "tests");
const requested = process.argv.slice(2);
const files =
  requested.length > 0
    ? requested
    : fs
        .readdirSync(testsDir)
        .filter((name) => name.endsWith(".test.mjs"))
        .sort()
        .map((name) => path.join("tests", name));

// Backstop if this runner itself is SIGKILLed: reaps the sandbox once we die.
const watchdogPid = startWatchdog(sandbox.root, { env });

// Asynchronous so that SIGINT/SIGTERM/SIGHUP (e.g. Ctrl-C on the process
// group) reach our handlers: forward the signal, give the child a moment, then
// always reap and run the survivor check before exiting.
const SIGNAL_CHILD_WAIT_MS = 5000;
const child = spawn(process.execPath, ["--test", ...files], { cwd: ROOT, env, stdio: "inherit" });
let receivedSignal = null;
const childExit = new Promise((resolve) => {
  child.once("error", (error) => {
    process.stderr.write(`Failed to start the test runner: ${error.message}\n`);
    resolve({ code: 1, signal: null });
  });
  child.once("exit", (code, signal) => resolve({ code, signal }));
});
for (const name of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(name, () => {
    if (receivedSignal) return; // Already shutting down; cleanup below still runs.
    receivedSignal = name;
    process.stderr.write(`\nReceived ${name}; stopping tests and reaping the sandbox...\n`);
    try {
      child.kill(name);
    } catch {
      // Already gone.
    }
    setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    }, SIGNAL_CHILD_WAIT_MS).unref();
  });
}

const result = await childExit;

// Tests start shared brokers lazily; anything still referencing the sandbox
// (command line or environment) is stopped here: SIGTERM, then SIGKILL. This
// includes our watchdog, which is no longer needed.
const { reaped, survivors } = reapSandboxProcesses(sandbox.root);
const leftovers = reaped.filter((proc) => proc.pid !== watchdogPid);
if (leftovers.length > 0) {
  process.stderr.write(`Stopped ${leftovers.length} leftover test process(es).\n`);
}
if (survivors.length > 0) {
  process.stderr.write(
    `ERROR: ${survivors.length} test process(es) survived reaping (sandbox ${sandbox.root} left in place):\n` +
      survivors.map((p) => `  ${p.pid} ${p.args}`).join("\n") +
      "\n"
  );
  process.exit(1);
}
fs.rmSync(sandbox.root, { recursive: true, force: true });
if (receivedSignal) {
  process.exit(128 + (os.constants.signals[receivedSignal] ?? 1));
}
process.exit(result.code ?? 1);
