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

Treat `AGENT_OS_WORKER_PROFILES_JSON` the same way. Review each profile's backing
worker, exact role, capability subset, iteration cap, enabled state, and
evaluation policy. When this variable is present, only profile IDs are routable;
set `AGENT_OS_DEFAULT_WORKER` and task preferences to profile IDs. Removing the
variable restores one implicit profile per backing worker.

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

`list_workers` and `route_worker` expose profile metadata without credentials.
Confirm the selected profile role and effective iteration limit before a
high-impact delegation. `evaluationPolicy: strict` turns an inconclusive
evaluation into a failed, non-applicable run with
`EVALUATION_INCONCLUSIVE`; it never triggers fallback.

## Fallback incidents

Each fallback attempt creates a separate run report and worktree. The final report contains prior attempt IDs and failure codes.

Investigate repeated fallback by checking:

- provider HTTP status and timeout evidence
- model empty responses
- adapter compatibility with tool calls
- provider context and response limits
- model availability and exact model ID

Do not broaden fallback to include iteration caps, other policy failures, or
validation failures. Those outcomes indicate an exhausted authority boundary or
unsafe/incorrect work, not an unhealthy provider.

## Artifact retention

Run artifacts are stored outside repositories under the user-private state directory, or under `AGENT_HARNESS_ARTIFACT_ROOT`. Each run may contain:

- `report.json`
- `changes.patch`
- `worker-transcript.txt`

Reports include selected-worker metadata, route candidates, prior attempts,
usage, validation results, evaluation dimensions, and warnings. `failed`
evaluation dimensions block application. `unknown` dimensions make evaluation
inconclusive and require operator review; they are not claims of success. Protect
and expire artifacts according to source-code sensitivity. Patches are
intentionally byte-faithful and may contain secrets that already existed in
delegated source paths.

Version 3 application requires report evaluation metadata to match the
validated task timeline. Treat `EVALUATION_HISTORY_INVALID` and
`EVALUATION_HISTORY_MISMATCH` as fail-closed integrity incidents; do not repair
one artifact in isolation. Version 1 and 2 reports remain readable for audit
but cannot be applied; rerun the task to produce evaluation-bound evidence.

Task journals live under `tasks/<taskId>/events/`. Use `list_tasks` for bounded
discovery and `get_task_timeline` for the validated event chain. An
`incomplete` timeline may be active or interrupted; the journal does not guess.
Delete task journals only under the same retention policy as their run reports.
An interrupted atomic publication can leave a UUID task directory without
`.task-ready`, or a reserved `.publish-*` entry. Read-only queries recognize a
verified matching staging/final pair, ignore only bounded staging-only states,
and still count them toward traversal bounds. With the server stopped, unlink
only a same-inode staging link; remove a staging-only entry only after confirming
no task is active and no matching final name exists. Never remove the final
event name.

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
