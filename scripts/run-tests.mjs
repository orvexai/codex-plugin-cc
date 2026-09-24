#!/usr/bin/env node
// Runs the test suite with a scrubbed environment. When `npm test` is started
// from inside a Claude Code session the plugin's own session variables leak in
// and redirect state directories, which makes otherwise-passing tests fail.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LEAKY_ENV = [
  "CLAUDE_PLUGIN_DATA",
  "CLAUDE_ENV_FILE",
  "CODEX_COMPANION_SESSION_ID",
  "CODEX_COMPANION_TRANSCRIPT_PATH",
  "CODEX_COMPANION_APP_SERVER_ENDPOINT",
  "CODEX_COMPANION_APP_SERVER_PID_FILE",
  "CODEX_COMPANION_APP_SERVER_LOG_FILE",
  "CODEX_COMPANION_CONFIG",
  "CODEX_COMPANION_MODEL",
  "CODEX_COMPANION_EFFORT",
  "CODEX_COMPANION_SANDBOX",
  "CODEX_COMPANION_NETWORK",
  "CODEX_COMPANION_LOCK_TIMEOUT_MS"
];

const env = { ...process.env };
for (const name of LEAKY_ENV) {
  delete env[name];
}
// Keep tests away from the user's real global defaults and launcher, and give
// the run its own TMPDIR: test repos, fake Codex binaries and broker sockets
// all live under it, so everything the run spawned can be found and stopped.
const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), "cpt-"));
const sandboxTmp = path.join(sandboxHome, "tmp");
fs.mkdirSync(sandboxTmp);
env.CODEX_COMPANION_CONFIG = path.join(sandboxHome, "config.json");
env.CODEX_COMPANION_BIN_DIR = path.join(sandboxHome, "bin");
env.TMPDIR = sandboxTmp;
env.TMP = sandboxTmp;
env.TEMP = sandboxTmp;

// Tests start shared brokers lazily and never shut them down; without this a
// few full runs leave hundreds of broker and app-server processes behind.
function reapTestProcesses(marker) {
  if (process.platform === "win32") {
    return 0;
  }
  const listing = spawnSync("ps", ["-eo", "pid=,args="], { encoding: "utf8" });
  const pids = String(listing.stdout ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.includes(marker))
    .map((line) => Number(line.split(/\s+/)[0]))
    .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
  return pids.length;
}

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

const result = spawnSync(process.execPath, ["--test", ...files], { cwd: ROOT, env, stdio: "inherit" });
const reaped = reapTestProcesses(sandboxHome);
if (reaped > 0) {
  process.stderr.write(`Stopped ${reaped} leftover test process(es).\n`);
}
fs.rmSync(sandboxHome, { recursive: true, force: true });
process.exit(result.status ?? 1);
