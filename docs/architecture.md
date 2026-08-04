# Architecture

## Responsibility split

```text
Codex
  intent, decomposition, architecture, acceptance, final review
        |
        v
MCP tools
  health, registry inspection, route preview, delegation, report, apply
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

The kernel captures the candidate patch before deterministic validation. It persists the patch, transcript, selected worker, route, prior attempts, provider usage, and validation evidence.

### Fallback

Fallback occurs outside an attempt. The repository lease remains held, while the failed worktree is cleaned and a new worktree is created for the next candidate. This prevents one model's partial edits or Git state from contaminating another model's attempt.

### Artifact and apply boundary

Every attempt has its own immutable audit record. Only a completed run with a valid patch can pass `apply_worker_patch`. The apply path does not consult routing or a model; it verifies the repository, artifact, base commit, and patch deterministically.

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
