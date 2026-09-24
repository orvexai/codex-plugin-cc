import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "codex");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "codex-companion.mjs");
const SESSION_HOOK = path.join(PLUGIN_ROOT, "scripts", "session-lifecycle-hook.mjs");
const SESSION_ENV = [
  "CLAUDE_PLUGIN_DATA",
  "CODEX_COMPANION_SESSION_ID",
  "CODEX_COMPANION_APP_SERVER_ENDPOINT",
  "CODEX_COMPANION_MODEL",
  "CODEX_COMPANION_EFFORT",
  "CODEX_COMPANION_SANDBOX",
  "CODEX_COMPANION_NETWORK"
];

function makeWorkspace(behavior) {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const home = makeTempDir();
  installFakeCodex(binDir, behavior);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const env = {
    ...buildEnv(binDir),
    CODEX_COMPANION_CONFIG: path.join(home, "config.json"),
    CODEX_COMPANION_BIN_DIR: path.join(home, "bin")
  };
  for (const name of SESSION_ENV) {
    delete env[name];
  }

  return {
    repo,
    home,
    env,
    fakeState: () => JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8")),
    companion: (args, options = {}) =>
      run("node", [SCRIPT, ...args], {
        cwd: options.cwd ?? repo,
        env: { ...env, ...(options.env ?? {}) },
        input: options.input
      })
  };
}

function launchBackground(ws, args) {
  const launched = ws.companion(["task", "--background", "--json", ...args]);
  assert.equal(launched.status, 0, launched.stderr);
  return JSON.parse(launched.stdout).jobId;
}

test("task --full-access starts an unsandboxed thread and --network enables workspace network access", () => {
  const ws = makeWorkspace();

  let result = ws.companion(["task", "--full-access", "rebuild the index"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(ws.fakeState().lastThreadStart.sandbox, "danger-full-access");
  assert.equal(ws.fakeState().lastThreadStart.config, null);

  result = ws.companion(["task", "--write", "--network", "install the dependencies"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(ws.fakeState().lastThreadStart.sandbox, "workspace-write");
  assert.deepEqual(ws.fakeState().lastThreadStart.config, { sandbox_workspace_write: { network_access: true } });

  result = ws.companion(["task", "--sandbox", "full", "alias check"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(ws.fakeState().lastThreadStart.sandbox, "danger-full-access");

  result = ws.companion(["task", "look around"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(ws.fakeState().lastThreadStart.sandbox, "read-only");
});

test("task rejects unknown sandboxes and contradictory sandbox flags", () => {
  const ws = makeWorkspace();

  let result = ws.companion(["task", "--sandbox", "bogus", "x"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unsupported sandbox "bogus"/);

  result = ws.companion(["task", "--write", "--read-only", "x"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--write conflicts with a read-only sandbox/);

  result = ws.companion(["task", "--full-access", "--sandbox", "read-only", "x"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Choose only one of/);

  result = ws.companion(["task", "--network", "--no-network", "x"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Choose either --network or --no-network/);
});

test("setup defaults resolve flag > env > workspace > global, and --write never downgrades full access", () => {
  const ws = makeWorkspace();

  let result = ws.companion([
    "setup",
    "--global",
    "--default-model",
    "gpt-6-luna",
    "--default-effort",
    "high",
    "--default-sandbox",
    "danger-full-access",
    "--json"
  ]);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.defaults.model, { value: "gpt-6-luna", source: "global" });
  assert.deepEqual(report.defaults.sandbox, { value: "danger-full-access", source: "global" });

  result = ws.companion(["task", "--write", "use the defaults"]);
  assert.equal(result.status, 0, result.stderr);
  let state = ws.fakeState();
  assert.equal(state.lastThreadStart.sandbox, "danger-full-access");
  assert.equal(state.lastTurnStart.model, "gpt-6-luna");
  assert.equal(state.lastTurnStart.effort, "high");

  result = ws.companion(["setup", "--default-model", "gpt-5.6-luna"]);
  assert.equal(result.status, 0, result.stderr);
  result = ws.companion(["task", "workspace default wins over global"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(ws.fakeState().lastTurnStart.model, "gpt-5.6-luna");

  result = ws.companion(["task", "env wins over workspace"], { env: { CODEX_COMPANION_MODEL: "gpt-6-astra" } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(ws.fakeState().lastTurnStart.model, "gpt-6-astra");

  result = ws.companion(["task", "--model", "spark", "--read-only", "flags win"]);
  assert.equal(result.status, 0, result.stderr);
  state = ws.fakeState();
  assert.equal(state.lastTurnStart.model, "gpt-5.3-codex-spark");
  assert.equal(state.lastThreadStart.sandbox, "read-only");

  result = ws.companion(["setup", "--global", "--default-sandbox", "none"]);
  assert.equal(result.status, 0, result.stderr);
  const globalConfig = JSON.parse(fs.readFileSync(path.join(ws.home, "config.json"), "utf8"));
  assert.equal("defaultSandbox" in globalConfig, false);
  assert.equal(globalConfig.defaultModel, "gpt-6-luna");

  result = ws.companion(["setup", "--default-effort", "extreme"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unsupported reasoning effort/);
});

test("task --name labels the job and status reports its runtime", () => {
  const ws = makeWorkspace("slow-task");
  const jobId = launchBackground(ws, ["--name", "research: linear", "--full-access", "--model", "gpt-6-luna", "investigate"]);

  const waited = ws.companion(["wait", jobId, "--timeout-ms", "15000", "--json"]);
  assert.equal(waited.status, 0, waited.stderr);
  const payload = JSON.parse(waited.stdout);
  assert.equal(payload.timedOut, false);
  assert.equal(payload.jobs[0].status, "completed");
  assert.equal(payload.jobs[0].name, "research: linear");

  const status = ws.companion(["status", jobId]);
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /Name: research: linear/);
  assert.match(status.stdout, /Runtime: danger-full-access, model gpt-6-luna/);
});

test("parallel background jobs in one workspace all settle in the shared index", () => {
  const ws = makeWorkspace("slow-task");
  const jobIds = Array.from({ length: 6 }, (_, index) => launchBackground(ws, ["--name", `job ${index}`, `parallel job ${index}`]));

  const waited = ws.companion(["wait", ...jobIds, "--timeout-ms", "30000", "--json"]);
  assert.equal(waited.status, 0, waited.stderr);
  const payload = JSON.parse(waited.stdout);
  assert.deepEqual(
    payload.jobs.map((job) => job.status),
    jobIds.map(() => "completed")
  );

  const status = JSON.parse(ws.companion(["status", "--all", "--json"]).stdout);
  const indexed = [status.latestFinished, ...status.recent].filter(Boolean).map((job) => job.id);
  assert.deepEqual([...indexed].sort(), [...jobIds].sort());
  assert.equal(status.running.length, 0);
});

test("wait exits 124 when jobs are still active at the timeout", () => {
  const ws = makeWorkspace("interruptible-slow-task");
  const jobId = launchBackground(ws, ["long running work"]);

  const waited = ws.companion(["wait", jobId, "--timeout-ms", "300", "--json"]);
  assert.equal(waited.status, 124, waited.stderr);
  assert.equal(JSON.parse(waited.stdout).timedOut, true);

  const cancelled = ws.companion(["cancel", jobId]);
  assert.equal(cancelled.status, 0, cancelled.stderr);
});

test("wait, result and status resolve job ids launched from another workspace", () => {
  const ws = makeWorkspace("slow-task");
  const elsewhere = makeTempDir();
  const jobId = launchBackground(ws, ["cross-workspace job"]);

  const waited = ws.companion(["wait", jobId, "--timeout-ms", "15000", "--json"], { cwd: elsewhere });
  assert.equal(waited.status, 0, waited.stderr);
  assert.equal(JSON.parse(waited.stdout).jobs[0].status, "completed");

  const result = ws.companion(["result", jobId], { cwd: elsewhere });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Handled the requested task/);
});

test("result --output writes the raw final output to a file", () => {
  const ws = makeWorkspace();
  const task = ws.companion(["task", "summarise the repo"]);
  assert.equal(task.status, 0, task.stderr);

  const outputFile = path.join(ws.home, "out", "result.md");
  const result = ws.companion(["result", "--output", outputFile, "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.outputFile, outputFile);
  assert.equal(payload.status, "completed");
  assert.match(fs.readFileSync(outputFile, "utf8"), /Handled the requested task/);
});

test("send continues a finished job's thread in a follow-up job that inherits its runtime", () => {
  const ws = makeWorkspace();
  const first = ws.companion(["task", "--full-access", "--model", "gpt-6-luna", "--json", "first pass"]);
  assert.equal(first.status, 0, first.stderr);
  const threadId = JSON.parse(first.stdout).threadId;
  const jobId = JSON.parse(ws.companion(["status", "--json"]).stdout).latestFinished.id;

  const sent = ws.companion(["send", jobId, "please follow up on the findings", "--json"]);
  assert.equal(sent.status, 0, sent.stderr);
  assert.match(JSON.parse(sent.stdout).rawOutput, /Follow-up prompt accepted/);

  const state = ws.fakeState();
  assert.equal(state.lastThreadResume.threadId, threadId);
  assert.equal(state.lastThreadResume.sandbox, "danger-full-access");
  assert.equal(state.lastTurnStart.model, "gpt-6-luna");

  const latest = JSON.parse(ws.companion(["status", "--json"]).stdout).latestFinished;
  assert.equal(latest.parentJobId, jobId);
  assert.equal(latest.title, "Codex Follow-up");
});

test("send continues on a fork when another process still holds the finished job's thread", () => {
  const ws = makeWorkspace("resume-locked");
  const first = ws.companion(["task", "--write", "--json", "first pass"]);
  assert.equal(first.status, 0, first.stderr);
  const threadId = JSON.parse(first.stdout).threadId;
  const jobId = JSON.parse(ws.companion(["status", "--json"]).stdout).latestFinished.id;

  const sent = ws.companion(["send", jobId, "please follow up on the findings", "--json"]);
  assert.equal(sent.status, 0, sent.stderr);
  const payload = JSON.parse(sent.stdout);
  assert.match(payload.rawOutput, /Follow-up prompt accepted/);

  const state = ws.fakeState();
  assert.equal(state.lastThreadFork.sourceThreadId, threadId);
  assert.equal(state.lastThreadFork.sandbox, "workspace-write");
  assert.equal(payload.threadId, state.lastThreadFork.threadId);
  assert.notEqual(payload.threadId, threadId);
});

test("send steers a running job's active turn", () => {
  const ws = makeWorkspace("steerable-task");
  const jobId = launchBackground(ws, ["long job that accepts guidance"]);

  const sent = ws.companion(["send", jobId, "also check the docs", "--timeout-ms", "15000", "--json"]);
  assert.equal(sent.status, 0, sent.stderr);
  assert.equal(JSON.parse(sent.stdout).status, "delivered");

  const waited = ws.companion(["wait", jobId, "--timeout-ms", "15000", "--json"]);
  assert.equal(waited.status, 0, waited.stderr);
  assert.equal(JSON.parse(waited.stdout).jobs[0].status, "completed");

  const result = ws.companion(["result", jobId]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Steered: also check the docs/);
  assert.equal(ws.fakeState().steers.length, 1);
});

test("send retries a steer that fails transiently instead of dropping the message", () => {
  const ws = makeWorkspace("steer-flaky");
  const jobId = launchBackground(ws, ["long job with a flaky steer channel"]);

  const sent = ws.companion(["send", jobId, "retry me", "--timeout-ms", "15000", "--json"]);
  assert.equal(sent.status, 0, sent.stderr);
  assert.equal(JSON.parse(sent.stdout).status, "delivered");

  const waited = ws.companion(["wait", jobId, "--timeout-ms", "15000", "--json"]);
  assert.equal(waited.status, 0, waited.stderr);
  const result = ws.companion(["result", jobId]);
  assert.match(result.stdout, /Steered: retry me/);
  assert.equal(ws.fakeState().steerAttempts, 2);
});

test("messages the turn never accepts are reported as undelivered, not lost", () => {
  const ws = makeWorkspace("steer-rejected");
  const jobId = launchBackground(ws, ["job whose turn rejects steering"]);

  const sent = ws.companion(["send", jobId, "you will not get this", "--no-follow-up", "--timeout-ms", "15000", "--json"]);
  assert.equal(sent.status, 0, sent.stderr);
  const delivery = JSON.parse(sent.stdout);
  assert.equal(delivery.status, "finished-undelivered");

  const result = ws.companion(["result", jobId]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Undelivered messages/);
  assert.match(result.stdout, new RegExp(delivery.messageId));

  const stored = JSON.parse(ws.companion(["result", jobId, "--json"]).stdout).storedJob;
  assert.equal(stored.result.undeliveredMessages.length, 1);
  assert.equal(stored.result.undeliveredMessages[0].id, delivery.messageId);
  assert.match(stored.result.undeliveredMessages[0].error, /transient steer failure/);
});

test("send rejects empty messages and unknown jobs", () => {
  const ws = makeWorkspace();
  const task = ws.companion(["task", "seed"]);
  assert.equal(task.status, 0, task.stderr);
  const jobId = JSON.parse(ws.companion(["status", "--json"]).stdout).latestFinished.id;

  let result = ws.companion(["send", jobId]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Provide a message/);

  result = ws.companion(["send", "task-does-not-exist", "hello"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /No job found/);
});

test("setup --install-cli installs a working orvex-codex launcher and never clobbers foreign files", { skip: process.platform === "win32" }, () => {
  const ws = makeWorkspace();
  const binDir = path.join(ws.home, "launcher-bin");

  let result = ws.companion(["setup", "--install-cli", "--bin-dir", binDir, "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const shim = path.join(binDir, "orvex-codex");
  assert.ok(fs.statSync(shim).mode & 0o111);
  assert.match(fs.readFileSync(shim, "utf8"), /codex-companion\.mjs/);

  const viaShim = run(shim, ["status", "--json"], { cwd: ws.repo, env: ws.env });
  assert.equal(viaShim.status, 0, viaShim.stderr);
  assert.ok(JSON.parse(viaShim.stdout).workspaceRoot);

  const foreignDir = path.join(ws.home, "foreign-bin");
  fs.mkdirSync(foreignDir);
  fs.writeFileSync(path.join(foreignDir, "orvex-codex"), "#!/bin/sh\necho mine\n");
  result = ws.companion(["setup", "--install-cli", "--bin-dir", foreignDir]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Refusing to overwrite/);
  assert.equal(fs.readFileSync(path.join(foreignDir, "orvex-codex"), "utf8"), "#!/bin/sh\necho mine\n");
});

test("session start re-points a stale orvex-codex launcher at the running plugin", { skip: process.platform === "win32" }, () => {
  const home = makeTempDir();
  const binDir = path.join(home, "bin");
  fs.mkdirSync(binDir);
  const shim = path.join(binDir, "orvex-codex");
  fs.writeFileSync(shim, '#!/bin/sh\n# orvex-codex shim: old\nexec node "/old/plugin/scripts/codex-companion.mjs" "$@"\n', { mode: 0o755 });

  const env = { ...process.env, CODEX_COMPANION_BIN_DIR: binDir, CLAUDE_ENV_FILE: path.join(home, "env.sh") };
  const result = run("node", [SESSION_HOOK, "SessionStart"], {
    cwd: home,
    env,
    input: JSON.stringify({ hook_event_name: "SessionStart", session_id: "sess-shim", cwd: home })
  });
  assert.equal(result.status, 0, result.stderr);
  const contents = fs.readFileSync(shim, "utf8");
  assert.equal(contents.includes("/old/plugin/"), false);
  assert.equal(contents.includes(path.join(PLUGIN_ROOT, "scripts", "codex-companion.mjs")), true);
});
