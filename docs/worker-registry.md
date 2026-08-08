# Worker registry and routing

## Configuration format

`AGENT_OS_WORKERS_JSON` contains an array of one to thirty-two worker definitions. The JSON contains metadata and environment-variable names, not credentials.

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

The current coding runtime requires `tool-calling`. A task's mode is automatically added to its required capability set.

`private` means the operator considers the worker appropriate for the task's privacy requirement. The harness does not prove provider data handling or local isolation from this label.

## Routing metadata

- `priority`: zero to one hundred; higher is preferred for quality-oriented routing
- `costTier`: `low`, `medium`, or `high`
- `latencyTier`: `fast`, `standard`, or `slow`
- `pricing`: optional input/output USD per million tokens for API-worker run-level cost estimates
- for `codex`, `costTier` is an operator routing preference for incremental spend; the harness does not meter ChatGPT plan usage

Pricing and tiers are configuration, not live market data. Update them when provider terms change.

## Strategies

- `balanced`: combines priority, cost tier, and latency tier
- `cost`: strongly prefers lower cost tiers
- `latency`: strongly prefers faster latency tiers
- `quality`: strongly prefers higher priority

Sorting is deterministic. Worker ID is the final tie breaker.

## Fallback

Fallback requires:

- `allowFallback: true`
- more than one eligible worker
- a `maxAttempts` greater than one
- a failure classified as provider transport/response failure, empty model response, or model iteration exhaustion

Every attempt starts in a new detached worktree at the same base commit. Failed attempts are persisted for audit but cannot be applied. Policy violations, validation failures, unsafe repository state, and cancellation never trigger automatic fallback.
