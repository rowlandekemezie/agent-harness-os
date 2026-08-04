# Provider compatibility

## OpenAI-compatible adapter

A compatible endpoint must support:

- `POST /chat/completions`
- system, user, assistant, and tool messages
- function definitions using JSON Schema
- assistant tool calls with stable IDs, names, and JSON arguments
- tool-result messages correlated by tool-call ID
- a final assistant message without tool calls

The adapter accepts usage fields using either `prompt_tokens`/`completion_tokens` or `input_tokens`/`output_tokens`.

### OpenAI

```json
{
  "adapter": "openai-compatible",
  "baseUrl": "https://api.openai.com/v1",
  "apiKeyEnv": "OPENAI_API_KEY",
  "maxOutputTokensParameter": "max_completion_tokens"
}
```

OpenAI's current Chat Completions API deprecates `max_tokens` in favour of `max_completion_tokens`, and some reasoning models reject the older field. Configure the field explicitly for those workers.

### Gemini

Google exposes an OpenAI-compatible base URL:

```text
https://generativelanguage.googleapis.com/v1beta/openai
```

Use bearer authentication with `GEMINI_API_KEY`. Google recommends its native API for provider-specific advanced features; this harness uses the compatibility surface for the shared coding-worker contract.

### Ollama

Ollama exposes an OpenAI-compatible endpoint at a local base such as:

```text
http://127.0.0.1:11434/v1
```

Use `auth: "none"`. The selected local model must support tool calling. Marking a worker `private` remains an operator assertion about the complete local environment, not merely the endpoint address.

### Qwen and OpenRouter

Use the base URL and exact model ID from the selected host. Do not assume that every Qwen deployment implements OpenAI function calling identically. Validate the complete multi-turn tool loop before assigning write authority.

## Anthropic adapter

The native adapter uses:

- `POST /v1/messages`
- `x-api-key`
- `anthropic-version`
- Anthropic tool definitions
- `tool_use` and `tool_result` content blocks

Set `baseUrl` to `https://api.anthropic.com/v1`, or provide a complete `endpointUrl` for a compatible gateway.

## Compatibility smoke test

Before allowing repository writes:

1. Run `agent-harness-os doctor`.
2. Inspect `list_workers` and `route_worker` output.
3. Delegate a read-only task against a disposable repository.
4. Confirm the worker performs at least one file-tool call and returns a final response.
5. Delegate a one-file implementation task.
6. Inspect the selected worker, route metadata, changed files, and patch.
7. Apply the patch and rerun validation in the real checkout.
8. Test a deliberate provider failure and confirm fallback starts from a clean base.

A provider that generates text but cannot preserve tool-call IDs and arguments across turns is not compatible.
