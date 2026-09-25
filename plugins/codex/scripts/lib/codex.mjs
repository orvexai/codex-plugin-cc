/**
 * @typedef {import("./app-server-protocol").AppServerNotification} AppServerNotification
 * @typedef {import("./app-server-protocol").ReviewTarget} ReviewTarget
 * @typedef {import("./app-server-protocol").ThreadItem} ThreadItem
 * @typedef {import("./app-server-protocol").ThreadResumeParams} ThreadResumeParams
 * @typedef {import("./app-server-protocol").ThreadStartParams} ThreadStartParams
 * @typedef {import("./app-server-protocol").Turn} Turn
 * @typedef {import("./app-server-protocol").UserInput} UserInput
 * @typedef {((update: string | { message: string, phase: string | null, threadId?: string | null, turnId?: string | null, stderrMessage?: string | null, logTitle?: string | null, logBody?: string | null }) => void)} ProgressReporter
 * @typedef {{
 *   threadId: string,
 *   rootThreadId: string,
 *   threadIds: Set<string>,
 *   threadTurnIds: Map<string, string>,
 *   threadLabels: Map<string, string>,
 *   turnId: string | null,
 *   bufferedNotifications: AppServerNotification[],
 *   completion: Promise<TurnCaptureState>,
 *   resolveCompletion: (state: TurnCaptureState) => void,
 *   rejectCompletion: (error: unknown) => void,
 *   finalTurn: Turn | null,
 *   completed: boolean,
 *   finalAnswerSeen: boolean,
 *   pendingCollaborations: Set<string>,
 *   activeSubagentTurns: Set<string>,
 *   completionTimer: ReturnType<typeof setTimeout> | null,
 *   lastAgentMessage: string,
 *   reviewText: string,
 *   reasoningSummary: string[],
 *   error: unknown,
 *   messages: Array<{ lifecycle: string, phase: string | null, text: string }>,
 *   fileChanges: ThreadItem[],
 *   commandExecutions: ThreadItem[],
 *   onProgress: ProgressReporter | null
 * }} TurnCaptureState
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readJsonFile } from "./fs.mjs";
import { BROKER_BUSY_RPC_CODE, BROKER_ENDPOINT_ENV, CodexAppServerClient } from "./app-server.mjs";
import { loadBrokerSession } from "./broker-lifecycle.mjs";
import { readJobFile, resolveJobFile } from "./state.mjs";
import { binaryAvailable, readProcessStartTime } from "./process.mjs";
import { ackControlOp, appendControlOp, readControlAck, readControlOps } from "./control-channel.mjs";
import { assessOwner } from "./job-liveness.mjs";

const SERVICE_NAME = "claude_code_codex_plugin";
const TASK_THREAD_PREFIX = "Codex Companion Task";
const DEFAULT_CONTINUE_PROMPT =
  "Continue from the current thread state. Pick the next highest-value step and follow through until the task is resolved.";
const EXTERNAL_AGENT_IMPORT_COMPLETED = "externalAgentConfig/import/completed";
const EXTERNAL_AGENT_IMPORT_TIMEOUT_MS = 2 * 60 * 1000;

function cleanCodexStderr(stderr) {
  return stderr
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line && !line.startsWith("WARNING: proceeding, even though we could not update PATH:"))
    .join("\n");
}

/** @returns {ThreadStartParams} */
function buildThreadParams(cwd, options = {}) {
  return {
    cwd,
    model: options.model ?? null,
    approvalPolicy: options.approvalPolicy ?? "never",
    sandbox: options.sandbox ?? "read-only",
    ...(options.config ? { config: options.config } : {}),
    serviceName: SERVICE_NAME,
    ephemeral: options.ephemeral ?? true
  };
}

/** @returns {ThreadResumeParams} */
function buildResumeParams(threadId, cwd, options = {}) {
  return {
    threadId,
    cwd,
    model: options.model ?? null,
    approvalPolicy: options.approvalPolicy ?? "never",
    sandbox: options.sandbox ?? "read-only",
    ...(options.config ? { config: options.config } : {})
  };
}

// Reads the complete lines appended to a job inbox after `offset` (in
// characters). Each entry carries the offset just past its line, so a reader
// only moves past a message once it has been handled.
function readInboxEntries(inboxFile, offset) {
  let contents;
  try {
    contents = fs.readFileSync(inboxFile, "utf8");
  } catch {
    return [];
  }
  const entries = [];
  let cursor = offset;
  for (;;) {
    const newline = contents.indexOf("\n", cursor);
    if (newline === -1) {
      break;
    }
    const line = contents.slice(cursor, newline);
    cursor = newline + 1;
    let message = null;
    try {
      message = JSON.parse(line);
    } catch {
      message = null;
    }
    const valid = message && typeof message.text === "string" && message.text.trim();
    entries.push({ message: valid ? message : null, end: cursor });
  }
  return entries;
}

const MAX_STEER_ATTEMPTS = 3;
const STEER_REQUEST_TIMEOUT_MS = 30000;
const STEER_STOP_GRACE_MS = 5000;

export function resolveClosedInboxFile(inboxFile) {
  return `${inboxFile}.closed`;
}

function withTimeout(promise, timeoutMs, message) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Closes the inbox by renaming it: a `send` that appends afterwards writes a
// fresh file nobody reads, and can tell from the closed file that it missed.
function closeInbox(inboxFile) {
  const closedFile = resolveClosedInboxFile(inboxFile);
  try {
    fs.renameSync(inboxFile, closedFile);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
    fs.writeFileSync(closedFile, "", "utf8");
  }
  return closedFile;
}

// Delivers messages that `send` appends to the job inbox into the active turn.
// A message is only consumed once Codex accepts it; failures are retried in
// order, and stop() reports every message the turn never received.
function startInboxSteering(client, threadId, turnId, options = {}) {
  if (!options.inboxFile || !turnId) {
    return { stop: async () => [] };
  }
  let offset = 0;
  let inFlight = null;
  let stopped = false;
  const attempts = new Map();
  const abandoned = [];

  const tick = async () => {
    for (const entry of readInboxEntries(options.inboxFile, offset)) {
      if (stopped) {
        return;
      }
      if (!entry.message) {
        offset = entry.end;
        continue;
      }
      const message = entry.message;
      const label = message.id ? `message ${message.id}` : "message";
      try {
        await withTimeout(
          client.request("turn/steer", {
            threadId,
            expectedTurnId: turnId,
            input: buildTurnInput(message.text)
          }),
          options.steerTimeoutMs ?? STEER_REQUEST_TIMEOUT_MS,
          "turn/steer did not answer in time"
        );
        offset = entry.end;
        emitProgress(options.onProgress, `Delivered ${label} to the running turn.`, null, { threadId, turnId });
        options.onSteered?.(message);
      } catch (error) {
        const count = (attempts.get(entry.end) ?? 0) + 1;
        attempts.set(entry.end, count);
        const detail = error?.message ?? String(error);
        emitProgress(
          options.onProgress,
          `Could not deliver ${label} to the running turn (attempt ${count}/${MAX_STEER_ATTEMPTS}): ${detail}`,
          null
        );
        if (count < MAX_STEER_ATTEMPTS) {
          return;
        }
        abandoned.push({ ...message, error: detail });
        offset = entry.end;
      }
    }
  };

  const schedule = () => {
    if (inFlight || stopped) {
      return;
    }
    inFlight = tick()
      .catch(() => {})
      .finally(() => {
        inFlight = null;
      });
  };
  const timer = setInterval(schedule, options.inboxPollMs ?? 500);
  schedule();

  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      if (inFlight) {
        // Never let a stalled steer keep a finished turn from completing.
        await Promise.race([inFlight, new Promise((resolve) => setTimeout(resolve, STEER_STOP_GRACE_MS))]);
      }
      const closedFile = closeInbox(options.inboxFile);
      const pending = readInboxEntries(closedFile, offset)
        .map((entry) => entry.message)
        .filter(Boolean);
      return [...abandoned, ...pending];
    }
  };
}

/** @returns {UserInput[]} */
function buildTurnInput(prompt) {
  return [{ type: "text", text: prompt, text_elements: [] }];
}

function shorten(text, limit = 72) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function looksLikeVerificationCommand(command) {
  return /\b(test|tests|lint|build|typecheck|type-check|check|verify|validate|pytest|jest|vitest|cargo test|npm test|pnpm test|yarn test|go test|mvn test|gradle test|tsc|eslint|ruff)\b/i.test(
    command
  );
}

function buildTaskThreadName(prompt) {
  const excerpt = shorten(prompt, 56);
  return excerpt ? `${TASK_THREAD_PREFIX}: ${excerpt}` : TASK_THREAD_PREFIX;
}

function extractThreadId(message) {
  return message?.params?.threadId ?? null;
}

function extractTurnId(message) {
  if (message?.params?.turnId) {
    return message.params.turnId;
  }
  if (message?.params?.turn?.id) {
    return message.params.turn.id;
  }
  return null;
}

function collectTouchedFiles(fileChanges) {
  const paths = new Set();
  for (const fileChange of fileChanges) {
    for (const change of fileChange.changes ?? []) {
      if (change.path) {
        paths.add(change.path);
      }
    }
  }
  return [...paths];
}

function normalizeReasoningText(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

function extractReasoningSections(value) {
  if (!value) {
    return [];
  }

  if (typeof value === "string") {
    const normalized = normalizeReasoningText(value);
    return normalized ? [normalized] : [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry) => extractReasoningSections(entry));
  }

  if (typeof value === "object") {
    if (typeof value.text === "string") {
      return extractReasoningSections(value.text);
    }
    if ("summary" in value) {
      return extractReasoningSections(value.summary);
    }
    if ("content" in value) {
      return extractReasoningSections(value.content);
    }
    if ("parts" in value) {
      return extractReasoningSections(value.parts);
    }
  }

  return [];
}

function mergeReasoningSections(existingSections, nextSections) {
  const merged = [];
  for (const section of [...existingSections, ...nextSections]) {
    const normalized = normalizeReasoningText(section);
    if (!normalized || merged.includes(normalized)) {
      continue;
    }
    merged.push(normalized);
  }
  return merged;
}

/**
 * @param {ProgressReporter | null | undefined} onProgress
 * @param {string | null | undefined} message
 * @param {string | null | undefined} [phase]
 */
function emitProgress(onProgress, message, phase = null, extra = {}) {
  if (!onProgress || !message) {
    return;
  }
  if (!phase && Object.keys(extra).length === 0) {
    onProgress(message);
    return;
  }
  onProgress({ message, phase, ...extra });
}

function emitLogEvent(onProgress, options = {}) {
  if (!onProgress) {
    return;
  }

  onProgress({
    message: options.message ?? "",
    phase: options.phase ?? null,
    stderrMessage: options.stderrMessage ?? null,
    logTitle: options.logTitle ?? null,
    logBody: options.logBody ?? null
  });
}

function labelForThread(state, threadId) {
  if (!threadId || threadId === state.rootThreadId || threadId === state.threadId) {
    return null;
  }
  return state.threadLabels.get(threadId) ?? threadId;
}

function registerThread(state, threadId, options = {}) {
  if (!threadId) {
    return;
  }

  state.threadIds.add(threadId);
  const label =
    options.threadName ??
    options.name ??
    options.agentNickname ??
    options.agentRole ??
    state.threadLabels.get(threadId) ??
    null;
  if (label) {
    state.threadLabels.set(threadId, label);
  }
}

function describeStartedItem(state, item) {
  switch (item.type) {
    case "enteredReviewMode":
      return { message: `Reviewer started: ${item.review}`, phase: "reviewing" };
    case "commandExecution":
      return {
        message: `Running command: ${shorten(item.command, 96)}`,
        phase: looksLikeVerificationCommand(item.command) ? "verifying" : "running"
      };
    case "fileChange":
      return { message: `Applying ${item.changes.length} file change(s).`, phase: "editing" };
    case "mcpToolCall":
      return { message: `Calling ${item.server}/${item.tool}.`, phase: "investigating" };
    case "dynamicToolCall":
      return { message: `Running tool: ${item.tool}.`, phase: "investigating" };
    case "collabAgentToolCall": {
      const subagents = (item.receiverThreadIds ?? []).map((threadId) => labelForThread(state, threadId) ?? threadId);
      const summary =
        subagents.length > 0
          ? `Starting subagent ${subagents.join(", ")} via collaboration tool: ${item.tool}.`
          : `Starting collaboration tool: ${item.tool}.`;
      return { message: summary, phase: "investigating" };
    }
    case "webSearch":
      return { message: `Searching: ${shorten(item.query, 96)}`, phase: "investigating" };
    default:
      return null;
  }
}

function describeCompletedItem(state, item) {
  switch (item.type) {
    case "commandExecution": {
      const exitCode = item.exitCode ?? "?";
      const statusLabel = item.status === "completed" ? "completed" : item.status;
      return {
        message: `Command ${statusLabel}: ${shorten(item.command, 96)} (exit ${exitCode})`,
        phase: looksLikeVerificationCommand(item.command) ? "verifying" : "running"
      };
    }
    case "fileChange":
      return { message: `File changes ${item.status}.`, phase: "editing" };
    case "mcpToolCall":
      return { message: `Tool ${item.server}/${item.tool} ${item.status}.`, phase: "investigating" };
    case "dynamicToolCall":
      return { message: `Tool ${item.tool} ${item.status}.`, phase: "investigating" };
    case "collabAgentToolCall": {
      const subagents = (item.receiverThreadIds ?? []).map((threadId) => labelForThread(state, threadId) ?? threadId);
      const summary =
        subagents.length > 0
          ? `Subagent ${subagents.join(", ")} ${item.status}.`
          : `Collaboration tool ${item.tool} ${item.status}.`;
      return { message: summary, phase: "investigating" };
    }
    case "exitedReviewMode":
      return { message: "Reviewer finished.", phase: "finalizing" };
    default:
      return null;
  }
}

/** @returns {TurnCaptureState} */
function createTurnCaptureState(threadId, options = {}) {
  let resolveCompletion;
  let rejectCompletion;
  const completion = new Promise((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });

  return {
    threadId,
    rootThreadId: threadId,
    threadIds: new Set([threadId]),
    threadTurnIds: new Map(),
    threadLabels: new Map(),
    turnId: null,
    bufferedNotifications: [],
    completion,
    resolveCompletion,
    rejectCompletion,
    finalTurn: null,
    completed: false,
    finalAnswerSeen: false,
    pendingCollaborations: new Set(),
    activeSubagentTurns: new Set(),
    completionTimer: null,
    lastAgentMessage: "",
    reviewText: "",
    reasoningSummary: [],
    error: null,
    messages: [],
    fileChanges: [],
    commandExecutions: [],
    onProgress: options.onProgress ?? null
  };
}

function clearCompletionTimer(state) {
  if (state.completionTimer) {
    clearTimeout(state.completionTimer);
    state.completionTimer = null;
  }
}

function completeTurn(state, turn = null, options = {}) {
  if (state.completed) {
    return;
  }

  clearCompletionTimer(state);
  state.completed = true;

  if (turn) {
    state.finalTurn = turn;
    if (!state.turnId) {
      state.turnId = turn.id;
    }
  } else if (!state.finalTurn) {
    state.finalTurn = {
      id: state.turnId ?? "inferred-turn",
      status: "completed"
    };
  }

  if (options.inferred) {
    emitProgress(state.onProgress, "Turn completion inferred after the main thread finished and subagent work drained.", "finalizing");
  }

  state.resolveCompletion(state);
}

function scheduleInferredCompletion(state) {
  if (state.completed || state.finalTurn || !state.finalAnswerSeen) {
    return;
  }

  if (state.pendingCollaborations.size > 0 || state.activeSubagentTurns.size > 0) {
    return;
  }

  clearCompletionTimer(state);
  state.completionTimer = setTimeout(() => {
    state.completionTimer = null;
    if (state.completed || state.finalTurn || !state.finalAnswerSeen) {
      return;
    }
    if (state.pendingCollaborations.size > 0 || state.activeSubagentTurns.size > 0) {
      return;
    }
    completeTurn(state, null, { inferred: true });
  }, 250);
  state.completionTimer.unref?.();
}

function belongsToTurn(state, message) {
  const messageThreadId = extractThreadId(message);
  if (!messageThreadId || !state.threadIds.has(messageThreadId)) {
    return false;
  }
  const trackedTurnId = state.threadTurnIds.get(messageThreadId) ?? null;
  const messageTurnId = extractTurnId(message);
  return trackedTurnId === null || messageTurnId === null || messageTurnId === trackedTurnId;
}

function recordItem(state, item, lifecycle, threadId = null) {
  if (item.type === "collabAgentToolCall") {
    if (!threadId || threadId === state.threadId) {
      if (lifecycle === "started" || item.status === "inProgress") {
        state.pendingCollaborations.add(item.id);
      } else if (lifecycle === "completed") {
        state.pendingCollaborations.delete(item.id);
        scheduleInferredCompletion(state);
      }
    }
    for (const receiverThreadId of item.receiverThreadIds ?? []) {
      registerThread(state, receiverThreadId);
    }
  }

  if (item.type === "agentMessage") {
    state.messages.push({
      lifecycle,
      phase: item.phase ?? null,
      text: item.text ?? ""
    });
    if (item.text) {
      if (!threadId || threadId === state.threadId) {
        state.lastAgentMessage = item.text;
        if (lifecycle === "completed" && item.phase === "final_answer") {
          state.finalAnswerSeen = true;
          scheduleInferredCompletion(state);
        }
      }
      if (lifecycle === "completed") {
        const sourceLabel = labelForThread(state, threadId);
        emitLogEvent(state.onProgress, {
          message: sourceLabel ? `Subagent ${sourceLabel}: ${shorten(item.text, 96)}` : `Assistant message captured: ${shorten(item.text, 96)}`,
          stderrMessage: null,
          phase: item.phase === "final_answer" ? "finalizing" : null,
          logTitle: sourceLabel ? `Subagent ${sourceLabel} message` : "Assistant message",
          logBody: item.text
        });
      }
    }
    return;
  }

  if (item.type === "exitedReviewMode") {
    state.reviewText = item.review ?? "";
    if (lifecycle === "completed" && item.review) {
      emitLogEvent(state.onProgress, {
        message: "Review output captured.",
        stderrMessage: null,
        phase: "finalizing",
        logTitle: "Review output",
        logBody: item.review
      });
    }
    return;
  }

  if (item.type === "reasoning" && lifecycle === "completed") {
    const nextSections = extractReasoningSections(item.summary);
    state.reasoningSummary = mergeReasoningSections(state.reasoningSummary, nextSections);
    if (nextSections.length > 0) {
      const sourceLabel = labelForThread(state, threadId);
      emitLogEvent(state.onProgress, {
        message: sourceLabel
          ? `Subagent ${sourceLabel} reasoning: ${shorten(nextSections[0], 96)}`
          : `Reasoning summary captured: ${shorten(nextSections[0], 96)}`,
        stderrMessage: null,
        logTitle: sourceLabel ? `Subagent ${sourceLabel} reasoning summary` : "Reasoning summary",
        logBody: nextSections.map((section) => `- ${section}`).join("\n")
      });
    }
    return;
  }

  if (item.type === "fileChange" && lifecycle === "completed") {
    state.fileChanges.push(item);
    return;
  }

  if (item.type === "commandExecution" && lifecycle === "completed") {
    state.commandExecutions.push(item);
  }
}

function applyTurnNotification(state, message) {
  switch (message.method) {
    case "thread/started":
      registerThread(state, message.params.thread.id, {
        threadName: message.params.thread.name,
        name: message.params.thread.name,
        agentNickname: message.params.thread.agentNickname,
        agentRole: message.params.thread.agentRole
      });
      break;
    case "thread/name/updated":
      registerThread(state, message.params.threadId, {
        threadName: message.params.threadName ?? null
      });
      break;
    case "turn/started":
      registerThread(state, message.params.threadId);
      state.threadTurnIds.set(message.params.threadId, message.params.turn.id);
      if ((message.params.threadId ?? null) !== state.threadId) {
        state.activeSubagentTurns.add(message.params.threadId);
      }
      emitProgress(
        state.onProgress,
        `Turn started (${message.params.turn.id}).`,
        "starting",
        (message.params.threadId ?? null) === state.threadId
          ? {
              threadId: message.params.threadId ?? null,
              turnId: message.params.turn.id ?? null
            }
          : {}
      );
      break;
    case "item/started":
      recordItem(state, message.params.item, "started", message.params.threadId ?? null);
      {
        const update = describeStartedItem(state, message.params.item);
        emitProgress(state.onProgress, update?.message, update?.phase ?? null);
      }
      break;
    case "item/completed":
      recordItem(state, message.params.item, "completed", message.params.threadId ?? null);
      {
        const update = describeCompletedItem(state, message.params.item);
        emitProgress(state.onProgress, update?.message, update?.phase ?? null);
      }
      break;
    case "error":
      state.error = message.params.error;
      emitProgress(state.onProgress, `Codex error: ${message.params.error.message}`, "failed");
      break;
    case "turn/completed":
      if ((message.params.threadId ?? null) !== state.threadId) {
        state.activeSubagentTurns.delete(message.params.threadId);
        scheduleInferredCompletion(state);
        break;
      }
      emitProgress(
        state.onProgress,
        `Turn ${message.params.turn.status === "completed" ? "completed" : message.params.turn.status}.`,
        "finalizing"
      );
      completeTurn(state, message.params.turn);
      break;
    default:
      break;
  }
}

async function captureTurn(client, threadId, startRequest, options = {}) {
  const state = createTurnCaptureState(threadId, options);
  const previousHandler = client.notificationHandler;

  client.setNotificationHandler((message) => {
    if (!state.turnId) {
      state.bufferedNotifications.push(message);
      return;
    }

    if (message.method === "thread/started" || message.method === "thread/name/updated") {
      applyTurnNotification(state, message);
      return;
    }

    if (!belongsToTurn(state, message)) {
        if (previousHandler) {
          previousHandler(message);
        }
        return;
    }

    applyTurnNotification(state, message);
  });

  try {
    const response = await startRequest();
    options.onResponse?.(response, state);
    state.turnId = response.turn?.id ?? null;
    if (state.turnId) {
      state.threadTurnIds.set(state.threadId, state.turnId);
    }
    for (const message of state.bufferedNotifications) {
      if (belongsToTurn(state, message)) {
        applyTurnNotification(state, message);
      } else {
        if (previousHandler) {
          previousHandler(message);
        }
      }
    }
    state.bufferedNotifications.length = 0;

    if (response.turn?.status && response.turn.status !== "inProgress") {
      completeTurn(state, response.turn);
    }

    return await state.completion;
  } finally {
    clearCompletionTimer(state);
    client.setNotificationHandler(previousHandler ?? null);
  }
}

async function withAppServer(cwd, fn, options = {}) {
  let client = null;
  try {
    client = await CodexAppServerClient.connect(cwd);
    options.onTransport?.({ transport: client.transport, brokerEndpoint: client.endpoint ?? null, appServerPid: client.pid ?? null, appServerStartTime: client.pid ? readProcessStartTime(client.pid) : null });
    const result = await fn(client);
    await client.close();
    return result;
  } catch (error) {
    const brokerRequested = client?.transport === "broker" || Boolean(process.env[BROKER_ENDPOINT_ENV]);
    const shouldRetryDirect =
      (client?.transport === "broker" && error?.rpcCode === BROKER_BUSY_RPC_CODE) ||
      (brokerRequested && (error?.code === "ENOENT" || error?.code === "ECONNREFUSED"));

    if (client) {
      await client.close().catch(() => {});
      client = null;
    }

    if (!shouldRetryDirect) {
      throw error;
    }

    const directClient = await CodexAppServerClient.connect(cwd, { disableBroker: true });
    options.onTransport?.({ transport: directClient.transport, brokerEndpoint: null, appServerPid: directClient.pid ?? null, appServerStartTime: directClient.pid ? readProcessStartTime(directClient.pid) : null, transportFallbackReason: error?.message ?? String(error) });
    try {
      return await fn(directClient);
    } finally {
      await directClient.close();
    }
  }
}

async function withDirectAppServer(cwd, fn) {
  const client = await CodexAppServerClient.connect(cwd, { disableBroker: true });
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

function resolveCodexHome() {
  return path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
}

function sourceContentSha256(sourcePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(sourcePath)).digest("hex");
}

function importedThreadIdForSource(sourcePath) {
  const ledgerPath = path.join(resolveCodexHome(), "external_agent_session_imports.json");
  if (!fs.existsSync(ledgerPath)) {
    return null;
  }
  const ledger = readJsonFile(ledgerPath);
  const canonicalSource = fs.realpathSync(sourcePath);
  const contentSha256 = sourceContentSha256(canonicalSource);
  const records = Array.isArray(ledger?.records) ? ledger.records : [];
  const match = records
    .filter(
      (record) =>
        record?.source_path === canonicalSource &&
        record?.content_sha256 === contentSha256 &&
        typeof record?.imported_thread_id === "string"
    )
    .at(-1);
  return match?.imported_thread_id ?? null;
}

function externalAgentSessionMigration(sourcePath, cwd) {
  return {
    migrationItems: [
      {
        itemType: "SESSIONS",
        description: `Transfer Claude session ${path.basename(sourcePath)}`,
        cwd: null,
        details: {
          plugins: [],
          sessions: [{ path: sourcePath, cwd, title: null }],
          mcpServers: [],
          hooks: [],
          subagents: [],
          commands: []
        }
      }
    ]
  };
}

async function requestExternalAgentSessionImport(client, params) {
  const previousHandler = client.notificationHandler;
  let timeout = null;
  let resolveCompleted;
  let rejectCompleted;
  const completed = new Promise((resolve, reject) => {
    resolveCompleted = resolve;
    rejectCompleted = reject;
  });
  void completed.catch(() => {});

  client.setNotificationHandler((message) => {
    if (message.method === EXTERNAL_AGENT_IMPORT_COMPLETED) {
      resolveCompleted();
      return;
    }
    previousHandler?.(message);
  });
  timeout = setTimeout(() => {
    rejectCompleted(new Error("Timed out waiting for Codex to finish importing the Claude session."));
  }, EXTERNAL_AGENT_IMPORT_TIMEOUT_MS);

  try {
    await client.request("externalAgentConfig/import", params);
    await completed;
  } finally {
    clearTimeout(timeout);
    client.setNotificationHandler(previousHandler ?? null);
  }
}

async function startThread(client, cwd, options = {}) {
  const response = await client.request("thread/start", buildThreadParams(cwd, options));
  const threadId = response.thread.id;
  if (options.threadName) {
    try {
      await client.request("thread/name/set", { threadId, name: options.threadName });
    } catch (err) {
      // Only suppress "unknown variant/method" errors from older CLI versions
      // that don't support thread/name/set. Rethrow auth, network, or server errors.
      const msg = String(err?.message ?? err ?? "");
      if (!msg.includes("unknown variant") && !msg.includes("unknown method")) {
        throw err;
      }
    }
  }
  return response;
}

async function resumeThread(client, threadId, cwd, options = {}) {
  return client.request("thread/resume", buildResumeParams(threadId, cwd, options));
}

function buildResultStatus(turnState) {
  return turnState.finalTurn?.status === "completed" ? 0 : 1;
}

const BUILTIN_PROVIDER_LABELS = new Map([
  ["openai", "OpenAI"],
  ["ollama", "Ollama"],
  ["lmstudio", "LM Studio"]
]);

function normalizeProviderId(value) {
  const providerId = typeof value === "string" ? value.trim() : "";
  return providerId || null;
}

function formatProviderLabel(providerId, providerConfig = null) {
  const configuredName = typeof providerConfig?.name === "string" ? providerConfig.name.trim() : "";
  if (configuredName) {
    return configuredName;
  }
  if (!providerId) {
    return "The active provider";
  }
  return BUILTIN_PROVIDER_LABELS.get(providerId) ?? providerId;
}

function buildAuthStatus(fields = {}) {
  return {
    available: true,
    loggedIn: false,
    detail: "not authenticated",
    source: "unknown",
    authMethod: null,
    verified: null,
    requiresOpenaiAuth: null,
    provider: null,
    ...fields
  };
}

function resolveProviderConfig(configResponse) {
  const config = configResponse?.config;
  if (!config || typeof config !== "object") {
    return {
      providerId: null,
      providerConfig: null
    };
  }

  const providerId = normalizeProviderId(config.model_provider);
  const providers =
    config.model_providers && typeof config.model_providers === "object" && !Array.isArray(config.model_providers)
      ? config.model_providers
      : null;
  const providerConfig =
    providerId && providers?.[providerId] && typeof providers[providerId] === "object" ? providers[providerId] : null;

  return {
    providerId,
    providerConfig
  };
}

function buildAppServerAuthStatus(accountResponse, configResponse) {
  const account = accountResponse?.account ?? null;
  const requiresOpenaiAuth =
    typeof accountResponse?.requiresOpenaiAuth === "boolean" ? accountResponse.requiresOpenaiAuth : null;
  const { providerId, providerConfig } = resolveProviderConfig(configResponse);
  const providerLabel = formatProviderLabel(providerId, providerConfig);

  if (account?.type === "chatgpt") {
    const email = typeof account.email === "string" && account.email.trim() ? account.email.trim() : null;
    return buildAuthStatus({
      loggedIn: true,
      detail: email ? `ChatGPT login active for ${email}` : "ChatGPT login active",
      source: "app-server",
      authMethod: "chatgpt",
      verified: true,
      requiresOpenaiAuth,
      provider: providerId
    });
  }

  if (account?.type === "apiKey") {
    return buildAuthStatus({
      loggedIn: true,
      detail: "API key configured (unverified)",
      source: "app-server",
      authMethod: "apiKey",
      verified: false,
      requiresOpenaiAuth,
      provider: providerId
    });
  }

  if (requiresOpenaiAuth === false) {
    return buildAuthStatus({
      loggedIn: true,
      detail: `${providerLabel} is configured and does not require OpenAI authentication`,
      source: "app-server",
      requiresOpenaiAuth,
      provider: providerId
    });
  }

  return buildAuthStatus({
    loggedIn: false,
    detail: `${providerLabel} requires OpenAI authentication`,
    source: "app-server",
    requiresOpenaiAuth,
    provider: providerId
  });
}

async function getCodexAuthStatusFromClient(client, cwd) {
  try {
    const accountResponse = await client.request("account/read", { refreshToken: false });
    const configResponse = await client.request("config/read", {
      includeLayers: false,
      cwd
    });

    return buildAppServerAuthStatus(accountResponse, configResponse);
  } catch (error) {
    return buildAuthStatus({
      loggedIn: false,
      detail: error instanceof Error ? error.message : String(error),
      source: "app-server"
    });
  }
}

export function getCodexAvailability(cwd) {
  const versionStatus = binaryAvailable("codex", ["--version"], { cwd });
  if (!versionStatus.available) {
    return versionStatus;
  }

  const appServerStatus = binaryAvailable("codex", ["app-server", "--help"], { cwd });
  if (!appServerStatus.available) {
    return {
      available: false,
      detail: `${versionStatus.detail}; advanced runtime unavailable: ${appServerStatus.detail}`
    };
  }

  return {
    available: true,
    detail: `${versionStatus.detail}; advanced runtime available`
  };
}

export function getSessionRuntimeStatus(env = process.env, cwd = process.cwd()) {
  const endpoint = env?.[BROKER_ENDPOINT_ENV] ?? loadBrokerSession(cwd)?.endpoint ?? null;
  if (endpoint) {
    return {
      mode: "shared",
      label: "shared session",
      detail: "This Claude session is configured to reuse one shared Codex runtime.",
      endpoint
    };
  }

  return {
    mode: "direct",
    label: "direct startup",
    detail: "No shared Codex runtime is active yet. The first review or task command will start one on demand.",
    endpoint: null
  };
}

export async function getCodexAuthStatus(cwd, options = {}) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    return {
      available: false,
      loggedIn: false,
      detail: availability.detail,
      source: "availability",
      authMethod: null,
      verified: null,
      requiresOpenaiAuth: null,
      provider: null
    };
  }

  let client = null;
  try {
    client = await CodexAppServerClient.connect(cwd, {
      env: options.env,
      reuseExistingBroker: true
    });
    return await getCodexAuthStatusFromClient(client, cwd);
  } catch (error) {
    return buildAuthStatus({
      loggedIn: false,
      detail: error instanceof Error ? error.message : String(error),
      source: "app-server"
    });
  } finally {
    if (client) {
      await client.close().catch(() => {});
    }
  }
}

export async function interruptAppServerTurn(cwd, { threadId, turnId, brokerEndpoint, noSpawn = false }) {
  if (!threadId) {
    return {
      attempted: false,
      interrupted: false,
      transport: null,
      detail: "missing threadId or turnId"
    };
  }

  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    return {
      attempted: false,
      interrupted: false,
      transport: null,
      detail: availability.detail
    };
  }

  let client = null;
  try {
    if (noSpawn && !brokerEndpoint) throw new Error("broker-not-found");
    client = await CodexAppServerClient.connect(cwd, { brokerEndpoint, noSpawn, reuseExistingBroker: noSpawn });
    if (!turnId) {
      const response = await client.request("thread/read", { threadId, includeTurns: true });
      const turns = response.thread?.turns ?? response.turns ?? [];
      turnId = [...turns].reverse().find((turn) => ["inProgress", "running"].includes(turn.status))?.id ?? null;
      if (!turnId) return { attempted: true, interrupted: false, transport: client.transport, detail: "thread has no active turn" };
    }
    await withTimeout(client.request("turn/interrupt", { threadId, turnId }), Number(process.env.CODEX_COMPANION_CONTROL_ACK_MS) || 3000, "turn/interrupt acknowledgement timed out");
    return {
      attempted: true,
      interrupted: true,
      transport: client.transport,
      detail: `Interrupted ${turnId} on ${threadId}.`
    };
  } catch (error) {
    const brokerGone = noSpawn && (error?.message === "broker-not-found" || ["ENOENT", "ECONNREFUSED", "EPIPE"].includes(error?.code) || /broker socket closed|connection closed/i.test(String(error?.message ?? "")));
    return {
      attempted: true,
      interrupted: false,
      transport: client?.transport ?? null,
      detail: brokerGone ? "broker-not-found" : error instanceof Error ? error.message : String(error),
      ...(brokerGone ? { errorCode: "broker-not-found" } : {})
    };
  } finally {
    await client?.close().catch(() => {});
  }
}

export async function markBrokerThreadDetached(cwd, { threadId, brokerEndpoint }) {
  if (!threadId || !brokerEndpoint) return false;
  let client;
  try {
    client = await CodexAppServerClient.connect(cwd, { brokerEndpoint, noSpawn: true, reuseExistingBroker: true });
    await client.request("broker/markDetached", { threadId });
    return true;
  } finally {
    await client?.close().catch(() => {});
  }
}

export async function waitForAppServerThreadStop(cwd, { threadId, brokerEndpoint, timeoutMs = 0 }) {
  if (!threadId || !brokerEndpoint) return { confirmed: false, detail: "broker-not-found" };
  let client;
  try {
    client = await CodexAppServerClient.connect(cwd, { brokerEndpoint, noSpawn: true, reuseExistingBroker: true });
    const deadline = Date.now() + Math.max(0, timeoutMs);
    do {
      const response = await withTimeout(client.request("thread/read", { threadId, includeTurns: true }), Math.max(100, Math.min(1000, timeoutMs || 1000)), "thread/read timed out");
      const thread = response?.thread;
      const turns = thread?.turns;
      if (Array.isArray(turns) && thread?.status?.type) {
        const active = thread.status.type === "active" || turns.some((turn) => ["inProgress", "running"].includes(turn.status));
        if (!active) return { confirmed: true, detail: "thread/read reports idle" };
      }
      if (Date.now() >= deadline) return { confirmed: false, detail: "thread/read did not confirm an idle thread" };
      await new Promise((resolve) => setTimeout(resolve, Math.min(50, deadline - Date.now())));
    } while (Date.now() <= deadline);
    return { confirmed: false, detail: "thread/read did not confirm an idle thread" };
  } catch (error) {
    const brokerGone = error?.message === "broker-not-found" || ["ENOENT", "ECONNREFUSED", "EPIPE"].includes(error?.code) || /broker socket closed|connection closed/i.test(String(error?.message ?? ""));
    return { confirmed: false, detail: brokerGone ? "broker-not-found" : error instanceof Error ? error.message : String(error) };
  } finally {
    await client?.close().catch(() => {});
  }
}

export async function runAppServerReview(cwd, options = {}) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/codex:setup`.");
  }

  return withAppServer(cwd, async (client) => {
    emitProgress(options.onProgress, "Starting Codex review thread.", "starting");
    const thread = await startThread(client, cwd, {
      model: options.model,
      sandbox: "read-only",
      ephemeral: true,
      threadName: options.threadName
    });
    const sourceThreadId = thread.thread.id;
    emitProgress(options.onProgress, `Thread ready (${sourceThreadId}).`, "starting", {
      threadId: sourceThreadId
    });
    const delivery = options.delivery ?? "inline";

    const turnState = await captureTurn(
      client,
      sourceThreadId,
      () =>
        client.request("review/start", {
          threadId: sourceThreadId,
          delivery,
          target: options.target
        }),
      {
        onProgress: options.onProgress,
        onResponse(response, state) {
          if (response.reviewThreadId) {
            state.threadIds.add(response.reviewThreadId);
            if (delivery === "detached") {
              state.threadId = response.reviewThreadId;
            }
          }
        }
      }
    );

    return {
      status: buildResultStatus(turnState),
      threadId: turnState.threadId,
      sourceThreadId,
      turnId: turnState.turnId,
      reviewText: turnState.reviewText,
      reasoningSummary: turnState.reasoningSummary,
      turn: turnState.finalTurn,
      error: turnState.error,
      stderr: cleanCodexStderr(client.stderr)
    };
  });
}

export async function importExternalAgentSession(cwd, options = {}) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/codex:setup`.");
  }
  if (!options.sourcePath) {
    throw new Error("A Claude session source path is required.");
  }

  return withDirectAppServer(cwd, async (client) => {
    emitProgress(options.onProgress, "Importing Claude session into Codex.", "transferring");
    try {
      await requestExternalAgentSessionImport(client, externalAgentSessionMigration(options.sourcePath, cwd));
    } catch (error) {
      if (error?.rpcCode === -32601) {
        throw new Error(
          "This Codex version does not support Claude session transfer. Update Codex with `npm install -g @openai/codex@latest`, then retry.",
          { cause: error }
        );
      }
      throw error;
    }
    const threadId = importedThreadIdForSource(options.sourcePath);
    if (!threadId) {
      const stderr = cleanCodexStderr(client.stderr);
      throw new Error(
        `Codex reported that the Claude import completed, but did not record an imported thread.${stderr ? `\n${stderr}` : " Check the Codex app-server logs for the underlying import error."}`
      );
    }
    emitProgress(options.onProgress, `Claude session imported (${threadId}).`, "completed", { threadId });
    return {
      threadId,
      stderr: cleanCodexStderr(client.stderr)
    };
  });
}

export async function runAppServerTurn(cwd, options = {}) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/codex:setup`.");
  }

  const alreadyControlled = () => {
    if (!options.controlFile) return null;
    const entries = readControlOps(options.controlFile, 0);
    const op = entries.find((entry) => entry.op === "cancel");
    if (op && options.workspaceRoot && options.jobId) {
      ackControlOp(options.workspaceRoot, options.jobId, op.id, { interruptDelivered: false, turnConfirmedStopped: true, noTurn: true });
      return op;
    }
    if (options.workspaceRoot && options.jobId) {
      for (const entry of entries) {
        if (entry.op !== "interrupt" || readControlAck(options.workspaceRoot, options.jobId, entry.id)) continue;
        ackControlOp(options.workspaceRoot, options.jobId, entry.id, { interruptDelivered: false, turnConfirmedStopped: true, noTurn: true });
      }
    }
    return null;
  };
  const preConnectOp = alreadyControlled();
  if (preConnectOp) return { status: 0, cancelledByControl: preConnectOp, threadId: null, turnId: null, finalMessage: "", reasoningSummary: [], touchedFiles: [], commandExecutions: [] };
  return withAppServer(cwd, async (client) => {
    let threadId;

    const preThreadOp = alreadyControlled();
    if (preThreadOp) return { status: 0, cancelledByControl: preThreadOp, threadId: null, turnId: null, finalMessage: "", reasoningSummary: [], touchedFiles: [], commandExecutions: [] };

    if (options.resumeThreadId) {
      emitProgress(options.onProgress, `Resuming thread ${options.resumeThreadId}.`, "starting");
      try {
        const response = await resumeThread(client, options.resumeThreadId, cwd, {
          model: options.model,
          sandbox: options.sandbox,
          config: options.config,
          ephemeral: false
        });
        threadId = response.thread.id;
      } catch (error) {
        // Another app-server (typically the shared broker) still holds the
        // thread's writer. A fork carries the full history into a new thread.
        if (!/active writer/i.test(String(error?.message ?? error))) {
          throw error;
        }
        emitProgress(
          options.onProgress,
          `Thread ${options.resumeThreadId} is held by another Codex process; continuing on a fork of it.`,
          "starting"
        );
        const response = await client.request("thread/fork", {
          threadId: options.resumeThreadId,
          cwd,
          model: options.model ?? null,
          approvalPolicy: "never",
          sandbox: options.sandbox ?? "read-only",
          ...(options.config ? { config: options.config } : {}),
          ephemeral: false
        });
        threadId = response.thread.id;
      }
    } else {
      emitProgress(options.onProgress, "Starting Codex task thread.", "starting");
      const response = await startThread(client, cwd, {
        model: options.model,
        sandbox: options.sandbox,
        config: options.config,
        ephemeral: options.persistThread ? false : true,
        threadName: options.persistThread ? options.threadName : options.threadName ?? null
      });
      threadId = response.thread.id;
    }

    emitProgress(options.onProgress, `Thread ready (${threadId}).`, "starting", {
      threadId
    });

    const latestJob = options.workspaceRoot && options.jobId
      ? readJobFile(resolveJobFile(options.workspaceRoot, options.jobId))
      : null;
    const brokerDetached = options.brokerDetached || latestJob?.owner?.brokerDetached === true;
    if (brokerDetached && client.transport === "broker") {
      await client.request("broker/markDetached", { threadId });
    }

    const preTurnOp = alreadyControlled();
    if (preTurnOp) return { status: 0, cancelledByControl: preTurnOp, threadId, turnId: null, finalMessage: "", reasoningSummary: [], touchedFiles: [], commandExecutions: [] };

    const prompt = options.prompt?.trim() || options.defaultPrompt || "";
    if (!prompt) {
      throw new Error("A prompt is required for this Codex run.");
    }

    let steering = { stop: async () => [] };
    let controlPoller = { stop: async () => null };
    let undeliveredMessages = [];
    let controlledOp = null;
    let turnState;
    try {
      turnState = await captureTurn(
        client,
        threadId,
        () =>
          client.request("turn/start", {
            threadId,
            input: buildTurnInput(prompt),
            model: options.model ?? null,
            effort: options.effort ?? null,
            outputSchema: options.outputSchema ?? null,
            ...(brokerDetached ? { brokerDetached: true } : {})
          }),
        {
          onProgress: options.onProgress,
          onResponse: (response) => {
            steering = startInboxSteering(client, threadId, response.turn?.id ?? null, {
              inboxFile: options.inboxFile,
              inboxPollMs: options.inboxPollMs,
              onProgress: options.onProgress,
              onSteered: options.onSteered
            });
            if (options.controlFile && options.workspaceRoot && options.jobId && response.turn?.id) {
              controlPoller = startControlPoller(client, threadId, response.turn.id, options);
            }
          }
        }
      );
    } finally {
      try {
        undeliveredMessages = await steering.stop();
      } finally {
        controlledOp = await controlPoller.stop(turnState);
      }
    }

    return {
      status: buildResultStatus(turnState),
      threadId,
      turnId: turnState.turnId,
      finalMessage: turnState.lastAgentMessage,
      reasoningSummary: turnState.reasoningSummary,
      turn: turnState.finalTurn,
      error: turnState.error,
      stderr: cleanCodexStderr(client.stderr),
      fileChanges: turnState.fileChanges,
      touchedFiles: collectTouchedFiles(turnState.fileChanges),
      commandExecutions: turnState.commandExecutions,
      undeliveredMessages,
      cancelledByControl: controlledOp
    };
  }, options);
}

function startControlPoller(client, threadId, turnId, options) {
  let offset = 0;
  let inFlight = false;
  let ownerCheckInFlight = false;
  let stopped = false;
  let pending = null;
  let ownerCancelQueued = false;
  const checkOwner = async () => {
    if (ownerCheckInFlight || stopped || pending || ownerCancelQueued) return;
    ownerCheckInFlight = true;
    try {
      const currentJob = options.workspaceRoot && options.jobId ? readJobFile(resolveJobFile(options.workspaceRoot, options.jobId)) : null;
      const currentOwner = currentJob?.owner ?? options.owner;
      const ownerExitPolicy = currentJob?.onOwnerExit ?? options.onOwnerExit;
      if (currentOwner && currentOwner.kind !== "none" && currentOwner.kind !== "detached" && ownerExitPolicy === "cancel") {
        const ownerState = assessOwner(options.workspaceRoot, { id: options.jobId, owner: currentOwner });
        if (!ownerState.alive) {
          appendControlOp(options.workspaceRoot, options.jobId, { op: "cancel", reason: "owner-lost" });
          ownerCancelQueued = true;
          void tick();
          if (options.logFile) {
            try { fs.appendFileSync(options.logFile, `[${new Date().toISOString()}] owner exited; cancelling\n`); } catch { /* A logging failure must not block cancellation. */ }
          }
        }
      }
    } catch (error) {
      if (options.logFile) {
        try { fs.appendFileSync(options.logFile, `[${new Date().toISOString()}] owner check failed: ${error.message}\n`); } catch { /* Best-effort diagnostic only. */ }
      }
    } finally { ownerCheckInFlight = false; }
  };
  const tick = async () => {
    if (inFlight || stopped || pending) return;
    inFlight = true;
    try {
      for (const op of readControlOps(options.controlFile, offset)) {
        offset = op.end;
        if (readControlAck(options.workspaceRoot, options.jobId, op.id)) continue;
        if (op.op !== "cancel" && op.op !== "interrupt") continue;
        pending = op;
        let interruptDelivered = false;
        try { await withTimeout(client.request("turn/interrupt", { threadId, turnId }), Number(process.env.CODEX_COMPANION_CONTROL_ACK_MS) || 3000, "turn/interrupt acknowledgement timed out"); interruptDelivered = true; } catch { /* Stop verification below reports failure. */ }
        pending.interruptDelivered = interruptDelivered;
        break;
      }
    } finally { inFlight = false; }
  };
  const controlTimer = setInterval(() => { void tick(); }, Number(process.env.CODEX_COMPANION_CONTROL_POLL_MS) || 100);
  const ownerTimer = options.workspaceRoot && options.jobId
    ? setInterval(() => { void checkOwner().catch(() => {}); }, Number(process.env.CODEX_COMPANION_OWNER_POLL_MS) || 2000)
    : null;
  controlTimer.unref?.();
  ownerTimer?.unref?.();
  void checkOwner().catch(() => {});
  void tick();
  return {
    async stop(state) {
      try {
        const settleUntil = Date.now() + 500;
        while (inFlight && Date.now() < settleUntil) await new Promise((resolve) => setTimeout(resolve, 10));
        await tick();
        const deadline = Date.now() + (Number(process.env.CODEX_COMPANION_CANCEL_GRACE_MS) || 10000);
        while (!pending && state && Date.now() < deadline && !state.completed) await new Promise((resolve) => setTimeout(resolve, 20));
      } finally {
        stopped = true;
        clearInterval(controlTimer);
        if (ownerTimer) clearInterval(ownerTimer);
      }
      if (!pending) return null;
      const turnConfirmedStopped = state?.finalTurn?.status !== "inProgress" && state?.completed === true;
      ackControlOp(options.workspaceRoot, options.jobId, pending.id, { interruptDelivered: Boolean(pending.interruptDelivered), turnConfirmedStopped, noTurn: false });
      return pending.op === "cancel" ? { ...pending, turnConfirmedStopped, interruptDelivered: Boolean(pending.interruptDelivered) } : null;
    }
  };
}

export async function findLatestTaskThread(cwd) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/codex:setup`.");
  }

  return withAppServer(cwd, async (client) => {
    const response = await client.request("thread/list", {
      cwd,
      limit: 20,
      sortKey: "updated_at",
      sourceKinds: ["appServer"],
      searchTerm: TASK_THREAD_PREFIX
    });

    return (
      response.data.find((thread) => typeof thread.name === "string" && thread.name.startsWith(TASK_THREAD_PREFIX)) ??
      null
    );
  });
}

export function buildPersistentTaskThreadName(prompt) {
  return buildTaskThreadName(prompt);
}

export function parseStructuredOutput(rawOutput, fallback = {}) {
  if (!rawOutput) {
    return {
      parsed: null,
      parseError: fallback.failureMessage ?? "Codex did not return a final structured message.",
      rawOutput: rawOutput ?? "",
      ...fallback
    };
  }

  try {
    return {
      parsed: JSON.parse(rawOutput),
      parseError: null,
      rawOutput,
      ...fallback
    };
  } catch (error) {
    return {
      parsed: null,
      parseError: error.message,
      rawOutput,
      ...fallback
    };
  }
}

export function readOutputSchema(schemaPath) {
  return readJsonFile(schemaPath);
}

export { DEFAULT_CONTINUE_PROMPT, TASK_THREAD_PREFIX };
