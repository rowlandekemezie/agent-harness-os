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
- Detached Git worktrees with cleanup after every run
- Read, literal search, list, write, delete, diff, and validation-command worker tools
- Allowed and prohibited path globs
- Traversal, symlink escape, secret-path, and `.git` protections
- Shell-free command execution with allowlisting
- Package installation, publishing, deployment, release, migration, and production-script denial
- Local or Docker execution backends
- Network disabled by default for Docker validation
- Sanitized child-process environments
- Bounded concurrency, iterations, retries, provider bodies, tool-call fanout, output, patch size, file size, and wall-clock time
- Private external artifact storage that does not dirty the target repository
- Exact patch persistence with SHA-256 integrity verification
- Secure artifact-file validation plus clean-tree, base-commit, and `git apply --check` gates before application
- Redacted transcripts, provider errors, command output, and logs
- Cross-process repository leases and MCP cancellation propagation
- Executable Git configuration preflight with hooks, filters, fsmonitor, textconv, and merge drivers disabled or rejected
- Strict TypeScript, unit tests, integration tests, CodeQL, Dependabot, and SHA-pinned GitHub Actions

## Trust model

The worker may inspect and edit only the paths in its task contract. It never receives production credentials, deployment authority, merge authority, or automatic access to the caller's working tree.

`delegate_to_worker` is intentionally non-destructive to the checkout. `apply_worker_patch` is marked destructive so Codex can require approval before it changes files.

This project protects against common agent failures and repository prompt injection. It does not protect against a compromised host account, a compromised Docker daemon, a malicious Git executable, or a provider that violates its own data-handling commitments. See [Threat model](docs/threat-model.md).

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

Use `QWEN_CHAT_COMPLETIONS_URL` when the provider does not use the conventional `/v1/chat/completions` path. Use `QWEN_HEADERS_JSON` for provider-specific string headers.

Do not guess a model identifier. Use the identifier exposed by the provider you actually selected.

## Choose an execution backend

### Docker, recommended

```bash
export AGENT_HARNESS_EXECUTION_BACKEND='docker'
export AGENT_HARNESS_DOCKER_IMAGE='node:22-bookworm-slim@sha256:<64-hex-digest>'
export AGENT_HARNESS_REQUIRE_PINNED_DOCKER_IMAGE='true'
export AGENT_HARNESS_DOCKER_NETWORK='none'
```

The container image must be pinned by digest by default. Pull the tag you intend to use, inspect its `RepoDigests`, and copy the complete `name@sha256:...` value into `AGENT_HARNESS_DOCKER_IMAGE`. The container root filesystem is read-only. The detached worktree is mounted writable, `/tmp` is a restricted tmpfs, the child environment is sanitized, and networking remains disabled unless a task explicitly requests it and you configure a non-`none` network.

```bash
docker pull node:22-bookworm-slim
docker image inspect --format='{{index .RepoDigests 0}}' node:22-bookworm-slim
```

### Local, trusted repositories only

```bash
export AGENT_HARNESS_EXECUTION_BACKEND='local'
export AGENT_HARNESS_ALLOW_UNSANDBOXED_LOCAL='true'
```

Local execution is disabled by default. File inspection and patch creation still work, but worker validation commands fail until Docker is selected or local execution is explicitly enabled.

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
4. Codex independently inspects relevant files and validation output.
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

Creates a detached worktree from `baseRef`, executes one bounded task, runs deterministic validation commands, validates all changed paths, stores a private report and patch, removes the worktree, and returns the report.

It never applies the patch to the caller's checkout.

### `get_worker_run`

Read-only. Reloads a persisted report using repository path and run ID.

### `apply_worker_patch`

Requires all of the following:

- run status is `completed`
- report belongs to the selected repository
- report and patch are regular files at their exact expected paths, not symlinks
- patch is inside the private artifact directory
- patch SHA-256 matches the report
- caller's working tree is clean
- caller's `HEAD` exactly matches the worker base commit
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
| `AGENT_HARNESS_ARTIFACT_ROOT` | user-private state directory | Optional artifact root override |
| `AGENT_HARNESS_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, or `error` |

## Development

```bash
npm run lint
npm run typecheck
npm test
npm run check
```

The test suite includes real temporary Git repositories, fake OpenAI-compatible HTTP providers, modern and legacy MCP negotiation, MCP cancellation, repository-lock contention, Git-config attack cases, provider bounds, and the complete delegate/review/apply lifecycle. It verifies the complete delegation and application lifecycle without calling an external model.

## Operational status

This repository is a production-oriented local harness, not a hosted multi-tenant control plane. Before using it across an organization, add central identity, audit export, provider egress controls, artifact retention policy, telemetry, signed releases, and an organization-specific allowlist policy. See [Operations](docs/operations.md).

## License

MIT
