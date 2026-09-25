import "./_isolation.mjs";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { testSandbox } from "./_isolation.mjs";
import { findSandboxProcesses, readStartTime, reapSandboxProcesses, resolveOnPath, REAL_CODEX_BLOCKED_EXIT } from "../scripts/test-sandbox.mjs";
import { isPidAlive, makeTempDir, waitFor } from "./helpers.mjs";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(TESTS_DIR);
const FIXTURE = path.join(TESTS_DIR, "fixtures", "leaky-broker.mjs");
const REAL_HOME = os.userInfo().homedir;

function isUnder(child, parent) {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

test("HOME, CODEX_HOME, XDG dirs and TMPDIR live inside the sandbox", () => {
  const root = testSandbox.root;
  assert.equal(process.env.CODEX_PLUGIN_TEST_SANDBOX, root);
  for (const name of ["HOME", "CODEX_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "TMPDIR", "CODEX_COMPANION_CONFIG", "CODEX_COMPANION_BIN_DIR"]) {
    assert.ok(isUnder(process.env[name], root), `${name}=${process.env[name]} is not under ${root}`);
  }
  assert.ok(isUnder(os.homedir(), root));
  assert.ok(isUnder(os.tmpdir(), root));
  assert.notEqual(os.homedir(), REAL_HOME);
  assert.equal(fs.existsSync(path.join(process.env.CODEX_HOME, "auth.json")), false);
  assert.deepEqual(fs.readdirSync(process.env.CODEX_HOME), []);
});

test("leaky session variables are stripped", () => {
  for (const name of Object.keys(process.env)) {
    if (name.startsWith("CLAUDE_")) assert.fail(`${name} leaked into the test environment`);
    if (name.startsWith("CODEX_COMPANION_") && !["CODEX_COMPANION_CONFIG", "CODEX_COMPANION_BIN_DIR"].includes(name)) {
      assert.fail(`${name} leaked into the test environment`);
    }
  }
});

test("the real codex binary is shadowed by a guard that fails loudly", () => {
  const found = resolveOnPath("codex");
  assert.equal(path.dirname(found), testSandbox.guardBin);
  const result = spawnSync("codex", ["--version"], { encoding: "utf8", env: process.env });
  assert.equal(result.status, REAL_CODEX_BLOCKED_EXIT);
  assert.match(result.stderr, /real codex blocked in tests/);
});

test("every test file imports the isolation module first", () => {
  for (const name of fs.readdirSync(TESTS_DIR).filter((file) => file.endsWith(".test.mjs"))) {
    const firstImport = fs.readFileSync(path.join(TESTS_DIR, name), "utf8").split("\n").find((line) => line.startsWith("import "));
    assert.equal(firstImport, 'import "./_isolation.mjs";', `${name} must import ./_isolation.mjs first`);
  }
});

test("a bare node --test child strips inherited state vars and its leaked broker is reaped on exit", { timeout: 60000 }, () => {
  const parent = makeTempDir("isolation-child-");
  const reportFile = path.join(parent, "report.json");
  const leakedPluginData = path.join(parent, "leaked-plugin-data");
  const env = {
    ...process.env,
    TMPDIR: parent,
    CLAUDE_PLUGIN_DATA: leakedPluginData,
    CLAUDE_PLUGIN_ROOT: leakedPluginData,
    CODEX_COMPANION_SESSION_ID: "leaked-session",
    CODEX_COMPANION_APP_SERVER_ENDPOINT: "unix:/nonexistent/leaked.sock",
    ISOLATION_FIXTURE_REPORT: reportFile
  };
  delete env.NODE_TEST_CONTEXT; // Run as a standalone `node --test`, not as our subtest.
  const child = spawnSync(process.execPath, ["--test", path.join(TESTS_DIR, "fixtures", "leaky-broker.mjs")], {
    cwd: path.dirname(TESTS_DIR),
    encoding: "utf8",
    timeout: 50000,
    env
  });
  assert.equal(child.status, 0, child.stdout + child.stderr);
  const report = JSON.parse(fs.readFileSync(reportFile, "utf8"));

  assert.ok(report.sandbox && isUnder(report.sandbox, parent), `child sandbox ${report.sandbox} not under ${parent}`);
  assert.ok(isUnder(report.home, report.sandbox));
  assert.ok(isUnder(report.codexHome, report.sandbox));
  assert.equal(report.claudePluginData, null);
  assert.equal(report.sessionId, null);
  assert.equal(fs.existsSync(leakedPluginData), false, "inherited CLAUDE_PLUGIN_DATA must never be written");

  assert.ok(report.brokerPid > 0);
  assert.equal(isPidAlive(report.brokerPid), false, `broker ${report.brokerPid} survived the child test run`);
  assert.deepEqual(findSandboxProcesses(report.sandbox), []);
  assert.deepEqual(findSandboxProcesses(parent), []);
  assert.equal(fs.existsSync(report.sandbox), false, "child sandbox should be removed after a clean reap");
});

function fixtureEnv(parent, reportFile, extra = {}) {
  const env = { ...process.env, TMPDIR: parent, ISOLATION_FIXTURE_REPORT: reportFile, ISOLATION_FIXTURE_HANG: "1", ...extra };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

// Starts `args` in its own process group (like a terminal job) and waits until
// the leaky fixture has a live broker.
async function startHangingRun(t, args, parent) {
  const reportFile = path.join(parent, "report.json");
  const child = spawn(process.execPath, args, { cwd: ROOT, env: fixtureEnv(parent, reportFile), detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  t.after(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} reapSandboxProcesses(parent); });
  await waitFor(() => fs.existsSync(reportFile), { timeoutMs: 30000, intervalMs: 100 }).catch(() => assert.fail(`fixture never reported a broker:\n${output}`));
  const report = JSON.parse(fs.readFileSync(reportFile, "utf8"));
  assert.ok(isPidAlive(report.brokerPid), "broker should be alive mid-run");
  assert.ok(findSandboxProcesses(parent).length > 0, "expected live processes mid-run");
  return { child, exited, report, output: () => output };
}

test("Ctrl-C (SIGINT to the process group) during npm test leaves no survivors", { timeout: 90000 }, async (t) => {
  const parent = makeTempDir("sig-");
  const run = await startHangingRun(t, [path.join(ROOT, "scripts", "run-tests.mjs"), path.relative(ROOT, FIXTURE)], parent);
  process.kill(-run.child.pid, "SIGINT");
  const { code } = await run.exited;
  assert.equal(code, 130, run.output());
  // The runner reaps before it exits, so nothing may be left right now.
  assert.deepEqual(findSandboxProcesses(parent), [], run.output());
  assert.equal(isPidAlive(run.report.brokerPid), false);
  assert.deepEqual(fs.readdirSync(parent).filter((name) => name.startsWith("cpt-")), [], "runner sandbox should be removed");
});

test("SIGKILL of a bare node --test process group is cleaned up by the watchdog", { timeout: 90000 }, async (t) => {
  const parent = makeTempDir("kil-");
  const run = await startHangingRun(t, ["--test", FIXTURE], parent);
  process.kill(-run.child.pid, "SIGKILL");
  await run.exited;
  await waitFor(() => findSandboxProcesses(parent).length === 0, { timeoutMs: 8000, intervalMs: 100 })
    .catch(() => assert.fail(`survivors: ${JSON.stringify(findSandboxProcesses(parent))}`));
  assert.equal(isPidAlive(run.report.brokerPid), false);
  await waitFor(() => !fs.existsSync(run.report.sandbox), { timeoutMs: 3000 });
});

test("a broker.json pid that belongs to an unrelated process is never killed", async (t) => {
  const marker = makeTempDir("isolation-pidreuse-");
  // Unrelated live process that looks like a broker but does not reference the sandbox.
  const imposter = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "app-server-broker.mjs", "serve"], {
    env: { PATH: process.env.PATH },
    stdio: "ignore"
  });
  t.after(() => imposter.kill("SIGKILL"));
  await waitFor(() => readStartTime(imposter.pid) !== null, { timeoutMs: 3000 });
  const stateDir = path.join(marker, "state", "ws");
  fs.mkdirSync(stateDir, { recursive: true });
  const brokerFile = path.join(stateDir, "broker.json");

  for (const record of [{ pid: imposter.pid }, { pid: imposter.pid, startTime: "1" }]) {
    fs.writeFileSync(brokerFile, JSON.stringify(record));
    assert.deepEqual(findSandboxProcesses(marker), [], JSON.stringify(record));
    const { reaped } = reapSandboxProcesses(marker);
    assert.deepEqual(reaped, []);
    assert.ok(isPidAlive(imposter.pid), `unrelated process was killed for ${JSON.stringify(record)}`);
  }

  // Only a verified identity (matching start time) makes a recorded pid a target.
  fs.writeFileSync(brokerFile, JSON.stringify({ pid: imposter.pid, startTime: readStartTime(imposter.pid) }));
  assert.deepEqual(findSandboxProcesses(marker).map((proc) => proc.pid), [imposter.pid]);
});
