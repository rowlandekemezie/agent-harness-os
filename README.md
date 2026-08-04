# Agent Harness OS

A secure, model-agnostic Agent OS for routing bounded coding tasks from Codex to pluggable AI workers.

Codex remains the orchestrator. It owns user intent, decomposition, architecture, review, and final acceptance. Agent Harness OS owns deterministic worker selection, isolated execution, evidence capture, fallback, and patch enforcement. Workers never share the caller's checkout and never apply their own changes.

```text
Codex authenticated with ChatGPT
        |
        | MCP over STDIO
        v
Agent Harness OS
        |
        +--> worker registry
        |      OpenAI-compatible: GPT, Qwen, Gemini, OpenRouter, Ollama
        |      Native: Anthropic Messages API
        |
        +--> deterministic capability and budget router
        |
        +--> fresh detached Git worktree per attempt
        |
        +--> private report + exact patch + SHA-256 digest
        |
        | separate approval-gated MCP call
        v
your clean checkout
```

## What version 0.2 provides

- A worker registry configured through `AGENT_OS_WORKERS_JSON`
- OpenAI-compatible and native Anthropic adapters
- Capability-based routing for research, implementation, testing, review, tool calling, long context, and private execution
- Deterministic `balanced`, `cost`, `latency`, and `quality` strategies
- Optional worker preference, cost ceiling, latency ceiling, and required capabilities per task
- Bounded fallback across eligible workers
- A fresh detached worktree for every fallback attempt
- Request, token, latency, and operator-supplied cost telemetry in run reports
- `list_workers` and `route_worker` MCP inspection tools
- Legacy `QWEN_*` configuration compatibility
- The hardened execution kernel from version 0.1: strict path authority, file-only worker tools, immutable patch validation, isolated command execution, artifact integrity, cancellation, bounded resources, and approval-separated application

This release intentionally does not add adaptive learning, durable distributed queues, memory, or a dashboard. Those layers should consume a proven routing and execution contract rather than redefine it.

## Security model

The system keeps authority in deterministic code:

1. Codex declares a bounded task and explicit allowed paths.
2. The router selects only configured workers that satisfy the task contract.
3. Each attempt starts from the same verified base commit in a new detached worktree.
4. The model receives bounded file tools, never a command-execution tool.
5. The harness captures the candidate patch before running Codex-declared validation commands.
6. Validation invalidates the run if it changes patch bytes, changed files, `HEAD`, or executable Git configuration.
7. Failed attempts and policy-violating patches cannot be applied.
8. Applying a completed patch is a separate destructive MCP call with repeated clean-tree, base-commit, artifact-integrity, and `git apply --check` gates.

Automatic fallback is limited to provider failures and bounded model-loop failures. It does not route around path-policy violations, failed deterministic validation, unsafe Git configuration, or an operator cancellation.

See [Architecture](docs/architecture.md) and [Threat model](docs/threat-model.md).

## Prerequisites

- Node.js 22 or newer
- Git 2.30 or newer
- Codex CLI, IDE extension, or another local MCP client
- At least one compatible worker endpoint
- Docker for the recommended isolated validation backend

Your ChatGPT subscription can authenticate Codex through its supported sign-in flow. Calls made to configured workers use those providers' own credentials and billing.

## Install

```bash
git clone https://github.com/rowlandekemezie/agent-harness-os.git
cd agent-harness-os
npm ci --ignore-scripts
npm run check
npm link
```

## Configure workers

Worker metadata is JSON. Credentials stay in separately named environment variables.

```bash
export OPENAI_API_KEY='...'
export ANTHROPIC_API_KEY='...'

export AGENT_OS_WORKERS_JSON="$(cat <<'JSON'
[
  {
    "id": "gpt-implementation",
    "adapter": "openai-compatible",
    "model": "your-openai-model-id",
    "baseUrl": "https://api.openai.com/v1",
    "apiKeyEnv": "OPENAI_API_KEY",
    "capabilities": ["research", "implementation", "testing", "review", "tool-calling", "long-context"],
    "priority": 90,
    "costTier": "high",
    "latencyTier": "standard",
    "maxOutputTokensParameter": "max_completion_tokens",
    "pricing": {
      "inputPerMillion": null,
      "outputPerMillion": null
    }
  },
  {
    "id": "claude-review",
    "adapter": "anthropic",
    "model": "your-anthropic-model-id",
    "baseUrl": "https://api.anthropic.com/v1",
    "apiKeyEnv": "ANTHROPIC_API_KEY",
    "capabilities": ["research", "implementation", "testing", "review", "tool-calling", "long-context"],
    "priority": 95,
    "costTier": "high",
    "latencyTier": "standard"
  }
]
JSON
)"
```

The values under `capabilities`, `costTier`, `latencyTier`, `priority`, and `pricing` are operator assertions. The router does not infer provider quality or silently rewrite them.

More examples, including Qwen, Gemini, OpenRouter, and Ollama, are in [Worker registry](docs/worker-registry.md) and [`examples/workers.json`](examples/workers.json).

### Legacy Qwen configuration

Existing single-worker deployments continue to work:

```bash
export QWEN_BASE_URL='https://your-provider.example/v1'
export QWEN_API_KEY='...'
export QWEN_MODEL='provider-model-id'
```

When `AGENT_OS_WORKERS_JSON` is absent, the harness creates one legacy worker named `qwen`.

## Routing

Global defaults:

```bash
export AGENT_OS_DEFAULT_WORKER='gpt-implementation'
export AGENT_OS_ROUTING_STRATEGY='balanced'
export AGENT_OS_MAX_WORKER_ATTEMPTS='3'
```

A task can override those defaults:

```json
{
  "routing": {
    "preferredWorkerId": null,
    "requiredCapabilities": ["long-context"],
    "strategy": "quality",
    "maxCostTier": "high",
    "maxLatencyTier": "standard",
    "allowFallback": true,
    "maxAttempts": 2
  }
}
```

Use `route_worker` to preview selection without contacting a model:

```json
{
  "mode": "implementation",
  "routing": {
    "strategy": "cost",
    "maxCostTier": "medium"
  }
}
```

An explicit `preferredWorkerId` is a strict contract: the call fails if that worker is absent, unconfigured, or lacks the required capabilities.

## Configure isolated validation

Docker is recommended:

```bash
export AGENT_HARNESS_EXECUTION_BACKEND='docker'
export AGENT_HARNESS_DOCKER_IMAGE='node:22-bookworm-slim@sha256:<digest>'
export AGENT_HARNESS_REQUIRE_PINNED_DOCKER_IMAGE='true'
export AGENT_HARNESS_DOCKER_NETWORK='none'
```

The worker never chooses commands. Codex declares validation commands before delegation, and the harness runs them only after the model loop.

## Connect to Codex

Generate a configuration block:

```bash
agent-harness-os codex-config
```

The generated server name is `agent_os`. Run the command with `AGENT_OS_WORKERS_JSON` loaded; it forwards common provider credential names and every custom `apiKeyEnv` or `headerEnv` name declared by that registry. Regenerate the block whenever those names change.

The six MCP tools are:

- `health_check`: configuration and runtime readiness
- `list_workers`: redacted worker registry metadata
- `route_worker`: deterministic route preview
- `delegate_to_worker`: isolated execution and evidence generation
- `get_worker_run`: persisted report retrieval
- `apply_worker_patch`: approval-gated patch application

## Operating workflow

1. Codex inspects the repository and defines acceptance criteria.
2. Codex optionally previews routing.
3. Codex delegates one bounded task.
4. Agent Harness OS selects a worker and executes it in an isolated worktree.
5. Eligible provider/model failures may fall back to another worker in a new worktree.
6. Codex reviews the final report, selected worker, prior attempts, validation evidence, changed files, and patch.
7. Codex invokes `apply_worker_patch` only for an acceptable completed run.
8. Codex reruns validation in the real checkout and reviews the final diff.

## Development

```bash
npm ci --ignore-scripts
npm run check
npm pack --dry-run --ignore-scripts
```

The project uses strict TypeScript and Node's built-in test runner. Security or routing changes require adversarial regression tests.

## Current boundary

Agent Harness OS is a local, durable-artifact coding runtime, not yet a distributed orchestration platform. It does not currently provide:

- persistent task queues across machines
- dynamic provider discovery
- automatic benchmark-based capability updates
- self-modifying routing weights
- long-term semantic memory
- a web dashboard
- autonomous merge or deployment

Those are subsequent layers. The current release establishes the worker contract, routing contract, fallback semantics, evidence model, and authority boundaries they must preserve.
