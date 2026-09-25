import "./_isolation.mjs";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import net from "node:net";
import { spawn } from "node:child_process";

import { writeExecutable } from "./helpers.mjs";

export function installFakeCodex(binDir, behavior = "review-ok", options = {}) {
  const statePath = path.join(binDir, "fake-codex-state.json");
  const optionsPath = path.join(binDir, "fake-codex-options.json");
  const rpcPath = path.join(binDir, "fake-codex-rpc.jsonl");
  fs.writeFileSync(optionsPath, JSON.stringify(options));
  const scriptPath = path.join(binDir, "codex");
  const source = `#!/usr/bin/env node
const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const readline = require("node:readline");

	const STATE_PATH = ${JSON.stringify(statePath)};
	const OPTIONS_PATH = ${JSON.stringify(optionsPath)};
	const RPC_PATH = ${JSON.stringify(rpcPath)};
	const BEHAVIOR = ${JSON.stringify(behavior)};
	const activeTurns = new Map();
	const completedTurns = new Map();
	const interruptibleTurns = new Map();
	const steerableTurns = new Map();
	const PROCESS_START_MS = Date.now();
	const CONN = process.pid + "-" + PROCESS_START_MS;
	let rpcId = 1;
	const requestMethods = new Map();

	function getOptions() {
	  try { return JSON.parse(fs.readFileSync(OPTIONS_PATH, "utf8")); } catch { return {}; }
	}
	function recordRpc(dir, message, requestMethod) {
	  const entry = { ts: Date.now(), conn: CONN, pid: process.pid, dir, id: message.id ?? null, method: message.method || requestMethod || (message.id !== undefined ? requestMethods.get(message.id) : null) || null, params: message.params ?? null };
	  if (message.result !== undefined) entry.result = message.result;
	  if (message.error !== undefined) entry.error = message.error;
	  fs.appendFileSync(RPC_PATH, JSON.stringify(entry) + "\\n");
	}

	function loadState() {
	  if (!fs.existsSync(STATE_PATH)) {
	    return { nextThreadId: 1, nextTurnId: 1, appServerStarts: 0, threads: [], capabilities: null, lastInterrupt: null };
	  }
	  return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
	}

function saveState(state) {
  const temp = STATE_PATH + "." + process.pid + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(state, null, 2));
  fs.renameSync(temp, STATE_PATH);
}

function requiresExperimental(field, message, state) {
  if (!(field in (message.params || {}))) {
    return false;
  }
  return !state.capabilities || state.capabilities.experimentalApi !== true;
}

function now() {
  return Math.floor(Date.now() / 1000);
}

function assignRolloutPath(thread) {
  if (!getOptions().writeRollout || thread.rolloutPath) return;
  const day = new Date().toISOString().slice(0, 10).split("-");
  const home = process.env.CODEX_HOME || path.join(path.dirname(STATE_PATH), "codex-home");
  thread.rolloutPath = path.join(home, "sessions", day[0], day[1], day[2], "rollout-" + Date.now() + "-" + thread.id + ".jsonl");
  fs.mkdirSync(path.dirname(thread.rolloutPath), { recursive: true });
  fs.writeFileSync(thread.rolloutPath, "{}\\n");
}

function buildThread(thread) {
  const active = Array.from(activeTurns.values()).find((turn) => turn.threadId === thread.id && !turn.done);
  return {
    id: thread.id,
    preview: thread.preview || "",
    ephemeral: Boolean(thread.ephemeral),
    modelProvider: "openai",
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    status: { type: active ? "active" : "idle" },
    path: thread.rolloutPath || null,
    cwd: thread.cwd,
    cliVersion: "fake-codex",
    source: "appServer",
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: thread.name || null,
    turns: active ? [{ id: active.turnId, status: "inProgress" }] : completedTurns.has(thread.id) ? [completedTurns.get(thread.id)] : []
  };
}

function buildTurn(id, status = "inProgress", error = null, items = []) {
  return { id, status, items, error };
}

function buildAccountReadResult() {
  switch (BEHAVIOR) {
    case "logged-out":
    case "refreshable-auth":
    case "auth-run-fails":
      return { account: null, requiresOpenaiAuth: true };
    case "provider-no-auth":
    case "env-key-provider":
      return { account: null, requiresOpenaiAuth: false };
    case "api-key-account-only":
      return { account: { type: "apiKey" }, requiresOpenaiAuth: true };
    default:
      return {
        account: { type: "chatgpt", email: "test@example.com", planType: "plus" },
        requiresOpenaiAuth: true
      };
  }
}

function buildConfigReadResult() {
  switch (BEHAVIOR) {
    case "provider-no-auth":
      return {
        config: { model_provider: "ollama" },
        origins: {}
      };
    case "env-key-provider":
      return {
        config: {
          model_provider: "openai-custom",
          model_providers: {
            "openai-custom": {
              name: "OpenAI custom",
              env_key: "OPENAI_API_KEY",
              requires_openai_auth: false
            }
          }
        },
        origins: {}
      };
    default:
      return {
        config: { model_provider: "openai" },
        origins: {}
      };
  }
}

function send(message) {
  if (message.id !== undefined && !message.method && !message.__delayApplied) {
    const method = requestMethods.get(message.id);
    const delayKey = { initialize: "initialize", "thread/start": "threadStart", "turn/start": "turnStart" }[method];
    const delay = delayKey ? Number(getOptions().delays?.[delayKey] || 0) : 0;
    if (delay > 0) { const delayed = { ...message, __delayApplied: true }; setTimeout(() => send(delayed), delay); return; }
  }
  if (message.__delayApplied) { const { __delayApplied, ...clean } = message; message = clean; }
  if (message.id !== undefined && message.method) requestMethods.set(message.id, message.method);
  recordRpc("out", message);
  process.stdout.write(JSON.stringify(message) + "\\n");
}

function sendResponse(request, result, error) {
  const options = getOptions();
  const delayKey = { initialize: "initialize", "thread/start": "threadStart", "turn/start": "turnStart" }[request.method];
  const delay = delayKey ? Number(options.delays?.[delayKey] || 0) : 0;
  setTimeout(() => send(error ? { id: request.id, error } : { id: request.id, result }), delay);
}

function notify(method, params) { send({ method, params }); }
function scriptedItem(method, threadId, turnId, item) { notify(method, { threadId, turnId, item }); }
function scriptTurn(threadId, turnId, cwd, payload) {
  const options = getOptions();
  const turn = { threadId, turnId, done: false, timer: null, interrupted: false };
  activeTurns.set(turnId, turn);
  interruptibleTurns.set(turnId, turn);
  notify("turn/started", { threadId, turn: buildTurn(turnId) });
  let finalMessageSent = false;
  const steps = Array.isArray(options.turnScript) ? options.turnScript : [];
  const finish = () => {
    if (turn.done) return;
    const finalItems = finalMessageSent ? [] : [{ type: "agentMessage", id: "msg_" + turnId, text: payload, phase: "final_answer" }];
    if (!finalMessageSent) scriptedItem("item/completed", threadId, turnId, finalItems[0]);
    turn.done = true;
    activeTurns.delete(turnId);
    interruptibleTurns.delete(turnId);
    const status = options.turnStatus === "failed" ? "failed" : "completed";
    const completed = buildTurn(turnId, status, null, finalItems);
    completedTurns.set(threadId, completed);
    notify("turn/completed", { threadId, turn: completed });
  };
  const runStep = (index) => {
    if (turn.done || turn.interrupted) return;
    if (index >= steps.length) { finish(); return; }
    const step = steps[index] || {};
    if (step.type === "delay") { turn.timer = setTimeout(() => runStep(index + 1), Math.max(0, Number(step.ms || 0))); return; }
    if (step.type === "silence") return;
    if (step.type === "command") {
      const id = "cmd_" + turnId + "_" + index;
      const base = { type: "commandExecution", id, command: step.command || "", cwd, status: "inProgress" };
      scriptedItem("item/started", threadId, turnId, base);
      const chunks = Array.isArray(step.outputChunks) ? step.outputChunks : (step.output ? [step.output] : []);
      let output = "";
      for (const chunk of chunks) { const delta = String(chunk); output += delta; notify("item/commandExecution/outputDelta", { threadId, turnId, itemId: id, delta }); }
      scriptedItem("item/completed", threadId, turnId, { type: "commandExecution", id, command: step.command || "", cwd, status: (step.exitCode || 0) === 0 ? "completed" : "failed", exitCode: step.exitCode || 0, aggregatedOutput: output, durationMs: step.durationMs || 0 });
    } else if (step.type === "fileChange") {
      const id = "file_" + turnId + "_" + index;
      scriptedItem("item/started", threadId, turnId, { type: "fileChange", id, changes: step.changes || [] });
      if (step.writeFiles) for (const change of step.changes || []) { const target = path.resolve(cwd, change.path); if (!target.startsWith(path.resolve(cwd) + path.sep)) continue; if (change.kind === "delete") { if (fs.existsSync(target)) fs.unlinkSync(target); } else { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, change.diff || ""); } }
      scriptedItem("item/completed", threadId, turnId, { type: "fileChange", id, changes: step.changes || [] });
    } else if (step.type === "agentMessage") { if (step.phase === "final_answer") finalMessageSent = true; scriptedItem("item/completed", threadId, turnId, { type: "agentMessage", id: "msg_" + turnId + "_" + index, text: step.text || "", phase: step.phase || "commentary" }); }
    else if (step.type === "reasoning") scriptedItem("item/completed", threadId, turnId, { type: "reasoning", id: "reasoning_" + turnId + "_" + index, summary: [{ text: step.text || "" }], content: [] });
    else if (step.type === "plan") notify("turn/plan/updated", { threadId, turnId, plan: step.steps || [] });
    else if (step.type === "diff") notify("turn/diff/updated", { threadId, turnId, diff: step.diff || "" });
    else if (step.type === "usage") notify("thread/tokenUsage/updated", { threadId, turnId, tokenUsage: { total: step.total || 0, input: step.input || 0, output: step.output || 0 } });
    else if (step.type === "serverRequest") { const id = "server_" + rpcId++; send({ id, method: step.method || "item/commandExecution/requestApproval", params: step.params || {} }); }
    runStep(index + 1);
  };
  runStep(0);
}

function nextThread(state, cwd, ephemeral) {
  const thread = {
    id: "thr_" + state.nextThreadId++,
    cwd: cwd || process.cwd(),
    name: null,
    preview: "",
    ephemeral: Boolean(ephemeral),
    createdAt: now(),
    updatedAt: now()
  };
  assignRolloutPath(thread);
  state.threads.unshift(thread);
  saveState(state);
  return thread;
}

function ensureThread(state, threadId) {
  const thread = state.threads.find((candidate) => candidate.id === threadId);
  if (!thread) {
    throw new Error("unknown thread " + threadId);
  }
  return thread;
}

function nextTurnId(state) {
  const turnId = "turn_" + state.nextTurnId++;
  saveState(state);
  return turnId;
}

function importLedgerPath() {
  return path.join(process.env.CODEX_HOME || path.join(path.dirname(STATE_PATH), "codex-home"), "external_agent_session_imports.json");
}

function loadImportLedger() {
  const ledgerPath = importLedgerPath();
  return fs.existsSync(ledgerPath) ? JSON.parse(fs.readFileSync(ledgerPath, "utf8")) : { records: [] };
}

function saveImportLedger(ledger) {
  const ledgerPath = importLedgerPath();
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));
}

function emitTurnCompleted(threadId, turnId, item) {
  activeTurns.delete(turnId);
  interruptibleTurns.delete(turnId);
  const items = Array.isArray(item) ? item : [item];
  send({ method: "turn/started", params: { threadId, turn: buildTurn(turnId) } });
  for (const entry of items) {
    if (entry && entry.started) {
      send({ method: "item/started", params: { threadId, turnId, item: entry.started } });
    }
    if (entry && entry.completed) {
      send({ method: "item/completed", params: { threadId, turnId, item: entry.completed } });
    }
  }
  const completed = buildTurn(turnId, "completed", null, items.map((entry) => entry?.completed).filter(Boolean));
  completedTurns.set(threadId, completed);
  send({ method: "turn/completed", params: { threadId, turn: completed } });
}

function emitTurnCompletedLater(threadId, turnId, item, delayMs) {
	  const active = { threadId, turnId, done: false, timer: null, interrupted: false };
	  activeTurns.set(turnId, active);
	  active.timer = setTimeout(() => {
	    emitTurnCompleted(threadId, turnId, item);
	  }, delayMs);
}

function nativeReviewText(target) {
  if (target.type === "baseBranch") {
    return "Reviewed changes against " + target.branch + ".\\nNo material issues found.";
  }
  if (target.type === "custom") {
    return "Reviewed custom target.\\nNo material issues found.";
  }
  return "Reviewed uncommitted changes.\\nNo material issues found.";
}

function structuredReviewPayload(prompt) {
  if (prompt.includes("adversarial software review")) {
    if (BEHAVIOR === "adversarial-clean") {
      return JSON.stringify({
        verdict: "approve",
        summary: "No material issues found.",
        findings: [],
        next_steps: []
      });
    }

    return JSON.stringify({
      verdict: "needs-attention",
      summary: "One adversarial concern surfaced.",
      findings: [
        {
          severity: "high",
          title: "Missing empty-state guard",
          body: "The change assumes data is always present.",
          file: "src/app.js",
          line_start: 4,
          line_end: 6,
          confidence: 0.87,
          recommendation: "Handle empty collections before indexing."
        }
      ],
      next_steps: ["Add an empty-state test."]
    });
  }

  if (BEHAVIOR === "invalid-json") {
    return "not valid json";
  }

  return JSON.stringify({
    verdict: "approve",
    summary: "No material issues found.",
    findings: [],
    next_steps: []
  });
}

function taskPayload(prompt, resume) {
  if (prompt.includes("<task>") && prompt.includes("Only review the work from the previous Claude turn.")) {
    if (BEHAVIOR === "adversarial-clean") {
      return "ALLOW: No blocking issues found in the previous turn.";
    }
    return "BLOCK: Missing empty-state guard in src/app.js:4-6.";
  }

  if (resume || prompt.includes("Continue from the current thread state") || prompt.includes("follow up")) {
    return "Resumed the prior run.\\nFollow-up prompt accepted.";
  }

  return "Handled the requested task.\\nTask prompt accepted.";
}

const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("codex-cli test");
  process.exit(0);
}
if (args[0] === "app-server" && args[1] === "--help") {
  console.log("fake app-server help");
  process.exit(0);
}
if (args[0] === "login" && args[1] === "status") {
  if (BEHAVIOR === "logged-out" || BEHAVIOR === "refreshable-auth" || BEHAVIOR === "auth-run-fails" || BEHAVIOR === "provider-no-auth" || BEHAVIOR === "env-key-provider" || BEHAVIOR === "api-key-account-only") {
    console.error("not authenticated");
    process.exit(1);
  }
  console.log("logged in");
  process.exit(0);
}
if (args[0] === "login") {
  process.exit(0);
}
if (args[0] !== "app-server") {
  process.exit(1);
}
const bootState = loadState();
bootState.appServerStarts = (bootState.appServerStarts || 0) + 1;
saveState(bootState);

const rl = readline.createInterface({ input: process.stdin });
if (getOptions().ignoreSigterm) process.on("SIGTERM", () => {});
rl.on("line", (line) => {
  if (!line.trim()) {
    return;
  }

  const message = JSON.parse(line);
  recordRpc("in", message);
  if (message.id !== undefined) requestMethods.set(message.id, message.method);
  const state = loadState();

  try {
    switch (message.method) {
      case "initialize":
        state.capabilities = message.params.capabilities || null;
        saveState(state);
        send({ id: message.id, result: { userAgent: "fake-codex-app-server" } });
        break;

      case "initialized":
        break;

      case "account/read":
        send({ id: message.id, result: buildAccountReadResult() });
        break;

      case "config/read":
        if (BEHAVIOR === "config-read-fails") {
          throw new Error("config/read failed for cwd");
        }
        send({ id: message.id, result: (() => { const base = buildConfigReadResult(); const override = getOptions().config; return override ? { ...base, ...override, config: { ...base.config, ...(override.config || {}) } } : base; })() });
        break;

      case "model/list": {
        const defaults = [{ id: "gpt-5.4", model: "gpt-5.4", displayName: "GPT 5.4", isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Low" }, { reasoningEffort: "high", description: "High" }], defaultReasoningEffort: "high" }];
        send({ id: message.id, result: { data: getOptions().models ?? defaults } });
        break;
      }

      case "thread/read": {
        const thread = ensureThread(state, message.params.threadId);
        send({ id: message.id, result: { thread: buildThread(thread) } });
        break;
      }

      case "thread/unload":
        send({ id: message.id, result: {} });
        break;

      case "thread/start": {
        if (BEHAVIOR === "auth-run-fails") {
          throw new Error("authentication expired; run codex login");
        }
        if (requiresExperimental("persistExtendedHistory", message, state) || requiresExperimental("persistFullHistory", message, state)) {
          throw new Error("thread/start.persistFullHistory requires experimentalApi capability");
        }
        const thread = nextThread(state, message.params.cwd, message.params.ephemeral);
        const startRecordState = loadState();
        startRecordState.lastThreadStart = {
          threadId: thread.id,
          cwd: message.params.cwd ?? null,
          sandbox: message.params.sandbox ?? null,
          config: message.params.config ?? null,
          model: message.params.model ?? null
        };
        saveState(startRecordState);
        send({ id: message.id, result: { thread: buildThread(thread), model: message.params.model || "gpt-5.4", modelProvider: "openai", serviceTier: null, cwd: thread.cwd, approvalPolicy: "never", sandbox: { type: "readOnly", access: { type: "fullAccess" }, networkAccess: false }, reasoningEffort: null } });
        send({ method: "thread/started", params: { thread: { id: thread.id } } });
        break;
      }

      case "thread/name/set": {
        const thread = ensureThread(state, message.params.threadId);
        thread.name = message.params.name;
        thread.updatedAt = now();
        saveState(state);
        send({ id: message.id, result: {} });
        break;
      }

      case "thread/list": {
        let threads = state.threads.slice();
        if (message.params.cwd) {
          threads = threads.filter((thread) => thread.cwd === message.params.cwd);
        }
        if (message.params.searchTerm) {
          threads = threads.filter((thread) => (thread.name || "").includes(message.params.searchTerm));
        }
        threads.sort((left, right) => right.updatedAt - left.updatedAt);
        send({ id: message.id, result: { data: threads.map(buildThread), nextCursor: null } });
        break;
      }

      case "thread/resume": {
        if (requiresExperimental("persistExtendedHistory", message, state) || requiresExperimental("persistFullHistory", message, state)) {
          throw new Error("thread/resume.persistFullHistory requires experimentalApi capability");
        }
        if (BEHAVIOR === "resume-locked" || getOptions().forceActiveWriter) {
          throw new Error("thread " + message.params.threadId + " already has an active writer");
        }
        const thread = ensureThread(state, message.params.threadId);
        thread.updatedAt = now();
        state.lastThreadResume = {
          threadId: message.params.threadId,
          sandbox: message.params.sandbox ?? null,
          config: message.params.config ?? null,
          model: message.params.model ?? null
        };
        saveState(state);
        send({ id: message.id, result: { thread: buildThread(thread), model: message.params.model || "gpt-5.4", modelProvider: "openai", serviceTier: null, cwd: thread.cwd, approvalPolicy: "never", sandbox: { type: "readOnly", access: { type: "fullAccess" }, networkAccess: false }, reasoningEffort: null } });
        break;
      }

      case "externalAgentConfig/import": {
        if (BEHAVIOR === "external-import-unsupported") {
          send({ id: message.id, error: { code: -32601, message: "Unsupported method: externalAgentConfig/import" } });
          break;
        }
        if (BEHAVIOR === "external-import-fails") {
          send({ id: message.id, result: {} });
          send({ method: "externalAgentConfig/import/completed", params: {} });
          break;
        }
        const sessions = (message.params.migrationItems || [])
          .flatMap((item) => item.details && Array.isArray(item.details.sessions) ? item.details.sessions : []);
        const session = sessions[0];
        if (!session) {
          throw new Error("missing external session migration");
        }
        const sourcePath = fs.realpathSync(session.path);
        const contents = fs.readFileSync(sourcePath, "utf8");
        const contentSha256 = crypto.createHash("sha256").update(contents).digest("hex");
        const ledger = loadImportLedger();
        let record = ledger.records.find(
          (candidate) => candidate.source_path === sourcePath && candidate.content_sha256 === contentSha256
        );
        let thread;
        if (record) {
          thread = ensureThread(state, record.imported_thread_id);
        } else {
          const records = contents.split(/\\r?\\n/).filter(Boolean).map((line) => JSON.parse(line));
          const title = records.find((entry) => entry.type === "custom-title")?.customTitle || null;
          const messages = records
            .filter((entry) => entry.type === "user" || entry.type === "assistant")
            .map((entry) => ({ role: entry.type, text: entry.message?.content || "" }));
          thread = nextThread(state, session.cwd, false);
          thread.name = title;
          thread.preview = messages.find((entry) => entry.role === "user")?.text || "";
          thread.visibleMessages = messages;
          state.lastExternalAgentImport = { sourcePath, threadId: thread.id, messages };
          record = {
            source_path: sourcePath,
            content_sha256: contentSha256,
            imported_thread_id: thread.id,
            imported_at: now(),
            source_modified_at: null
          };
          ledger.records.push(record);
          saveState(state);
          saveImportLedger(ledger);
        }
        send({ id: message.id, result: {} });
        send({ method: "externalAgentConfig/import/completed", params: {} });
        break;
      }

      case "review/start": {
        const thread = ensureThread(state, message.params.threadId);
        let reviewThread = thread;
        if (message.params.delivery === "detached") {
          reviewThread = nextThread(state, thread.cwd, true);
          send({ method: "thread/started", params: { thread: { id: reviewThread.id } } });
        }
        const turnId = nextTurnId(state);
        send({ id: message.id, result: { turn: buildTurn(turnId), reviewThreadId: reviewThread.id } });
        emitTurnCompleted(reviewThread.id, turnId, [
          {
            started: { type: "enteredReviewMode", id: turnId, review: "current changes" }
          },
          ...(BEHAVIOR === "with-reasoning"
            ? [
                {
                  completed: {
                    type: "reasoning",
                    id: "reasoning_" + turnId,
                    summary: [{ text: "Reviewed the changed files and checked the likely regression paths." }],
                    content: []
                  }
                }
              ]
            : []),
          {
            completed: { type: "exitedReviewMode", id: turnId, review: nativeReviewText(message.params.target) }
          }
        ]);
        break;
      }

	      case "turn/start": {
	        const thread = ensureThread(state, message.params.threadId);
	        const prompt = (message.params.input || [])
          .filter((item) => item.type === "text")
          .map((item) => item.text)
          .join("\\n");
        const turnId = nextTurnId(state);
        thread.updatedAt = now();
	        state.lastTurnStart = {
	          threadId: message.params.threadId,
	          turnId,
	          model: message.params.model ?? null,
	          effort: message.params.effort ?? null,
	          prompt
	        };
	        saveState(state);

	        send({ id: message.id, result: { turn: buildTurn(turnId) } });

        const payload = message.params.outputSchema && message.params.outputSchema.properties && message.params.outputSchema.properties.verdict
          ? structuredReviewPayload(prompt)
          : taskPayload(prompt, thread.name && thread.name.startsWith("Codex Companion Task") && prompt.includes("Continue from the current thread state"));

        if (Array.isArray(getOptions().turnScript)) {
          scriptTurn(thread.id, turnId, thread.cwd, payload);
          break;
        }

        if (
          BEHAVIOR === "with-subagent" ||
          BEHAVIOR === "with-late-subagent-message" ||
          BEHAVIOR === "with-subagent-no-main-turn-completed"
        ) {
          const subThread = nextThread(state, thread.cwd, true);
          const subThreadRecord = ensureThread(state, subThread.id);
          subThreadRecord.name = "design-challenger";
          saveState(state);
          const subTurnId = nextTurnId(state);
          const subagentNotifyDelay = Math.max(100, Number(getOptions().delays?.turnStart || 0) + 25);
          setTimeout(() => {
          send({ method: "thread/started", params: { thread: { ...buildThread(subThreadRecord), name: "design-challenger", agentNickname: "design-challenger" } } });
          send({ method: "turn/started", params: { threadId: thread.id, turn: buildTurn(turnId) } });
          send({
            method: "item/started",
            params: {
              threadId: thread.id,
              turnId,
              item: {
                type: "collabAgentToolCall",
                id: "collab_" + turnId,
                tool: "wait",
                status: "inProgress",
                senderThreadId: thread.id,
                receiverThreadIds: [subThread.id],
                prompt: "Challenge the implementation approach",
                model: null,
                reasoningEffort: null,
                agentsStates: {
                  [subThread.id]: { status: "inProgress", message: "Investigating design tradeoffs" }
                }
              }
            }
          });
          if (BEHAVIOR === "with-late-subagent-message") {
            send({
              method: "item/completed",
              params: {
                threadId: thread.id,
                turnId,
                item: { type: "agentMessage", id: "msg_" + turnId, text: payload, phase: "final_answer" }
              }
            });
          }
          send({ method: "turn/started", params: { threadId: subThread.id, turn: buildTurn(subTurnId) } });
          send({
            method: "item/completed",
            params: {
              threadId: subThread.id,
              turnId: subTurnId,
              item: {
                type: "reasoning",
                id: "reasoning_" + subTurnId,
                summary: [{ text: "Questioned the retry strategy and the cache invalidation boundaries." }],
                content: []
              }
            }
          });
          send({
            method: "item/completed",
            params: {
              threadId: subThread.id,
              turnId: subTurnId,
              item: {
                type: "agentMessage",
                id: "msg_" + subTurnId,
                text: "The design assumes retries are harmless, but they can duplicate side effects without stronger idempotency guarantees.",
                phase: "analysis"
              }
            }
          });
          send({ method: "turn/completed", params: { threadId: subThread.id, turn: buildTurn(subTurnId, "completed") } });
          send({
            method: "item/completed",
            params: {
              threadId: thread.id,
              turnId,
              item: {
                type: "collabAgentToolCall",
                id: "collab_" + turnId,
                tool: "wait",
                status: "completed",
                senderThreadId: thread.id,
                receiverThreadIds: [subThread.id],
                prompt: "Challenge the implementation approach",
                model: null,
                reasoningEffort: null,
                agentsStates: {
                  [subThread.id]: { status: "completed", message: "Finished" }
                }
              }
            }
          });
          if (BEHAVIOR !== "with-late-subagent-message") {
            send({
              method: "item/completed",
              params: {
                threadId: thread.id,
                turnId,
                item: { type: "agentMessage", id: "msg_" + turnId, text: payload, phase: "final_answer" }
              }
            });
          }
          if (BEHAVIOR !== "with-subagent-no-main-turn-completed") {
            send({ method: "turn/completed", params: { threadId: thread.id, turn: buildTurn(turnId, "completed") } });
          }
          }, subagentNotifyDelay);
          break;
        }

        const items = [
          ...(BEHAVIOR === "with-reasoning"
            ? [
                {
                  completed: {
                    type: "reasoning",
                    id: "reasoning_" + turnId,
                    summary: [{ text: "Inspected the prompt, gathered evidence, and checked the highest-risk paths first." }],
                    content: []
                  }
              }
            ]
            : []),
          {
            completed: { type: "agentMessage", id: "msg_" + turnId, text: payload, phase: "final_answer" }
          }
        ];

	        if (BEHAVIOR === "steer-rejected") {
	          emitTurnCompletedLater(thread.id, turnId, items, 2000);
	        } else if (BEHAVIOR === "steer-hang") {
	          emitTurnCompletedLater(thread.id, turnId, items, 1500);
	        } else if (BEHAVIOR === "steerable-task" || BEHAVIOR === "steer-flaky") {
	          send({ method: "turn/started", params: { threadId: thread.id, turn: buildTurn(turnId) } });
	          const timer = setTimeout(() => {
	            if (!steerableTurns.has(turnId)) {
	              return;
	            }
	            steerableTurns.delete(turnId);
	            send({ method: "item/completed", params: { threadId: thread.id, turnId, item: { type: "agentMessage", id: "msg_" + turnId, text: "Finished without steering.", phase: "final_answer" } } });
	            send({ method: "turn/completed", params: { threadId: thread.id, turn: buildTurn(turnId, "completed") } });
	          }, 8000);
	          steerableTurns.set(turnId, { threadId: thread.id, timer });
	        } else if (BEHAVIOR === "interruptible-slow-task") {
	          send({ method: "turn/started", params: { threadId: thread.id, turn: buildTurn(turnId) } });
	          const timer = setTimeout(() => {
	            if (!interruptibleTurns.has(turnId)) {
	              return;
	            }
	            interruptibleTurns.delete(turnId);
	            activeTurns.delete(turnId);
	            for (const entry of items) {
	              if (entry && entry.completed) {
	                send({ method: "item/completed", params: { threadId: thread.id, turnId, item: entry.completed } });
	              }
	            }
	            send({ method: "turn/completed", params: { threadId: thread.id, turn: buildTurn(turnId, "completed") } });
	          }, 5000);
	          const active = { threadId: thread.id, turnId, timer, done: false };
	          activeTurns.set(turnId, active);
	          interruptibleTurns.set(turnId, active);
	        } else if (BEHAVIOR === "slow-task") {
	          const active = { threadId: thread.id, turnId, timer: null, done: false };
	          activeTurns.set(turnId, active);
	          if (Object.prototype.hasOwnProperty.call(getOptions(), "interrupt")) interruptibleTurns.set(turnId, active);
	          active.timer = setTimeout(() => emitTurnCompleted(thread.id, turnId, items), 400);
	        } else {
	          emitTurnCompleted(thread.id, turnId, items);
	        }
	        break;
	      }

	      case "thread/fork": {
	        const source = ensureThread(state, message.params.threadId);
	        const forked = nextThread(state, message.params.cwd || source.cwd, message.params.ephemeral);
	        const forkState = loadState();
	        const forkedRecord = ensureThread(forkState, forked.id);
	        forkedRecord.name = source.name || null;
	        forkState.lastThreadFork = {
	          sourceThreadId: message.params.threadId,
	          threadId: forked.id,
	          sandbox: message.params.sandbox ?? null
	        };
	        saveState(forkState);
	        send({ id: message.id, result: { thread: buildThread(forkedRecord), model: message.params.model || "gpt-5.4", modelProvider: "openai", serviceTier: null, cwd: forkedRecord.cwd, approvalPolicy: "never", sandbox: { type: "readOnly", access: { type: "fullAccess" }, networkAccess: false }, reasoningEffort: null } });
	        break;
	      }

	      case "turn/steer": {
	        if (BEHAVIOR === "steer-hang") {
	          state.steerAttempts = (state.steerAttempts || 0) + 1;
	          saveState(state);
	          break;
	        }
	        const steerText = (message.params.input || [])
	          .filter((item) => item.type === "text")
	          .map((item) => item.text)
	          .join("\\n");
	        state.steerAttempts = (state.steerAttempts || 0) + 1;
	        if (BEHAVIOR === "steer-rejected" || (BEHAVIOR === "steer-flaky" && state.steerAttempts === 1)) {
	          saveState(state);
	          send({ id: message.id, error: { code: -32000, message: "transient steer failure" } });
	          break;
	        }
	        state.steers = [...(state.steers || []), { threadId: message.params.threadId, expectedTurnId: message.params.expectedTurnId, text: steerText }];
	        saveState(state);
	        const pendingSteer = steerableTurns.get(message.params.expectedTurnId);
	        if (!pendingSteer) {
	          send({ id: message.id, error: { code: -32000, message: "no active turn " + message.params.expectedTurnId } });
	          break;
	        }
	        send({ id: message.id, result: { turnId: message.params.expectedTurnId } });
	        clearTimeout(pendingSteer.timer);
	        steerableTurns.delete(message.params.expectedTurnId);
	        setTimeout(() => {
	          send({ method: "item/completed", params: { threadId: pendingSteer.threadId, turnId: message.params.expectedTurnId, item: { type: "agentMessage", id: "msg_" + message.params.expectedTurnId, text: "Steered: " + steerText, phase: "final_answer" } } });
	          send({ method: "turn/completed", params: { threadId: pendingSteer.threadId, turn: buildTurn(message.params.expectedTurnId, "completed") } });
	        }, 300);
	        break;
	      }

	      case "turn/interrupt": {
	        state.lastInterrupt = {
	          threadId: message.params.threadId,
	          turnId: message.params.turnId
	        };
	        saveState(state);
	        const pending = interruptibleTurns.get(message.params.turnId);
        const interruptMode = getOptions().interrupt || "cooperate";
        if (pending && interruptMode === "ignore") break;
        if (pending && interruptMode === "cooperate") {
          pending.interrupted = true;
          pending.done = true;
          if (pending.timer) clearTimeout(pending.timer);
          activeTurns.delete(message.params.turnId);
          interruptibleTurns.delete(message.params.turnId);
          send({ method: "turn/completed", params: { threadId: pending.threadId, turn: buildTurn(message.params.turnId, "interrupted") } });
        }
        if (pending) {
          if (interruptMode === "ack-only") { send({ id: message.id, result: {} }); break; }
        }
        send({ id: message.id, result: {} });
	        break;
	      }

	      default:
	        send({ id: message.id, error: { code: -32601, message: "Unsupported method: " + message.method } });
        break;
    }
  } catch (error) {
    send({ id: message.id, error: { code: -32000, message: error.message } });
  }
});
`;
  writeExecutable(scriptPath, source);

  // On Windows, npm global binaries are invoked via .cmd wrappers.
  // Create a codex.cmd so the fake binary is discoverable by spawn with shell: true.
  if (process.platform === "win32") {
    const cmdWrapper = `@echo off\r\nnode "%~dp0codex" %*\r\n`;
    fs.writeFileSync(path.join(binDir, "codex.cmd"), cmdWrapper, { encoding: "utf8" });
  }
}

export function buildEnv(binDir) {
  const sep = process.platform === "win32" ? ";" : ":";
  return {
    ...process.env,
    PATH: `${binDir}${sep}${process.env.PATH}`
  };
}

export function setFakeCodexOptions(binDir, patch) {
  const file = path.join(binDir, "fake-codex-options.json");
  const current = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  const next = { ...current, ...patch };
  fs.writeFileSync(file, JSON.stringify(next));
  return next;
}

export function readFakeRpcLog(binDir, { method, conn, dir } = {}) {
  const file = path.join(binDir, "fake-codex-rpc.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
    .filter((entry) => (method === undefined || entry.method === method) && (conn === undefined || entry.conn === conn) && (dir === undefined || entry.dir === dir));
}

export function fakeConnections(binDir) {
  return [...new Set(readFakeRpcLog(binDir).map((entry) => entry.conn))];
}

export function startFakeAppServer(binDir, { env = buildEnv(binDir) } = {}) {
  const child = spawn(process.execPath, [path.join(binDir, "codex"), "app-server"], { env, stdio: ["pipe", "pipe", "pipe"] });
  let buffer = "";
  const pending = new Map();
  const notifications = [];
  const waiters = [];
  let nextId = 1;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const index = buffer.indexOf("\n");
      if (index < 0) break;
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (message.id !== undefined && pending.has(message.id)) { const entry = pending.get(message.id); pending.delete(message.id); message.error ? entry.reject(Object.assign(new Error(message.error.message), { code: message.error.code })) : entry.resolve(message.result); }
      else { notifications.push(message); for (const waiter of [...waiters]) { if (waiter.method === message.method && (!waiter.predicate || waiter.predicate(message.params))) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(message.params); } } }
    }
  });
  child.stdin.write(JSON.stringify({ id: nextId++, method: "initialize", params: { capabilities: { experimentalApi: true } } }) + "\n");
  const request = (method, params = {}) => new Promise((resolve, reject) => { const id = nextId++; pending.set(id, { resolve, reject }); child.stdin.write(JSON.stringify({ id, method, params }) + "\n"); });
  const waitForNotification = (method, predicate = () => true, timeoutMs = 1000) => {
    const found = notifications.find((message) => message.method === method && predicate(message.params));
    if (found) return Promise.resolve(found.params);
    return new Promise((resolve, reject) => { const waiter = { method, predicate, resolve: (value) => { clearTimeout(timer); resolve(value); } }; const timer = setTimeout(() => { const index = waiters.indexOf(waiter); if (index >= 0) waiters.splice(index, 1); reject(new Error("Timed out waiting for " + method)); }, timeoutMs); waiters.push(waiter); });
  };
  return { child, request, notifications, waitForNotification, close: () => new Promise((resolve) => { if (child.exitCode !== null || child.signalCode !== null) return resolve(); child.once("exit", resolve); child.kill("SIGKILL"); }) };
}

export async function occupyBroker(endpoint, { holdMs = 500 } = {}) {
  if (!endpoint.startsWith("unix:")) throw new Error("occupyBroker currently supports unix broker endpoints");
  const socketPath = endpoint.slice("unix:".length);
  const socket = net.createConnection(socketPath);
  await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  let buffer = "";
  const pending = new Map();
  const settle = (requestId, error, result) => {
    const entry = pending.get(requestId);
    if (!entry) return;
    pending.delete(requestId);
    clearTimeout(entry.timer);
    error ? entry.reject(error) : entry.resolve(result);
  };
  const rejectPending = (error) => { for (const requestId of pending.keys()) settle(requestId, error); };
  // The connect-time one-shot handler only rejects the connect promise. Keep
  // handling errors after connect too, and reject any request using this socket.
  socket.on("error", rejectPending);
  socket.once("close", () => rejectPending(new Error("broker socket closed")));
  socket.setEncoding("utf8"); socket.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const index = buffer.indexOf("\n");
      if (index < 0) break;
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.id === undefined || !pending.has(message.id)) continue;
      const error = message.error ? Object.assign(new Error(message.error.message), { code: message.error.code }) : null;
      settle(message.id, error, message.result);
    }
  });
  let id = 1;
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const requestId = id++;
    const timer = setTimeout(() => settle(requestId, new Error("broker request timed out: " + method)), 5000);
    pending.set(requestId, { resolve, reject, timer });
    try {
      socket.write(JSON.stringify({ id: requestId, method, params }) + "\n", (error) => { if (error) settle(requestId, error); });
    } catch (error) { settle(requestId, error); }
  });
  await request("initialize", { capabilities: { experimentalApi: true } });
  const thread = await request("thread/start", { cwd: process.cwd(), ephemeral: true });
  // This helper holds the broker stream while its startup turn remains delayed.
  // A companion broker forwards to the fake app-server configured for the test.
  const result = { release: () => { rejectPending(new Error("broker socket released")); socket.destroy(); } };
  result.turn = request("turn/start", { threadId: thread.thread.id, input: [{ type: "text", text: "occupy broker" }] }).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, holdMs));
  return result;
}
