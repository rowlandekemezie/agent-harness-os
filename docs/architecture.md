# Architecture

## Components

### Codex

Codex is the user-facing orchestrator. It interprets intent, inspects the repository, creates task boundaries, declares deterministic validation commands, calls the MCP tools, reviews worker evidence, and owns final acceptance.

### MCP server

The MCP server is a zero-runtime-dependency Node.js process. It speaks byte-bounded, newline-delimited JSON-RPC over standard input and output. It supports the stateless `2026-07-28` protocol through `server/discover`, per-request `_meta`, cache hints, and `resultType`, while retaining the `2025-11-25` and `2025-06-18` initialization handshake used by existing Codex clients. Input size, concurrent requests, duplicate request IDs, and cancellation are enforced by the transport. Logs are emitted only to standard error so they cannot corrupt the protocol stream.

### Worker service

The worker service serializes work per repository, enforces global concurrency, creates a detached worktree, invokes the provider, executes bounded file-tool calls, captures the candidate patch, runs harness-controlled validation, verifies that validation preserved the candidate, validates changed paths, stores artifacts, and removes the worktree.

The model never receives a command-execution tool. Commands in `requiredCommands` are part of the Codex-supplied task contract and run only after the model loop completes.

### Provider adapter

The provider adapter calls an OpenAI-compatible chat-completions endpoint. It supports assistant tool calls, bounded retries for transient failures, request timeouts, abort propagation, custom headers, response-body, context, per-turn tool-call, total tool-call, and assistant-content limits, manual redirect handling, and redacted error bodies. Non-loopback provider endpoints require HTTPS unless insecure transport is explicitly enabled.

### Policy layer

The path policy and command policy are deterministic. They do not ask the model whether an action is safe.

The path policy requires an explicit allowlist and enforces repository-relative paths, prohibited globs, direct and nested secret patterns, lexical containment, realpath containment, symlink restrictions, hard-link restrictions, changed-file type checks, and separate write denial for dependency manifests, lockfiles, CI configuration, development-container files, and other control-plane files.

The command policy applies only to post-model validation. It enforces executable allowlisting, denies global flags and package mutation, and blocks publishing, release, deployment, migration, seeding, destruction, and obvious production-oriented scripts. A passing command is evidence, not proof that natural-language acceptance criteria are satisfied.

### Artifact store

Artifacts are stored outside the repository in a private directory keyed by the normalized repository path. Reports, patches, and transcripts use mode `0600`; run directories use mode `0700`. Reads reject unexpected paths, symbolic links, multiple hard links, non-regular files, and oversized artifacts. Transcripts and reports are redacted. Patches remain byte-faithful and are protected by a recorded SHA-256 digest.

## Delegation sequence

1. Codex calls `delegate_to_worker` with a typed contract and an explicit path allowlist.
2. The service validates provider, execution, artifact-root, repository, Git-configuration, and task-contract preconditions.
3. A detached worktree is created from the resolved base commit under the operating system's temporary directory.
4. The provider receives the task prompt and only the file tools appropriate for the mode.
5. Every model tool call passes through deterministic path, size, traversal, search, and run-level bounds.
6. Git compares the original base commit with the complete worktree state, including staged and worker-committed changes.
7. Changed paths, file types, control-plane restrictions, and limits are revalidated independently of the model.
8. Git creates the candidate binary-capable patch only after those checks pass.
9. Codex-declared validation commands run in Docker or explicitly trusted local mode.
10. The service verifies that validation did not alter `HEAD`, executable Git configuration, changed-file membership, or patch bytes.
11. Report, original candidate patch, and redacted transcript are persisted. A failed or policy-violating run has no applicable patch.
12. The worktree is removed. When Docker cleanup cannot be confirmed, the run fails closed, no patch is exposed, and the isolated worktree is preserved for manual remediation.
13. Codex reviews the report and patch evidence.
14. A separate `apply_worker_patch` call verifies artifact integrity, a clean checkout, the exact base commit before and after `git apply --check`, and patch applicability before changing the checkout.

## State model

The service is intentionally local and mostly stateless. Durable state consists of immutable run artifacts plus a repository-scoped filesystem lease. An abort-aware in-process semaphore bounds repository work, while the filesystem lease coordinates separate MCP server processes on the same host. MCP cancellation propagates through provider calls, tool traversal, semaphore waits, and validation processes.

A hosted multi-host deployment would need a distributed lease, database-backed run state, centralized audit log, identity model, distributed cancellation, provider egress policy, and artifact retention enforcement.

## Design decisions

### Why detached worktrees

Returning a patch from model prose is fragile, while sharing the real checkout makes concurrent edits and accidental destruction likely. Worktrees let the worker use ordinary repository file tools while preserving a clean authority boundary.

### Why the worker cannot execute commands

An allowlisted package script can still execute arbitrary repository code. Keeping command execution out of the model tool surface prevents the worker from choosing scripts, harvesting their output, or using command side effects as another write path. Codex declares validation up front, and the harness runs it only after capturing the model patch.

### Why validation must be non-mutating

Formatters, generators, tests, and build scripts sometimes rewrite files. Letting those mutations silently enter the patch would make the persisted artifact differ from the model-reviewed candidate and would create a second, less visible code-generation path. The harness therefore invalidates the run when validation changes the patch, changed-file list, `HEAD`, or executable Git configuration.

### Why a separate apply tool

Generation and authorization are different decisions. A completed worker run is evidence, not approval. The separate tool gives Codex and the user a review point and lets Codex's MCP approval policy prompt before a destructive action.

### Why no runtime dependencies

The MCP surface used here is small. Implementing discovery, legacy initialization, bounded STDIO framing, cancellation, and tool methods with Node built-ins reduces supply-chain exposure and makes the protocol stream easy to audit. Protocol-version behavior is covered by integration tests. The implementation can migrate to the official SDK when its benefits outweigh the added dependency surface.

### Why acceptance criteria remain unknown after successful commands

A passing command proves only that the command passed. It does not prove every natural-language criterion. The report marks criteria failed whenever the run is not completed and otherwise leaves them `unknown` for Codex to judge.
