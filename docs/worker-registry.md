# Worker registry and routing

## Configuration format

`AGENT_OS_WORKERS_JSON` contains one to thirty-two backing worker definitions.
Each definition owns provider/model transport and declared capabilities. The
JSON contains environment-variable names, not credentials.

```json
{
  "id": "worker-id",
  "enabled": true,
  "adapter": "openai-compatible",
  "model": "provider-model-id",
  "baseUrl": "https://provider.example/v1",
  "endpointUrl": null,
  "apiKeyEnv": "PROVIDER_API_KEY",
  "auth": "bearer",
  "headers": {},
  "headerEnv": {},
  "capabilities": ["implementation", "tool-calling"],
  "priority": 50,
  "costTier": "medium",
  "latencyTier": "standard",
  "timeoutMs": 120000,
  "maxRetries": 3,
  "maxResponseBytes": 4194304,
  "maxOutputTokens": 8192,
  "maxOutputTokensParameter": "max_tokens",
  "temperature": null,
  "allowInsecureHttp": false,
  "pricing": {
    "inputPerMillion": null,
    "outputPerMillion": null
  }
}
```

## Worker profiles

`AGENT_OS_WORKER_PROFILES_JSON` optionally turns backing workers into explicit,
routable roles. One backing worker can support several profiles without
duplicating credentials or provider settings.

```json
[
  {
    "id": "codex-implementation",
    "worker": "codex-subscription",
    "role": "implementation",
    "maxIterations": 20,
    "allowedCapabilities": ["implementation", "testing", "tool-calling", "long-context"],
    "evaluationPolicy": "strict"
  },
  {
    "id": "codex-review",
    "worker": "codex-subscription",
    "role": "review",
    "maxIterations": 12,
    "allowedCapabilities": ["review", "tool-calling", "long-context"],
    "evaluationPolicy": "default"
  }
]
```

Profile rules:

- `id` is the route, report, and task-history identity.
- `worker` must reference an existing backing worker.
- `role` is exactly one of `research`, `implementation`, `testing`, or `review`.
- `allowedCapabilities` must include the role and `tool-calling`, and must be a subset of the backing worker's capabilities.
- `maxIterations` defaults to 20 and caps the task's requested limit; it never raises it.
- `evaluationPolicy` defaults to `default`. `strict` rejects an inconclusive evaluation as `EVALUATION_INCONCLUSIVE`.
- `enabled` defaults to true. A profile remains unusable when its backing worker is disabled or misconfigured.

Profiles are bounded to sixty-four entries and reject unknown fields. When the
variable is present, backing worker IDs are not independently routable unless a
profile uses that ID. `AGENT_OS_DEFAULT_WORKER` and `preferredWorkerId` refer to
profile IDs. Without the variable, every backing worker remains an implicit,
backward-compatible profile with no additional role or iteration restriction.

## Adapters

### `codex`

Uses the locally installed Codex CLI as a worker by invoking non-interactive `codex exec`. It reuses saved Codex authentication instead of accepting a provider API key.

Minimal worker definition:

```json
{
  "id": "codex-subscription",
  "adapter": "codex",
  "capabilities": ["research", "implementation", "testing", "review", "tool-calling", "long-context"],
  "priority": 100,
  "costTier": "low"
}
```

Codex-specific fields:

- `command`: executable path or command name; defaults to `codex`
- `authMode`: `chatgpt` or `any`; defaults to `chatgpt`
- `model`: optional CLI model override; omitted by default so Codex chooses its supported default
- `timeoutMs` and `maxResponseBytes`: execution and structured-response bounds

Provider endpoint, API-key, header, pricing, retry, temperature, and output-token fields are rejected for this adapter. `authMode: "chatgpt"` fails closed unless `codex login status` reports ChatGPT authentication. `authMode: "any"` explicitly permits whatever saved Codex auth is active, including API-key auth that may be billed separately.

Each turn uses an ephemeral read-only scratch workspace with user config and rules disabled. The Codex process is not pointed at the repository. It returns either a bounded tool call or final content, and Agent Harness OS executes repository tools through the existing path and patch policies.

### `openai-compatible`

Uses `POST /chat/completions`, OpenAI-style messages, function tools, and tool-call results. This adapter covers providers that implement that contract, including OpenAI, many Qwen hosts, Gemini's compatibility endpoint, OpenRouter, and Ollama's compatibility endpoint.

`auth` may be:

- `bearer`: sends `Authorization: Bearer <apiKeyEnv value>`
- `none`: sends no built-in credential header; use this for local Ollama or `headerEnv` for another header scheme

`maxOutputTokensParameter` may be:

- `max_tokens`: broad compatibility default
- `max_completion_tokens`: current OpenAI Chat Completions models, including models incompatible with deprecated `max_tokens`
- `none`: omit an output-token request parameter

### `anthropic`

Uses the native Anthropic Messages API. It translates internal function definitions into Anthropic tools, assistant tool calls into `tool_use` blocks, and tool results into `tool_result` blocks. Authentication is an `x-api-key` sourced from `apiKeyEnv`.

## Credential rules

- Do not put credentials in `AGENT_OS_WORKERS_JSON`.
- `apiKeyEnv` names an environment variable that holds the primary credential.
- `headerEnv` maps a header name to an environment-variable name.
- Sensitive static headers such as `Authorization`, `api-key`, and `x-api-key` are rejected.
- Credential-shaped URL query parameters are rejected.
- Non-loopback HTTP endpoints are rejected unless `allowInsecureHttp` is explicitly true.
- Registry inspection never returns credentials and redacts query values.

When using Codex, run `agent-harness-os codex-config` with the registry loaded. The generated MCP block includes Codex auth-location variables plus every custom `apiKeyEnv` and `headerEnv` variable name declared by that registry. Regenerate it whenever those names change.

## Capabilities

Capabilities are operator assertions:

- `research`
- `implementation`
- `testing`
- `review`
- `tool-calling`
- `long-context`
- `private`

The current coding runtime requires `tool-calling`. A task's mode is automatically added to its required capability set. An explicit profile must also have an exact matching role, even if its capability subset mentions another mode.

`private` means the operator considers the worker appropriate for the task's privacy requirement. The harness does not prove provider data handling or local isolation from this label.

## Routing metadata

- `priority`: zero to one hundred; higher is preferred for quality-oriented routing
- `costTier`: `low`, `medium`, or `high`
- `latencyTier`: `fast`, `standard`, or `slow`
- `pricing`: optional input/output USD per million tokens for API-worker run-level cost estimates
- for `codex`, `costTier` is an operator routing preference for incremental spend; the harness does not meter ChatGPT plan usage

Pricing and tiers are configuration, not live market data. Update them when provider terms change.

Delegation supplements these assertions with bounded same-mode task history.
Measured evidence never makes an ineligible worker eligible. See
[Historical routing evidence](routing-evidence.md).

## Strategies

- `balanced`: combines priority, cost tier, and latency tier
- `cost`: strongly prefers lower cost tiers
- `latency`: strongly prefers faster latency tiers
- `quality`: strongly prefers higher priority

Sorting is deterministic. Historical completion/evaluation performance and,
when relevant, measured cost or duration adjust the declared score with bounded
confidence. Worker ID is the final tie breaker.

## Fallback

Fallback requires:

- `allowFallback: true`
- more than one eligible worker
- a `maxAttempts` greater than one
- a failure classified as provider transport/response failure or empty model response

Every attempt starts in a new detached worktree at the same base commit. Failed attempts are persisted for audit but cannot be applied. Policy violations, validation failures, unsafe repository state, and cancellation never trigger automatic fallback.

An inconclusive result rejected by a strict profile and exhaustion of a profile
or task iteration cap are policy failures, so neither triggers fallback.
