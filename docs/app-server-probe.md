# Codex 0.157.0 app-server protocol probe

Run on 2026-09-25 with `codex-cli 0.157.0`, authenticated using the existing CLI login. `node scripts/probe-app-server.mjs --json` reproduces the live requests and writes generated types into a fresh temporary directory. It never writes user Codex configuration; the sandbox-fallback probes write scratch config files under isolated temporary `CODEX_HOME` directories. Normal live turns use explicitly read-only threads. The omitted-sandbox probes are ephemeral and never start a turn.

Static definitions came from:

```sh
codex app-server generate-ts --out <tmpdir> --experimental
```

The relevant generated files are `v2/ThreadStartParams.ts`, `v2/ThreadStartResponse.ts`, `v2/ThreadReadParams.ts`, `v2/ThreadReadResponse.ts`, `v2/Thread.ts`, `v2/ThreadResumeParams.ts`, `v2/TurnSteerParams.ts`, `v2/ModelListParams.ts`, `v2/ModelListResponse.ts`, `v2/ConfigReadParams.ts`, `v2/ConfigReadResponse.ts`, `v2/ConfigLayer.ts`, `v2/ReviewStartParams.ts`, and the notification type files listed in Fixture shapes. Generated `ClientRequest.ts` includes `thread/read`, `thread/resume`, `turn/steer`, `model/list`, `config/read`, `skills/list`, `hooks/list`, and `review/start`; it does not include `thread/unload`.

## 1. `model/list`

Request: JSON-RPC `model/list` with `{"limit":100}`.

Complete live response from `model/list` (all data fields and rows):

```json
{
  "data": [
    {
      "id": "gpt-6-astra",
      "model": "gpt-6-astra",
      "upgrade": null,
      "upgradeInfo": null,
      "availabilityNux": {
        "message": "This is GPT-6, a new generation of intelligence. Astra is state-of-the-art in coding, computer use, science, and professional work. Give it a hard problem, a half-formed idea, or anything you've been meaning to build. See where it takes you."
      },
      "displayName": "GPT-6-Astra",
      "description": "Frontier intelligence for the most demanding work.",
      "modelSpecialty": null,
      "hidden": false,
      "supportedReasoningEfforts": [
        {
          "reasoningEffort": "low",
          "description": "Fast responses with lighter reasoning"
        },
        {
          "reasoningEffort": "medium",
          "description": "Balances speed and reasoning depth for everyday tasks"
        },
        {
          "reasoningEffort": "high",
          "description": "Greater reasoning depth for complex problems"
        },
        {
          "reasoningEffort": "xhigh",
          "description": "Extra high reasoning depth for complex problems"
        },
        {
          "reasoningEffort": "max",
          "description": "Maximum reasoning depth for the hardest problems"
        },
        {
          "reasoningEffort": "ultra",
          "description": "Maximum reasoning with automatic task delegation"
        }
      ],
      "defaultReasoningEffort": "medium",
      "inputModalities": [
        "text",
        "image"
      ],
      "supportsPersonality": false,
      "multiAgentVersion": "v2",
      "additionalSpeedTiers": [
        "fast"
      ],
      "serviceTiers": [
        {
          "id": "priority",
          "name": "Fast",
          "description": "2x speed, increased usage"
        }
      ],
      "defaultServiceTier": null,
      "availableAccessPrograms": {
        "cyber": [
          "standard"
        ]
      },
      "isDefault": true
    },
    {
      "id": "gpt-6-sol",
      "model": "gpt-6-sol",
      "upgrade": null,
      "upgradeInfo": null,
      "availabilityNux": null,
      "displayName": "GPT-6-Sol",
      "description": "Workhorse model for coding and everyday work.",
      "modelSpecialty": null,
      "hidden": false,
      "supportedReasoningEfforts": [
        {
          "reasoningEffort": "low",
          "description": "Fast responses with lighter reasoning"
        },
        {
          "reasoningEffort": "medium",
          "description": "Balances speed and reasoning depth for everyday tasks"
        },
        {
          "reasoningEffort": "high",
          "description": "Greater reasoning depth for complex problems"
        },
        {
          "reasoningEffort": "xhigh",
          "description": "Extra high reasoning depth for complex problems"
        },
        {
          "reasoningEffort": "max",
          "description": "Maximum reasoning depth for the hardest problems"
        },
        {
          "reasoningEffort": "ultra",
          "description": "Maximum reasoning with automatic task delegation"
        }
      ],
      "defaultReasoningEffort": "medium",
      "inputModalities": [
        "text",
        "image"
      ],
      "supportsPersonality": false,
      "multiAgentVersion": "v2",
      "additionalSpeedTiers": [
        "fast"
      ],
      "serviceTiers": [
        {
          "id": "priority",
          "name": "Fast",
          "description": "1.5x speed"
        }
      ],
      "defaultServiceTier": null,
      "availableAccessPrograms": {
        "cyber": [
          "standard"
        ]
      },
      "isDefault": false
    },
    {
      "id": "gpt-6-luna",
      "model": "gpt-6-luna",
      "upgrade": null,
      "upgradeInfo": null,
      "availabilityNux": null,
      "displayName": "GPT-6-Luna",
      "description": "Fast and affordable model for easier tasks.",
      "modelSpecialty": null,
      "hidden": false,
      "supportedReasoningEfforts": [
        {
          "reasoningEffort": "low",
          "description": "Fast responses with lighter reasoning"
        },
        {
          "reasoningEffort": "medium",
          "description": "Balances speed and reasoning depth for everyday tasks"
        },
        {
          "reasoningEffort": "high",
          "description": "Greater reasoning depth for complex problems"
        },
        {
          "reasoningEffort": "xhigh",
          "description": "Extra high reasoning depth for complex problems"
        },
        {
          "reasoningEffort": "max",
          "description": "Maximum reasoning depth for the hardest problems"
        }
      ],
      "defaultReasoningEffort": "medium",
      "inputModalities": [
        "text",
        "image"
      ],
      "supportsPersonality": false,
      "multiAgentVersion": "v2",
      "additionalSpeedTiers": [
        "fast"
      ],
      "serviceTiers": [
        {
          "id": "priority",
          "name": "Fast",
          "description": "1.5x speed"
        }
      ],
      "defaultServiceTier": null,
      "availableAccessPrograms": {
        "cyber": [
          "standard"
        ]
      },
      "isDefault": false
    },
    {
      "id": "gpt-5.6-sol",
      "model": "gpt-5.6-sol",
      "upgrade": null,
      "upgradeInfo": null,
      "availabilityNux": null,
      "displayName": "GPT-5.6-Sol",
      "description": "Older coding model for complex work.",
      "modelSpecialty": null,
      "hidden": false,
      "supportedReasoningEfforts": [
        {
          "reasoningEffort": "low",
          "description": "Fast responses with lighter reasoning"
        },
        {
          "reasoningEffort": "medium",
          "description": "Balances speed and reasoning depth for everyday tasks"
        },
        {
          "reasoningEffort": "high",
          "description": "Greater reasoning depth for complex problems"
        },
        {
          "reasoningEffort": "xhigh",
          "description": "Extra high reasoning depth for complex problems"
        },
        {
          "reasoningEffort": "max",
          "description": "Maximum reasoning depth for the hardest problems"
        },
        {
          "reasoningEffort": "ultra",
          "description": "Maximum reasoning with automatic task delegation"
        }
      ],
      "defaultReasoningEffort": "low",
      "inputModalities": [
        "text",
        "image"
      ],
      "supportsPersonality": false,
      "multiAgentVersion": "v2",
      "additionalSpeedTiers": [
        "fast"
      ],
      "serviceTiers": [
        {
          "id": "priority",
          "name": "Fast",
          "description": "1.5x speed, increased usage"
        }
      ],
      "defaultServiceTier": null,
      "availableAccessPrograms": {
        "cyber": [
          "standard"
        ]
      },
      "isDefault": false
    },
    {
      "id": "gpt-5.6-terra",
      "model": "gpt-5.6-terra",
      "upgrade": null,
      "upgradeInfo": null,
      "availabilityNux": null,
      "displayName": "GPT-5.6-Terra",
      "description": "Older balanced model for straightforward work.",
      "modelSpecialty": null,
      "hidden": false,
      "supportedReasoningEfforts": [
        {
          "reasoningEffort": "low",
          "description": "Fast responses with lighter reasoning"
        },
        {
          "reasoningEffort": "medium",
          "description": "Balances speed and reasoning depth for everyday tasks"
        },
        {
          "reasoningEffort": "high",
          "description": "Greater reasoning depth for complex problems"
        },
        {
          "reasoningEffort": "xhigh",
          "description": "Extra high reasoning depth for complex problems"
        },
        {
          "reasoningEffort": "max",
          "description": "Maximum reasoning depth for the hardest problems"
        },
        {
          "reasoningEffort": "ultra",
          "description": "Maximum reasoning with automatic task delegation"
        }
      ],
      "defaultReasoningEffort": "medium",
      "inputModalities": [
        "text",
        "image"
      ],
      "supportsPersonality": false,
      "multiAgentVersion": "v2",
      "additionalSpeedTiers": [
        "fast"
      ],
      "serviceTiers": [
        {
          "id": "priority",
          "name": "Fast",
          "description": "1.5x speed, increased usage"
        }
      ],
      "defaultServiceTier": null,
      "availableAccessPrograms": {
        "cyber": [
          "standard"
        ]
      },
      "isDefault": false
    },
    {
      "id": "gpt-5.6-luna",
      "model": "gpt-5.6-luna",
      "upgrade": null,
      "upgradeInfo": null,
      "availabilityNux": null,
      "displayName": "GPT-5.6-Luna",
      "description": "Older fast and efficient model.",
      "modelSpecialty": null,
      "hidden": false,
      "supportedReasoningEfforts": [
        {
          "reasoningEffort": "low",
          "description": "Fast responses with lighter reasoning"
        },
        {
          "reasoningEffort": "medium",
          "description": "Balances speed and reasoning depth for everyday tasks"
        },
        {
          "reasoningEffort": "high",
          "description": "Greater reasoning depth for complex problems"
        },
        {
          "reasoningEffort": "xhigh",
          "description": "Extra high reasoning depth for complex problems"
        },
        {
          "reasoningEffort": "max",
          "description": "Maximum reasoning depth for the hardest problems"
        }
      ],
      "defaultReasoningEffort": "medium",
      "inputModalities": [
        "text",
        "image"
      ],
      "supportsPersonality": false,
      "multiAgentVersion": "v1",
      "additionalSpeedTiers": [
        "fast"
      ],
      "serviceTiers": [
        {
          "id": "priority",
          "name": "Fast",
          "description": "1.5x speed, increased usage"
        }
      ],
      "defaultServiceTier": null,
      "availableAccessPrograms": {
        "cyber": [
          "standard"
        ]
      },
      "isDefault": false
    },
    {
      "id": "gpt-5.5",
      "model": "gpt-5.5",
      "upgrade": "gpt-5.6-sol",
      "upgradeInfo": {
        "model": "gpt-5.6-sol",
        "upgradeCopy": null,
        "modelLink": null,
        "migrationMarkdown": "GPT-5.5 retires on October 14, 2026. Switch to GPT-5.6 Sol to continue working in Codex.",
        "retirementAt": 1792004400
      },
      "availabilityNux": null,
      "displayName": "GPT-5.5",
      "description": "Legacy coding model.",
      "modelSpecialty": null,
      "hidden": false,
      "supportedReasoningEfforts": [
        {
          "reasoningEffort": "low",
          "description": "Fast responses with lighter reasoning"
        },
        {
          "reasoningEffort": "medium",
          "description": "Balances speed and reasoning depth for everyday tasks"
        },
        {
          "reasoningEffort": "high",
          "description": "Greater reasoning depth for complex problems"
        },
        {
          "reasoningEffort": "xhigh",
          "description": "Extra high reasoning depth for complex problems"
        }
      ],
      "defaultReasoningEffort": "medium",
      "inputModalities": [
        "text",
        "image"
      ],
      "supportsPersonality": false,
      "multiAgentVersion": null,
      "additionalSpeedTiers": [
        "fast"
      ],
      "serviceTiers": [
        {
          "id": "priority",
          "name": "Fast",
          "description": "1.5x speed, increased usage"
        }
      ],
      "defaultServiceTier": null,
      "availableAccessPrograms": {
        "cyber": [
          "standard"
        ]
      },
      "isDefault": false
    }
  ],
  "nextCursor": null
}
```

Verdict: the response is `data[]` plus nullable `nextCursor`; each model provides `id`, `model`, `displayName`, `supportedReasoningEfforts`, `defaultReasoningEffort`, and `isDefault` among its metadata.

## 2. `config/read` layers and values

Request: JSON-RPC `config/read` with `{"includeLayers":true,"cwd":"<fresh temp directory>"}`.

Trimmed response:

```json
{
  "config": {"model":"gpt-6-luna","sandbox_mode":"danger-full-access","approval_policy":"never"},
  "origins": {
    "model": {"name":{"type":"user","file":"/home/crew/.codex/config.toml","profile":null}},
    "sandbox_mode": {"name":{"type":"user","file":"/home/crew/.codex/config.toml","profile":null}},
    "approval_policy": {"name":{"type":"user","file":"/home/crew/.codex/config.toml","profile":null}}
  },
  "layers": [
    {"name":{"type":"user","file":"/home/crew/.codex/config.toml","profile":null},"version":"sha256:42146b8f3123c2a2fe9bdb1e5346f52a62fb28364bde3689b2934945cca176c3","disabledReason":null,"config":{"model":"gpt-6-luna","model_reasoning_effort":"high","approval_policy":"never","sandbox_mode":"danger-full-access","…":"other user config keys omitted"}},
    {"name":{"type":"system","file":"/etc/codex/config.toml"},"version":"sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a","disabledReason":null,"config":{}}
  ]
}
```

Verdict: `config` is effective merged config; `origins` maps individual dotted keys to the layer source and version. `layers` is present when requested and names user and system sources. This host's effective `model`, `sandbox_mode`, and `approval_policy` came from its user `config.toml`.

## 3. `thread/start` without `sandbox`

The script creates two fresh scratch homes inside its temp root. Each contains only the shown config, and the app-server is launched with `CODEX_HOME` set to that scratch home:

```sh
CODEX_HOME=<temporary isolated home> codex app-server
```

First scratch config:

```toml
sandbox_mode = "workspace-write"
approval_policy = "never"
```

Second scratch config:

```toml
sandbox_mode = "read-only"
approval_policy = "never"
```

For each server, after `initialize` / `initialized`, the exact request is `thread/start` with no sandbox parameter:

```json
{"cwd":"<fresh temp cwd>","approvalPolicy":"never","ephemeral":true}
```

Trimmed responses:

```json
{"sandbox":{"type":"workspaceWrite","writableRoots":[],"networkAccess":false,"excludeTmpdirEnvVar":false,"excludeSlashTmp":false},"approvalPolicy":"never","cwd":"<fresh temp cwd>","thread":{"ephemeral":true,"path":null}}
{"sandbox":{"type":"readOnly","networkAccess":false},"approvalPolicy":"never","cwd":"<fresh temp cwd>","thread":{"ephemeral":true,"path":null}}
```

Verdict: PASS. Both live starts inherited their isolated `config.toml` sandbox values. The responses were ephemeral, no turn was started, and no credentials were copied from the user's Codex home.

## 4. `thread/start` with explicit values and `developerInstructions`

Request: JSON-RPC `thread/start` with `{"cwd":"<fresh temp directory>","sandbox":"read-only","approvalPolicy":"never","developerInstructions":"For this probe, answer exactly: DEV-INSTRUCTIONS-LOADED.","ephemeral":false}`. Persistence is needed only for the separate resume-across-process check; this thread has an explicit read-only sandbox.

Trimmed response:

```json
{"model":"gpt-6-luna","reasoningEffort":"high","sandbox":{"type":"readOnly","networkAccess":false},"approvalPolicy":"never","cwd":"<fresh temp directory>","thread":{"id":"<probe thread>","path":"<rollout path>","ephemeral":false}}
```

Visibility request on that explicitly read-only thread: `turn/start` with `{"threadId":"<probe thread>","input":[{"type":"text","text":"Reply with exactly: OK"}]}`.

Trimmed `thread/read` result after completion:

```json
{"thread":{"status":{"type":"idle"},"turns":[{"id":"<probe turn>","status":"completed","items":[{"type":"agentMessage","text":"DEV-INSTRUCTIONS-LOADED"}]}]}}
```

Verdict: generated `ThreadStartParams` includes `developerInstructions?: string | null`; the explicit value was accepted and affected this read-only probe turn.

## 5. `thread/read`: path, turns, and running status

Requests: first JSON-RPC `thread/read` with `{"threadId":"<probe thread>"}`, then `turn/start` as above, followed by `thread/read` with `{"threadId":"<probe thread>","includeTurns":true}`.

The initial `includeTurns:true` read before any turns returned `{"code":-32601,"message":"list_turns is not supported yet"}`. During the active turn, the trimmed response was:

```json
{"thread":{"path":"<rollout path>","status":{"type":"active","activeFlags":[]},"turns":[{"id":"<probe turn>","status":"inProgress"}]}}
```

After completion it returned `status:{"type":"idle"}` and the same turn with `status:"completed"`. A read after closing that app-server returned the same rollout path and completed turn. The turn ran only on the thread whose `thread/start` response reported `sandbox:{"type":"readOnly","networkAccess":false}`.

Verdict: `ThreadReadResponse` wraps `thread`; `Thread.path` is a nullable rollout path, and `Thread.status` plus `Thread.turns[].status` expose live state. On this build, `includeTurns:true` errored before a turn existed but worked during and after a turn.

## 6. `thread/unload` or equivalent

Request: JSON-RPC `thread/unload` with `{"threadId":"<probe thread>"}`.

Trimmed error:

```json
{"code":-32600,"message":"Invalid request: unknown variant `thread/unload` …"}
```

Equivalent check: close the first `codex app-server` process, start another with `codex app-server`, initialize, and send `thread/resume` with `{"threadId":"<probe thread>","cwd":"<same temp directory>"}`. It returned the same thread ID, rollout path, and completed turn with `status:{"type":"idle"}`, but its response reported `sandbox:{"type":"dangerFullAccess"}` under this host's config.

Verdict: no `thread/unload` RPC exists; `thread/resume` works from another app-server process after the prior client/server has closed. Because the resumed response did not report read-only, the probe runs no further turn on that resumed thread. Native review is tested on a separate ephemeral thread explicitly started read-only.

Cleanup request: after all persistent-thread probes, the runner verifies `thread/queue/list` is empty and `thread/read` shows no active turn, then sends `thread/delete` with `{"threadId":"<probe thread>"}`. The live probe returned `{}` and the recorded rollout path no longer existed. If those safety checks or deletion verification fail, the runner records a cleanup failure and exits nonzero.

## 7. `turn/steer` on a native review turn

First start an ephemeral thread with `{"cwd":"<fresh temp directory>","sandbox":"read-only","approvalPolicy":"never","ephemeral":true}`. Then send `review/start` with `{"threadId":"<ephemeral read-only thread>","target":{"type":"custom","instructions":"Reply exactly OK without using tools."}}`; send `turn/steer` with the returned `expectedTurnId` and input `[{"type":"text","text":"Review turn steering probe."}]`.

Trimmed response:

```json
{"code":-32600,"message":"cannot steer a review turn","data":{"codexErrorInfo":{"activeTurnNotSteerable":{"turnKind":"review"}}}}
```

Verdict: a native review turn is explicitly not steerable. `TurnSteerParams` requires `expectedTurnId`.
The test turn was interrupted immediately after the rejected steer request.

## 8. Per-thread config for skills, hooks, and AGENTS.md

Inspection requests: `skills/list` with `{"cwds":["<fresh temp directory>"]}` returned 59 skills; `hooks/list` with the same cwd returned 4 hooks. Generated `Config` has `features` and `project_doc_fallback_filenames`; generated `ThreadStartParams.config` accepts a JSON object. The protocol also exposes `skills/config/write`, but this probe did not call it.

Candidate thread starts (each succeeded) and resulting instruction source:

```json
[
  {"feature":"skills","config":{"skills":{"enabled":false}},"instructionSources":["/home/crew/.codex/AGENTS.md"]},
  {"feature":"hooks","config":{"features":{"hooks":false}},"instructionSources":["/home/crew/.codex/AGENTS.md"]},
  {"feature":"AGENTS.md fallback","config":{"project_doc_fallback_filenames":[]},"instructionSources":["/home/crew/.codex/AGENTS.md"]}
]
```

Verdict: these candidate objects are accepted by `thread/start`, but no per-thread disable effect was verified. `skills/list` and `hooks/list` are cwd/global inventory requests, not thread-specific policy controls. The AGENTS.md candidate did not suppress the observed user AGENTS.md source. Treat a per-thread disable key for any of these as unverified; `features.hooks` is also reported as a user config value by `config/read`, not evidence of a thread-only switch.

## 9. Unknown `turn/interrupt`

Request: JSON-RPC `turn/interrupt` with `{"threadId":"<explicit read-only probe thread>","turnId":"00000000-0000-4000-8000-000000000000"}` after the probe turn had completed.

Response:

```json
{"code":-32600,"message":"no active turn to interrupt"}
```

Verdict: interrupting without an active turn fails with an explicit protocol error.

## Fixture shapes

The snippets below are copy-paste-ready JSON examples based on the generated `v2` definitions and live responses. IDs and sample contents are illustrative.

`model/list` (`ModelListParams`, `ModelListResponse`):

```json
{"request":{"method":"model/list","params":{"limit":100}},"response":{"data":[{"id":"gpt-6-luna","model":"gpt-6-luna","displayName":"GPT-6-Luna","hidden":false,"supportedReasoningEfforts":[{"reasoningEffort":"low","description":"Fast responses with lighter reasoning"},{"reasoningEffort":"medium","description":"Balances speed and reasoning depth for everyday work"}],"defaultReasoningEffort":"medium","isDefault":true}],"nextCursor":null}}
```

`config/read` (`ConfigReadParams`, `ConfigReadResponse`, `ConfigLayer`):

```json
{"request":{"method":"config/read","params":{"includeLayers":true,"cwd":"/tmp/probe"}},"response":{"config":{"model":"gpt-6-luna","approval_policy":"never","sandbox_mode":"read-only"},"origins":{"model":{"name":{"type":"user","file":"/home/user/.codex/config.toml","profile":null},"version":"sha256:example"}},"layers":[{"name":{"type":"user","file":"/home/user/.codex/config.toml","profile":null},"version":"sha256:example","config":{"model":"gpt-6-luna"},"disabledReason":null}]}}
```

`thread/read` (`ThreadReadParams`, `ThreadReadResponse`, `Thread`):

```json
{"request":{"method":"thread/read","params":{"threadId":"00000000-0000-4000-8000-000000000001","includeTurns":true}},"response":{"thread":{"id":"00000000-0000-4000-8000-000000000001","path":"/home/user/.codex/sessions/2026/09/25/rollout-example.jsonl","status":{"type":"active","activeFlags":[]},"turns":[{"id":"00000000-0000-4000-8000-000000000002","status":"inProgress","items":[]}]}}}
```

`ThreadStartResponse` (`v2/ThreadStartResponse.ts`; corresponding params in `v2/ThreadStartParams.ts`):

```json
{"thread":{"id":"00000000-0000-4000-8000-000000000001","path":null,"ephemeral":true},"model":"gpt-6-luna","modelProvider":"openai","serviceTier":null,"disabledPluginIds":[],"cwd":"/tmp/probe","runtimeWorkspaceRoots":["/tmp/probe"],"instructionSources":[],"approvalPolicy":"never","approvalsReviewer":"user","sandbox":{"type":"readOnly","networkAccess":false},"activePermissionProfile":null,"reasoningEffort":"medium","multiAgentMode":"explicitRequestOnly"}
```

Notification examples from `v2/CommandExecutionOutputDeltaNotification.ts`, `v2/TurnDiffUpdatedNotification.ts`, `v2/TurnPlanUpdatedNotification.ts`, `v2/ThreadTokenUsageUpdatedNotification.ts`, and `v2/TurnPlanStep.ts`:

```json
{"method":"item/commandExecution/outputDelta","params":{"threadId":"00000000-0000-4000-8000-000000000001","turnId":"00000000-0000-4000-8000-000000000002","itemId":"item-1","delta":"hello\n"}}
```

```json
{"method":"turn/diff/updated","params":{"threadId":"00000000-0000-4000-8000-000000000001","turnId":"00000000-0000-4000-8000-000000000002","diff":"diff --git a/a.txt b/a.txt\n"}}
```

```json
{"method":"turn/plan/updated","params":{"threadId":"00000000-0000-4000-8000-000000000001","turnId":"00000000-0000-4000-8000-000000000002","explanation":null,"plan":[{"step":"Inspect inputs","status":"inProgress"}]}}
```

```json
{"method":"thread/tokenUsage/updated","params":{"threadId":"00000000-0000-4000-8000-000000000001","turnId":"00000000-0000-4000-8000-000000000002","tokenUsage":{"total":{"totalTokens":120,"inputTokens":80,"cachedInputTokens":20,"cacheWriteInputTokens":0,"outputTokens":40,"reasoningOutputTokens":0},"last":{"totalTokens":120,"inputTokens":80,"cachedInputTokens":20,"cacheWriteInputTokens":0,"outputTokens":40,"reasoningOutputTokens":0},"modelContextWindow":null}}}
```
