# Changelog

All notable changes are documented here.

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
