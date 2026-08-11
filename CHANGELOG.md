# Changelog

All notable changes are documented here.

## Unreleased

### Added

- Durable task IDs and digest-chained execution timelines across fallback attempts
- Bounded `list_tasks` and `get_task_timeline` MCP tools
- Explicit patch-request, approval, rejection, and application events
- Provider-neutral evaluator contract with mandatory deterministic evidence
- Version 3 run reports with aggregate evaluation results
- Version 2 task events with required `EvaluationCompleted` lifecycle evidence

- ChatGPT-authenticated `codex` worker adapter using ephemeral non-interactive `codex exec`
- ChatGPT plan-backed Codex workers require no `OPENAI_API_KEY`; external provider workers retain their own credentials and billing
- Fail-closed ChatGPT auth enforcement with explicit `authMode: any` opt-in for other saved Codex auth
- Codex worker isolation in a read-only scratch workspace while Agent OS retains repository tool authority
- Codex adapter tests for auth, environment isolation, structured tool calls, and end-to-end patch application

### Security

- Atomically publish private artifacts from verified directory inodes and fsync files and directories
- Reject unknown report and event fields, invalid lifecycle order, mismatched run links, and aggregate history traversal
- Keep run reports and deterministic patch gates authoritative when history is unavailable
- Validate evaluator output as hostile input and prevent evaluation failures from falling back or applying

- Strip OpenAI API credential environment variables from delegated Codex subprocesses
- Reject provider-only API configuration on subscription-backed Codex workers

## 0.2.0 - 2026-08-04

### Added

- Model-agnostic worker registry configured through environment-backed JSON
- Deterministic capability, cost, latency, quality, and preferred-worker routing
- Bounded fallback using a fresh detached worktree for every worker attempt
- Native Anthropic Messages API adapter
- Generic OpenAI-compatible adapter for OpenAI, Qwen hosts, Gemini compatibility, OpenRouter, Ollama, and similar endpoints
- Worker usage, token, latency, estimated cost, selected route, and prior-attempt evidence in reports
- `list_workers` and `route_worker` MCP tools
- Automatic Codex forwarding for custom credential environment-variable names declared by the worker registry
- Worker-registry, routing, fallback, and provider-compatibility documentation

### Security

- Rejected credentials embedded in endpoint query parameters and static authorization headers
- Redacted query values from worker-registry inspection
- Restricted fallback to provider and bounded model-loop failures
- Preserved the original base commit and clean worktree boundary across attempts
- Removed unsupported capability claims from the routable capability vocabulary

### Compatibility

- Retained legacy `QWEN_*` single-worker configuration
- Retained version 1 run-report compatibility through optional routing and telemetry fields

## 0.1.0 - 2026-08-03

### Added

- Local MCP STDIO server with byte-bounded stateless `2026-07-28` discovery and legacy Codex initialization compatibility
- Bounded OpenAI-compatible worker agent with HTTPS-by-default provider transport, no redirect following, response limits, context limits, per-turn and total tool-call limits, retries, timeouts, cancellation, and redacted errors
- Explicit non-empty path allowlists and detached Git worktree isolation
- Worker file tools for bounded list, literal search, read, diff, write, and delete operations; command execution is not exposed to the model
- Deterministic post-model validation commands declared by Codex, with shell-free execution, executable allowlisting, sanitized environments, and patch-immutability verification
- Docker and explicitly opted-in local validation backends
- Digest-pinned Docker execution by default with entrypoint reset, read-only root and `.git`, dropped capabilities, no-new-privileges, resource bounds, network denial, named-container cleanup, and fail-closed worktree preservation when cleanup cannot be confirmed
- Exact patch generation against the original base commit, including staged and worker-committed changes, with rename-safe path visibility
- Independent changed-path, file-type, secret-path, control-plane-write, symlink, hard-link, changed-file-count, and patch-size validation
- Private external artifact storage with repository-isolation checks, exact filenames, regular-file, symlink, hard-link, size, realpath, and SHA-256 integrity enforcement
- Separate delegation and patch-application tools with repeated clean-tree and base-commit checks around `git apply --check`
- Cross-process repository leases with stale-lock quarantine, abort-aware in-process concurrency, bounded MCP in-flight requests, duplicate-ID rejection, and cancellation propagation
- Git hook, filter, worktree-redirection, fsmonitor, textconv, merge-driver, and attributes-configuration hardening
- Search-byte, directory-traversal, UTF-8 output, file-size, provider-context, assistant-content, iteration, wall-clock, and artifact bounds
- Redacted reports, transcripts, provider errors, validation output, and logs while preserving byte-faithful patches
- Lockfile, SHA-pinned GitHub Actions, CodeQL, Dependabot, strict TypeScript, packaging checks, and adversarial unit and integration tests
