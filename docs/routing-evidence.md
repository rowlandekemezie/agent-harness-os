# Historical routing evidence

Delegation augments declared worker metadata with bounded measurements from the
repository's validated task journal. The router remains deterministic: no model
selects a worker, rewrites a capability, or changes policy.

## Evidence window

`AGENT_OS_ROUTING_EVIDENCE_TASK_LIMIT` controls the number of recent same-mode
tasks included per delegation. The default is 100, the maximum is 100, and `0`
disables history-based scoring. Journal traversal and sampled timelines are
separately bounded; reads are read-only,
cancellation-aware, and included in the task deadline.

Only event-schema-version-5 attempts contain routing metrics. Older history
remains readable but does not invent measurements. Evidence is grouped by exact
worker/profile ID and task mode, so review results do not score implementation
work and a renamed profile starts with no samples.

Each worker aggregate records:

- completed attempts and evaluation passes
- median end-to-end attempt duration
- average provider latency and total tokens
- average estimated cost when configured pricing produced one
- produced and applied patch counts

Patch application is exposed for audit but does not affect routing scores;
application may reflect human workflow rather than worker quality.

## Scoring

Capability, profile-role, cost-tier, latency-tier, and policy filters run first.
An explicit preferred worker remains authoritative when it satisfies those
filters. History can only reorder eligible fallback candidates.

Measured completion and evaluation rates receive confidence
`min(sampleSize, 20) / 20`. Strategy-specific maximum score adjustments are:

| Strategy | Performance | Measured cost | Median duration |
| --- | ---: | ---: | ---: |
| `quality` | ±300,000 | — | — |
| `balanced` | ±75,000 | ±30,000 | ±30,000 |
| `cost` | ±20,000 | ±60,000 | — |
| `latency` | ±20,000 | — | ±60,000 |

Cost and duration adjustments are deterministic ranks among eligible workers
with comparable measurements. Missing or tied measurements contribute zero.
Worker ID remains the final tie breaker.

## Audit and trust boundary

The run report stores the complete evidence snapshot, the sampled task IDs and
latest event hashes, its SHA-256 digest, and each candidate's score and reasons.
Event schema version 5 binds the digest and sample counts in `RouteSelected`;
`AttemptCompleted` records the bounded metrics that future routes consume.
The event also binds a routing-decision digest over the strategy, eligible
candidates, scores, reasons, attempt bound, and evidence digest. Removing or
changing report evidence makes a current run fail the patch-application history
gate.

Corrupt or unsafe history fails closed before a provider is contacted. Operators
who need declared-metadata-only routing can set the task limit to `0`. The
`route_worker` tool remains a registry-only preview because it does not accept a
repository; inspect a delegation report for the evidence-backed route.
