# Operations

## Startup checks

Run:

```bash
agent-harness-os doctor
```

A ready system has provider configuration, Git, and the selected execution backend. Docker must be available when Docker mode is selected, and the configured image must use an immutable SHA-256 digest unless that protection was explicitly disabled.

## Logs

Logs are newline-delimited JSON on standard error. They intentionally omit prompts, source code, patches, and credentials. Collect standard error with your local process supervisor when durable diagnostics are required.

Supported levels are `debug`, `info`, `warn`, and `error` through `AGENT_HARNESS_LOG_LEVEL`.

## Artifacts

Default artifacts are stored under:

```text
~/.agent-harness-os/runs/<repository-key>/<run-id>/
```

Each run contains private regular files. Report and patch loading rejects symlinks and paths that resolve outside the repository-specific artifact root.

Each run contains:

- `report.json`
- `changes.patch`, when files changed
- `worker-transcript.txt`

The repository key is a truncated SHA-256 of the normalized repository path. Set `AGENT_HARNESS_ARTIFACT_ROOT` to use an encrypted or centrally managed local volume.

Define a retention policy appropriate for source-code sensitivity. A conservative personal default is 30 days, provided no active review still references the run. Remove an entire run directory atomically; never edit a report or patch in place.

## Credential handling

- Inject `QWEN_API_KEY` through the process environment or an operating-system secret manager.
- Do not place provider credentials in `.codex/config.toml` when `env_vars` can forward them.
- Rotate the key after suspected exposure.
- Treat provider-specific custom headers as credentials unless proven otherwise.

## Failure recovery

### Provider unavailable

The adapter retries HTTP 429 and 5xx failures with exponential backoff and jitter. Non-retryable HTTP responses fail immediately. Re-run the task after correcting provider configuration or availability.

### Worker timeout or cancellation

A timeout is persisted as `timed_out`; an MCP cancellation is persisted as `cancelled` when possible. Neither run can be applied. Narrow the task, retry it, or raise the bounded timeout only after reviewing the task scope.

### Policy violation

The run is persisted with `policy_violation` and cannot be applied. Review whether the worker attempted an unsafe action or whether the task contract was incorrectly narrow. Do not weaken a global control when a narrower allowlist adjustment is sufficient.

### Stale base

`apply_worker_patch` rejects a run when `HEAD` moved. Re-run delegation against the current commit. Do not force-apply a stale agent patch.

### Dirty checkout

Commit, stash, or discard local work before applying. The harness does not automatically stash user changes.

### Repository lease

Repository operations use a lock file under the private artifact root. A live lock prevents concurrent delegate/apply operations across MCP processes. Same-host dead-process locks and locks older than 24 hours are reclaimed. Investigate repeated stale locks before deleting anything manually.

### Orphaned worktree

Cleanup runs in a `finally` block. After a process crash, inspect temporary directories named `agent-harness-os-*` and run `git worktree prune` in the affected repository before removing a verified orphan.

## Monitoring

A local installation should at minimum track:

- run count by status
- provider request count and latency
- retry count
- command duration and timeout count
- policy-violation count
- patch size and changed-file count
- artifact storage volume

The current release exposes these details in reports and logs but does not ship a telemetry exporter.

## Upgrade procedure

1. Review `CHANGELOG.md` and security notes.
2. Run `npm ci` and `npm run check` in the upgraded source.
3. Run `agent-harness-os doctor`.
4. Restart Codex or the MCP host.
5. Execute a read-only task in a disposable repository.
6. Execute and apply a small implementation task in a disposable repository.
7. Roll out to important repositories only after both pass.
