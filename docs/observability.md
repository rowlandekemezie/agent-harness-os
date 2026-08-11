# Observability

Agent Harness OS projects traces and metrics from validated task and workflow
journals. Observability is read-only evidence: it does not change routing,
policy, evaluation, workflow state, approval, or patch authority.

## Tools

`get_observability_trace` accepts a repository, `task` or `workflow`, its UUID,
and optional cursor pagination. A page contains at most 200 spans. Each
response is bounded to 512 KiB and one absolute 30-second deadline. The default
page size is 100.

`get_observability_metrics` requires a worker mode and reads at most 100 recent
same-mode task timelines; the default limit is 50. The actual
`sampledTaskCount`, `sampledAttemptCount`,
event-schema coverage, missing-measurement counts, and source event digests are
returned. Retention and aggregate journal bounds may make the sample smaller
than the requested limit.

Both tools propagate MCP cancellation, reject repository or workflow-stage
provenance mismatches, and fail the whole query if sampled history is invalid.
They never return a partial result.

## Trace model

Task traces contain routing, attempt, model-turn, tool, patch, validation,
evaluation, completion, and patch-application spans. Workflow traces contain
dependency, stage, approval, and completion spans; a completed stage points to
the deterministic trace ID of its validated task.

Trace and span IDs are deterministic hashes, not authentication. Every response
includes the source ID, event count, and latest event SHA-256. Sequence numbers,
not timestamps, establish ordering. `clockAnomalyCount` reports backward wall
clock movement; a duration derived only from inconsistent journal timestamps is
`null`.

New delegations use task event schema version 7. It records monotonic durations
and bounded wall times for task, routing, attempt, model, tool, validation, and
evaluation phases. Each model turn also binds the exact number of following
tool-call events. Older timelines remain readable; absent measurements remain
`null` or appear in coverage counts rather than being inferred.

Trace output excludes objectives, prompts, responses, transcripts, patches,
changed paths, command output, approval feedback, provider endpoints, headers,
and environment values.

## Metric semantics

Ratios return numerator, denominator, and integer basis points. A zero
denominator produces `basisPoints: null`.

- Task success: completed terminal tasks / all terminal tasks. In-progress tasks
  are excluded.
- Retry attempts: attempts after the first / all started attempts.
- Fallback tasks: tasks with more than one started attempt / tasks with any
  attempt.
- Attempt success: completed attempts / terminal attempts.
- Evaluation failure: failed evaluations / evaluated attempts. Failed
  dimensions are counted separately and are not described as defects.
- Patch acceptance: distinct applied patch-producing runs / distinct
  patch-producing runs.

Duration and usage distributions report sample count, minimum, median, p95,
maximum, total, and rounded average. Cost is stored in micro-US dollars. Missing
cost is unknown, never zero; task cost is included only when every terminal
attempt in a terminal task is priced. Tokens are provider-reported totals, not a
claim of complete billing usage.

Worker IDs and finite mode, status, outcome, and dimension values are the only
metric labels. Objectives, paths, task/run/workflow IDs, failure messages,
commands, model names, and provider URLs never become metric labels.

## Trust boundary and non-goals

The service reads only through the bounded task and workflow journals. Those
readers enforce private regular files, containment, link identity, UTF-8, exact
schemas, event order, digest chains, and credential screening. Workflow spans
are linked only after repository, run, task, stage, execution, source-candidate,
and stage-contract provenance agrees.

This milestone does not add a telemetry store, background collector, network
exporter, workflow aggregate metrics, dashboard, or automatic retention. The
validated journals remain the sole source of truth.
