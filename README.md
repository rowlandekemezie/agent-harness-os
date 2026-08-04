# Agent Harness OS

A secure local MCP server that lets Codex remain the primary coding agent while delegating bounded repository tasks to an OpenAI-compatible worker model such as Qwen.

The harness is deliberately not a free-form multi-agent chat room. Codex owns intent, decomposition, architecture, review, and final acceptance. The worker receives one typed task contract, operates inside a detached Git worktree, and can only return an auditable patch. Applying that patch to your checkout is a separate tool call with independent safety checks.

## Why this exists

A strong orchestrator and a lower-cost worker can be useful, but the hierarchy is unsafe when the worker shares the orchestrator's filesystem authority or when either model decides its own completion criteria. This project keeps authority in deterministic code:

```text
Codex authenticated with ChatGPT
        |
        | MCP over STDIO
        v
Agent Harness OS
        |
        | bounded OpenAI-compatible tool-calling API
        v
Qwen worker in detached Git worktree
        |
        v
private report + exact patch + SHA-256 digest
        |
        | separate approval-gated MCP call
        v
your clean checkout
```

## Current capabilities

- Dual-protocol MCP STDIO transport using newline-delimited JSON-RPC: stateless `2026-07-28` discovery/per-request metadata plus legacy `2025-11-25` and `2025-06-18` initialization for Codex compatibility
- Four MCP tools:
  - `health_check`
  - `delegate_to_worker`
  - `get_worker_run`
  - `apply_worker_patch`
- OpenAI-compatible `/chat/completions` worker adapter with tool calling
- Detached Git worktrees with cleanup after ordinary runs and fail-closed preservation when validation-container cleanup cannot be confirmed
- Read, literal search, list, diff, write, and delete worker tools; the model never receives a command-execution tool
- Allowed and prohibited path globs
- Traversal, symlink escape, hard-link, changed-symlink, secret-path, and `.git` protections
- Shell-free deterministic validation after the model loop, using Codex-declared commands, executable allowlisting, and patch-immutability checks
- Package installation, publishing, deployment, release, migration, and obvious production-script denial for harness-run validation
- Local or Docker execution backends
- Network disabled by default for Docker validation
- Sanitized child-process environments
- Bounded MCP messages and in-flight requests, task arrays, repository concurrency, iterations, retries, provider bodies and context, per-turn and total tool calls, searches, traversal, changed-file count, output, artifacts, patch size, file size, and wall-clock time
- Private external artifact storage that does not dirty the target repository
- Exact patches generated against the original base commit, including staged and worker-committed changes, with SHA-256 integrity verification
- Secure artifact-file validation with path, symlink, hard-link, size, and digest checks plus repeated clean-tree, base-commit, and `git apply --check` gates before application
- Redacted transcripts, provider errors, command output, and logs
- Cross-process repository leases and MCP cancellation propagation
- Executable Git configuration preflight with hooks, filters, fsmonitor, textconv, and merge drivers disabled or rejected
- Strict TypeScript, unit tests, integration tests, CodeQL, Dependabot, and SHA-pinned GitHub Actions

## Trust model

The worker may inspect and edit only the paths in its task contract. It never receives production credentials, deployment authority, merge authority, or automatic access to the caller's working tree.

`delegate_to_worker` is intentionally non-destructive to the checkout. `apply_worker_patch` is marked destructive so Codex can require approval before it changes files.

This project limits the blast radius of common agent failures and repository prompt injection; it cannot guarantee that a model will ignore malicious instructions inside otherwise allowed source files. It does not protect against a compromised host account, a compromised Docker daemon, a malicious Git executable, or a provider that violates its own data-handling commitments. See [Threat model](docs/threat-model.md).

## Prerequisites

- Node.js 22 or newer
- Git 2.30 or newer
- Codex CLI, IDE extension, or ChatGPT desktop app with local MCP support
- A worker endpoint that implements OpenAI-compatible chat completions and function/tool calling
- Docker when using the recommended isolated command backend

Your ChatGPT subscription authenticates Codex through the supported ChatGPT sign-in flow. It does not pay for calls to the Qwen worker endpoint; configure that provider separately.

## Install from source

```bash
git clone https://github.com/rowlandekemezie/agent-harness-os.git
cd agent-harness-os
npm ci
npm run check
npm link
```

Until the repository is published to npm, `npm link` exposes the `agent-harness-os` command globally.

## Configure the worker provider

Copy the example environment file and replace the placeholders:

```bash
cp .env.example .env
```

Required variables:

```bash
export QWEN_BASE_URL='https://your-provider.example/v1'
export QWEN_API_KEY='...'
export QWEN_MODEL='the-exact-provider-model-id'
```

Use `QWEN_CHAT_COMPLETIONS_URL` when the provider does not use the conventional `/v1/chat/completions` path. Use `QWEN_HEADERS_JSON` for provider-specific string headers. HTTPS is required for non-loopback endpoints. Set `QWEN_ALLOW_INSECURE_HTTP=true` only when a trusted private-network provider cannot offer TLS and you accept plaintext transport of credentials and source context.

Do not guess a model identifier. Use the identifier exposed by the provider you actually selected.

## Choose an execution backend

### Docker, recommended

```bash
export AGENT_HARNESS_EXECUTION_BACKEND='docker'
export AGENT_HARNESS_DOCKER_IMAGE='node:22-bookworm-slim@sha256:<64-hex-digest>'
export AGENT_HARNESS_REQUIRE_PINNED_DOCKER_IMAGE='true'
export AGENT_HARNESS_DOCKER_NETWORK='none'
```

The container image must be pinned by digest by default. Pull the tag you intend to use, inspect its `RepoDigests`, and copy the complete `name@sha256:...` value into `AGENT_HARNESS_DOCKER_IMAGE`. The container root filesystem and worktree `.git` marker are read-only. The source worktree is mounted writable, `/tmp` is a restricted tmpfs, the child environment is sanitized, and networking remains disabled unless a task explicitly requests it and you configure a non-`none` network. The harness captures the model patch before validation and rejects the run when a validation command changes that patch, Git configuration, or `HEAD`. If the harness cannot confirm removal of a validation container, it returns no applicable patch and preserves the isolated worktree for manual remediation.

```bash
docker pull node:22-bookworm-slim
docker image inspect --format='{{index .RepoDigests 0}}' node:22-bookworm-slim
```

### Local, trusted repositories only

```bash
export AGENT_HARNESS_EXECUTION_BACKEND='local'
export AGENT_HARNESS_ALLOW_UNSANDBOXED_LOCAL='true'
```

Local execution is disabled by default. File inspection and patch creation still work, but deterministic validation fails until Docker is selected or unsandboxed local execution is explicitly enabled. Because local mode cannot enforce network isolation, a task with validation commands must also set `allowNetwork: true`. This flag controls validation-command egress only; the configured model-provider request always requires network access unless the provider is local.

## Connect it to Codex

First authenticate Codex with your ChatGPT account:

```bash
codex login
```

Then generate a project-compatible MCP block:

```bash
agent-harness-os codex-config
```

Paste the output into `~/.codex/config.toml` or a trusted project's `.codex/config.toml`. The generated configuration forwards only named environment variables, sets the server as required, approves read-only tools, and prompts for worker delegation and patch application.

You can alternatively register the server with the Codex CLI:

```bash
codex mcp add qwen_worker \
  --env QWEN_BASE_URL="$QWEN_BASE_URL" \
  --env QWEN_API_KEY="$QWEN_API_KEY" \
  --env QWEN_MODEL="$QWEN_MODEL" \
  -- agent-harness-os mcp
```

Verify it:

```bash
agent-harness-os doctor
codex mcp list
```

## Add repository instructions

Copy [the example AGENTS.md](examples/AGENTS.md) into the repository that Codex will operate on, then adapt the validation commands and allowed areas.

The critical workflow rule is:

1. Codex defines a bounded task.
2. Codex calls `delegate_to_worker`.
3. Codex reads the report and patch evidence.
4. Codex independently inspects relevant files and the harness-captured validation output.
5. Codex calls `apply_worker_patch` only when the result is acceptable.
6. Codex reruns validation in the real checkout.

## Example delegation

A Codex request can be phrased naturally:

```text
Implement organization-scoped API-key rotation.

Use qwen_worker.delegate_to_worker for the mechanical implementation after you
inspect the existing auth architecture. Allow only src/auth/**, src/api-keys/**,
and test/**. Prohibit migrations and deployment files. Require npm run typecheck
and npm test. Review the resulting report and diff before asking to apply it.
```

The underlying tool contract resembles [examples/task.json](examples/task.json).

## MCP tools

### `health_check`

Read-only. Reports provider configuration, Git and Docker availability, execution mode, artifact location, and safety warnings.

### `delegate_to_worker`

Creates a detached worktree from `baseRef`, gives the model only bounded file tools, captures the candidate patch, runs Codex-declared deterministic validation commands after the model loop, verifies that validation did not change the patch or Git state, validates all changed paths, and stores a private report and patch. `allowedPaths` is mandatory so delegation never silently expands to the entire repository. Dependency manifests, lockfiles, CI configuration, development-container configuration, and other control-plane files are readable when allowed but cannot be changed by the worker.

It never applies the patch to the caller's checkout.

### `get_worker_run`

Read-only. Reloads a persisted report using repository path and run ID.

### `apply_worker_patch`

Requires all of the following:

- run status is `completed`
- report belongs to the selected repository
- report and patch are bounded regular files at their exact expected paths, with neither symbolic nor multiple hard links
- patch is inside the private artifact directory
- patch SHA-256 matches the report
- caller's working tree is clean
- caller's `HEAD` exactly matches the worker base commit before and after patch verification
- `git apply --check --whitespace=error-all` succeeds

No merge, commit, push, deployment, database action, or external communication is performed.

## Configuration reference

| Variable | Default | Purpose |
|---|---|---|
| `QWEN_BASE_URL` | empty | OpenAI-compatible API base URL |
| `QWEN_CHAT_COMPLETIONS_URL` | empty | Full chat-completions URL override |
| `QWEN_API_KEY` | empty | Worker-provider credential |
| `QWEN_MODEL` | empty | Exact provider model ID |
| `QWEN_HEADERS_JSON` | `{}` | Additional string headers |
| `QWEN_TIMEOUT_MS` | `120000` | Timeout per provider request |
| `QWEN_MAX_RETRIES` | `3` | Retries for transient provider failures |
| `QWEN_MAX_RESPONSE_BYTES` | `4194304` | Maximum provider response body |
| `QWEN_ALLOW_INSECURE_HTTP` | `false` | Explicitly permit non-loopback plaintext provider endpoints |
| `AGENT_HARNESS_EXECUTION_BACKEND` | `local` | `local` or `docker` |
| `AGENT_HARNESS_ALLOW_UNSANDBOXED_LOCAL` | `false` | Explicit local command opt-in |
| `AGENT_HARNESS_DOCKER_IMAGE` | `node:22-bookworm-slim` | Validation image; Docker mode requires a digest by default |
| `AGENT_HARNESS_REQUIRE_PINNED_DOCKER_IMAGE` | `true` | Reject mutable Docker tags |
| `AGENT_HARNESS_DOCKER_NETWORK` | `none` | Network used only when a task allows it |
| `AGENT_HARNESS_ALLOWED_COMMANDS` | validation tools | Executable allowlist |
| `AGENT_HARNESS_COMMAND_TIMEOUT_MS` | `120000` | Default validation-command timeout |
| `AGENT_HARNESS_MAX_CONCURRENCY` | `1` | Concurrent repositories, maximum 8 |
| `AGENT_HARNESS_MAX_FILE_BYTES` | `1048576` | Per-file read/write limit |
| `AGENT_HARNESS_MAX_TOOL_OUTPUT_BYTES` | `65536` | Per-command/tool output limit |
| `AGENT_HARNESS_MAX_MCP_MESSAGE_BYTES` | `1048576` | Maximum newline-delimited MCP request size |
| `AGENT_HARNESS_MAX_MCP_IN_FLIGHT` | `64` | Maximum concurrent MCP requests on one STDIO session |
| `AGENT_HARNESS_MAX_CHANGED_FILES` | `200` | Maximum files in one worker patch |
| `AGENT_HARNESS_MAX_SEARCH_BYTES` | `33554432` | Maximum bytes scanned by one worker search |
| `AGENT_HARNESS_MAX_TRAVERSAL_ENTRIES` | `10000` | Maximum directory entries visited by one list/search traversal |
| `AGENT_HARNESS_MAX_TOTAL_TOOL_CALLS` | `128` | Maximum model tool calls across one worker run |
| `AGENT_HARNESS_MAX_PROVIDER_CONTEXT_BYTES` | `8388608` | Maximum serialized provider conversation and tool context |
| `AGENT_HARNESS_ARTIFACT_ROOT` | user-private state directory | Optional artifact root override; must resolve outside the target repository |
| `AGENT_HARNESS_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, or `error` |

## Development

```bash
npm run lint
npm run typecheck
npm test
npm run check
```

The test suite includes real temporary Git repositories, fake OpenAI-compatible HTTP providers, modern and legacy MCP negotiation, oversized-message recovery, MCP cancellation and in-flight bounds, repository-lock contention, staged and committed worker changes, validation-mutation detection, Git-config attack cases, provider and context bounds, link attacks, scope-safe diff inspection, Docker cleanup failure, and the complete delegate/review/apply lifecycle. It verifies the complete delegation and application lifecycle without calling an external model.

## Operational status

This repository is a production-oriented local harness, not a hosted multi-tenant control plane. Before using it across an organization, add central identity, audit export, provider egress controls, artifact retention policy, telemetry, signed releases, and an organization-specific allowlist policy. See [Operations](docs/operations.md).

## License

MIT
