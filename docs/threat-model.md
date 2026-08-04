# Threat model

## Protected assets

- Host credentials and environment variables
- Files outside the assigned repository paths
- The caller's working tree and branch state
- Git history and remote repositories
- Production infrastructure and customer data
- Provider credentials
- Integrity of worker evidence
- MCP protocol availability

## Threat actors and failure sources

- A worker model that hallucinates, ignores instructions, or follows repository prompt injection
- Malicious text, source code, tests, package scripts, and generated tool arguments in a repository
- Accidental over-broad task contracts
- A provider returning malformed, oversized, repeated, or hostile tool calls
- A stale or tampered run artifact
- Concurrent tasks targeting the same repository
- Child processes that hang or emit excessive output

## Security controls

### Filesystem

- Repository-relative paths only
- Allowlist and denylist globs
- Direct and nested `.git`, `.env`, private-key, credentials, npm, PyPI, and harness-artifact denial
- Lexical path containment
- Realpath containment
- Symlink write denial and symlink escape detection
- File-size and binary-read restrictions
- Single-file deletion only

### Commands

- No shell
- Executable allowlist
- Argument-array invocation
- Global installation flags denied
- Package installation, removal, update, publication, login, config mutation, and remote execution helpers denied
- Destructive package scripts denied
- Sanitized environment
- Output bounds
- Timeouts, abort propagation, and forced termination
- Docker image digest required by default; root filesystem read-only, all Linux capabilities dropped, no-new-privileges enabled, PID/CPU/memory bounds, and networking off by default

### Git and patch handling

- Detached worktree per run
- Cross-process repository lease with stale-lock recovery
- Sanitized Git environment with global/system configuration disabled
- Hooks and fsmonitor overridden; executable local filters, textconv, merge drivers, and attributes configuration rejected
- Binary-capable patch collection
- Independent changed-path validation
- Artifacts outside the checkout
- Private filesystem modes
- Exact artifact filenames, regular-file checks, realpath containment, and symlink rejection
- Patch SHA-256
- Patch bytes are passed to Git over standard input after verification, avoiding a second path lookup
- Clean caller working tree
- Exact base-commit match
- `git apply --check` before application
- No automatic commit, push, merge, or deployment

### Provider and protocol

- Provider credential is used only in the provider request
- Child processes never inherit it
- Provider error bodies and transcripts are redacted
- Request retry, timeout, response-size, and tool-call fanout bounds
- MCP request cancellation while tools are active
- MCP standard output contains JSON-RPC only
- Read-only and destructive MCP annotations support Codex approval policy

## Residual risks

- A malicious package script can execute arbitrary code inside the selected execution environment. Use Docker for untrusted repositories and keep networking disabled.
- Docker access is effectively privileged on many hosts. A compromised Docker daemon is outside this project's protection boundary.
- A malicious or replaced `git`, `node`, or operating-system runtime can bypass controls.
- Provider-side retention, training, and logging are governed by the selected provider, not this harness.
- A user can intentionally supply an unsafe allowlist, enable local execution, permit networking, or configure a dangerous Docker image.
- Artifacts may contain proprietary source code. Secure the host account and configure retention.

## Out of scope

- Multi-tenant isolation
- Central authentication and authorization
- Remote execution infrastructure
- Production deployment
- Database migrations
- Secrets brokerage
- Signed patch approval
- Organization-wide audit retention
- Defense against a compromised host account
