# Architecture

## Components

### Codex

Codex is the user-facing orchestrator. It interprets intent, inspects the repository, creates task boundaries, calls the MCP tools, reviews worker evidence, and owns final acceptance.

### MCP server

The MCP server is a zero-runtime-dependency Node.js process. It speaks newline-delimited JSON-RPC over standard input and output. It supports the stateless `2026-07-28` protocol through `server/discover`, per-request `_meta`, cache hints, and `resultType`, while retaining the `2025-11-25` and `2025-06-18` initialization handshake used by existing Codex clients. Logs are emitted only to standard error so they cannot corrupt the protocol stream.

### Worker service

The worker service serializes work per repository, enforces global concurrency, creates a detached worktree, invokes the provider, executes worker tool calls, runs deterministic validation, collects a binary-capable patch, validates changed paths, stores artifacts, and removes the worktree.

### Provider adapter

The provider adapter calls an OpenAI-compatible chat-completions endpoint. It supports assistant tool calls, bounded retries for transient failures, request timeouts, abort propagation, custom headers, response-body and tool-call limits, and redacted error bodies.

### Policy layer

The path policy and command policy are deterministic. They do not ask the model whether an action is safe.

The path policy enforces repository-relative paths, allowlisted globs, prohibited globs, direct and nested secret patterns, lexical containment, realpath containment, and symlink restrictions.

The command policy enforces executable allowlisting, denies global flags, denies package mutation, and denies deployment, publishing, release, migration, seeding, destruction, and production-oriented package scripts.

### Artifact store

Artifacts are stored outside the repository in a private directory keyed by the normalized repository path. Reports and transcripts use mode `0600`; run directories use mode `0700`. Transcripts are redacted. Patches are exact and protected by a recorded SHA-256 digest.

## Delegation sequence

1. Codex calls `delegate_to_worker` with a typed contract.
2. The service resolves the repository and base commit.
3. A detached worktree is created under the operating system's temporary directory.
4. The provider receives the task prompt and only the worker tools appropriate for the mode.
5. Every tool call passes through deterministic policy.
6. Required commands run after the model loop.
7. Git creates a binary-capable patch and changed-file list.
8. Changed paths are revalidated independently of the model.
9. Report, patch, and redacted transcript are persisted.
10. The worktree is forcibly removed.
11. Codex reviews the report.
12. A separate `apply_worker_patch` call verifies integrity, clean state, base commit, and patch applicability.

## State model

The service is intentionally local and mostly stateless. Durable state consists of immutable run artifacts plus a repository-scoped filesystem lease. An in-process semaphore bounds concurrency, while the filesystem lease coordinates separate MCP server processes on the same host. MCP cancellation propagates through provider calls and validation processes.

A hosted multi-host deployment would need a distributed lease, database-backed run state, centralized audit log, identity model, and distributed cancellation.

## Design decisions

### Why detached worktrees

Returning a patch from model prose is fragile, while sharing the real checkout makes concurrent edits and accidental destruction likely. Worktrees let the worker use ordinary repository tools while preserving a clean authority boundary.

### Why a separate apply tool

Generation and authorization are different decisions. A completed worker run is evidence, not approval. The separate tool gives Codex and the user a review point and lets Codex's MCP approval policy prompt before a destructive action.

### Why no runtime dependencies

The MCP surface used here is small. Implementing discovery, legacy initialization, STDIO framing, cancellation, and tool methods with Node built-ins reduces supply-chain exposure and makes the protocol stream easy to audit. Protocol-version behavior is covered by integration tests. The implementation can migrate to the official SDK when its benefits outweigh the added dependency surface.

### Why acceptance criteria remain unknown after successful commands

A passing command proves only that the command passed. It does not prove every natural-language criterion. The report marks criteria failed when deterministic validation fails and otherwise leaves them `unknown` for Codex to judge.
