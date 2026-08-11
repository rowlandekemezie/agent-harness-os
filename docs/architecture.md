# Architecture

## Responsibility split

```text
Codex
  intent, decomposition, architecture, acceptance, final review
        |
        v
MCP tools
  health, registry inspection, route preview, delegation, history, report, apply
        |
        v
Worker registry and deterministic router
  configuration, capabilities, budgets, candidate ordering, fallback limits
        |
        v
Provider adapter
  OpenAI-compatible or Anthropic Messages API
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

`src/config.ts` loads worker definitions, secret references, routing defaults, execution policy, and limits. Invalid URLs, embedded credentials, duplicate worker IDs, unsupported adapters, and missing capabilities fail closed.

### Worker registry

`src/provider/registry.ts` owns configured worker metadata and adapter construction. Model names never appear in the execution kernel.

### Router

`src/provider/router.ts` filters workers by:

1. enabled and configured state
2. task mode and required capabilities
3. maximum cost tier
4. maximum latency tier

It then scores the remaining candidates using an explicit strategy and deterministic tie breaking. No LLM participates in routing.

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

The kernel captures the candidate patch before deterministic validation. It persists the patch, transcript, selected worker, route, prior attempts, provider usage, validation evidence, and evaluation results.

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

### Secure artifact I/O

`src/artifacts/secure-io.ts` verifies handle identity and containment for reads.
For writes, a sanitized Node helper starts in the verified destination
directory inode, rechecks containment around mutation, stages and syncs content,
publishes it with a no-replace hard link, and syncs the directory. Task
directories use exclusive creation plus a final readiness marker. Both run
artifacts and task events use this module.

### Fallback

Fallback occurs outside an attempt. The repository lease remains held, while the failed worktree is cleaned and a new worktree is created for the next candidate. This prevents one model's partial edits or Git state from contaminating another model's attempt.

### Artifact and apply boundary

Every attempt has its own immutable audit record. Only a completed run with a valid patch can pass `apply_worker_patch`. The apply path does not consult routing or a model; it verifies the repository, artifact, base commit, and patch deterministically. Version 3 application also binds evaluator IDs, outcome, and status to the validated task chain, so removing a failed reviewer from `report.json` cannot make a patch applicable. Legacy reports keep their prior degraded-history behavior. Failure to append later patch-lifecycle events does not change patch authority.

## Why this remains one package

The current codebase is intentionally monolithic. The registry, router, adapters, MCP surface, and execution kernel have narrow module boundaries, but splitting them into separately versioned packages would create release and compatibility overhead before the contracts have sufficient production evidence.

A later package split should preserve these dependency directions:

```text
provider adapters -> domain contracts
router -> worker metadata + domain contracts
execution kernel -> router + provider registry + security modules
MCP -> execution service
UI/durable workflows -> MCP or application service, never provider internals
```
