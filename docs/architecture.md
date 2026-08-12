# Architecture

## Responsibility split

```text
Codex
  intent, decomposition, architecture, acceptance, final review
        |
        v
MCP tools
  health, routing, delegation, workflow control, history, observability, report, apply
        |
        v
Workflow service
  replay, dependencies, bounded stages, repair, approval, resume, cancellation
        |
        v
Policy resolver
  fixed-base repository policy, organization policy, restrictive task composition
        |
        v
Worker registry and deterministic router
  provider configuration, role profiles, budgets, candidate ordering, fallback limits
        |
        v
Provider adapter
  Codex CLI, OpenAI-compatible, or Anthropic Messages API
        |
        v
Secure execution kernel
  detached worktree, bounded file tools, path policy, validation, artifacts
        |
        v
Evaluation
  mandatory deterministic evidence, optional independent reviewers
        |
        v
Approval-separated patch application
```

Codex is not delegated away. The Agent OS supplies controlled execution capacity and evidence.

## Core components

### Configuration

`src/config.ts` loads backing workers, optional role profiles, secret references,
routing defaults, execution policy, and limits. A profile can reduce a backing
worker's capabilities and iterations but cannot expand them. Invalid references,
URLs, embedded credentials, duplicate IDs, unsupported adapters, and authority
expansion fail closed.

### Worker registry

`src/provider/registry.ts` owns configured worker metadata and adapter
construction. When profiles are configured, profile IDs are the routable and
historical worker identities; provider/model settings remain on the referenced
backing workers. Model names never drive the execution kernel.

### Router

`src/provider/router.ts` filters workers by:

1. enabled and configured state
2. exact profile role, task mode, and required capabilities
3. maximum cost tier
4. maximum latency tier

It then scores the remaining candidates using an explicit strategy, bounded
same-mode measurements from `src/provider/routing-evidence.ts`, and deterministic
tie breaking. Historical evidence is a read-only projection of validated task
events; it cannot change eligibility or policy. No LLM participates in routing.

Before routing, `src/policy/engine.ts` reads the repository policy from the
verified base commit and combines it with the optional host-managed organization
policy and task contract. Every merge operation is restrictive. The resolved
policy and source digests are bound to the report and event history. See
[Policies as code](policies.md).

The execution kernel caps the task's requested iteration count at the selected
profile limit. A `strict` evaluation profile also rejects an inconclusive
evaluation; a `default` profile preserves the explicit inconclusive result for
operator review.

### Provider adapters

Adapters implement the internal `WorkerProvider` contract:

```ts
interface WorkerProvider {
	complete(request: ProviderRequest): Promise<ProviderCompletion>
	getUsage?(): ProviderUsage
}
```

The internal agent loop is provider-neutral. Adapters translate messages, tools, tool results, response blocks, usage, authentication, errors, timeouts, and retries.

### Execution kernel

Each attempt receives:

- a fresh detached Git worktree at the original base commit
- one bounded task contract
- file-only tools constrained by path policy
- shared resource and context limits
- an attempt-specific provider instance

The kernel captures the candidate patch before deterministic validation. It persists the patch, transcript, selected worker, route, resolved policy, prior attempts, provider usage, validation evidence, and evaluation results.

### Evaluation

`src/evaluation/evaluator.ts` defines the provider-neutral evaluator contract.
`src/evaluation/deterministic.ts` converts only harness-captured status, command,
patch, changed-file, criterion, warning, and policy evidence into explicit
dimensions. `WorkerService` always runs it before optional injected reviewers,
validates every result, and aggregates outcomes without consulting the router.
Reviewers receive a bounded candidate patch and task evidence, plus a deadline
and cancellation signal; they receive no repository or command capability.
See [Evaluation](evaluation.md).

### Task journal

`src/artifacts/task-journal.ts` owns task identity, event storage, bounded
queries, and report-to-history linkage. `src/artifacts/task-event-model.ts` owns
exact schemas and the replay state machine. A task spans all fallback attempts;
each attempt keeps its own run ID and report.

Events are the history seam, while run reports remain patch authority. Event
filenames include their content digest and each event links to its predecessor.
The journal projects summaries from the validated chain instead of trusting a
mutable summary file.

### Observability

`src/observability/service.ts` is a read-only projection over the task and
workflow journals. It produces deterministic traces and recent same-mode task
metrics without reading raw artifact files, creating another store, or feeding
results back into routing and policy. Workflow-to-task spans require exact stage
provenance before linking. See [Observability](observability.md).

### Workflow service and journal

`src/workflow/service.ts` coordinates stages only through the `WorkerService`
contract; it never reaches into adapters or execution internals.
`src/workflow/journal.ts` and `src/workflow/event-model.ts` persist and replay
workflow decisions. A workflow stage maps to one ordinary delegation, so all
policy, routing, evaluation, artifact, and fresh-worktree gates still apply.

Patch-bearing stages are chained by run ID. `WorkerService` validates the source
report and task history, seeds the exact patch into a fresh worktree, and checks
the regenerated cumulative patch before provider execution. Task history and
the report bind each run to its workflow, stage, execution, stage-contract
digest, and source candidate. Workflow approval records intent only; the patch
application service remains the sole checkout mutation boundary. See
[Durable coding workflows](workflows.md).

### Secure artifact I/O

`src/artifacts/secure-io.ts` opens hostile files nonblocking, then verifies
regular-file type, handle identity, and containment for reads.
For writes, a sanitized Node helper starts in the verified destination
directory inode, rechecks containment around mutation, stages and syncs content,
publishes it with a no-replace hard link, and syncs the directory. Task
directories use exclusive creation plus a final readiness marker. Both run
artifacts, task events, workflow events, and workflow leases use this module.

### Fallback

Fallback occurs outside an attempt. The repository lease remains held, while the failed worktree is cleaned and a new worktree is created for the next candidate. This prevents one model's partial edits or Git state from contaminating another model's attempt.

### Artifact and apply boundary

Every attempt has its own immutable audit record. Only a completed version 3 run with a valid patch can pass `apply_worker_patch`. The apply path does not consult routing or a model; it verifies the repository, artifact, base commit, patch, and evaluation history deterministically. Removing a failed reviewer from `report.json`, or relabeling the report as legacy, cannot make a patch applicable. Version 1 and 2 reports remain readable for audit but must be rerun before application. Failure to append later patch-lifecycle events does not change patch authority.

Authoritative event publication uses a two-phase helper protocol. The helper
stages and fsyncs bytes, then waits. The parent keeps cancellation armed after
granting commit until the helper acknowledges a directory-synced final link. If
abort races that acknowledgment, the parent syncs the verified directory and
accepts only the exact final or final/staging inode and bytes. Removal helpers
likewise acknowledge only after directory sync; an unacknowledged mutation is
resynced or fails closed.

## Why this remains one package

The current codebase is intentionally monolithic. The registry, router, adapters, MCP surface, and execution kernel have narrow module boundaries, but splitting them into separately versioned packages would create release and compatibility overhead before the contracts have sufficient production evidence.

A later package split should preserve these dependency directions:

```text
provider adapters -> domain contracts
router -> worker metadata + domain contracts
execution kernel -> router + provider registry + security modules
MCP -> execution service
UI -> MCP or workflow application service
workflow service -> execution service, never provider internals
```
