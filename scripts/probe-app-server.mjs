#!/usr/bin/env node
/**
 * Small codex-cli app-server protocol probe. It never writes user Codex
 * configuration; scratch config files live under its temporary root. Normal
 * live turns use explicitly read-only threads in fresh temporary directories.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import readline from "node:readline";

const asJson = process.argv.includes("--json");
const steps = [];
const children = [];
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-app-server-probe-"));
let cleanedUp = false;
let cleanupFailed = false;

function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  for (const child of children) {
    if (!child.killed && child.exitCode === null) child.kill("SIGKILL");
  }
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

function handleSignal(signal) {
  cleanup();
  process.exitCode = signal === "SIGINT" ? 130 : 143;
  process.exit();
}

process.on("SIGINT", () => handleSignal("SIGINT"));
process.on("SIGTERM", () => handleSignal("SIGTERM"));

function record(question, request, response, verdict) {
  steps.push({ question, request, response, verdict });
}

function runCommand(args, cwd = undefined, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let child;
    try {
      child = spawn("codex", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      finish({ code: -1, stdout, stderr: error.message });
      return;
    }
    children.push(child);
    child.stdout.setEncoding("utf8").on("data", (part) => { stdout += part; });
    child.stderr.setEncoding("utf8").on("data", (part) => { stderr += part; });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ code: -1, stdout: stdout.trim(), stderr: `${stderr}command timed out after ${timeoutMs}ms`.trim() });
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      finish({ code: -1, stdout: stdout.trim(), stderr: `${stderr}${error.message}`.trim() });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish({ code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

class RpcProcess {
  constructor(args, cwd, env = process.env) {
    this.proc = spawn("codex", args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    children.push(this.proc);
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
    this.stderr = "";
    this.dead = false;
    this.processError = null;
    this.proc.stdout.setEncoding("utf8");
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (chunk) => { this.stderr += chunk; });
    this.rl = readline.createInterface({ input: this.proc.stdout });
    this.rl.on("line", (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const pending = this.pending.get(msg.id);
        clearTimeout(pending.timer);
        this.pending.delete(msg.id);
        msg.error ? pending.reject(msg.error) : pending.resolve(msg.result ?? {});
      } else if (msg.method) this.notifications.push(msg);
    });
    this.proc.on("error", (error) => {
      this.processError = error;
      this.rejectPending({ message: `app-server process error: ${error.message}`, stderr: this.stderr.trim() });
    });
    this.proc.on("exit", (code, signal) => {
      this.rejectPending({ message: `app-server exited (${signal ?? code})`, stderr: this.stderr.trim() });
    });
    this.proc.stdin.on("error", (error) => {
      this.rejectPending({ message: `app-server stdin error: ${error.message}`, stderr: this.stderr.trim() });
    });
  }
  rejectPending(error) {
    this.dead = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
  request(method, params = {}, timeoutMs = 20000) {
    if (this.dead) return Promise.reject({ message: this.processError?.message ?? "app-server process is not running", stderr: this.stderr.trim() });
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject({ message: `timeout waiting for ${method}` });
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.proc.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  notify(method, params = {}) {
    this.proc.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }
  async initialize() {
    await this.request("initialize", {
      clientInfo: { name: "codex-app-server-probe", title: "Codex app-server probe", version: "1.0.0" },
      capabilities: { experimentalApi: true, requestAttestation: false, optOutNotificationMethods: [] }
    });
    this.notify("initialized", {});
  }
  async close() {
    this.rl.close();
    if (!this.proc.killed && this.proc.exitCode === null) this.proc.kill("SIGKILL");
  }
}

function errorText(error) {
  return typeof error === "string" ? error : JSON.stringify(error);
}

async function probeIsolatedSandboxFallback(sandboxMode) {
  const label = `isolated config sandbox_mode=${sandboxMode}`;
  const isolatedHome = path.join(tempRoot, `codex-home-${sandboxMode}`);
  const isolatedCwd = path.join(tempRoot, `fallback-cwd-${sandboxMode}`);
  fs.mkdirSync(isolatedHome, { recursive: true });
  fs.mkdirSync(isolatedCwd, { recursive: true });
  fs.writeFileSync(path.join(isolatedHome, "config.toml"), `sandbox_mode = "${sandboxMode}"\napproval_policy = "never"\n`);

  const params = { cwd: isolatedCwd, approvalPolicy: "never", ephemeral: true };
  let isolatedServer;
  try {
    isolatedServer = new RpcProcess(["app-server"], isolatedCwd, {
      ...process.env,
      CODEX_HOME: isolatedHome
    });
    await isolatedServer.initialize();
    const response = await isolatedServer.request("thread/start", params, 15000);
    const effectiveSandbox = response.sandbox;
    const result = {
      model: response.model,
      sandbox: effectiveSandbox,
      approvalPolicy: response.approvalPolicy,
      cwd: response.cwd,
      thread: { ephemeral: response.thread?.ephemeral, path: response.thread?.path }
    };
    const matches = effectiveSandbox?.type === (sandboxMode === "read-only" ? "readOnly" : "workspaceWrite");
    record(`Does thread/start without sandbox inherit ${label}?`, {
      method: "thread/start", params, environment: { CODEX_HOME: `<temporary isolated home: ${sandboxMode}>` },
      scratchConfig: { sandbox_mode: sandboxMode, approval_policy: "never" }
    }, result, matches
      ? `PASS: omitted sandbox resolved to ${effectiveSandbox.type}; thread is ephemeral and no turn was started`
      : `FAIL: omitted sandbox resolved to ${effectiveSandbox?.type ?? "no sandbox value"}; expected ${sandboxMode}`);
  } catch (error) {
    const detail = errorText(error);
    const needsAuth = /auth|login|credential|unauthorized/i.test(detail);
    record(`Does thread/start without sandbox inherit ${label}?`, {
      method: "thread/start", params, environment: { CODEX_HOME: `<temporary isolated home: ${sandboxMode}>` },
      scratchConfig: { sandbox_mode: sandboxMode, approval_policy: "never" }
    }, { error: detail }, needsAuth
      ? "UNVERIFIED: isolated app-server/thread start requires authentication; no credentials were copied"
      : "UNVERIFIED: isolated probe failed before the effective sandbox could be read");
  } finally {
    if (isolatedServer) await isolatedServer.close();
  }
}

async function probe() {
  const staticOut = await runCommand(["app-server", "generate-ts", "--out", path.join(tempRoot, "types"), "--experimental"]);
  record("Generate the protocol TypeScript definitions", ["codex", "app-server", "generate-ts", "--out", "<temporary directory>", "--experimental"], staticOut, staticOut.code === 0 ? "PASS: static protocol types generated" : "FAIL: type generation failed");
  if (staticOut.code !== 0) return;

  for (const args of [["--help"], ["agents", "--help"], ["queue", "--help"], ["exec", "--help"]]) {
    const help = await runCommand(args);
    record(`Capture codex ${args.join(" ")} static help`, ["codex", ...args], help, help.code === 0 ? "PASS: help available without authentication" : "FAIL: help command failed");
  }

  await probeIsolatedSandboxFallback("workspace-write");
  await probeIsolatedSandboxFallback("read-only");

  const auth = await runCommand(["login", "status"]);
  const authOutput = `${auth.stdout}\n${auth.stderr}`.trim();
  if (auth.code !== 0 || !/logged in/i.test(authOutput)) {
    record("Live app-server authentication", ["codex", "login", "status"], { output: authOutput }, auth.code === -1 && /enoent|not found/i.test(authOutput) ? "SKIPPED (codex executable unavailable)" : "SKIPPED (no auth)");
    for (const question of ["model/list", "config/read", "thread/start", "thread/read", "thread/unload/resume", "turn/steer", "skills/list and hooks/list", "per-thread skills/hooks/AGENTS.md config", "turn/interrupt unknown turn"]) {
      record(question, null, { status: "SKIPPED (no auth)" }, "SKIPPED (no auth)");
    }
    return;
  }

  let server;
  try {
    server = new RpcProcess(["app-server"], tempRoot);
    await server.initialize();
  } catch (error) {
    record("Live app-server authentication", ["codex", "app-server", "initialize"], { error: errorText(error) }, /auth|login|credential|unauthorized/i.test(errorText(error)) ? "SKIPPED (no auth)" : "ERROR: app-server did not initialize");
    return;
  }

  const attempt = async (question, method, params = {}, verdict = "Recorded live response") => {
    if (method === "thread/start" && params.sandbox !== "read-only") {
      throw new Error("Safety guard: every probe thread/start must set sandbox to read-only");
    }
    const request = { method, params };
    try {
      const response = await server.request(method, params);
      record(question, request, response, verdict);
      return response;
    } catch (error) {
      record(question, request, { error: errorText(error) }, `Rejected/error: ${error.message ?? error}`);
      return null;
    }
  };

  const cleanupPersistentThread = async (threadId) => {
    if (server?.dead) {
      try {
        server = new RpcProcess(["app-server"], tempRoot);
        await server.initialize();
      } catch (error) {
        cleanupFailed = true;
        record("Can the persistent probe thread be safely deleted?", { threadId }, { error: errorText(error) },
          "FAIL: could not reconnect to app-server for persistent thread cleanup");
        return;
      }
    }
    const threadRead = async () => {
      let result = await attempt("Read persistent probe thread before cleanup", "thread/read", { threadId, includeTurns: true });
      if (!result?.thread) result = await attempt("Read persistent probe thread status before cleanup", "thread/read", { threadId });
      return result?.thread ?? null;
    };
    const queueList = async () => {
      const result = await attempt("Check persistent probe thread queue before cleanup", "thread/queue/list", { threadId });
      return Array.isArray(result?.data) ? result.data : null;
    };
    const activeTurn = (thread) => thread?.status?.type === "active"
      || (thread?.turns ?? []).some((turn) => !["completed", "interrupted", "failed", "cancelled"].includes(turn.status));

    let queue = await queueList();
    let thread = await threadRead();
    if (queue === null || !thread) {
      cleanupFailed = true;
      record("Can the persistent probe thread be safely deleted?", { threadId }, {
        queueVerified: queue !== null, threadReadVerified: Boolean(thread)
      }, "SKIPPED: could not verify queue and thread status before deletion");
      return;
    }

    if (queue.length > 0) {
      cleanupFailed = true;
      record("Can the persistent probe thread be safely deleted?", { threadId }, {
        queuedSubmissionIds: queue.map((item) => item.id)
      }, "SKIPPED: queue contains submissions not created by this probe; thread retained");
      return;
    }

    if (activeTurn(thread)) {
      const turn = (thread.turns ?? []).find((item) => !["completed", "interrupted", "failed", "cancelled"].includes(item.status));
      if (turn?.id) await attempt("Interrupt active persistent probe turn before deletion", "turn/interrupt", { threadId, turnId: turn.id });
      for (let i = 0; i < 20; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        thread = await threadRead();
        if (thread && !activeTurn(thread)) break;
      }
    }

    queue = await queueList();
    thread = await threadRead();
    if (queue === null || !thread || queue.length > 0 || activeTurn(thread)) {
      cleanupFailed = true;
      record("Can the persistent probe thread be safely deleted?", { threadId }, {
        queueVerified: queue !== null, queuedSubmissionCount: queue?.length ?? null,
        threadReadVerified: Boolean(thread), status: thread?.status,
        turns: thread?.turns?.map((turn) => ({ id: turn.id, status: turn.status }))
      }, "FAIL: persistent thread is not idle with an empty queue; thread retained");
      return;
    }

    const rolloutPath = thread.path;
    const deletion = await attempt("Delete the idle persistent probe thread after verifying its queue is empty", "thread/delete", { threadId },
      "PASS: persistent probe rollout removed after confirming no active turns or queued submissions");
    const rolloutExists = rolloutPath ? fs.existsSync(rolloutPath) : null;
    const deleted = Boolean(deletion) && rolloutExists === false;
    record("Verify the persistent probe rollout was removed", { threadId, path: rolloutPath }, { rolloutExists },
      deleted ? "PASS: rollout file is absent after thread/delete" : "FAIL: thread/delete did not verify rollout removal");
    if (!deleted) cleanupFailed = true;
  };

  await attempt("What models does model/list expose?", "model/list", { limit: 100 });
  const configRead = await attempt("Which config layers and effective config values does config/read report?", "config/read", { includeLayers: true, cwd: tempRoot });
  await attempt("What skills are available?", "skills/list", { cwds: [tempRoot] });
  await attempt("What hooks are available?", "hooks/list", { cwds: [tempRoot] });

  record("What sandbox fallback does config/read indicate when thread/start omits sandbox?", {
    method: "config/read", params: { includeLayers: true, cwd: tempRoot },
    note: "No live thread/start without sandbox is issued; derive the configured fallback from this read-only response."
  }, configRead ? {
    config: { sandbox_mode: configRead.config?.sandbox_mode, model: configRead.config?.model, approval_policy: configRead.config?.approval_policy },
    origins: { sandbox_mode: configRead.origins?.sandbox_mode, model: configRead.origins?.model, approval_policy: configRead.origins?.approval_policy }
  } : { error: "config/read failed; fallback not determined" }, configRead?.config?.sandbox_mode
    ? `INFERRED from config/read: configured sandbox_mode is ${configRead.config.sandbox_mode}; no unsandboxed thread was created.`
    : "UNVERIFIED: config/read did not return sandbox_mode; no unsandboxed thread was created.");

  // Persist only this explicitly read-only thread because the resume probe
  // needs its rollout to survive closing and restarting the app-server.
  const safeThreadStartParams = {
    cwd: tempRoot, sandbox: "read-only", approvalPolicy: "never",
    developerInstructions: "For this probe, answer exactly: DEV-INSTRUCTIONS-LOADED.", ephemeral: false
  };
  const safeThreadStart = await attempt("Start the read-only persistent thread used for turn, read, resume, unload, and interrupt probes", "thread/start", safeThreadStartParams,
    "sandbox is explicit read-only; persistence is required only to verify resume across app-server processes");
  const safeThreadId = safeThreadStart?.thread?.id;
  try {
  if (safeThreadId && safeThreadStart.sandbox?.type === "readOnly") {
    let resumedRuntime = null;
    record("ThreadStartResponse effective fields with explicit read-only sandbox", { method: "thread/start", params: safeThreadStartParams }, {
      model: safeThreadStart.model, reasoningEffort: safeThreadStart.reasoningEffort, sandbox: safeThreadStart.sandbox,
      approvalPolicy: safeThreadStart.approvalPolicy, cwd: safeThreadStart.cwd, threadId: safeThreadId
    }, "PASS: response reports effective values for an explicitly read-only thread");
    await attempt("Does thread/read return path and status without requesting turns?", "thread/read", { threadId: safeThreadId });
    await attempt("Does thread/read return rollout path, turns, and status?", "thread/read", { threadId: safeThreadId, includeTurns: true });
    const turn = await attempt("Does turn/start run on the explicitly read-only thread?", "turn/start", {
      threadId: safeThreadId, input: [{ type: "text", text: "Reply with exactly: OK" }]
    }, "One harmless turn on the explicitly read-only thread; inspect its live and completed status");
    if (turn?.turn?.id) {
      await attempt("Does thread/read expose rollout path, turn list, and status while a turn is active?", "thread/read", { threadId: safeThreadId, includeTurns: true });
      const activeRead = steps[steps.length - 1];
      if (activeRead.response?.thread) activeRead.response = { thread: {
        id: activeRead.response.thread.id, path: activeRead.response.thread.path,
        status: activeRead.response.thread.status,
        turns: activeRead.response.thread.turns?.map((item) => ({ id: item.id, status: item.status }))
      } };
      let completed = false;
      let finalState = null;
      for (let i = 0; i < 24 && !completed; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        try {
          finalState = await server.request("thread/read", { threadId: safeThreadId, includeTurns: true });
          completed = finalState?.thread?.status?.type === "idle";
        } catch {
          break;
        }
      }
      if (finalState) record("What is the final thread/read status and turn list?", { method: "thread/read", params: { threadId: safeThreadId, includeTurns: true } }, {
        thread: { path: finalState.thread?.path, status: finalState.thread?.status, turns: finalState.thread?.turns?.map((item) => ({ id: item.id, status: item.status, items: item.items })) }
      }, "PASS: response includes rollout path, thread status, and turn status");
      const assistantText = (finalState?.thread?.turns ?? []).flatMap((item) => item.items ?? []).filter((item) => item.type === "agentMessage").map((item) => item.text);
      record("Was developerInstructions applied to the probe turn?", { method: "turn/start", params: { threadId: safeThreadId, input: [{ type: "text", text: "Reply with exactly: OK" }] }, threadStart: { developerInstructions: "For this probe, answer exactly: DEV-INSTRUCTIONS-LOADED." } }, { assistantText }, assistantText.some((text) => text.includes("DEV-INSTRUCTIONS-LOADED")) ? "PASS: developer instruction text is reflected in the answer" : "PARTIAL: field accepted; turn did not expose the marker");
      if (!completed) await attempt("Interrupt the probe turn during cleanup", "turn/interrupt", { threadId: safeThreadId, turnId: turn.turn.id });
      await attempt("Does thread/unload exist?", "thread/unload", { threadId: safeThreadId });
      await attempt("Can turn/interrupt on an unknown turn be identified as an error?", "turn/interrupt", { threadId: safeThreadId, turnId: "00000000-0000-4000-8000-000000000000" });
      await server.close();
      server = new RpcProcess(["app-server"], tempRoot);
      await server.initialize();
      resumedRuntime = await attempt("Can a read-only persisted thread be resumed by another app-server process?", "thread/resume", { threadId: safeThreadId, cwd: tempRoot });
      if (resumedRuntime?.sandbox?.type !== "readOnly") {
        record("Is the resumed thread still reported as read-only?", { method: "thread/resume", params: { threadId: safeThreadId, cwd: tempRoot } }, {
          sandbox: resumedRuntime?.sandbox ?? null
        }, "Do not run any further turn on the resumed thread unless the response explicitly reports read-only");
      }
    }
  } else if (safeThreadId) {
    record("Skip turns because thread/start did not report an effective read-only sandbox", { method: "thread/start", params: safeThreadStartParams }, {
      sandbox: safeThreadStart.sandbox ?? null
    }, "SKIPPED for safety: effective sandbox was not confirmed read-only");
  }

  const explicit = await attempt("Does thread/start accept explicit runtime and developer instructions?", "thread/start", {
    cwd: tempRoot, model: "gpt-5-codex", sandbox: "read-only", approvalPolicy: "never",
    developerInstructions: "Probe marker: respond with exactly OK.", ephemeral: true
  });
  if (explicit?.thread?.id) {
    record("ThreadStartResponse fields with explicit runtime", { method: "thread/start", params: { cwd: tempRoot, model: "gpt-5-codex", sandbox: "read-only", approvalPolicy: "never", developerInstructions: "Probe marker: respond with exactly OK.", ephemeral: true } }, {
      model: explicit.model, reasoningEffort: explicit.reasoningEffort, sandbox: explicit.sandbox,
      approvalPolicy: explicit.approvalPolicy, cwd: explicit.cwd, threadId: explicit.thread.id
    }, "Verify effective fields and developerInstructions acceptance");
  }

  for (const [feature, config] of [
    ["skills", { skills: { enabled: false } }],
    ["hooks", { features: { hooks: false } }],
    ["AGENTS.md fallback", { project_doc_fallback_filenames: [] }]
  ]) {
    const result = await attempt(`Does the candidate per-thread config disable ${feature}?`, "thread/start", {
      cwd: tempRoot, sandbox: "read-only", approvalPolicy: "never", ephemeral: true, config
    });
    if (result?.thread?.id) {
      const read = await attempt(`What instruction sources remain after the ${feature} candidate?`, "thread/read", { threadId: result.thread.id });
      const item = steps[steps.length - 1];
      if (read?.thread) item.response = { instructionSources: result.instructionSources, path: read.thread.path, status: read.thread.status };
    }
  }

  if (safeThreadId) {
    // Resume may report the ambient configured sandbox even when the original
    // thread was started read-only. Keep review/start on a new explicit,
    // ephemeral read-only thread, never on the resumed thread.
    const reviewThread = await attempt("Start an ephemeral read-only thread for the native review/steer probe", "thread/start", {
      cwd: tempRoot, sandbox: "read-only", approvalPolicy: "never", ephemeral: true
    }, "review/start is isolated to an explicitly read-only ephemeral thread");
    const reviewThreadId = reviewThread?.thread?.id;
    if (reviewThreadId && reviewThread.sandbox?.type === "readOnly") {
      const review = await attempt("Does native review/start create an inline review turn?", "review/start", {
        threadId: reviewThreadId, target: { type: "custom", instructions: "Reply exactly OK without using tools." }
      });
      if (review) {
        const activeTurn = review.turn?.id ?? server.notifications.findLast((n) => n.method === "turn/started" && n.params.threadId === reviewThreadId)?.params.turn?.id;
        if (activeTurn) await attempt("Does turn/steer accept input on a native review turn?", "turn/steer", {
          threadId: reviewThreadId, expectedTurnId: activeTurn,
          input: [{ type: "text", text: "Review turn steering probe." }]
        });
        if (activeTurn) await attempt("Interrupt the native review probe turn during cleanup", "turn/interrupt", { threadId: reviewThreadId, turnId: activeTurn });
      }
    } else if (reviewThreadId) {
      record("Skip review turn because thread/start did not report an effective read-only sandbox", {
        method: "thread/start", params: { cwd: tempRoot, sandbox: "read-only", approvalPolicy: "never", ephemeral: true }
      }, { sandbox: reviewThread.sandbox ?? null }, "SKIPPED for safety: effective sandbox was not confirmed read-only");
    }
  }
  } finally {
    if (safeThreadId) await cleanupPersistentThread(safeThreadId);
  }

  await server.close();
}

function renderMarkdown() {
  return `# app-server probe\n\n${steps.map((step, i) => `## ${i + 1}. ${step.question}\n\nRequest:\n\n\`\`\`json\n${JSON.stringify(step.request, null, 2)}\n\`\`\`\n\nResponse:\n\n\`\`\`json\n${JSON.stringify(step.response, null, 2)}\n\`\`\`\n\nVerdict: ${step.verdict}\n`).join("\n")}`;
}

try {
  await probe();
} catch (error) {
  record("Probe runner error", null, { error: error.stack ?? String(error) }, "ERROR: runner encountered an unexpected failure");
} finally {
  cleanup();
  if (cleanupFailed && process.exitCode === undefined) process.exitCode = 1;
  if (asJson) process.stdout.write(`${JSON.stringify({ version: "0.157.0", steps }, null, 2)}\n`);
  else process.stdout.write(`${renderMarkdown()}\n`);
}
