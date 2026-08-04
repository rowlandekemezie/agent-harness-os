# Operations

## Startup checks

Run:

```bash
agent-harness-os doctor
```

A ready installation has:

- a current Git executable
- at least one enabled, fully configured worker
- a valid default worker, when configured
- Docker available with a digest-pinned image, or explicit trusted local validation enabled
- artifact storage outside the target repository

Inspect the worker registry and route separately through `list_workers` and `route_worker`.

## Registry changes

Treat `AGENT_OS_WORKERS_JSON` as production configuration. Review changes to:

- worker IDs and enabled state
- capabilities
- priority and routing tiers
- authentication environment-variable names
- provider endpoints and adapters
- retry and timeout limits
- output-token parameter choice
- pricing metadata

Capability and pricing changes can alter routing without changing application code. Keep the registry under configuration management and audit its effective value at startup.

## Credential rotation

Credentials are read at process startup. Rotate by updating the referenced environment variable and restarting the MCP process. Do not place credentials in the worker JSON, endpoint query strings, command arguments, repository files, or Codex prompts.

For provider-specific authentication headers, use `headerEnv`. Run `agent-harness-os codex-config` with the registry loaded and regenerate the MCP block whenever custom secret-variable names change.

## Routing operations

Use route preview before high-cost, privacy-sensitive, or high-blast-radius work. Record the intended:

- mode
- required capabilities
- cost and latency ceilings
- preferred worker, when strict selection is required
- fallback policy and maximum attempts

A route is deterministic for a fixed registry and policy. It is not based on live provider health, benchmark history, or current prices.

## Fallback incidents

Each fallback attempt creates a separate run report and worktree. The final report contains prior attempt IDs and failure codes.

Investigate repeated fallback by checking:

- provider HTTP status and timeout evidence
- model empty responses or iteration exhaustion
- adapter compatibility with tool calls
- provider context and response limits
- model availability and exact model ID

Do not broaden fallback to include policy or validation failures. Those failures indicate unsafe or incorrect work, not an unhealthy provider.

## Artifact retention

Run artifacts are stored outside repositories under the user-private state directory, or under `AGENT_HARNESS_ARTIFACT_ROOT`. Each run may contain:

- `report.json`
- `changes.patch`
- `worker-transcript.txt`

Reports include selected-worker metadata, route candidates, prior attempts, usage, validation results, and warnings. Protect and expire artifacts according to source-code sensitivity. Patches are intentionally byte-faithful and may contain secrets that already existed in delegated source paths.

## Docker validation

Use a digest-pinned image and network `none` by default. The harness resets the image entrypoint, uses a read-only root filesystem, mounts `.git` read-only, drops capabilities, sets no-new-privileges, and applies resource bounds.

If container cleanup cannot be confirmed, the run fails closed, exposes no applicable patch, and preserves the worktree for manual remediation.

## Local validation

Local validation is intended only for trusted repositories. It requires:

```bash
export AGENT_HARNESS_EXECUTION_BACKEND='local'
export AGENT_HARNESS_ALLOW_UNSANDBOXED_LOCAL='true'
```

A task with local validation commands must set `allowNetwork: true` because the host runtime cannot enforce network isolation.

## Upgrades

Before upgrading:

1. review the changelog
2. run the full test suite
3. inspect generated Codex configuration
4. preview routes for representative tasks
5. run a disposable fallback smoke test
6. verify report loading and patch application from the upgraded process
