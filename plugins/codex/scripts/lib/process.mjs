import fs from "node:fs";
import { spawnSync } from "node:child_process";
import process from "node:process";

export function isProcessAlive(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false;
  if (process.platform === "linux") {
    try {
      const stat = fs.readFileSync(`/proc/${Number(pid)}/stat`, "utf8");
      const end = stat.lastIndexOf(")");
      if (stat.slice(end + 1).trim().split(/\s+/)[0] === "Z") return false;
    } catch { /* Fall back to kill(pid, 0) when procfs is unavailable. */ }
  }
  try { process.kill(Number(pid), 0); return true; } catch (error) { return error?.code === "EPERM"; }
}

export function readProcessStartTime(pid) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) return null;
  if (process.platform === "linux") {
    try {
      const stat = fs.readFileSync(`/proc/${numericPid}/stat`, "utf8");
      const end = stat.lastIndexOf(")");
      const fields = stat.slice(end + 1).trim().split(/\s+/);
      return fields[19] ?? null;
    } catch { return null; }
  }
  if (process.platform === "darwin") {
    const result = spawnSync("ps", ["-o", "lstart=", "-p", String(numericPid)], { encoding: "utf8" });
    return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : null;
  }
  return null;
}

export function isSameProcess({ pid, startTime }) {
  if (!isProcessAlive(Number(pid))) return false;
  const current = readProcessStartTime(pid);
  return !(startTime != null && current != null && String(startTime) !== String(current));
}

export async function terminateProcessTreeVerified(pid, { group = false, graceMs = 1000, killWaitMs = 5000 } = {}) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) {
    return { delivered: false, exited: true, escalated: false, residualPids: [] };
  }
  const startTime = readProcessStartTime(numericPid);
  const same = () => isSameProcess({ pid: numericPid, startTime });
  const signal = (name) => {
    try { process.kill(group ? -numericPid : numericPid, name); return true; }
    catch (error) { return error?.code !== "ESRCH" ? false : false; }
  };
  if (!same()) return { delivered: false, exited: true, escalated: false, residualPids: [] };
  const delivered = signal("SIGTERM");
  const wait = async (ms) => {
    const until = Date.now() + Math.max(0, ms);
    while (same() && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, Math.min(25, until - Date.now())));
    return !same();
  };
  let exited = await wait(graceMs);
  let escalated = false;
  if (!exited) {
    escalated = true;
    signal("SIGKILL");
    exited = await wait(killWaitMs);
  }
  return { delivered, exited, escalated, residualPids: exited ? [] : [numericPid] };
}

export function runCommand(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    maxBuffer: options.maxBuffer,
    stdio: options.stdio ?? "pipe",
    shell: options.shell ?? (process.platform === "win32" ? (process.env.SHELL || true) : false),
    windowsHide: true
  });

  return {
    command,
    args,
    status: result.status ?? 0,
    signal: result.signal ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null
  };
}

export function runCommandChecked(command, args = [], options = {}) {
  const result = runCommand(command, args, options);
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return result;
}

export function binaryAvailable(command, versionArgs = ["--version"], options = {}) {
  const result = runCommand(command, versionArgs, options);
  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOENT") {
    return { available: false, detail: "not found" };
  }
  if (result.error) {
    return { available: false, detail: result.error.message };
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
    return { available: false, detail };
  }
  return { available: true, detail: result.stdout.trim() || result.stderr.trim() || "ok" };
}

function looksLikeMissingProcessMessage(text) {
  return /not found|no running instance|cannot find|does not exist|no such process/i.test(text);
}

export function terminateProcessTree(pid, options = {}) {
  if (!Number.isFinite(pid)) {
    return { attempted: false, delivered: false, method: null };
  }

  const platform = options.platform ?? process.platform;
  const runCommandImpl = options.runCommandImpl ?? runCommand;
  const killImpl = options.killImpl ?? process.kill.bind(process);

  if (platform === "win32") {
    const result = runCommandImpl("taskkill", ["/PID", String(pid), "/T", "/F"], {
      cwd: options.cwd,
      env: options.env
    });

    if (!result.error && result.status === 0) {
      return { attempted: true, delivered: true, method: "taskkill", result };
    }

    const combinedOutput = `${result.stderr}\n${result.stdout}`.trim();
    if (!result.error && looksLikeMissingProcessMessage(combinedOutput)) {
      return { attempted: true, delivered: false, method: "taskkill", result };
    }

    if (result.error?.code === "ENOENT") {
      try {
        killImpl(pid);
        return { attempted: true, delivered: true, method: "kill" };
      } catch (error) {
        if (error?.code === "ESRCH") {
          return { attempted: true, delivered: false, method: "kill" };
        }
        throw error;
      }
    }

    if (result.error) {
      throw result.error;
    }

    throw new Error(formatCommandFailure(result));
  }

  try {
    killImpl(-pid, "SIGTERM");
    return { attempted: true, delivered: true, method: "process-group" };
  } catch (error) {
    if (error?.code !== "ESRCH") {
      try {
        killImpl(pid, "SIGTERM");
        return { attempted: true, delivered: true, method: "process" };
      } catch (innerError) {
        if (innerError?.code === "ESRCH") {
          return { attempted: true, delivered: false, method: "process" };
        }
        throw innerError;
      }
    }

    return { attempted: true, delivered: false, method: "process-group" };
  }
}

export function formatCommandFailure(result) {
  const parts = [`${result.command} ${result.args.join(" ")}`.trim()];
  if (result.signal) {
    parts.push(`signal=${result.signal}`);
  } else {
    parts.push(`exit=${result.status}`);
  }
  const stderr = (result.stderr || "").trim();
  const stdout = (result.stdout || "").trim();
  if (stderr) {
    parts.push(stderr);
  } else if (stdout) {
    parts.push(stdout);
  }
  return parts.join(": ");
}
