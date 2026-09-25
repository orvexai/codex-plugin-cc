#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import {
    buildPersistentTaskThreadName,
    resolveClosedInboxFile,
    DEFAULT_CONTINUE_PROMPT,
    findLatestTaskThread,
    getCodexAuthStatus,
    getCodexAvailability,
    getSessionRuntimeStatus,
    importExternalAgentSession,
    interruptAppServerTurn,
    waitForAppServerThreadStop,
    parseStructuredOutput,
    readOutputSchema,
    runAppServerReview,
    runAppServerTurn
  } from "./lib/codex.mjs";
import { resolveClaudeSessionPath } from "./lib/claude-session-transfer.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import { collectReviewContext, ensureGitRepository, resolveReviewTarget } from "./lib/git.mjs";
import { binaryAvailable, isSameProcess, terminateProcessTree, terminateProcessTreeVerified } from "./lib/process.mjs";
import { EXIT, exitCodeForJob, isActiveJobStatus } from "./lib/exit-codes.mjs";
import { reconcileJob, reconcileJobDeep } from "./lib/job-liveness.mjs";
import { ackControlOp, appendControlOp, readControlAck, resolveControlFile, waitForControlAck } from "./lib/control-channel.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import {
  generateJobId,
  getConfig,
  getGlobalConfig,
  listJobs,
  resolveJobFile,
  resolveJobInboxFile,
  setConfig,
  setGlobalConfig,
  upsertJob,
  upsertJobRecord,
  writeJobFile,
  markResultRead
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
  recordTaskWorker,
  spawnTaskWorker,
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
const WAIT_TIMEOUT_EXIT_CODE = EXIT.WAITER_TIMEOUT;

const USAGE = {
  setup: [
    "  node scripts/codex-companion.mjs setup [--enable-review-gate|--disable-review-gate] [--default-model <m|none>] [--default-effort <e|none>] [--default-sandbox <mode|none>] [--default-network <on|off|none>] [--global] [--install-cli [--bin-dir <dir>]] [--json]",
  ],
  review: [
    "  node scripts/codex-companion.mjs review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>]",
  ],
  "adversarial-review": [
    "  node scripts/codex-companion.mjs adversarial-review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [focus text]",
  ],
  task: [
    "  node scripts/codex-companion.mjs task [--background] [--write|--read-only|--full-access|--sandbox <read-only|workspace-write|danger-full-access>] [--network|--no-network] [--name <label>] [--resume-last|--resume|--fresh] [--model <model|spark>] [--effort <none|minimal|low|medium|high|xhigh>] [--cwd <dir>] [--prompt-file <file>] [prompt]",
  ],
  send: [
    "  node scripts/codex-companion.mjs send <job-id> [--background] [--timeout-ms <ms>] [--no-follow-up] [--prompt-file <file>] [message]",
  ],
  wait: [
    "  node scripts/codex-companion.mjs wait [job-id...] [--any] [--timeout-ms <ms>] [--json]",
  ],
  transfer: [
    "  node scripts/codex-companion.mjs transfer [--source <claude-jsonl>] [--json]",
  ],
  status: [
    "  node scripts/codex-companion.mjs status [job-id] [--all] [--json]",
  ],
  result: [
    "  node scripts/codex-companion.mjs result [job-id] [--output <file>] [--json]",
  ],
  cancel: [
    "  node scripts/codex-companion.mjs cancel [job-id] [--json]"
  ],
  "task-worker": ["  node scripts/codex-companion.mjs task-worker --job-id <id> [--cwd <dir>]"],
  "task-resume-candidate": ["  node scripts/codex-companion.mjs task-resume-candidate [--cwd <dir>] [--json]"]
};

function printUsage(subcommand) {
  const lines = subcommand ? USAGE[subcommand] ?? [] : Object.values(USAGE).flat();
  console.log(["Usage:", ...lines].join("\n"));
}

function printHelpIfRequested(options, subcommand) {
  if (!options.help) {
    return false;
  }
  printUsage(subcommand);
  return true;
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
    strict: config.strict ?? true,
    booleanOptions: [...(config.booleanOptions ?? []), "help"],
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

  if (printHelpIfRequested(options, "setup")) return;

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
  let snapshot = await buildSingleJobSnapshotDeep(cwd, reference);

  while (isActiveJobStatus(snapshot.job.status) && Date.now() < deadline) {
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    snapshot = await buildSingleJobSnapshotDeep(cwd, reference);
  }

  return {
    ...snapshot,
    waitTimedOut: isActiveJobStatus(snapshot.job.status),
    timeoutMs
  };
}

async function buildSingleJobSnapshotDeep(cwd, reference) {
  let snapshot = buildSingleJobSnapshot(cwd, reference);
  const stored = readStoredJob(snapshot.workspaceRoot, snapshot.job.id);
  if (stored && ["lost", "orphaned", "running", "queued"].includes(stored.status)) {
    await reconcileJobDeep(snapshot.workspaceRoot, stored);
    const latest = readStoredJob(snapshot.workspaceRoot, snapshot.job.id);
    if (latest && latest.status !== stored.status) snapshot = buildSingleJobSnapshot(cwd, reference);
  }
  return snapshot;
}

async function resolveLatestTrackedTaskThread(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const sessionId = getCurrentClaudeSessionId();
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot).map((job) => reconcileJob(workspaceRoot, job))).filter((job) => job.id !== options.excludeJobId);
  const visibleJobs = filterJobsForCurrentClaudeSession(jobs);
  const activeTask = visibleJobs.find((job) => job.jobClass === "task" && isActiveJobStatus(job.status));
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
    controlFile: request.jobId ? resolveControlFile(workspaceRoot, request.jobId) : null,
    workspaceRoot,
    jobId: request.jobId ?? null,
    onTransport: (transport) => {
      if (request.jobId) upsertJobRecord(workspaceRoot, request.jobId, (stored) => ({ ...stored, ...transport, workerStartTime: stored?.worker?.startTime ?? null }));
    },
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
    cancelledByControl: result.cancelledByControl ?? null,
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
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  return spawnTaskWorker({ scriptPath, cwd, workspaceRoot, jobId, env: process.env });
}

function enqueueBackgroundTask(cwd, job, request) {
  const { logFile } = createTrackedProgress(job);
  appendLogLine(logFile, "Queued for background execution.");

  const queuedRecord = {
    ...job,
    status: "queued",
    phase: "queued",
    logFile,
    request
  };
  writeJobFile(job.workspaceRoot, job.id, queuedRecord);
  upsertJob(job.workspaceRoot, queuedRecord);
  const worker = spawnDetachedTaskWorker(cwd, job.id);
  recordTaskWorker(job.workspaceRoot, job.id, worker);

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

  if (printHelpIfRequested(options, config.usageName ?? "review")) return;

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
    usageName: "review",
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

  if (printHelpIfRequested(options, "task")) return;

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

// True once the worker has closed the inbox without ever reading `messageId`,
// i.e. the message was appended after the turn stopped listening.
function missedClosedInbox(inboxFile, messageId) {
  const closedFile = resolveClosedInboxFile(inboxFile);
  if (!fs.existsSync(closedFile)) {
    return false;
  }
  return !fs.readFileSync(closedFile, "utf8").includes(`"id":"${messageId}"`);
}

async function deliverToRunningJob(workspaceRoot, job, text, timeoutMs) {
  job = reconcileJob(workspaceRoot, job);
  if (job.status === "lost") return { status: "lost", jobId: job.id, jobStatus: "lost" };
  const message = { id: generateJobId("msg"), text, createdAt: nowIso() };
  const inboxFile = resolveJobInboxFile(workspaceRoot, job.id);
  fs.appendFileSync(inboxFile, `${JSON.stringify(message)}\n`, "utf8");
  appendLogLine(job.logFile, `Queued ${message.id} for the running turn.`);

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const current = readStoredJob(workspaceRoot, job.id);
    if (current?.deliveredMessageIds?.includes(message.id)) {
      return { status: "delivered", jobId: job.id, messageId: message.id };
    }
    const reconciled = current ? reconcileJob(workspaceRoot, current) : current;
    if (reconciled && !isActiveJobStatus(reconciled.status)) {
      return { status: reconciled.status === "lost" ? "lost" : "finished-undelivered", jobId: job.id, messageId: message.id, jobStatus: reconciled.status };
    }
    if (missedClosedInbox(inboxFile, message.id)) {
      return { status: "finished-undelivered", jobId: job.id, messageId: message.id, jobStatus: "finishing" };
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

  if (printHelpIfRequested(options, "send")) return;

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

  if (["lost", "orphaned"].includes(job.status) && options["no-follow-up"]) {
    outputCommandResult({ status: job.status, jobId: job.id }, `${job.id} is ${job.status}.\n`, options.json);
    process.exitCode = EXIT.LOST;
    return;
  }

  if (isActiveJobStatus(job.status)) {
    const timeoutMs =
      options["timeout-ms"] != null ? Math.max(0, Number(options["timeout-ms"]) || 0) : DEFAULT_SEND_ACK_TIMEOUT_MS;
    const delivery = await deliverToRunningJob(workspaceRoot, job, message, timeoutMs);
    if (delivery.status === "lost" && options["no-follow-up"]) {
      outputCommandResult({ status: "lost", jobId: job.id }, `${job.id} is lost.\n`, options.json);
      return;
    }
    if (delivery.status !== "finished-undelivered" && delivery.status !== "lost") {
      outputCommandResult(delivery, renderDelivery(delivery), options.json);
      return;
    }
    if (options["no-follow-up"]) {
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

  if (printHelpIfRequested(options, "wait")) return;

  const cwd = resolveCommandCwd(options);
  const timeoutMs =
    options["timeout-ms"] != null ? Math.max(0, Number(options["timeout-ms"]) || 0) : DEFAULT_WAIT_TIMEOUT_MS;
  const pollIntervalMs = Math.max(100, Number(options["poll-interval-ms"]) || DEFAULT_STATUS_POLL_INTERVAL_MS);

  const references = positionals.length > 0 ? positionals : buildStatusSnapshot(cwd).running.map((job) => job.id);
  if (references.length === 0) {
    outputCommandResult({ timedOut: false, timeoutMs, jobs: [] }, "No active Codex jobs to wait for.\n", options.json);
    return;
  }

  const snapshotAll = async () => {
    const out = [];
    for (const reference of references) out.push((await buildSingleJobSnapshotDeep(cwd, reference)).job);
    return out;
  };
  const isSettled = (jobs) =>
    options.any ? jobs.some((job) => !isActiveJobStatus(job.status)) : jobs.every((job) => !isActiveJobStatus(job.status));

  const deadline = Date.now() + timeoutMs;
  let jobs = await snapshotAll();
  while (!isSettled(jobs) && Date.now() < deadline) {
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    jobs = await snapshotAll();
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
  } else {
    const codes = jobs.map((job) => exitCodeForJob(job.status, { mode: "wait" }));
    process.exitCode = codes.includes(EXIT.LOST)
      ? EXIT.LOST
      : codes.includes(EXIT.TIMED_OUT)
        ? EXIT.TIMED_OUT
        : codes.includes(EXIT.USAGE)
          ? EXIT.USAGE
          : codes.includes(EXIT.JOB_FAILED)
            ? EXIT.JOB_FAILED
            : EXIT.OK;
    for (const job of jobs) if (!isActiveJobStatus(job.status)) markResultRead(job.workspaceRoot ?? resolveWorkspaceRoot(cwd), job.id);
  }
}

async function handleTransfer(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "source"],
    booleanOptions: ["json"]
  });

  if (printHelpIfRequested(options, "transfer")) return;

  const cwd = resolveCommandCwd(options);
  const { payload, rendered } = await executeTransfer(cwd, {
    source: options.source
  });
  outputCommandResult(payload, rendered, options.json);
}

async function handleTaskWorker(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "job-id"],
    strict: false
  });

  if (printHelpIfRequested(options, "task-worker")) return;

  if (!options["job-id"]) {
    throw new Error("Missing required --job-id for task-worker.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  try {
    const storedJob = readStoredJob(workspaceRoot, options["job-id"]);
    if (!storedJob) throw new Error(`No stored job found for ${options["job-id"]}.`);
    const request = storedJob.request;
    if (!request || typeof request !== "object") throw new Error(`Stored job ${options["job-id"]} is missing its task request payload.`);

    const { logFile, progress } = createTrackedProgress(
      { ...storedJob, workspaceRoot },
      { logFile: storedJob.logFile ?? null }
    );
    const signalHandlers = [];
    let hardExitTimer = null;
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
      const handler = () => {
        try { appendControlOp(workspaceRoot, storedJob.id, { op: "cancel", reason: "worker-signal" }); } catch { /* best effort */ }
        if (!hardExitTimer) {
          hardExitTimer = setTimeout(() => process.exit(1), Number(process.env.CODEX_COMPANION_CANCEL_GRACE_MS) || 10000);
          hardExitTimer.unref?.();
        }
      };
      process.on(signal, handler);
      signalHandlers.push([signal, handler]);
    }
    await runTrackedJob(
      { ...storedJob, workspaceRoot, logFile },
      () => executeTaskRun({ ...request, onProgress: progress }),
      { logFile }
    );
    if (hardExitTimer) clearTimeout(hardExitTimer);
    for (const [signal, handler] of signalHandlers) process.off(signal, handler);
  } catch (error) {
    const stderrFile = path.join(path.dirname(resolveJobFile(workspaceRoot, options["job-id"])), `${options["job-id"]}.worker.err`);
    fs.appendFileSync(stderrFile, `${error instanceof Error ? error.stack : String(error)}\n`);
    throw error;
  }
}

async function handleStatus(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["json", "all", "wait"]
  });

  if (printHelpIfRequested(options, "status")) return;

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  if (reference) {
    const snapshot = options.wait
      ? await waitForSingleJobSnapshot(cwd, reference, {
          timeoutMs: options["timeout-ms"],
          pollIntervalMs: options["poll-interval-ms"]
        })
      : await buildSingleJobSnapshotDeep(cwd, reference);
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

  if (printHelpIfRequested(options, "result")) return;

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveResultJob(cwd, reference);
  markResultRead(workspaceRoot, job.id);
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

  if (printHelpIfRequested(options, "task-resume-candidate")) return;

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const sessionId = getCurrentClaudeSessionId();
  const jobs = filterJobsForCurrentClaudeSession(sortJobsNewestFirst(listJobs(workspaceRoot).map((job) => reconcileJob(workspaceRoot, job))));
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
    valueOptions: ["cwd", "grace-ms"],
    booleanOptions: ["json", "force"]
  });

  if (printHelpIfRequested(options, "cancel")) return;

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  let resolved;
  try {
    resolved = resolveCancelableJob(cwd, reference, { env: process.env });
  } catch (error) {
    const workspaceRoot = resolveWorkspaceRoot(cwd);
    const terminal = reference ? readStoredJob(workspaceRoot, reference) : null;
    if (!terminal || !["completed", "failed", "cancelled", "cancel-failed", "interrupted", "timed-out", "lost", "orphaned"].includes(terminal.status)) throw error;
    if (["lost", "orphaned"].includes(terminal.status)) {
      resolved = { workspaceRoot, job: terminal };
    } else {
      outputCommandResult({ jobId: terminal.id, status: terminal.status, title: terminal.title, cancel: terminal.cancel ?? null }, renderCancelReport(terminal), options.json);
      return;
    }
  }
  const { workspaceRoot, job } = resolved;
  const existing = readStoredJob(workspaceRoot, job.id) ?? {};
  const terminal = ["completed", "failed", "cancelled", "cancel-failed", "interrupted", "timed-out"].includes(existing.status ?? job.status);
  if (terminal) {
    const payload = { jobId: job.id, status: existing.status ?? job.status, title: job.title, cancel: existing.cancel ?? null };
    outputCommandResult(payload, renderCancelReport({ ...job, ...existing }), options.json);
    return;
  }

  const requestedAt = nowIso();
  const op = appendControlOp(workspaceRoot, job.id, { op: "cancel", reason: "user" });
  const worker = existing.worker ?? job.worker ?? {};
  const workerPid = Number(worker.pid ?? existing.pid ?? job.pid);
  const workerAlive = isSameProcess({ pid: workerPid, startTime: worker.startTime ?? null });
  const ackTimeout = Number(process.env.CODEX_COMPANION_CONTROL_ACK_MS) || 3000;
  let ack = workerAlive && existing.worker ? await waitForControlAck(workspaceRoot, job.id, op.id, ackTimeout, 50) : null;
  const graceMs = options.force || (!existing.threadId && !existing.worker) ? 0 : Math.max(0, Number(options["grace-ms"] ?? process.env.CODEX_COMPANION_CANCEL_GRACE_MS) || 10000);
  let interrupt = { attempted: false, interrupted: false, detail: null };
  let fallbackStopConfirmed = false;
  let fallbackWaited = false;
  if (!ack && existing.transport === "broker" && existing.threadId) {
    interrupt = await interruptAppServerTurn(cwd, {
      threadId: existing.threadId,
      turnId: existing.turnId ?? null,
      brokerEndpoint: existing.brokerEndpoint,
      noSpawn: true
    });
    if (interrupt.interrupted) {
      const stopped = await waitForAppServerThreadStop(cwd, { threadId: existing.threadId, brokerEndpoint: existing.brokerEndpoint, timeoutMs: graceMs });
      fallbackStopConfirmed = stopped.confirmed;
      fallbackWaited = true;
      if (!stopped.confirmed) interrupt.detail = stopped.detail;
    }
  }

  const waitUntil = Date.now() + (fallbackWaited || interrupt.errorCode === "broker-not-found" ? 0 : graceMs);
  let latest = readStoredJob(workspaceRoot, job.id) ?? existing;
  while (Date.now() < waitUntil) {
    ack = readControlAck(workspaceRoot, job.id, op.id) ?? ack;
    latest = readStoredJob(workspaceRoot, job.id) ?? latest;
    if (ack?.turnConfirmedStopped || ["cancelled", "completed", "failed"].includes(latest.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  ack = readControlAck(workspaceRoot, job.id, op.id) ?? ack;
  latest = readStoredJob(workspaceRoot, job.id) ?? latest;
  if (["completed", "failed"].includes(latest.status)) {
    outputCommandResult(
      { jobId: job.id, status: latest.status, title: job.title, cancel: latest.cancel ?? null, result: latest.result ?? null },
      renderCancelReport({ ...job, ...latest }),
      options.json
    );
    return;
  }
  let turnConfirmedStopped = Boolean(ack?.turnConfirmedStopped || fallbackStopConfirmed);

  let termination = { delivered: false, exited: !workerAlive, escalated: false, residualPids: [] };
  if (workerAlive) termination = await terminateProcessTreeVerified(workerPid, {
    group: worker.processGroup === true,
    graceMs: Number(process.env.CODEX_COMPANION_KILL_WAIT_MS) || 5000,
    killWaitMs: Number(process.env.CODEX_COMPANION_KILL_VERIFY_MS) || 1000
  });
  const workerExited = termination.exited || !isSameProcess({ pid: workerPid, startTime: worker.startTime ?? null });
  const appServerPid = Number(existing.transport === "direct" ? existing.appServerPid : NaN);
  const hasDirectAppServerPid = Number.isInteger(appServerPid) && appServerPid > 0;
  const appServerExited = existing.transport === "direct"
    ? hasDirectAppServerPid && !isSameProcess({ pid: appServerPid, startTime: existing.appServerStartTime ?? null })
    : true;
  if (existing.transport === "direct" && appServerExited) turnConfirmedStopped = true;
  if (!existing.threadId && !existing.transport && workerExited) turnConfirmedStopped = true;
  latest = readStoredJob(workspaceRoot, job.id) ?? latest;
  if (["completed", "failed"].includes(latest.status)) {
    outputCommandResult(
      { jobId: job.id, status: latest.status, title: job.title, cancel: latest.cancel ?? null, result: latest.result ?? null },
      renderCancelReport({ ...job, ...latest }),
      options.json
    );
    return;
  }
  const verified = turnConfirmedStopped && workerExited && (existing.transport !== "direct" || appServerExited);
  const cancel = {
    requestedAt,
    reason: "user",
    interruptDelivered: Boolean(ack?.interruptDelivered || interrupt.interrupted),
    turnConfirmedStopped,
    escalated: Boolean(termination.escalated),
    workerExited,
    appServerExited: existing.transport === "direct" ? appServerExited : null,
    residualPids: [...new Set([...(termination.residualPids ?? []), ...(!appServerExited && Number.isFinite(appServerPid) ? [appServerPid] : [])])],
    residualTurns: !turnConfirmedStopped && existing.transport === "broker" && existing.threadId
      ? [{ threadId: existing.threadId, turnId: existing.turnId ?? null, brokerEndpoint: existing.brokerEndpoint ?? null }]
      : [],
    detail: interrupt.errorCode === "broker-not-found" ? "broker-not-found" : !turnConfirmedStopped && existing.transport === "broker"
      ? "broker turn stop could not be verified"
      : interrupt.detail ?? (verified ? "Turn stop and worker exit verified." : "Cancellation could not be fully verified.")
  };
  const status = verified ? "cancelled" : "cancel-failed";
  const completedAt = nowIso();
  const nextJob = { ...existing, ...latest, status, phase: status, cancel, cancelReason: "user", pid: workerExited ? null : workerPid, completedAt, ...(verified ? {} : { errorMessage: "Cancellation could not be verified." }) };
  writeJobFile(workspaceRoot, job.id, nextJob);
  upsertJob(workspaceRoot, { id: job.id, status, phase: status, pid: nextJob.pid, completedAt, errorMessage: nextJob.errorMessage });
  appendLogLine(job.logFile, `Cancel ${status}: interrupt ${cancel.interruptDelivered ? "delivered" : "not confirmed"}; worker ${workerExited ? "exited" : "still alive"}; turn ${turnConfirmedStopped ? "stopped" : "not verified"}.`);
  const payload = { jobId: job.id, status, title: job.title, cancel, ...(!verified ? { error: { code: "cancel-failed", message: "Cancellation could not be verified." } } : {}) };
  outputCommandResult(payload, renderCancelReport(nextJob), options.json);
  if (!verified) process.exitCode = EXIT.USAGE;
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage(subcommand === "help" ? argv[0] : undefined);
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
        reviewName: "Adversarial Review",
        usageName: "adversarial-review"
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

let activeSubcommand = process.argv[2];
main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\nRun "${activeSubcommand || "codex-companion"} --help" for usage.\n`);
  process.exitCode = error?.exitCode ?? 1;
});
