import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { spawn } from "node:child_process";

export function makeTempDir(prefix = "codex-plugin-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function writeExecutable(filePath, source) {
  fs.writeFileSync(filePath, source, { encoding: "utf8", mode: 0o755 });
}

export function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    shell: options.shell ?? (process.platform === "win32" && !path.isAbsolute(command)),
    windowsHide: true
  });
}

export function initGitRepo(cwd) {
  run("git", ["init", "-b", "main"], { cwd });
  run("git", ["config", "user.name", "Codex Plugin Tests"], { cwd });
  run("git", ["config", "user.email", "tests@example.com"], { cwd });
  run("git", ["config", "commit.gpgsign", "false"], { cwd });
  run("git", ["config", "tag.gpgsign", "false"], { cwd });
}

export function waitFor(predicate, { timeoutMs = 5000, intervalMs = 50 } = {}) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = async () => {
      try { if (await predicate()) return resolve(true); } catch {}
      if (Date.now() - started >= timeoutMs) return reject(new Error(`Timed out after ${timeoutMs}ms`));
      setTimeout(poll, intervalMs);
    };
    poll();
  });
}

export function isPidAlive(pid) {
  try { process.kill(Number(pid), 0); return true; } catch (error) { return error.code === "EPERM"; }
}

export function spawnStubborn() {
  const child = spawn(process.execPath, ["-e", 'process.on("SIGTERM",()=>{}); console.log(process.pid); setInterval(()=>{},1000)'], { stdio: ["ignore", "pipe", "ignore"] });
  let output = "";
  child.stdout.setEncoding("utf8");
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("stubborn child did not print pid")), 3000);
    child.stdout.on("data", (chunk) => { output += chunk; const match = output.match(/\d+/); if (match) { clearTimeout(timer); resolve(Number(match[0])); } });
    child.once("error", reject);
  });
  return { pid: child.pid, ready, kill: () => child.kill("SIGKILL"), child };
}

export async function makeCompanionWorkspace(behavior = "review-ok", options = {}) {
  const repo = makeTempDir("codex-companion-repo-");
  const binDir = makeTempDir("codex-companion-bin-");
  const home = makeTempDir("codex-companion-home-");
  const { installFakeCodex, buildEnv } = await import("./fake-codex-fixture.mjs");
  installFakeCodex(binDir, behavior, options.fakeOptions || {});
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "fixture workspace\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  const pluginRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../plugins/codex");
  const env = { ...buildEnv(binDir), CLAUDE_PLUGIN_DATA: path.join(home, "plugin-data"), CODEX_COMPANION_CONFIG: path.join(home, "config.json"), CODEX_COMPANION_BIN_DIR: path.join(home, "bin") };
  const script = path.join(pluginRoot, "scripts", "codex-companion.mjs");
  const companion = (args, opts = {}) => run(process.execPath, [script, ...args], { cwd: opts.cwd ?? repo, env: { ...env, ...(opts.env || {}) }, input: opts.input });
  const spawnCompanion = (args, opts = {}) => spawn(process.execPath, [script, ...args], { cwd: opts.cwd ?? repo, env: { ...env, ...(opts.env || {}) }, stdio: opts.stdio || ["ignore", "pipe", "pipe"] });
  const close = () => {
    const stateRoot = path.join(home, "plugin-data", "state");
    if (!fs.existsSync(stateRoot)) return;
    for (const dir of fs.readdirSync(stateRoot)) {
      const file = path.join(stateRoot, dir, "broker.json");
      if (!fs.existsSync(file)) continue;
      try { const session = JSON.parse(fs.readFileSync(file, "utf8")); if (session.pid) process.kill(session.pid, "SIGKILL"); } catch {}
    }
  };
  return { repo, home, binDir, env, companion, spawnCompanion, close, fakeState: () => JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8")) };
}
