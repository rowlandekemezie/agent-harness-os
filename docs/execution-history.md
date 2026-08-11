# Execution history

Agent Harness OS assigns one `taskId` to an accepted delegation. Every isolated
worker attempt still receives its own `runId`. Fallback attempts share the task
ID but retain separate reports, patches, transcripts, worktrees, and run IDs.

```text
taskId
  |
  +-- runId 1 (failed provider attempt)
  |
  +-- runId 2 (completed fallback attempt)
  |
  +-- patch application lifecycle
```

The run report remains the authority for patch review and application. The task
journal provides durable history and query projections; Agent Harness OS does
not reconstruct patch bytes or application authority from events.

Before adding application events, the harness proves that the report's run,
worker, repository, base commit, patch digest, changed-file count, and terminal
status match the journal. Missing, corrupt, mismatched, or unwritable history is
reported as a warning but does not override a valid report or patch gate.

## Event model

The harness records these versioned events:

- `TaskCreated`
- `RouteSelected`
- `WorkerStarted`
- `ToolCalled`
- `WorkerCompleted`
- `PatchProduced`
- `ValidationCompleted`
- `EvaluationCompleted`
- `AttemptCompleted`
- `TaskCompleted`
- `PatchApplicationRequested`
- `PatchApproved`
- `PatchApplied`
- `PatchApplicationRejected`

Events contain control-plane metadata only. `ToolCalled` records the tool name,
iteration, outcome, duration, and input/output byte counts. It never records tool
arguments or results. `PatchProduced` records the patch digest, byte count, and
changed-file count. Exact patch bytes remain only in `changes.patch` with the
existing private permissions and integrity checks.

`EvaluationCompleted` records evaluator IDs, the aggregate outcome, and failed
or unknown dimension IDs. Detailed summaries and evidence remain in the run
report. New event-schema-version-2 attempts require evaluation after validation
and before attempt completion. Version 1 timelines remain readable without
invented evaluation events.

`PatchApplicationRequested` records the incoming destructive MCP request.
`PatchApproved` is emitted only after deterministic pre-application checks pass
and immediately before Git is invoked. Its source is `mcp_call`; it records the
approval seam but does not authenticate a person. Authentication remains the
MCP client's responsibility.

## Storage and integrity

Task history is stored under the repository-specific artifact root:

```text
tasks/<taskId>/
  events/
    000000000001-<sha256>.json
    000000000002-<sha256>.json
```

Event files are private, individually bounded, strictly sequenced, named with
their SHA-256 digest, and linked by SHA-256. Writes stage and sync content in a
verified directory inode, atomically publish the final name, then sync the
directory. A task becomes visible only after `TaskCreated` is durable and an
exclusive `.task-ready` marker links the task ID to its first event digest.
Readers recognize a verified staging/final hard-link pair as committed without
mutating it, ignore staging-only names, and validate exact event fields, the
full lifecycle, run relationships, containment, sequence, and digests before
returning content.

A process crash may leave a UUID task directory without `.task-ready`, or a
`.publish-*` staging link. Queries remain read-only: they recognize a matching
committed pair and ignore bounded staging-only entries. With the server stopped,
operators may unlink a verified same-inode staging link, or remove a staging-only
entry after confirming no task is active and no final name exists. Never remove
the final event name.

Summaries are projected from the validated event chain. They are not stored as
a second mutable source of truth. One timeline is bounded to 10,000 events and
8 MiB. Task listing is bounded to 10,000 directory entries, 25,000 events, and 8 MiB of
event bytes per request.

The digest chain detects accidental or partial mutation. It is not a signed or
externally anchored audit ledger: a host account able to rewrite the entire
artifact root remains outside the threat model.

## Query tools

`list_tasks` returns repository-scoped summaries with a maximum page size of
100. It supports status, mode, and worker-ID filters plus cursor pagination.

`get_task_timeline` returns a validated summary and ordered event list. Its
`incomplete` field is true when no terminal `TaskCompleted` event exists. An
incomplete timeline may represent an active operation or a process that stopped
before writing its terminal event; the journal does not guess between them.

Historical schema-version-1 and version-2 run reports remain readable through
`get_worker_run` and applicable through `apply_worker_patch`. They do not have
mandatory evaluation evidence. Version 1 reports do not have a task ID, so the
harness cannot synthesize a task timeline for them.

## Replay semantics

History replay means reconstructing the recorded task timeline for debugging or
using its evidence to submit a new task against a newly verified base commit. It
does not mean reproducing a model response. Provider behavior is not assumed to
be deterministic, and a replay never bypasses routing, worktree isolation,
validation, or patch approval.
