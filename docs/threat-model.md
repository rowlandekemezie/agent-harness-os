# Threat model

## Protected assets

- Host credentials and environment variables
- Files outside the assigned repository paths
- Dependency manifests, CI configuration, editor/agent configuration, and other control-plane files
- The caller's working tree and branch state
- Git history and remote repositories
- Production infrastructure and customer data
- Provider credentials and source context in transit
- Integrity of worker evidence and persisted artifacts
- MCP protocol availability

## Threat actors and failure sources

- A worker model that hallucinates, ignores instructions, or follows repository prompt injection
- Malicious text, source code, tests, package scripts, and generated tool arguments in a repository
- Accidental over-broad task contracts
- A provider returning malformed, oversized, repeated, redirected, or hostile tool calls
- An evaluator returning malformed, contradictory, oversized, or hostile evidence
- A locally authenticated Codex CLI process that is unavailable, mis-authenticated, compromised, or instructed to use authority outside the Agent OS tool contract
- Incorrect or malicious worker profile, capability, cost, latency, priority, endpoint, or pricing configuration
- Corrupt, oversized, or adversarial task history used as routing evidence
- Corrupt workflow events, stale leases, forged dependencies, or tampered candidate links
- Malformed, unsafe, mutable-checkout, or authority-expanding policy input
- A failed primary worker leaving partial state that could contaminate a fallback attempt
- A stale, oversized, linked, or tampered run artifact
- Concurrent tasks or external processes targeting the same repository
- Child processes that hang, create descendants, mutate the worktree, or emit excessive output
- Validation containers that outlive their Docker client

## Security controls

### Worker registry and routing

- Worker IDs are unique and configuration is bounded to thirty-two entries
- Profile IDs are unique and configuration is bounded to sixty-four entries
- Profiles reference an existing worker, match exactly one role, and can only reduce declared capabilities and iterations
- Only profiles are routable when explicit profiles are configured
- Provider credentials are sourced from named environment variables
- Sensitive static headers and credential-shaped URL query parameters are rejected
- Non-loopback plaintext endpoints require explicit opt-in
- Registry inspection omits credentials and redacts query values
- Capabilities and budget tiers are explicit operator claims
- Routing is deterministic and does not call an LLM
- Required capabilities and cost/latency ceilings are enforced before scoring
- Explicit worker preference fails closed when the worker cannot satisfy the contract
- Strict profiles fail closed on inconclusive evaluation without making fallback eligible
- Fallback is limited to eligible provider/empty-response failures and bounded attempts
- Every fallback attempt starts from the original base in a fresh worktree
- Failed attempts are persisted for audit but cannot be applied

### Policies as code

- Organization policy is an absolute-path, owner-owned, single-link regular file with no group or other write access
- Repository policy is read from the verified base commit as one non-executable regular Git blob
- Policy files are exact-schema UTF-8 JSON bounded to 64 KiB
- Numeric limits use the minimum; deny paths and capabilities use a union; permissions require every source to allow them
- `.agent-os` is outside worker read and write authority
- Invalid policy fails before provider invocation
- Policy metadata containing configured credentials fails instead of being persisted or transformed
- Reports retain effective policy and source digests; event schema version 4 binds the policy digest before patch application

### Historical routing evidence

- Only validated event-schema-version-5 attempts become measured samples
- A private digest-named index selects newest tasks without replaying all retained history
- Evidence reads are repository-scoped, sample- and resource-bounded, read-only, and cancellation-aware
- Capability, role, tier, and policy filters run before measured scoring
- Evidence weights are fixed code with bounded confidence; models cannot rewrite them
- Missing or malformed provider usage never becomes zero-cost routing evidence
- Reports retain source event hashes, evidence, scores, and reasons; task history binds evidence and decision digests
- Invalid history fails before provider invocation; a zero task limit disables evidence reads

### Durable workflows

- Definitions, events, dependencies, transitions, retries, repairs, and deadlines are schema- and count-bounded
- Digest-chained append-only events are replayed instead of trusting mutable workflow status
- Dependency workflows must already exist in the same repository scope; immutable definitions prevent cycles
- Active stages left by a crash are recorded as interrupted and resumed as fresh delegations
- Owner-private, uniquely named per-workflow claims serialize runners, avoid stale-path reuse, and fail closed on invalid or live ownership
- Candidate runs are report/history validated before delegation and approval; they require the same repository and base commit, an exact patch digest, and next-stage path authority
- Every completed stage run is history-bound before approval, and repair always requires a retained candidate
- Candidate patches are applied only inside fresh detached worktrees and regenerated against the original base before provider invocation
- Workflow deadlines reach active delegation, while cancellation is terminal and never fallback-eligible
- Credential-bearing definitions and events are rejected rather than redacted into false history
- Approval records the MCP caller's decision but grants no patch-application authority


### Filesystem

- Explicit non-empty repository path allowlist
- Repository-relative paths only
- Allowlist and denylist globs with bounded pattern counts and lengths
- Aggregate-bounded state-machine glob evaluation with cancellation between changed paths
- Direct and nested `.git`, environment, private-key, credential, package-registry, infrastructure-state, and harness-artifact denial
- Separate worker-write denial for manifests, lockfiles, CI, Docker, development-container, MCP, editor, and agent-control files
- Lexical path containment and realpath containment
- Symlink write denial and symlink escape detection
- Hard-link denial for worker file reads/writes and persisted artifact reads
- Changed-file regular-type validation
- File-size, artifact-size, and binary-read restrictions
- Single-file deletion only

### Model tool surface

- No command-execution tool
- Read-only modes expose no write or delete tool
- Literal search only
- Bounded file reads/writes, tool output, search bytes, traversal entries, changed files, provider context, assistant content, per-turn tool calls, total tool calls, iterations, and wall-clock time
- Abort checks during traversal and search
- Prohibited changed paths cannot be exposed through `get_diff`

### Validation commands

- Commands are declared by Codex before delegation and run only after the model loop
- No shell
- Executable allowlist
- Argument-array invocation
- Global installation flags denied
- Package installation, removal, update, publication, login, configuration mutation, and remote execution helpers denied
- Destructive or production-oriented package-script names denied
- Sanitized environment
- Output bounds, timeouts, abort propagation, and forced termination
- Candidate patch captured before validation
- Validation invalidates the run if it changes patch bytes, changed-file membership, `HEAD`, or executable Git configuration
- Local execution disabled by default and rejected when a task requests network isolation
- Docker image digest required by default; entrypoint reset, root filesystem read-only, all Linux capabilities dropped, no-new-privileges enabled, PID/CPU/memory bounds, `.git` read-only, and networking off by default
- Named validation containers are forcibly removed after each command; unconfirmed cleanup fails closed and preserves the isolated worktree

### Git and patch handling

- Detached worktree per run
- Cross-process repository lease with stale-lock quarantine and recovery
- Sanitized Git environment with global/system configuration disabled
- Hooks and fsmonitor overridden; `core.worktree`, executable local/worktree filters, textconv, merge drivers, and attributes configuration rejected
- Patch and changed-file collection against the original base commit, including staged and worker-committed changes
- Rename detection disabled so both deleted and added paths remain visible to policy
- Invalid UTF-8 patches fail closed before hashing or persistence; captured patch text is never replacement-decoded
- Binary-capable patch collection
- Independent changed-path and file-type validation
- Artifacts outside the checkout
- Private filesystem modes
- Exact artifact filenames, regular-file checks, hard-link rejection, size bounds, realpath containment, and symlink rejection
- Handle-bound artifact reads and helper-confined atomic writes that verify the destination directory inode before mutation
- Digest-named, chained task events; task summaries are projected from the validated chain
- Patch SHA-256
- Git standard output remains byte-faithful; only diagnostic standard error is redacted
- Patch bytes passed to Git over standard input after verification, avoiding a second patch-path lookup
- Clean caller working tree
- Exact base-commit match before and after patch verification
- `git apply --check` before application
- No automatic commit, push, merge, or deployment

### Evaluation

- The mandatory deterministic evaluator consumes only harness-captured evidence
- Worker assertions about tests or correctness never become evidence
- Optional reviewers add results but cannot replace deterministic evaluation
- Evaluator IDs are unique and execution order is stable
- Evaluators receive a bounded patch and task evidence, never repository or command authority
- Evaluation is deadline-bound and cancellation races evaluators that ignore their signal
- Exact schemas, UTF-8 byte bounds, dimensions, statuses, and aggregate outcomes are validated
- Final reports are revalidated and byte-bounded after redaction
- Version 3 application binds evaluator IDs, outcome, and status to task history
- Failed evaluation blocks patch application and never enables fallback
- Only deterministic patch-size evidence can suppress audit-patch persistence
- Evaluation text is redacted before persistence

### Codex CLI worker

- ChatGPT authentication is the default required auth mode; API-key-backed Codex use requires explicit `authMode: any` opt-in
- Codex login state is checked before the first delegated turn
- Nested Codex runs in a newly created scratch directory, not the repository worktree
- `codex exec` is invoked ephemerally with a read-only sandbox, approvals disabled, user config/rules disabled, and structured output validation
- Built-in shell, unified exec, shell snapshot, and code-mode execution features are explicitly disabled so the nested Codex turn cannot use its own execution tools to inspect the host
- Repository context is supplied only through the bounded conversation and Agent OS tool definitions; repository file authority remains in `WorkerToolExecutor`
- `OPENAI_API_KEY`, `OPENAI_ORG_ID`, and `OPENAI_PROJECT_ID` are removed from the Codex subprocess environment
- Only auth-location, platform, proxy, and TLS variables needed by the Codex CLI are forwarded
- Codex subprocess output, response file size, execution time, cancellation, tool-call count, and tool names are bounded and validated

### Provider and protocol

- HTTPS required for non-loopback provider endpoints unless plaintext transport is explicitly enabled
- Provider redirects are not followed
- Provider credential used only in the provider request
- Child processes never inherit provider credentials
- Provider error bodies, command output, reports, transcripts, and logs are redacted using credentials from every configured backing worker, including workers without a routable profile
- Request retry, timeout, response-size, context-size, and tool-call bounds
- Byte-bounded MCP framing, concurrent-request limits, duplicate-request-ID rejection, and cancellation while tools are active
- MCP standard output contains JSON-RPC only
- Read-only and destructive MCP annotations support Codex approval policy

## Residual risks

- Repository prompt injection remains possible inside any file the model is legitimately allowed to read. The harness constrains authority and validates outputs; it cannot guarantee model obedience.
- A Codex-declared validation script can execute arbitrary repository code inside the selected validation environment regardless of its benign name. Use Docker for untrusted repositories, keep networking disabled, and review validation commands.
- Docker access is effectively privileged on many hosts. A compromised Docker daemon or container-runtime escape is outside this project's protection boundary.
- Unsandboxed local validation may leave descendant processes and can access the host according to the invoking account. It is outside the recommended untrusted-repository path.
- A malicious or replaced `git`, `docker`, `node`, operating-system runtime, or host account can bypass controls.
- Provider-side retention, training, residency, and logging are governed by the selected provider, not this harness. ChatGPT-authenticated Codex workers are governed by the active ChatGPT/Codex account terms and limits.
- The nested Codex CLI is a local executable with access to its own authentication material. Agent OS isolates it from the repository and strips API environment credentials, but a compromised Codex binary or host account is outside the protection boundary.
- A subscription-backed Codex worker consumes Codex plan allowance and may be throttled or unavailable when plan limits are reached; the harness does not treat subscription allowance as unlimited capacity.
- Provider requests necessarily leave the validation network boundary. `allowNetwork: false` applies to validation commands, not the configured model endpoint.
- A user can intentionally supply a broad allowlist, enable plaintext provider transport, enable local execution, permit validation networking, disable image pinning, or configure a dangerous image.
- Patches may contain proprietary source code or inline secrets from otherwise allowed paths. Secure the host account and artifact volume, and configure retention.
- Task-event digests detect partial or accidental mutation but are not signed or externally anchored; a compromised host account can rewrite an entire chain.
- Workflow-event digests and leases are local integrity and concurrency controls, not a signed ledger or distributed consensus system.
- MCP approval identifies the authenticated tool caller, not a verified human approver. Add identity and authorization outside this process when policy requires named-human approval.
- Deterministic evaluation proves only the evidence it was given. Missing criterion-specific checks and warning baselines remain explicitly inconclusive.
- An external editor or process can still race the final patch application between the last precondition check and the operating-system write. Repeated checks narrow but cannot eliminate that host-level race.

## Out of scope

- Multi-tenant isolation
- Central authentication and authorization
- Remote execution infrastructure
- Production deployment
- Database migrations
- Secrets brokerage
- Signed patch approval
- Organization-wide audit retention
- Defense against a compromised host account, kernel, Docker daemon, or local toolchain
