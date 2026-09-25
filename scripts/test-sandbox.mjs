// Shared test sandbox: environment isolation and process reaping.
//
// Used by scripts/run-tests.mjs (the `npm test` runner) and by
// tests/_isolation.mjs, which every test file imports first so that a bare
// `node --test tests/<file>` is isolated and cleaned up as well.
//
// Every path a test can write to (HOME, CODEX_HOME, XDG dirs, TMPDIR, plugin
// state, launcher bin dir) is moved under a sandbox root. Every process a test
// starts inherits that environment, so "references the sandbox root in its
// command line or environment" identifies exactly the processes to reap.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// Set to the innermost sandbox root; descendants inherit it.
export const SANDBOX_ENV = "CODEX_PLUGIN_TEST_SANDBOX";

// Variables that route plugin/Codex state or identify the calling Claude
// session. Stripped from every test environment. Any other CODEX_COMPANION_* or
// CLAUDE_* variable is stripped as well (see LEAKY_ENV_PREFIXES).
export const LEAKY_ENV = [
  "CLAUDE_PLUGIN_DATA",
  "CLAUDE_PLUGIN_ROOT",
  "CLAUDE_PROJECT_DIR",
  "CLAUDE_ENV_FILE",
  "CODEX_COMPANION_SESSION_ID",
  "CODEX_COMPANION_TRANSCRIPT_PATH",
  "CODEX_COMPANION_APP_SERVER_ENDPOINT",
  "CODEX_COMPANION_APP_SERVER_PID_FILE",
  "CODEX_COMPANION_APP_SERVER_LOG_FILE",
  "CODEX_COMPANION_CONFIG",
  "CODEX_COMPANION_BIN_DIR",
  "CODEX_COMPANION_MODEL",
  "CODEX_COMPANION_EFFORT",
  "CODEX_COMPANION_SANDBOX",
  "CODEX_COMPANION_NETWORK",
  "CODEX_COMPANION_LOCK_TIMEOUT_MS",
  "CODEX_COMPANION_CANCEL_GRACE_MS",
  "CODEX_COMPANION_KILL_VERIFY_MS",
  "CODEX_COMPANION_KILL_WAIT_MS",
  "CODEX_COMPANION_CONTROL_ACK_MS",
  "CODEX_COMPANION_CONTROL_POLL_MS",
  "CODEX_COMPANION_OWNER_TTL_MS",
  "CODEX_COMPANION_OWNER_POLL_MS",
  "CODEX_COMPANION_HEARTBEAT_MS",
  "CODEX_COMPANION_HEARTBEAT_STALE_MS",
  "CODEX_HOME",
  "CODEX_API_KEY",
  "OPENAI_API_KEY"
];
export const LEAKY_ENV_PREFIXES = ["CODEX_COMPANION_", "CLAUDE_"];

export const REAL_CODEX_BLOCKED_EXIT = 97;
export const REAL_CODEX_BLOCKED_MESSAGE = "real codex blocked in tests";

export function scrubEnv(env) {
  for (const name of Object.keys(env)) {
    if (LEAKY_ENV.includes(name) || LEAKY_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      delete env[name];
    }
  }
  return env;
}

function writeCodexGuard(guardBin) {
  fs.mkdirSync(guardBin, { recursive: true });
  const message = REAL_CODEX_BLOCKED_MESSAGE;
  fs.writeFileSync(
    path.join(guardBin, "codex"),
    `#!/bin/sh\necho "${message}: codex $*" >&2\nexit ${REAL_CODEX_BLOCKED_EXIT}\n`,
    { mode: 0o755 }
  );
  fs.writeFileSync(
    path.join(guardBin, "codex.cmd"),
    `@echo off\r\necho ${message} 1>&2\r\nexit /b ${REAL_CODEX_BLOCKED_EXIT}\r\n`
  );
}

// Creates a sandbox directory tree under `parent` (default os.tmpdir()).
export function createSandbox({ parent = os.tmpdir(), prefix = "cpt-" } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(parent, prefix)));
  const dirs = {
    root,
    home: path.join(root, "home"),
    codexHome: path.join(root, "codex-home"),
    xdgConfig: path.join(root, "xdg", "config"),
    xdgData: path.join(root, "xdg", "data"),
    xdgState: path.join(root, "xdg", "state"),
    tmp: path.join(root, "t"), // Short: broker sockets live under it (sun_path limit).
    guardBin: path.join(root, "guard-bin"),
    launcherBin: path.join(root, "bin"),
    config: path.join(root, "config.json")
  };
  for (const key of ["home", "codexHome", "xdgConfig", "xdgData", "xdgState", "tmp"]) {
    fs.mkdirSync(dirs[key], { recursive: true });
  }
  writeCodexGuard(dirs.guardBin);
  return dirs;
}

// Applies the sandbox to an env object (mutated and returned).
export function applySandboxEnv(env, sandbox) {
  scrubEnv(env);
  env[SANDBOX_ENV] = sandbox.root;
  env.HOME = sandbox.home;
  env.USERPROFILE = sandbox.home;
  env.CODEX_HOME = sandbox.codexHome;
  env.XDG_CONFIG_HOME = sandbox.xdgConfig;
  env.XDG_DATA_HOME = sandbox.xdgData;
  env.XDG_STATE_HOME = sandbox.xdgState;
  env.TMPDIR = sandbox.tmp;
  env.TMP = sandbox.tmp;
  env.TEMP = sandbox.tmp;
  env.CODEX_COMPANION_CONFIG = sandbox.config;
  env.CODEX_COMPANION_BIN_DIR = sandbox.launcherBin;
  const sep = process.platform === "win32" ? ";" : ":";
  const rest = String(env.PATH ?? "").split(sep).filter((entry) => entry && entry !== sandbox.guardBin);
  env.PATH = [sandbox.guardBin, ...rest].join(sep);
  return env;
}

// First `codex` on PATH, or null.
export function resolveOnPath(command, env = process.env) {
  const sep = process.platform === "win32" ? ";" : ":";
  const names = process.platform === "win32" ? [`${command}.cmd`, `${command}.exe`, command] : [command];
  for (const dir of String(env.PATH ?? "").split(sep)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // Not here.
      }
    }
  }
  return null;
}

export function assertRealCodexUnreachable(sandbox, env = process.env) {
  const found = resolveOnPath("codex", env);
  if (!found || path.dirname(found) !== sandbox.guardBin) {
    throw new Error(`Test isolation failed: \`codex\` resolves to ${found ?? "nothing"}, not the sandbox guard in ${sandbox.guardBin}`);
  }
}

// ---------------------------------------------------------------------------
// Process discovery and reaping.

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readProcFile(pid, name) {
  try {
    return fs.readFileSync(`/proc/${pid}/${name}`, "latin1").replace(/\0/g, " ");
  } catch {
    return "";
  }
}

function procParent(pid) {
  const stat = readProcFile(pid, "stat");
  const match = stat.match(/\)\s+\S+\s+(\d+)/);
  return match ? Number(match[1]) : 0;
}

function ancestorPids() {
  const pids = new Set([process.pid, process.ppid]);
  if (process.platform !== "linux") return pids;
  let pid = process.ppid;
  for (let depth = 0; pid > 1 && depth < 64; depth += 1) {
    pid = procParent(pid);
    if (pid > 0) pids.add(pid);
  }
  return pids;
}

function listProcesses() {
  if (process.platform === "linux" && fs.existsSync("/proc/self/cmdline")) {
    const out = [];
    for (const entry of fs.readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      const cmdline = readProcFile(entry, "cmdline");
      if (!cmdline) continue; // Kernel thread, zombie or already gone.
      out.push({ pid: Number(entry), text: `${cmdline}\n${readProcFile(entry, "environ")}`, args: cmdline.trim() });
    }
    return out;
  }
  if (process.platform === "win32") return [];
  // macOS/BSD: `ps -E` appends the environment to the command column.
  const attempts = process.platform === "darwin" ? [["-Aww", "-E", "-o", "pid=,command="], ["-Aww", "-o", "pid=,command="]] : [["-eww", "-o", "pid=,args="]];
  for (const args of attempts) {
    const listing = spawnSync("ps", args, { encoding: "utf8" });
    if (listing.status !== 0) continue;
    return String(listing.stdout ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const pid = Number(line.split(/\s+/)[0]);
        const text = line.slice(String(pid).length).trim();
        return { pid, text, args: text };
      });
  }
  return [];
}

// Process start time (Linux: /proc stat field 22; macOS: ps lstart), or null.
export function readStartTime(pid) {
  const numeric = Number(pid);
  if (!Number.isInteger(numeric) || numeric <= 0) return null;
  if (process.platform === "linux") {
    const stat = readProcFile(numeric, "stat");
    const end = stat.lastIndexOf(")");
    if (end < 0) return null;
    return stat.slice(end + 1).trim().split(/\s+/)[19] ?? null;
  }
  if (process.platform === "darwin") {
    const result = spawnSync("ps", ["-o", "lstart=", "-p", String(numeric)], { encoding: "utf8" });
    return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : null;
  }
  return null;
}

// broker.json records under the sandbox: pid -> recorded start time (or null).
function brokerRecordsUnder(root) {
  const records = new Map();
  const walk = (dir, depth) => {
    if (depth > 12) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file, depth + 1);
      else if (entry.name === "broker.json") {
        try {
          const record = JSON.parse(fs.readFileSync(file, "utf8"));
          const pid = Number(record.pid);
          const startTime = record.startTime ?? record.pidStartTime ?? null;
          if (Number.isInteger(pid) && pid > 0) records.set(pid, startTime == null ? null : String(startTime));
        } catch {
          // Partial or foreign file.
        }
      }
    }
  };
  walk(root, 0);
  return records;
}

// A pid recorded in a sandbox broker.json is only trusted when the live
// process is provably the one recorded: its own command line/environment
// mentions the sandbox (handled by the marker match), or its start time equals
// the recorded one. A bare "app-server-broker" in argv is NOT enough: on a
// shared machine a recycled pid may be a real user's broker.
function isRecordedBroker(proc, records) {
  if (!records.has(proc.pid)) return false;
  const recorded = records.get(proc.pid);
  if (recorded == null) return false;
  const current = readStartTime(proc.pid);
  return current != null && current === recorded && proc.args.includes("app-server-broker");
}

// Processes (other than this one, its ancestors and `excludePids`) whose
// command line or environment mentions `marker`, plus brokers recorded under
// the sandbox whose identity is verified by start time.
export function findSandboxProcesses(marker, { excludePids = [] } = {}) {
  if (!marker) return [];
  const skip = ancestorPids();
  for (const pid of excludePids) skip.add(Number(pid));
  const records = brokerRecordsUnder(marker);
  return listProcesses()
    .filter((proc) => !skip.has(proc.pid))
    .filter((proc) => proc.text.includes(marker) || isRecordedBroker(proc, records))
    .map(({ pid, args }) => ({ pid, args }));
}

function signalAll(procs, signal) {
  for (const { pid } of procs) {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  }
}

// SIGTERM, short grace, SIGKILL. Returns what was found and what survived.
export function reapSandboxProcesses(marker, { graceMs = 1000, killWaitMs = 2000, excludePids = [] } = {}) {
  const find = () => findSandboxProcesses(marker, { excludePids });
  const found = new Map();
  let survivors = [];
  for (let round = 0; round < 3; round += 1) {
    let procs = find();
    if (procs.length === 0) {
      survivors = [];
      break;
    }
    for (const proc of procs) found.set(proc.pid, proc);
    signalAll(procs, "SIGTERM");
    const termDeadline = Date.now() + graceMs;
    while (procs.length > 0 && Date.now() < termDeadline) {
      sleepSync(50);
      procs = find();
    }
    signalAll(procs, "SIGKILL");
    const killDeadline = Date.now() + killWaitMs;
    while (procs.length > 0 && Date.now() < killDeadline) {
      sleepSync(50);
      procs = find();
    }
    survivors = procs;
    for (const proc of procs) found.set(proc.pid, proc);
  }
  return { reaped: [...found.values()], survivors };
}

// ---------------------------------------------------------------------------
// Watchdog: a detached process per sandbox that outlives its owner. When the
// owner dies for any reason (including SIGKILL or a Ctrl-C that tears node
// --test down before its hooks run) it reaps everything referencing the
// sandbox, removes it and exits.

export const WATCHDOG_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "test-sandbox-watchdog.mjs");

export function startWatchdog(root, { ownerPid = process.pid, env = process.env } = {}) {
  if (process.platform === "win32") return null;
  const child = spawn(
    process.execPath,
    [WATCHDOG_SCRIPT, "--owner", String(ownerPid), "--owner-start", String(readStartTime(ownerPid) ?? ""), "--root", root],
    { detached: true, stdio: "ignore", env }
  );
  child.unref();
  return child.pid ?? null;
}
