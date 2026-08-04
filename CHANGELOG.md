# Changelog

All notable changes are documented here.

## 0.1.0 - 2026-08-03

### Added

- Local MCP STDIO server with stateless `2026-07-28` discovery and legacy Codex initialization compatibility
- Bounded OpenAI-compatible worker agent
- Detached Git worktree isolation
- Deterministic path and command policies
- Docker and explicitly opted-in local command backends
- External private artifact store
- Patch integrity and stale-base protection
- Separate delegation and patch-application tools
- Cross-process repository leases and MCP cancellation
- Git hook/filter/textconv/merge-driver hardening
- Provider response and tool-call bounds
- UTF-8 byte limits, literal-only search, expanded secret-path denial, and hardened Docker execution
- Redacted run reports while preserving byte-faithful patches
- Strict artifact schemas, symlink-resistant loading, and verified patch application over standard input
- Immutable Docker image enforcement by default
- Lockfile, SHA-pinned GitHub Actions, CodeQL, Dependabot, strict TypeScript, and end-to-end integration tests
