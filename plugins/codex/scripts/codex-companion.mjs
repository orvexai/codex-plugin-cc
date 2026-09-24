#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import {
    buildPersistentTaskThreadName,
    DEFAULT_CONTINUE_PROMPT,
    findLatestTaskThread,
    getCodexAuthStatus,
    getCodexAvailability,
    getSessionRuntimeStatus,
    importExternalAgentSession,
    interruptAppServerTurn,
    parseStructuredOutput,
    readOutputSchema,
    runAppServerReview,
    runAppServerTurn
  } from "./lib/codex.mjs";
import { resolveClaudeSessionPath } from "./lib/claude-session-transfer.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import { collectReviewContext, ensureGitRepository, resolveReviewTarget } from "./lib/git.mjs";
import { binaryAvailable, terminateProcessTree } from "./lib/process.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import {
  generateJobId,
  getConfig,
  getGlobalConfig,
  listJobs,
  resolveJobInboxFile,
  setConfig,
  setGlobalConfig,
  upsertJob,
  writeJobFile
} from "./lib/state.mjs";
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  readStoredJob,
  resolveCancelableJob,
  resolveResultJob,
  sortJobsNewestFirst
} from "./lib/job-control.mjs";
import { CLI_SHIM_NAME, describeCliShim, installCliShim } from "./lib/cli-shim.mjs";
import {
  appendLogLine,
  createJobLogFile,
  createJobProgressUpdater,
  createJobRecord,
  createProgressReporter,
  nowIso,
  runTrackedJob,
  SESSION_ID_ENV
} from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import {
  renderNativeReviewResult,
  renderReviewResult,
  renderStoredJobResult,
  renderCancelReport,
  renderJobStatusReport,
  renderSetupReport,
  renderStatusReport,
  renderTaskResult,
  renderUndeliveredMessages
} from "./lib/render.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REVIEW_SCHEMA = path.join(ROOT_DIR, "schemas", "review-output.schema.json");
const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2000;
const VALID_REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);
const MODEL_ALIASES = new Map([["spark", "gpt-5.3-codex-spark"]]);
const STOP_REVIEW_TASK_MARKER = "Run a stop-gate review of the previous Claude turn.";
const VALID_SANDBOX_MODES = new Set(["read-only", "workspace-write", "danger-full-access"]);
const SANDBOX_ALIASES = new Map([
  ["readonly", "read-only"],
  ["read", "read-only"],
  ["write", "workspace-write"],
  ["workspace", "workspace-write"],
  ["full", "danger-full-access"],
  ["full-access", "danger-full-access"],
  ["none", "danger-full-access"],
  ["off", "danger-full-access"]
]);
const SANDBOX_RANK = { "read-only": 0, "workspace-write": 1, "danger-full-access": 2 };
const DEFAULT_ENV = {
  model: "CODEX_COMPANION_MODEL",
  effort: "CODEX_COMPANION_EFFORT",
  sandbox: "CODEX_COMPANION_SANDBOX",
  network: "CODEX_COMPANION_NETWORK"
};
const CLEAR_DEFAULT_VALUES = new Set(["", "none", "unset", "default", "clear"]);
const DEFAULT_WAIT_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_SEND_ACK_TIMEOUT_MS = 20000;
const WAIT_TIMEOUT_EXIT_CODE = 124;

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/codex-companion.mjs setup [--enable-review-gate|--disable-review-gate] [--default-model <m|none>] [--default-effort <e|none>] [--default-sandbox <mode|none>] [--default-network <on|off|none>] [--global] [--install-cli [--bin-dir <dir>]] [--json]",
      "  node scripts/codex-companion.mjs review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>]",
      "  node scripts/codex-companion.mjs adversarial-review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [focus text]",
      "  node scripts/codex-companion.mjs task [--background] [--write|--read-only|--full-access|--sandbox <read-only|workspace-write|danger-full-access>] [--network|--no-network] [--name <label>] [--resume-last|--resume|--fresh] [--model <model|spark>] [--effort <none|minimal|low|medium|high|xhigh>] [--cwd <dir>] [--prompt-file <file>] [prompt]",
      "  node scripts/codex-companion.mjs send <job-id> [--background] [--timeout-ms <ms>] [--no-follow-up] [--prompt-file <file>] [message]",
      "  node scripts/codex-companion.mjs wait [job-id...] [--any] [--timeout-ms <ms>] [--json]",
      "  node scripts/codex-companion.mjs transfer [--source <claude-jsonl>] [--json]",
      "  node scripts/codex-companion.mjs status [job-id] [--all] [--json]",
      "  node scripts/codex-companion.mjs result [job-id] [--output <file>] [--json]",
      "  node scripts/codex-companion.mjs cancel [job-id] [--json]"
    ].join("\n")
  );
}

function normalizeSandboxMode(value) {
  if (value == null) {
    return null;
  }
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  const resolved = SANDBOX_ALIASES.get(normalized) ?? normalized;
  if (!VALID_SANDBOX_MODES.has(resolved)) {
    throw new Error(`Unsupported sandbox "${value}". Use one of: read-only, workspace-write, danger-full-access.`);
  }
  return resolved;
}

function parseBooleanSetting(value) {
  if (typeof value === "boolean") {
    return value;
  }
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["1", "true", "on", "yes"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "off", "no"].includes(normalized)) {
    return false;
  }
  return null;
}

function normalizeJobName(name) {
  const normalized = String(name ?? "").trim();
  return normalized || null;
}

// Defaults resolve env > workspace (/codex:setup) > global (/codex:setup --global).
function readRuntimeDefaults(workspaceRoot) {
  const workspaceConfig = getConfig(workspaceRoot);
  const globalConfig = getGlobalConfig();
  const pick = (key, envName, normalize) => {
    const candidates = [
      [process.env[envName], `env ${envName}`],
      [workspaceConfig[key], "workspace"],
      [globalConfig[key], "global"]
    ];
    for (const [raw, source] of candidates) {
      if (raw == null || raw === "") {
        continue;
      }
      const value = normalize(raw);
      if (value != null) {
        return { value, source };
      }
    }
    return { value: null, source: null };
  };
  return {
    model: pick("defaultModel", DEFAULT_ENV.model, normalizeRequestedModel),
    effort: pick("defaultEffort", DEFAULT_ENV.effort, normalizeReasoningEffort),
    sandbox: pick("defaultSandbox", DEFAULT_ENV.sandbox, normalizeSandboxMode),
    network: pick("defaultNetwork", DEFAULT_ENV.network, parseBooleanSetting)
  };
}

function runtimeFromStoredJob(stored) {
  if (stored?.runtime?.sandbox) {
    return stored.runtime;
  }
  const request = stored?.request;
  if (request && typeof request === "object") {
    return {
      sandbox: request.sandbox ?? (request.write ? "workspace-write" : "read-only"),
      network: Boolean(request.network),
      model: request.model ?? null,
      effort: request.effort ?? null
    };
  }
  return stored?.write ? { sandbox: "workspace-write" } : null;
}

// Explicit flags win, then (for follow-ups) the parent job's runtime, then defaults.
// --write means "at least workspace-write", so it never downgrades a full-access default.
function resolveTaskRuntime(options, workspaceRoot, inherited = null) {
  const defaults = readRuntimeDefaults(workspaceRoot);
  const explicit = options.sandbox != null ? normalizeSandboxMode(options.sandbox) : null;
  const chosen = [
    options["full-access"] ? "--full-access" : null,
    options["read-only"] ? "--read-only" : null,
    explicit ? `--sandbox ${explicit}` : null
  ].filter(Boolean);
  if (chosen.length > 1) {
    throw new Error(`Choose only one of ${chosen.join(", ")}.`);
  }
  if (options.write && (options["read-only"] || explicit === "read-only")) {
    throw new Error("--write conflicts with a read-only sandbox.");
  }
  if (options.network && options["no-network"]) {
    throw new Error("Choose either --network or --no-network.");
  }

  let sandbox;
  if (options["full-access"]) {
    sandbox = "danger-full-access";
  } else if (explicit) {
    sandbox = explicit;
  } else if (options["read-only"]) {
    sandbox = "read-only";
  } else {
    const base = inherited?.sandbox ?? defaults.sandbox.value ?? "read-only";
    sandbox = options.write && SANDBOX_RANK[base] < SANDBOX_RANK["workspace-write"] ? "workspace-write" : base;
  }

  let network;
  if (options["no-network"]) {
    network = false;
  } else if (options.network != null) {
    network = Boolean(options.network);
  } else {
    network = inherited?.network ?? Boolean(defaults.network.value);
  }

  return {
    sandbox,
    network,
    model: normalizeRequestedModel(options.model) ?? inherited?.model ?? defaults.model.value ?? null,
    effort: normalizeReasoningEffort(options.effort) ?? inherited?.effort ?? defaults.effort.value ?? null
  };
}

function buildSandboxConfig(network) {
  return network ? { sandbox_workspace_write: { network_access: true } } : null;
}

function outputResult(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    process.stdout.write(value);
  }
}

function outputCommandResult(payload, rendered, asJson) {
  outputResult(asJson ? payload : rendered, asJson);
}

function normalizeRequestedModel(model) {
  if (model == null) {
    return null;
  }
  const normalized = String(model).trim();
  if (!normalized) {
    return null;
  }
  return MODEL_ALIASES.get(normalized.toLowerCase()) ?? normalized;
}

function normalizeReasoningEffort(effort) {
  if (effort == null) {
    return null;
  }
  const normalized = String(effort).trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (!VALID_REASONING_EFFORTS.has(normalized)) {
    throw new Error(
      `Unsupported reasoning effort "${effort}". Use one of: none, minimal, low, medium, high, xhigh.`
    );
  }
  return normalized;
}

function normalizeArgv(argv) {
  if (argv.length === 1) {
    const [raw] = argv;
    if (!raw || !raw.trim()) {
      return [];
    }
    return splitRawArgumentString(raw);
  }
  return argv;
}

function parseCommandInput(argv, config = {}) {
  return parseArgs(normalizeArgv(argv), {
    ...config,
    aliasMap: {
      C: "cwd",
      ...(config.aliasMap ?? {})
    }
  });
}

function resolveCommandCwd(options = {}) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

function resolveCommandWorkspace(options = {}) {
  return resolveWorkspaceRoot(resolveCommandCwd(options));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shorten(text, limit = 96) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function firstMeaningfulLine(text, fallback) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  return line ?? fallback;
}

async function buildSetupReport(cwd, actionsTaken = []) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const nodeStatus = binaryAvailable("node", ["--version"], { cwd });
  const npmStatus = binaryAvailable("npm", ["--version"], { cwd });
  const codexStatus = getCodexAvailability(cwd);
  const authStatus = await getCodexAuthStatus(cwd);
  const config = getConfig(workspaceRoot);

  const nextSteps = [];
  if (!codexStatus.available) {
    nextSteps.push("Install Codex with `npm install -g @openai/codex`.");
  }
  if (codexStatus.available && !authStatus.loggedIn && authStatus.requiresOpenaiAuth) {
    nextSteps.push("Run `!codex login`.");
    nextSteps.push("If browser login is blocked, retry with `!codex login --device-auth` or `!codex login --with-api-key`.");
  }
  if (!config.stopReviewGate) {
    nextSteps.push("Optional: run `/codex:setup --enable-review-gate` to require a fresh review before stop.");
  }

  return {
    ready: nodeStatus.available && codexStatus.available && authStatus.loggedIn,
    node: nodeStatus,
    npm: npmStatus,
    codex: codexStatus,
    auth: authStatus,
    sessionRuntime: getSessionRuntimeStatus(process.env, workspaceRoot),
    reviewGateEnabled: Boolean(config.stopReviewGate),
    defaults: readRuntimeDefaults(workspaceRoot),
    cliShim: describeCliShim(ROOT_DIR),
    actionsTaken,
    nextSteps
  };
}

function applyDefaultOption(options, optionName, apply) {
  if (options[optionName] === undefined) {
    return;
  }
  const raw = String(options[optionName]).trim();
  if (CLEAR_DEFAULT_VALUES.has(raw.toLowerCase())) {
    apply(null, raw);
    return;
  }
  apply(raw, raw);
}

async function handleSetup(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "default-model", "default-effort", "default-sandbox", "default-network", "bin-dir"],
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate", "global", "install-cli"]
  });

  if (options["enable-review-gate"] && options["disable-review-gate"]) {
    throw new Error("Choose either --enable-review-gate or --disable-review-gate.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const actionsTaken = [];

  if (options["enable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", true);
    actionsTaken.push(`Enabled the stop-time review gate for ${workspaceRoot}.`);
  } else if (options["disable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", false);
    actionsTaken.push(`Disabled the stop-time review gate for ${workspaceRoot}.`);
  }

  const scopeLabel = options.global ? "global" : `workspace (${workspaceRoot})`;
  const writeDefault = (key, value) =>
    options.global ? setGlobalConfig(key, value) : setConfig(workspaceRoot, key, value);
  const defaultSpecs = [
    ["default-model", "defaultModel", "model", normalizeRequestedModel],
    ["default-effort", "defaultEffort", "reasoning effort", normalizeReasoningEffort],
    ["default-sandbox", "defaultSandbox", "sandbox", normalizeSandboxMode],
    ["default-network", "defaultNetwork", "network access", parseBooleanSetting]
  ];
  for (const [optionName, key, label, normalize] of defaultSpecs) {
    applyDefaultOption(options, optionName, (raw) => {
      if (raw == null) {
        writeDefault(key, null);
        actionsTaken.push(`Cleared the ${scopeLabel} default ${label}.`);
        return;
      }
      const value = normalize(raw);
      if (value == null) {
        throw new Error(`Invalid value for --${optionName}: "${raw}".`);
      }
      writeDefault(key, value);
      actionsTaken.push(`Set the ${scopeLabel} default ${label} to ${value}.`);
    });
  }

  if (options["install-cli"]) {
    const binDir = options["bin-dir"] ? path.resolve(cwd, options["bin-dir"]) : undefined;
    const target = installCliShim(ROOT_DIR, binDir);
    actionsTaken.push(`Installed the ${CLI_SHIM_NAME} launcher at ${target}.`);
  }

  const finalReport = await buildSetupReport(cwd, actionsTaken);
  outputResult(options.json ? finalReport : renderSetupReport(finalReport), options.json);
}

function buildAdversarialReviewPrompt(context, focusText) {
  const template = loadPromptTemplate(ROOT_DIR, "adversarial-review");
  return interpolateTemplate(template, {
    REVIEW_KIND: "Adversarial Review",
    TARGET_LABEL: context.target.label,
    USER_FOCUS: focusText || "No extra focus provided.",
    REVIEW_COLLECTION_GUIDANCE: context.collectionGuidance,
    REVIEW_INPUT: context.content
  });
}

function ensureCodexAvailable(cwd) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/codex:setup`.");
  }
}

function buildNativeReviewTarget(target) {
  if (target.mode === "working-tree") {
    return { type: "uncommittedChanges" };
  }

  if (target.mode === "branch") {
    return { type: "baseBranch", branch: target.baseRef };
  }

  return null;
}

function validateNativeReviewRequest(target, focusText) {
  if (focusText.trim()) {
    throw new Error(
      `\`/codex:review\` now maps directly to the built-in reviewer and does not support custom focus text. Retry with \`/codex:adversarial-review ${focusText.trim()}\` for focused review instructions.`
    );
  }

  const nativeTarget = buildNativeReviewTarget(target);
  if (!nativeTarget) {
    throw new Error("This `/codex:review` target is not supported by the built-in reviewer. Retry with `/codex:adversarial-review` for custom targeting.");
  }

  return nativeTarget;
}

function renderStatusPayload(report, asJson) {
  return asJson ? report : renderStatusReport(report);
}

function isActiveJobStatus(status) {
  return status === "queued" || status === "running";
}

function getCurrentClaudeSessionId() {
  return process.env[SESSION_ID_ENV] ?? null;
}

function filterJobsForCurrentClaudeSession(jobs) {
  const sessionId = getCurrentClaudeSessionId();
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

function findLatestResumableTaskJob(jobs) {
  return (
    jobs.find(
      (job) =>
        job.jobClass === "task" &&
        job.threadId &&
        job.status !== "queued" &&
        job.status !== "running"
    ) ?? null
  );
}

async function waitForSingleJobSnapshot(cwd, reference, options = {}) {
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || DEFAULT_STATUS_WAIT_TIMEOUT_MS);
  const pollIntervalMs = Math.max(100, Number(options.pollIntervalMs) || DEFAULT_STATUS_POLL_INTERVAL_MS);
  const deadline = Date.now() + timeoutMs;
  let snapshot = buildSingleJobSnapshot(cwd, reference);

  while (isActiveJobStatus(snapshot.job.status) && Date.now() < deadline) {
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    snapshot = buildSingleJobSnapshot(cwd, reference);
  }

  return {
    ...snapshot,
    waitTimedOut: isActiveJobStatus(snapshot.job.status),
    timeoutMs
  };
}

async function resolveLatestTrackedTaskThread(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const sessionId = getCurrentClaudeSessionId();
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot)).filter((job) => job.id !== options.excludeJobId);
  const visibleJobs = filterJobsForCurrentClaudeSession(jobs);
  const activeTask = visibleJobs.find((job) => job.jobClass === "task" && (job.status === "queued" || job.status === "running"));
  if (activeTask) {
    throw new Error(`Task ${activeTask.id} is still running. Use /codex:status before continuing it.`);
  }

  const trackedTask = findLatestResumableTaskJob(visibleJobs);
  if (trackedTask) {
    return { id: trackedTask.threadId };
  }

  if (sessionId) {
    return null;
  }

  return findLatestTaskThread(workspaceRoot);
}

async function executeReviewRun(request) {
  ensureCodexAvailable(request.cwd);
  ensureGitRepository(request.cwd);

  const target = resolveReviewTarget(request.cwd, {
    base: request.base,
    scope: request.scope
  });
  const focusText = request.focusText?.trim() ?? "";
  const reviewName = request.reviewName ?? "Review";
  if (reviewName === "Review") {
    const reviewTarget = validateNativeReviewRequest(target, focusText);
    const result = await runAppServerReview(request.cwd, {
      target: reviewTarget,
      model: request.model,
      onProgress: request.onProgress
    });
    const payload = {
      review: reviewName,
      target,
      threadId: result.threadId,
      sourceThreadId: result.sourceThreadId,
      codex: {
        status: result.status,
        stderr: result.stderr,
        stdout: result.reviewText,
        reasoning: result.reasoningSummary
      }
    };
    const rendered = renderNativeReviewResult(
      {
        status: result.status,
        stdout: result.reviewText,
        stderr: result.stderr
      },
      { reviewLabel: reviewName, targetLabel: target.label, reasoningSummary: result.reasoningSummary }
    );

    return {
      exitStatus: result.status,
      threadId: result.threadId,
      turnId: result.turnId,
      payload,
      rendered,
      summary: firstMeaningfulLine(result.reviewText, `${reviewName} completed.`),
      jobTitle: `Codex ${reviewName}`,
      jobClass: "review",
      targetLabel: target.label
    };
  }

  const context = collectReviewContext(request.cwd, target);
  const prompt = buildAdversarialReviewPrompt(context, focusText);
  const result = await runAppServerTurn(context.repoRoot, {
    prompt,
    model: request.model,
    sandbox: "read-only",
    outputSchema: readOutputSchema(REVIEW_SCHEMA),
    onProgress: request.onProgress
  });
  const parsed = parseStructuredOutput(result.finalMessage, {
    status: result.status,
    failureMessage: result.error?.message ?? result.stderr
  });
  const payload = {
    review: reviewName,
    target,
    threadId: result.threadId,
    context: {
      repoRoot: context.repoRoot,
      branch: context.branch,
      summary: context.summary
    },
    codex: {
      status: result.status,
      stderr: result.stderr,
      stdout: result.finalMessage,
      reasoning: result.reasoningSummary
    },
    result: parsed.parsed,
    rawOutput: parsed.rawOutput,
    parseError: parsed.parseError,
    reasoningSummary: result.reasoningSummary
  };

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    payload,
    rendered: renderReviewResult(parsed, {
      reviewLabel: reviewName,
      targetLabel: context.target.label,
      reasoningSummary: result.reasoningSummary
    }),
    summary: parsed.parsed?.summary ?? parsed.parseError ?? firstMeaningfulLine(result.finalMessage, `${reviewName} finished.`),
    jobTitle: `Codex ${reviewName}`,
    jobClass: "review",
    targetLabel: context.target.label
  };
}


function recordDeliveredMessage(workspaceRoot, jobId, messageId) {
  if (!jobId || !messageId) {
    return;
  }
  const stored = readStoredJob(workspaceRoot, jobId);
  if (!stored) {
    return;
  }
  const delivered = new Set(stored.deliveredMessageIds ?? []);
  delivered.add(messageId);
  writeJobFile(workspaceRoot, jobId, { ...stored, deliveredMessageIds: [...delivered] });
}

async function executeTaskRun(request) {
  const workspaceRoot = resolveWorkspaceRoot(request.cwd);
  ensureCodexAvailable(request.cwd);

  const taskMetadata = buildTaskRunMetadata({
    prompt: request.prompt,
    resumeLast: request.resumeLast,
    name: request.name,
    followUp: Boolean(request.resumeThreadId)
  });

  let resumeThreadId = request.resumeThreadId ?? null;
  if (!resumeThreadId && request.resumeLast) {
    const latestThread = await resolveLatestTrackedTaskThread(workspaceRoot, {
      excludeJobId: request.jobId
    });
    if (!latestThread) {
      throw new Error("No previous Codex task thread was found for this repository.");
    }
    resumeThreadId = latestThread.id;
  }

  if (!request.prompt && !resumeThreadId) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }

  // Requests queued by older versions carry only `write`.
  const sandbox = request.sandbox ?? (request.write ? "workspace-write" : "read-only");
  const result = await runAppServerTurn(workspaceRoot, {
    resumeThreadId,
    prompt: request.prompt,
    defaultPrompt: resumeThreadId ? DEFAULT_CONTINUE_PROMPT : "",
    model: request.model,
    effort: request.effort,
    sandbox,
    config: buildSandboxConfig(request.network),
    inboxFile: request.jobId ? resolveJobInboxFile(workspaceRoot, request.jobId) : null,
    onSteered: (message) => recordDeliveredMessage(workspaceRoot, request.jobId, message.id),
    onProgress: request.onProgress,
    persistThread: true,
    threadName: resumeThreadId ? null : buildPersistentTaskThreadName(request.name || request.prompt || DEFAULT_CONTINUE_PROMPT)
  });

  const rawOutput = typeof result.finalMessage === "string" ? result.finalMessage : "";
  const failureMessage = result.error?.message ?? result.stderr ?? "";
  const undeliveredMessages = (result.undeliveredMessages ?? []).map((message) => ({
    id: message.id ?? null,
    text: message.text,
    error: message.error ?? null
  }));
  const rendered =
    renderTaskResult(
      {
        rawOutput,
        failureMessage,
        reasoningSummary: result.reasoningSummary
      },
      {
        title: taskMetadata.title,
        jobId: request.jobId ?? null,
        write: sandbox !== "read-only"
      }
    ) + renderUndeliveredMessages(request.jobId, undeliveredMessages);
  const payload = {
    status: result.status,
    threadId: result.threadId,
    rawOutput,
    touchedFiles: result.touchedFiles,
    reasoningSummary: result.reasoningSummary,
    undeliveredMessages
  };

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    payload,
    rendered,
    summary: firstMeaningfulLine(rawOutput, firstMeaningfulLine(failureMessage, `${taskMetadata.title} finished.`)),
    jobTitle: taskMetadata.title,
    jobClass: "task",
    write: sandbox !== "read-only"
  };
}

function buildReviewJobMetadata(reviewName, target) {
  return {
    kind: reviewName === "Adversarial Review" ? "adversarial-review" : "review",
    title: reviewName === "Review" ? "Codex Review" : `Codex ${reviewName}`,
    summary: `${reviewName} ${target.label}`
  };
}

function buildTaskRunMetadata({ prompt, resumeLast = false, name = null, followUp = false }) {
  if (!resumeLast && !followUp && String(prompt ?? "").includes(STOP_REVIEW_TASK_MARKER)) {
    return {
      title: "Codex Stop Gate Review",
      summary: "Stop-gate review of previous Claude turn"
    };
  }

  const title = followUp ? "Codex Follow-up" : resumeLast ? "Codex Resume" : "Codex Task";
  const fallbackSummary = resumeLast ? DEFAULT_CONTINUE_PROMPT : "Task";
  return {
    title,
    summary: shorten(name || prompt || fallbackSummary)
  };
}

function renderQueuedTaskLaunch(payload) {
  return `${payload.title} started in the background as ${payload.jobId}. Check /codex:status ${payload.jobId} for progress.\n`;
}

function getJobKindLabel(kind, jobClass) {
  if (kind === "adversarial-review") {
    return "adversarial-review";
  }
  return jobClass === "review" ? "review" : "rescue";
}

function createCompanionJob({ prefix, kind, title, workspaceRoot, jobClass, summary, write = false, extra = {} }) {
  return createJobRecord({
    id: generateJobId(prefix),
    kind,
    kindLabel: getJobKindLabel(kind, jobClass),
    title,
    workspaceRoot,
    jobClass,
    summary,
    write,
    ...extra
  });
}

function createTrackedProgress(job, options = {}) {
  const logFile = options.logFile ?? createJobLogFile(job.workspaceRoot, job.id, job.title);
  return {
    logFile,
    progress: createProgressReporter({
      stderr: Boolean(options.stderr),
      logFile,
      onEvent: createJobProgressUpdater(job.workspaceRoot, job.id)
    })
  };
}

function buildTaskJob(workspaceRoot, taskMetadata, write, extra = {}) {
  return createCompanionJob({
    prefix: "task",
    kind: "task",
    title: taskMetadata.title,
    workspaceRoot,
    jobClass: "task",
    summary: taskMetadata.summary,
    write,
    extra
  });
}

function buildTaskRequest({ cwd, model, effort, prompt, write, resumeLast, jobId, sandbox, network, name, resumeThreadId }) {
  return {
    cwd,
    model,
    effort,
    prompt,
    write,
    resumeLast,
    jobId,
    sandbox,
    network: Boolean(network),
    name: name ?? null,
    resumeThreadId: resumeThreadId ?? null
  };
}

function renderTransferResult(payload) {
  const lines = [
    "Transferred the Claude session into a Codex thread with visible turn history.",
    `Codex session ID: ${payload.threadId}`,
    `Resume in Codex: ${payload.resumeCommand}`
  ];
  return `${lines.join("\n")}\n`;
}

async function executeTransfer(cwd, options = {}) {
  const sourcePath = resolveClaudeSessionPath(cwd, {
    source: options.source
  });
  const result = await importExternalAgentSession(cwd, { sourcePath });
  const payload = {
    threadId: result.threadId,
    resumeCommand: `codex resume ${result.threadId}`,
    sourcePath,
    sessionId: path.basename(sourcePath, ".jsonl")
  };

  return {
    payload,
    rendered: renderTransferResult(payload)
  };
}

function readTaskPrompt(cwd, options, positionals) {
  if (options["prompt-file"]) {
    return fs.readFileSync(path.resolve(cwd, options["prompt-file"]), "utf8");
  }

  const positionalPrompt = positionals.join(" ");
  return positionalPrompt || readStdinIfPiped();
}

function requireTaskRequest(prompt, resumeLast) {
  if (!prompt && !resumeLast) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }
}

async function runForegroundCommand(job, runner, options = {}) {
  const { logFile, progress } = createTrackedProgress(job, {
    logFile: options.logFile,
    stderr: !options.json
  });
  const execution = await runTrackedJob(job, () => runner(progress), { logFile });
  outputResult(options.json ? execution.payload : execution.rendered, options.json);
  if (execution.exitStatus !== 0) {
    process.exitCode = execution.exitStatus;
  }
  return execution;
}

function spawnDetachedTaskWorker(cwd, jobId) {
  const scriptPath = path.join(ROOT_DIR, "scripts", "codex-companion.mjs");
  const child = spawn(process.execPath, [scriptPath, "task-worker", "--cwd", cwd, "--job-id", jobId], {
    cwd,
    env: process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  return child;
}

function enqueueBackgroundTask(cwd, job, request) {
  const { logFile } = createTrackedProgress(job);
  appendLogLine(logFile, "Queued for background execution.");

  const child = spawnDetachedTaskWorker(cwd, job.id);
  const queuedRecord = {
    ...job,
    status: "queued",
    phase: "queued",
    pid: child.pid ?? null,
    logFile,
    request
  };
  writeJobFile(job.workspaceRoot, job.id, queuedRecord);
  upsertJob(job.workspaceRoot, queuedRecord);

  return {
    payload: {
      jobId: job.id,
      status: "queued",
      title: job.title,
      summary: job.summary,
      logFile
    },
    logFile
  };
}

async function handleReviewCommand(argv, config) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["base", "scope", "model", "cwd"],
    booleanOptions: ["json", "background", "wait"],
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const focusText = positionals.join(" ").trim();
  const target = resolveReviewTarget(cwd, {
    base: options.base,
    scope: options.scope
  });

  config.validateRequest?.(target, focusText);
  const metadata = buildReviewJobMetadata(config.reviewName, target);
  const job = createCompanionJob({
    prefix: "review",
    kind: metadata.kind,
    title: metadata.title,
    workspaceRoot,
    jobClass: "review",
    summary: metadata.summary
  });
  await runForegroundCommand(
    job,
    (progress) =>
      executeReviewRun({
        cwd,
        base: options.base,
        scope: options.scope,
        model: options.model,
        focusText,
        reviewName: config.reviewName,
        onProgress: progress
      }),
    { json: options.json }
  );
}

async function handleReview(argv) {
  return handleReviewCommand(argv, {
    reviewName: "Review",
    validateRequest: validateNativeReviewRequest
  });
}

const RUNTIME_VALUE_OPTIONS = ["model", "effort", "sandbox", "name"];
const RUNTIME_BOOLEAN_OPTIONS = ["write", "read-only", "full-access", "network", "no-network"];

async function handleTask(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: [...RUNTIME_VALUE_OPTIONS, "cwd", "prompt-file"],
    booleanOptions: [...RUNTIME_BOOLEAN_OPTIONS, "json", "resume-last", "resume", "fresh", "background"],
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const runtime = resolveTaskRuntime(options, workspaceRoot);
  const name = normalizeJobName(options.name);
  const prompt = readTaskPrompt(cwd, options, positionals);

  const resumeLast = Boolean(options["resume-last"] || options.resume);
  const fresh = Boolean(options.fresh);
  if (resumeLast && fresh) {
    throw new Error("Choose either --resume/--resume-last or --fresh.");
  }
  const write = runtime.sandbox !== "read-only";
  const taskMetadata = buildTaskRunMetadata({
    prompt,
    resumeLast,
    name
  });
  const jobExtra = { name, runtime, cwd };

  if (options.background) {
    ensureCodexAvailable(cwd);
    requireTaskRequest(prompt, resumeLast);

    const job = buildTaskJob(workspaceRoot, taskMetadata, write, jobExtra);
    const request = buildTaskRequest({
      cwd,
      prompt,
      write,
      resumeLast,
      jobId: job.id,
      name,
      ...runtime
    });
    const { payload } = enqueueBackgroundTask(cwd, job, request);
    outputCommandResult(payload, renderQueuedTaskLaunch(payload), options.json);
    return;
  }

  const job = buildTaskJob(workspaceRoot, taskMetadata, write, jobExtra);
  await runForegroundCommand(
    job,
    (progress) =>
      executeTaskRun({
        ...buildTaskRequest({
          cwd,
          prompt,
          write,
          resumeLast,
          jobId: job.id,
          name,
          ...runtime
        }),
        onProgress: progress
      }),
    { json: options.json }
  );
}

async function deliverToRunningJob(workspaceRoot, job, text, timeoutMs) {
  const message = { id: generateJobId("msg"), text, createdAt: nowIso() };
  fs.appendFileSync(resolveJobInboxFile(workspaceRoot, job.id), `${JSON.stringify(message)}\n`, "utf8");
  appendLogLine(job.logFile, `Queued ${message.id} for the running turn.`);

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const current = readStoredJob(workspaceRoot, job.id);
    if (current?.deliveredMessageIds?.includes(message.id)) {
      return { status: "delivered", jobId: job.id, messageId: message.id };
    }
    if (current && !isActiveJobStatus(current.status)) {
      return { status: "finished-undelivered", jobId: job.id, messageId: message.id, jobStatus: current.status };
    }
    if (Date.now() >= deadline) {
      return { status: "queued", jobId: job.id, messageId: message.id };
    }
    await sleep(250);
  }
}

function renderDelivery(delivery) {
  switch (delivery.status) {
    case "delivered":
      return `Delivered ${delivery.messageId} to the running turn of ${delivery.jobId}.\n`;
    case "queued":
      return `Queued ${delivery.messageId} for ${delivery.jobId}; the running turn has not picked it up yet. If the job finishes first, send the message again to continue its thread in a follow-up job.\n`;
    default:
      return `${delivery.jobId} finished (${delivery.jobStatus}) before ${delivery.messageId} could be delivered.\n`;
  }
}

// Messages a job: steers the running turn, or continues a finished job's
// thread in a new follow-up job that inherits its sandbox, model and effort.
async function handleSend(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: [...RUNTIME_VALUE_OPTIONS, "cwd", "prompt-file", "timeout-ms"],
    booleanOptions: [...RUNTIME_BOOLEAN_OPTIONS, "json", "background", "wait", "no-follow-up"],
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options);
  const [reference, ...messageParts] = positionals;
  if (!reference) {
    throw new Error("Usage: send <job-id> <message>. Run /codex:status to list jobs.");
  }
  const message = options["prompt-file"]
    ? fs.readFileSync(path.resolve(cwd, options["prompt-file"]), "utf8")
    : messageParts.join(" ") || readStdinIfPiped();
  if (!String(message ?? "").trim()) {
    throw new Error("Provide a message to send, as text, --prompt-file, or piped stdin.");
  }

  const { workspaceRoot, job } = buildSingleJobSnapshot(cwd, reference);
  if (job.jobClass !== "task") {
    throw new Error(`Job ${job.id} is a ${job.kindLabel ?? job.jobClass} job; only task jobs accept messages.`);
  }

  if (isActiveJobStatus(job.status)) {
    const timeoutMs =
      options["timeout-ms"] != null ? Math.max(0, Number(options["timeout-ms"]) || 0) : DEFAULT_SEND_ACK_TIMEOUT_MS;
    const delivery = await deliverToRunningJob(workspaceRoot, job, message, timeoutMs);
    if (delivery.status !== "finished-undelivered" || options["no-follow-up"]) {
      outputCommandResult(delivery, renderDelivery(delivery), options.json);
      return;
    }
  }

  const stored = readStoredJob(workspaceRoot, job.id) ?? job;
  const threadId = stored.threadId ?? job.threadId ?? null;
  if (!threadId) {
    throw new Error(`Job ${job.id} has no Codex thread to continue.`);
  }

  const runtime = resolveTaskRuntime(options, workspaceRoot, runtimeFromStoredJob(stored));
  const name = normalizeJobName(options.name);
  const jobCwd = stored.cwd ?? stored.request?.cwd ?? workspaceRoot;
  const write = runtime.sandbox !== "read-only";
  const taskMetadata = buildTaskRunMetadata({ prompt: message, name, followUp: true });
  const followUp = buildTaskJob(workspaceRoot, taskMetadata, write, {
    name,
    runtime,
    cwd: jobCwd,
    parentJobId: job.id
  });
  const request = buildTaskRequest({
    cwd: jobCwd,
    prompt: message,
    write,
    resumeLast: false,
    resumeThreadId: threadId,
    jobId: followUp.id,
    name,
    ...runtime
  });

  if (options.background) {
    ensureCodexAvailable(jobCwd);
    const { payload } = enqueueBackgroundTask(jobCwd, followUp, request);
    outputCommandResult(
      { ...payload, parentJobId: job.id, threadId },
      renderQueuedTaskLaunch(payload),
      options.json
    );
    return;
  }

  await runForegroundCommand(followUp, (progress) => executeTaskRun({ ...request, onProgress: progress }), {
    json: options.json
  });
}

function renderWaitReport(payload) {
  const lines = ["# Codex Wait", ""];
  const active = payload.jobs.filter((job) => isActiveJobStatus(job.status)).length;
  lines.push(
    payload.timedOut
      ? `Timed out after ${Math.round(payload.timeoutMs / 1000)}s with ${active} of ${payload.jobs.length} job(s) still active.`
      : `${payload.jobs.length - active} of ${payload.jobs.length} job(s) finished.`,
    ""
  );
  lines.push("| Job | Status | Duration | Summary |", "| --- | --- | --- | --- |");
  for (const job of payload.jobs) {
    const cell = (value) => String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
    const label = job.name ? `${job.id} (${job.name})` : job.id;
    lines.push(`| ${cell(label)} | ${cell(job.status)} | ${cell(job.duration)} | ${cell(job.summary)} |`);
  }
  lines.push("", "Read a result with `result <job-id>` (add `--output <file>` to save it).");
  return `${lines.join("\n")}\n`;
}

// Blocks until the named jobs (default: this session's active jobs) finish.
// Exit codes: 0 all completed, 1 any failed or cancelled, 124 timed out.
async function handleWait(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["json", "any"]
  });

  const cwd = resolveCommandCwd(options);
  const timeoutMs =
    options["timeout-ms"] != null ? Math.max(0, Number(options["timeout-ms"]) || 0) : DEFAULT_WAIT_TIMEOUT_MS;
  const pollIntervalMs = Math.max(100, Number(options["poll-interval-ms"]) || DEFAULT_STATUS_POLL_INTERVAL_MS);

  const references = positionals.length > 0 ? positionals : buildStatusSnapshot(cwd).running.map((job) => job.id);
  if (references.length === 0) {
    outputCommandResult({ timedOut: false, timeoutMs, jobs: [] }, "No active Codex jobs to wait for.\n", options.json);
    return;
  }

  const snapshotAll = () => references.map((reference) => buildSingleJobSnapshot(cwd, reference).job);
  const isSettled = (jobs) =>
    options.any ? jobs.some((job) => !isActiveJobStatus(job.status)) : jobs.every((job) => !isActiveJobStatus(job.status));

  const deadline = Date.now() + timeoutMs;
  let jobs = snapshotAll();
  while (!isSettled(jobs) && Date.now() < deadline) {
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    jobs = snapshotAll();
  }

  const timedOut = !isSettled(jobs);
  const payload = {
    timedOut,
    timeoutMs,
    jobs: jobs.map((job) => ({
      id: job.id,
      name: job.name ?? null,
      status: job.status,
      phase: job.phase ?? null,
      title: job.title ?? null,
      summary: job.summary ?? null,
      duration: job.duration ?? job.elapsed ?? null,
      threadId: job.threadId ?? null,
      workspaceRoot: job.workspaceRoot ?? null,
      errorMessage: job.errorMessage ?? null
    }))
  };
  outputCommandResult(payload, renderWaitReport(payload), options.json);
  if (timedOut) {
    process.exitCode = WAIT_TIMEOUT_EXIT_CODE;
  } else if (jobs.some((job) => job.status === "failed" || job.status === "cancelled")) {
    process.exitCode = 1;
  }
}

async function handleTransfer(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "source"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const { payload, rendered } = await executeTransfer(cwd, {
    source: options.source
  });
  outputCommandResult(payload, rendered, options.json);
}

async function handleTaskWorker(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "job-id"]
  });

  if (!options["job-id"]) {
    throw new Error("Missing required --job-id for task-worker.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const storedJob = readStoredJob(workspaceRoot, options["job-id"]);
  if (!storedJob) {
    throw new Error(`No stored job found for ${options["job-id"]}.`);
  }

  const request = storedJob.request;
  if (!request || typeof request !== "object") {
    throw new Error(`Stored job ${options["job-id"]} is missing its task request payload.`);
  }

  const { logFile, progress } = createTrackedProgress(
    {
      ...storedJob,
      workspaceRoot
    },
    {
      logFile: storedJob.logFile ?? null
    }
  );
  await runTrackedJob(
    {
      ...storedJob,
      workspaceRoot,
      logFile
    },
    () =>
      executeTaskRun({
        ...request,
        onProgress: progress
      }),
    { logFile }
  );
}

async function handleStatus(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["json", "all", "wait"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  if (reference) {
    const snapshot = options.wait
      ? await waitForSingleJobSnapshot(cwd, reference, {
          timeoutMs: options["timeout-ms"],
          pollIntervalMs: options["poll-interval-ms"]
        })
      : buildSingleJobSnapshot(cwd, reference);
    outputCommandResult(snapshot, renderJobStatusReport(snapshot.job), options.json);
    return;
  }

  if (options.wait) {
    throw new Error("`status --wait` requires a job id.");
  }

  const report = buildStatusSnapshot(cwd, { all: options.all });
  outputResult(renderStatusPayload(report, options.json), options.json);
}

function extractRawJobOutput(job, storedJob) {
  const text =
    (typeof storedJob?.result?.rawOutput === "string" && storedJob.result.rawOutput) ||
    (typeof storedJob?.result?.codex?.stdout === "string" && storedJob.result.codex.stdout) ||
    storedJob?.rendered ||
    storedJob?.errorMessage ||
    job.errorMessage ||
    "";
  return text && !text.endsWith("\n") ? `${text}\n` : text;
}

function handleResult(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "output"],
    booleanOptions: ["json"],
    aliasMap: {
      o: "output"
    }
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveResultJob(cwd, reference);
  const storedJob = readStoredJob(workspaceRoot, job.id);

  if (options.output) {
    const outputFile = path.resolve(cwd, options.output);
    const text = extractRawJobOutput(job, storedJob);
    fs.mkdirSync(path.dirname(outputFile), { recursive: true });
    fs.writeFileSync(outputFile, text, "utf8");
    const written = { jobId: job.id, status: job.status, outputFile, bytes: Buffer.byteLength(text) };
    outputCommandResult(
      written,
      `Wrote ${written.bytes} bytes of ${job.id} (${job.status}) output to ${outputFile}.\n`,
      options.json
    );
    return;
  }

  const payload = {
    job,
    storedJob
  };

  outputCommandResult(payload, renderStoredJobResult(job, storedJob), options.json);
}

function handleTaskResumeCandidate(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const sessionId = getCurrentClaudeSessionId();
  const jobs = filterJobsForCurrentClaudeSession(sortJobsNewestFirst(listJobs(workspaceRoot)));
  const candidate = findLatestResumableTaskJob(jobs);

  const payload = {
    available: Boolean(candidate),
    sessionId,
    candidate:
      candidate == null
        ? null
        : {
            id: candidate.id,
            status: candidate.status,
            title: candidate.title ?? null,
            summary: candidate.summary ?? null,
            threadId: candidate.threadId,
            completedAt: candidate.completedAt ?? null,
            updatedAt: candidate.updatedAt ?? null
          }
  };

  const rendered = candidate
    ? `Resumable task found: ${candidate.id} (${candidate.status}).\n`
    : "No resumable task found for this session.\n";
  outputCommandResult(payload, rendered, options.json);
}

async function handleCancel(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveCancelableJob(cwd, reference, { env: process.env });
  const existing = readStoredJob(workspaceRoot, job.id) ?? {};
  const threadId = existing.threadId ?? job.threadId ?? null;
  const turnId = existing.turnId ?? job.turnId ?? null;

  const interrupt = await interruptAppServerTurn(cwd, { threadId, turnId });
  if (interrupt.attempted) {
    appendLogLine(
      job.logFile,
      interrupt.interrupted
        ? `Requested Codex turn interrupt for ${turnId} on ${threadId}.`
        : `Codex turn interrupt failed${interrupt.detail ? `: ${interrupt.detail}` : "."}`
    );
  }

  terminateProcessTree(job.pid ?? Number.NaN);
  appendLogLine(job.logFile, "Cancelled by user.");

  const completedAt = nowIso();
  const nextJob = {
    ...job,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    completedAt,
    errorMessage: "Cancelled by user."
  };

  writeJobFile(workspaceRoot, job.id, {
    ...existing,
    ...nextJob,
    cancelledAt: completedAt
  });
  upsertJob(workspaceRoot, {
    id: job.id,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    errorMessage: "Cancelled by user.",
    completedAt
  });

  const payload = {
    jobId: job.id,
    status: "cancelled",
    title: job.title,
    turnInterruptAttempted: interrupt.attempted,
    turnInterrupted: interrupt.interrupted
  };

  outputCommandResult(payload, renderCancelReport(nextJob), options.json);
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }

  switch (subcommand) {
    case "setup":
      await handleSetup(argv);
      break;
    case "review":
      await handleReview(argv);
      break;
    case "adversarial-review":
      await handleReviewCommand(argv, {
        reviewName: "Adversarial Review"
      });
      break;
    case "task":
      await handleTask(argv);
      break;
    case "send":
      await handleSend(argv);
      break;
    case "wait":
      await handleWait(argv);
      break;
    case "transfer":
      await handleTransfer(argv);
      break;
    case "task-worker":
      await handleTaskWorker(argv);
      break;
    case "status":
      await handleStatus(argv);
      break;
    case "result":
      handleResult(argv);
      break;
    case "task-resume-candidate":
      handleTaskResumeCandidate(argv);
      break;
    case "cancel":
      await handleCancel(argv);
      break;
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
