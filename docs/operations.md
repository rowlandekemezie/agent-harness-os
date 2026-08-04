# Operations

## Startup checks

Run:

```bash
agent-harness-os doctor
```

A ready system has provider configuration, Git, and the selected validation backend. Docker must be available when Docker mode is selected, and any task with validation commands requires an image pinned by SHA-256 unless that protection was explicitly disabled.

Local validation is an explicit trust decision. It is disabled by default and cannot enforce `allowNetwork: false`; a locally validated task must explicitly permit network access. The task's `allowNetwork` flag governs validation-command egress only. It does not disable the model-provider request.

## Logs

Logs are newline-delimited JSON on standard error. They intentionally omit prompts, source code, patches, and credentials. Collect standard error with your local process supervisor when durable diagnostics are required.

Supported levels are `debug`, `info`, `warn`, and `error` through `AGENT_HARNESS_LOG_LEVEL`.

## Artifacts

Default artifacts are stored under:

```text
~/.agent-harness-os/runs/<repository-key>/<run-id>/
```

The artifact root must resolve outside the target repository. Each run contains private regular files. Report and patch loading rejects unexpected paths, symbolic links, multiple hard links, oversized files, and paths that resolve outside the repository-specific artifact root.

Each run contains:

- `report.json`
- `changes.patch`, only when the run produced an applicable patch
- `worker-transcript.txt`

The repository key is a truncated SHA-256 of the normalized repository path. Set `AGENT_HARNESS_ARTIFACT_ROOT` to use an encrypted or centrally managed local volume.

Define a retention policy appropriate for source-code sensitivity. Reports and transcripts are redacted, but patches intentionally preserve exact source bytes and may contain proprietary code or inline secrets that were inside allowed paths. A conservative personal default is 30 days, provided no active review still references the run. Remove an entire run directory atomically; never edit a report or patch in place.

## Credential handling

- Inject `QWEN_API_KEY` through the process environment or an operating-system secret manager.
- Use HTTPS for every non-loopback provider endpoint. `QWEN_ALLOW_INSECURE_HTTP=true` sends the provider credential and source context over plaintext transport.
- Do not place provider credentials in `.codex/config.toml` when `env_vars` can forward them.
- Rotate the key after suspected exposure.
- Treat provider-specific custom headers as credentials unless proven otherwise.
- Confirm the provider's retention, training, residency, and logging policy before sending proprietary repositories.

## Validation behavior

The model receives file tools only. `requiredCommands` are supplied by Codex and executed by the harness after the model loop.

The harness captures and validates the candidate patch before running commands. A run is invalidated when validation changes any of the following:

- patch bytes
- changed-file membership
- `HEAD`
- executable Git configuration

Use check-only formatter modes and generators that write to disposable output locations outside the allowed patch. Run mutating formatters in the real checkout after applying and reviewing the worker patch.

Control-plane and dependency files, including manifests, lockfiles, CI configuration, Docker configuration, and editor/agent configuration, are readable when explicitly allowed but cannot be changed by the worker. Codex remains responsible for those changes.

## Failure recovery

### Provider unavailable

The adapter retries HTTP 429 and 5xx failures with exponential backoff and jitter. Non-retryable HTTP responses fail immediately. Redirects are not followed, preventing credentials and source context from being forwarded to another origin. Re-run the task after correcting provider configuration or availability.

### Worker timeout or cancellation

A timeout is persisted as `timed_out`; an MCP cancellation is persisted as `cancelled` when possible. Neither run can be applied. Narrow the task, retry it, or raise the bounded timeout only after reviewing the task scope.

### Context, tool-call, traversal, search, or MCP limits

Limit failures are intentional denial-of-service controls. Narrow the path allowlist, split the objective, reduce model iterations, or use targeted file reads. Raise a global limit only after measuring the repository and understanding the memory, cost, and latency consequence.

### Policy violation

The run is persisted with `policy_violation` and cannot be applied. Review whether the worker attempted an unsafe action or whether the task contract was incorrectly narrow. Do not weaken a global control when a narrower allowlist adjustment is sufficient.

### Validation mutated the worktree

The run is persisted as failed. The stored patch remains the original model patch, not the validation mutation. Replace the mutating command with a check-only equivalent or apply the original patch, then run the formatter or generator under Codex supervision in the real checkout.

### Validation container cleanup failed

The run fails closed and exposes no applicable patch. The harness preserves the detached worktree because deleting it while an unconfirmed container may still hold the writable mount would be unsafe. Inspect Docker, forcibly remove the named `agent-harness-*` container, inspect the preserved path in the warning, then remove the worktree and run `git worktree prune`.

### Stale base

`apply_worker_patch` rejects a run when `HEAD` moved. Re-run delegation against the current commit. Do not force-apply a stale agent patch.

### Dirty checkout

Commit, stash, or discard local work before applying. The harness does not automatically stash user changes. It checks cleanliness and the base commit again after `git apply --check`, immediately before application, to narrow the race with external editors or processes.

### Repository lease

Repository operations use a lock file under the private artifact root. A live same-host PID prevents concurrent delegate/apply operations across MCP processes. Fresh incomplete locks receive a grace period. Dead same-host locks and expired remote-host locks are reclaimed through an atomic rename to a quarantine path before removal. Investigate repeated stale locks before deleting anything manually.

### Orphaned worktree

Ordinary cleanup runs in a `finally` block. After a process crash, inspect temporary directories named `agent-harness-os-*` and run `git worktree prune` in the affected repository before removing a verified orphan. A worktree intentionally preserved after validation-container cleanup failure must be remediated as described above.

## Monitoring

A local installation should at minimum track:

- run count by status
- provider request count and latency
- retry count
- MCP input-size and in-flight rejections
- model context size and total tool calls
- search bytes and traversal entries
- command duration, output truncation, and timeout count
- validation-mutation and container-cleanup failures
- policy-violation count
- patch size and changed-file count
- artifact storage volume

The current release exposes most of these details through reports, error codes, and logs but does not ship a telemetry exporter.

## Upgrade procedure

1. Review `CHANGELOG.md` and security notes.
2. Run `npm ci --ignore-scripts` and `npm run check` in the upgraded source.
3. Run `agent-harness-os doctor`.
4. Restart Codex or the MCP host.
5. Execute a read-only task in a disposable repository.
6. Execute and apply a small implementation task in a disposable repository.
7. Execute a task with deterministic validation in the configured backend.
8. Roll out to important repositories only after all three pass.
