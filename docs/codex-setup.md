# Codex setup

## Install and validate

```bash
npm ci --ignore-scripts
npm run check
npm link
agent-harness-os doctor
```

## Configure workers

Export provider credentials and `AGENT_OS_WORKERS_JSON` in the shell that starts Codex. A complete registry example is in `examples/workers.json`.

```bash
export OPENAI_API_KEY='...'
export ANTHROPIC_API_KEY='...'
export AGENT_OS_WORKERS_JSON="$(cat examples/workers.json)"
```

The example file contains placeholder model IDs; replace or remove workers before use.

## Generate MCP configuration

```bash
agent-harness-os codex-config
```

Add the generated block to Codex configuration. The server is named `agent_os`.

Run this command with `AGENT_OS_WORKERS_JSON` set. The generated `env_vars` list includes common provider credentials and every custom `apiKeyEnv` and `headerEnv` name declared by the loaded registry. Regenerate the block whenever those names change.

## Approval model

Recommended approvals:

- `health_check`: approve
- `list_workers`: approve
- `route_worker`: approve
- `get_worker_run`: approve
- `delegate_to_worker`: prompt
- `apply_worker_patch`: prompt

Delegation is non-destructive to the caller's checkout but sends bounded repository context to a selected external worker. Patch application modifies the checkout.

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
