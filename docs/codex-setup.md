# Codex setup

## Install and validate

```bash
npm ci --ignore-scripts
npm run check
npm link
agent-harness-os doctor
```

## Zero-additional-OpenAI-API-bill worker path

Authenticate the local Codex CLI with ChatGPT, then register it as a worker:

```bash
codex login
codex login status

export AGENT_OS_WORKERS_JSON='[
  {
    "id": "codex-subscription",
    "adapter": "codex",
    "capabilities": ["research", "implementation", "testing", "review", "tool-calling", "long-context"],
    "priority": 100,
    "costTier": "low"
  }
]'
export AGENT_OS_DEFAULT_WORKER='codex-subscription'
```

`authMode` defaults to `chatgpt`. Agent Harness OS runs `codex login status` before the first delegated turn and refuses API-key-authenticated Codex sessions by default. Set `authMode: "any"` only when API-key-backed Codex usage is intentionally acceptable.

The nested Codex process runs with `codex exec`, `--ephemeral`, a read-only scratch workspace, no approvals, and user configuration/rules disabled. It receives the bounded conversation and Agent OS tool schemas. It does not receive the target repository as its working directory. Agent OS remains the component that reads or writes repository files.

Each provider turn currently starts a fresh `codex exec` process and replays the bounded conversation. That prioritizes isolation and compatibility over latency. A persistent Codex app-server transport can be added later without changing the worker contract.

## Optional external workers

External providers can be added as fallbacks or specialist workers. Export their credentials and include them in `AGENT_OS_WORKERS_JSON`. A complete registry example is in `examples/workers.json`.

## Generate MCP configuration

```bash
agent-harness-os codex-config
```

Add the generated block to Codex configuration. The server is named `agent_os`.

Run this command with `AGENT_OS_WORKERS_JSON` set. The generated `env_vars` list includes Codex auth-location variables plus every custom `apiKeyEnv` and `headerEnv` name declared by the loaded registry. The Codex worker subprocess deliberately strips `OPENAI_API_KEY`, `OPENAI_ORG_ID`, and `OPENAI_PROJECT_ID`; it relies on saved Codex CLI authentication instead.

## Approval model

Recommended approvals:

- `health_check`: approve
- `list_workers`: approve
- `route_worker`: approve
- `get_worker_run`: approve
- `delegate_to_worker`: prompt
- `apply_worker_patch`: prompt

Delegation is non-destructive to the caller's checkout. A Codex worker consumes the local Codex account allowance; external workers send bounded repository context to their configured provider. Patch application modifies the checkout.

## Project instructions

Copy and adapt `examples/AGENTS.md`. Require Codex to:

1. define explicit allowed and prohibited paths
2. declare validation commands before delegation
3. state routing constraints only when they are material
4. preview routing for sensitive or expensive tasks
5. inspect selected-worker and fallback evidence
6. apply patches only through `apply_worker_patch`
7. rerun validation in the real checkout

## Verify

From Codex, call:

1. `health_check`
2. `list_workers`
3. `route_worker` for an implementation task
4. `delegate_to_worker` against a disposable repository
5. `get_worker_run`
6. `apply_worker_patch` after reviewing the result
