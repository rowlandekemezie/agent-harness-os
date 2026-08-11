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
        +--> durable workflow service + event journal
        |
        +--> worker registry
        |      Subscription-backed: local Codex CLI via ChatGPT sign-in
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

## What Agent Harness OS provides

- A worker registry configured through `AGENT_OS_WORKERS_JSON`
- Optional role profiles configured through `AGENT_OS_WORKER_PROFILES_JSON`
- Restrictive organization, repository, and task policies with digest-bound provenance
- ChatGPT-authenticated Codex CLI, OpenAI-compatible, and native Anthropic adapters
- Capability-based routing for research, implementation, testing, review, tool calling, long context, and private execution
- Deterministic `balanced`, `cost`, `latency`, and `quality` strategies
- Bounded per-repository performance, latency, and cost evidence for eligible-worker scoring
- Optional worker preference, cost ceiling, latency ceiling, and required capabilities per task
- Bounded fallback across eligible workers
- A fresh detached worktree for every fallback attempt
- Request, token, latency, and operator-supplied cost telemetry in run reports
- Durable task IDs and validated append-only timelines across fallback attempts
- Durable plan, implement, test, review, repair, dependency, and approval workflows
- Mandatory deterministic evaluation with optional independent reviewer results
- Bounded task-history listing and timeline inspection
- `list_workers` and `route_worker` MCP inspection tools
- Legacy `QWEN_*` configuration compatibility
- The hardened execution kernel from version 0.1: strict path authority, file-only worker tools, immutable patch validation, isolated command execution, artifact integrity, cancellation, bounded resources, and approval-separated application

Historical evidence adjusts deterministic scores; it does not learn or rewrite
weights, capabilities, or policy. Workflows are local artifact-backed state
machines, not distributed queues. This release does not add semantic memory or
a dashboard.

## Security model

The system keeps authority in deterministic code:

1. Codex declares a bounded task and explicit allowed paths.
2. The router selects only configured workers that satisfy the task contract.
3. Each attempt starts from the same verified base commit in a new detached worktree.
4. The model receives bounded file tools, never a command-execution tool.
5. The harness captures the candidate patch before running Codex-declared validation commands.
6. Validation invalidates the run if it changes patch bytes, changed files, `HEAD`, or executable Git configuration.
7. The mandatory evaluator scores harness evidence; reviewers are deadline-bound, and failed evaluations and policy-violating patches cannot be applied.
8. Applying a completed patch is a separate destructive MCP call with repeated clean-tree, base-commit, artifact-integrity, and `git apply --check` gates.

Automatic fallback is limited to provider transport/response failures and empty
model responses. It does not route around iteration or other policy limits,
failed deterministic validation, unsafe Git configuration, or cancellation.

See [Architecture](docs/architecture.md) and [Threat model](docs/threat-model.md).

## Configure policies

Repositories may commit `.agent-os/policy.json`; operators may also set an
absolute host path with `AGENT_OS_ORGANIZATION_POLICY_PATH`. The harness reads
repository policy from the verified base commit and combines every source by
choosing the restrictive result.

```json
{
  "schemaVersion": 1,
  "maxChangedFiles": 30,
  "allowNetwork": false,
  "prohibitedPaths": ["infra/**", "migrations/**"],
  "routing": {
    "maxCostTier": "medium",
    "allowFallback": false
  }
}
```

Resolved policy and source digests are recorded in reports and task history.
See [Policies as code](docs/policies.md) for the schema, merge rules, trust
boundary, and operations.

## Prerequisites

- Node.js 22 or newer
- Git 2.30 or newer
- Codex CLI, IDE extension, or another local MCP client
- At least one worker: a logged-in Codex CLI or a compatible provider endpoint
- Docker for the recommended isolated validation backend

A `codex` worker can reuse the local Codex CLI's ChatGPT sign-in and therefore consumes the Codex allowance of that ChatGPT plan rather than requiring an OpenAI API key. External provider workers keep their own credentials and billing. The Codex adapter defaults to `authMode: "chatgpt"` and fails closed if the CLI is authenticated with an API key instead.

## Install

```bash
git clone https://github.com/rowlandekemezie/agent-harness-os.git
cd agent-harness-os
npm ci --ignore-scripts
npm run check
npm link
```

## Configure workers

### Use your ChatGPT-authenticated Codex CLI

This is the default path when you want delegation without a separate OpenAI API bill:

```bash
codex login
codex login status

export AGENT_OS_WORKERS_JSON='[
  {
    "id": "codex-subscription",
    "adapter": "codex",
    "capabilities": ["research", "implementation", "testing", "review", "tool-calling", "long-context"],
    "priority": 100,
    "costTier": "low",
    "latencyTier": "standard"
  }
]'
export AGENT_OS_DEFAULT_WORKER='codex-subscription'
```

The adapter invokes `codex exec` with an ephemeral, read-only scratch workspace. It does not give nested Codex direct repository authority. Repository reads and writes still happen through Agent Harness OS tools, path policy, detached worktrees, validation, and the separate patch-application gate.

By default, `authMode` is `chatgpt`. If `codex login status` reports API-key authentication, the worker refuses to run so an API-billed Codex session is not used accidentally. `authMode: "any"` is an explicit opt-in for either saved auth mode.

### Specialize one worker into profiles

Profiles give one provider/model configuration several bounded identities. When
profiles are configured, route and default-worker IDs refer to profiles:

```bash
export AGENT_OS_WORKER_PROFILES_JSON='[
  {
    "id": "codex-implementation",
    "worker": "codex-subscription",
    "role": "implementation",
    "maxIterations": 20,
    "allowedCapabilities": ["implementation", "testing", "tool-calling", "long-context"],
    "evaluationPolicy": "strict"
  },
  {
    "id": "codex-review",
    "worker": "codex-subscription",
    "role": "review",
    "maxIterations": 12,
    "allowedCapabilities": ["review", "tool-calling", "long-context"]
  }
]'
export AGENT_OS_DEFAULT_WORKER='codex-implementation'
```

A profile cannot gain capabilities the backing worker did not declare. Its role
must match the task mode, its iteration setting is a cap, and `strict`
evaluation makes inconclusive work fail closed. See [Worker registry](docs/worker-registry.md).

### Add external workers or fallbacks

Worker metadata is JSON. Credentials stay in separately named environment variables.

```bash
export ANTHROPIC_API_KEY='...'

export AGENT_OS_WORKERS_JSON="$(cat <<'JSON'
[
  {
    "id": "codex-subscription",
    "adapter": "codex",
    "capabilities": ["research", "implementation", "testing", "review", "tool-calling", "long-context"],
    "priority": 100,
    "costTier": "low"
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

The values under `capabilities`, `costTier`, `latencyTier`, `priority`, and `pricing` are operator assertions. For a subscription-backed Codex worker, `costTier` represents incremental out-of-pocket routing preference, not a claim that the ChatGPT plan has unlimited usage.

More examples, including OpenAI API, Qwen, Gemini, OpenRouter, and Ollama, are in [Worker registry](docs/worker-registry.md) and [`examples/workers.json`](examples/workers.json).

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
export AGENT_OS_ROUTING_EVIDENCE_TASK_LIMIT='100'
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

The preview is registry-only. During delegation, the router also includes up to
the configured number of recent same-mode task journals for that repository.
Set the evidence task limit to `0` to retain declared-metadata-only scoring.
Reports preserve the exact evidence snapshot, candidate scores, and reasons.
See [Historical routing evidence](docs/routing-evidence.md).

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

The generated server name is `agent_os`. Run the command with
`AGENT_OS_WORKERS_JSON`, optional `AGENT_OS_WORKER_PROFILES_JSON`, policy, and
routing-evidence settings loaded; it forwards those configuration values,
common provider credential names, and every custom `apiKeyEnv` or `headerEnv`
name used by the effective registry.
Regenerate the block whenever those names change.

The MCP tools are:

- `health_check`: configuration and runtime readiness
- `list_workers`: redacted worker registry metadata
- `route_worker`: deterministic route preview
- `delegate_to_worker`: isolated execution and evidence generation
- `get_worker_run`: persisted report retrieval
- `list_tasks`: bounded, filtered task-history listing
- `get_task_timeline`: validated task summary and event timeline
- `create_coding_workflow`: persist a fixed-base, bounded workflow
- `run_workflow`: run or resume until a wait or terminal state
- `approve_workflow`: approve or reject without applying
- `cancel_workflow`: cancel durable work and a locally owned active delegation
- `get_workflow`: validated definition, summary, and event timeline
- `list_workflows`: bounded workflow listing for one repository
- `apply_worker_patch`: approval-gated patch application

See [Execution history](docs/execution-history.md) for identity, integrity,
query bounds, incomplete tasks, and replay semantics.
See [Evaluation](docs/evaluation.md) for evidence sources, dimensions, outcome
semantics, compatibility, and extension boundaries.
See [Policies as code](docs/policies.md) for deterministic composition and
policy provenance.
See [Historical routing evidence](docs/routing-evidence.md) for measured inputs,
weights, cold-start behavior, and audit binding.
See [Durable coding workflows](docs/workflows.md) for stages, candidate chaining,
resume, dependencies, approvals, and limits.

## Operating workflow

1. Codex inspects the repository and defines acceptance criteria.
2. Codex optionally previews routing.
3. Codex delegates one bounded task.
4. Agent Harness OS selects a worker and executes it in an isolated worktree.
5. Eligible provider/model failures may fall back to another worker in a new worktree.
6. Codex reviews the task timeline, evaluation results, validation evidence, changed files, and patch.
7. Codex invokes `apply_worker_patch` only for an acceptable completed run.
8. Codex reruns validation in the real checkout and reviews the final diff.

For multi-stage work, Codex can instead create and run a durable workflow,
inspect its timeline at each wait, approve the candidate, then pass the returned
`candidateRunId` to `apply_worker_patch`. Workflow approval never applies it.

## Development

```bash
npm ci --ignore-scripts
npm run check
npm pack --dry-run --ignore-scripts
```

The project uses strict TypeScript and Node's built-in test runner. Security or routing changes require adversarial regression tests.

## Current boundary

Agent Harness OS is a local, durable-artifact coding runtime with resumable
workflows, not a distributed orchestration platform. It does not currently
provide:

- persistent task queues across machines
- dynamic provider discovery
- self-modifying routing weights
- long-term semantic memory
- a web dashboard
- autonomous merge or deployment

Those are subsequent layers. The current release establishes the worker contract, routing contract, fallback semantics, evidence model, and authority boundaries they must preserve.
