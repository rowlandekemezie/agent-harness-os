# Provider compatibility

## Required API behavior

The worker provider must accept an HTTP POST compatible with OpenAI chat completions:

```text
<base-url>/chat/completions
```

The request includes:

- `model`
- `messages`
- `tools`
- `tool_choice: "auto"`
- `temperature`

The provider must return at least one choice containing an assistant message. Tool calls must use the conventional shape:

```json
{
  "id": "call-id",
  "type": "function",
  "function": {
    "name": "read_file",
    "arguments": "{\"path\":\"src/index.ts\"}"
  }
}
```

The adapter does not currently support provider-native Responses APIs, streaming-only endpoints, XML tool calls, or proprietary tool-call formats. Responses are capped by `QWEN_MAX_RESPONSE_BYTES`, provider requests have bounded retries and timeouts, a single assistant turn may contain at most 32 tool calls, a complete run is bounded by `AGENT_HARNESS_MAX_TOTAL_TOOL_CALLS`, and the serialized provider conversation is bounded by `AGENT_HARNESS_MAX_PROVIDER_CONTEXT_BYTES`.

## URL configuration

Use `QWEN_BASE_URL` for a conventional API root such as `https://provider.example/v1`. HTTPS is mandatory for non-loopback hosts by default. Plain HTTP is accepted for `localhost`, `*.localhost`, IPv4 loopback, and `::1`. Set `QWEN_ALLOW_INSECURE_HTTP=true` only for a trusted endpoint that cannot provide TLS.

Provider URLs may not embed usernames or passwords. `QWEN_BASE_URL` may not contain a query string; use the full endpoint override when a provider requires query parameters.

Use `QWEN_CHAT_COMPLETIONS_URL` for a full endpoint override. When present, it takes precedence over `QWEN_BASE_URL`. HTTP redirects are not followed, so a provider must return the completion response from the configured origin rather than redirecting the credential and source context elsewhere.

## Authentication

The adapter sends:

```text
Authorization: Bearer <QWEN_API_KEY>
```

Additional string headers can be supplied through `QWEN_HEADERS_JSON`. Additional headers override the default header when names collide, so treat configuration access as security-sensitive. The task's `allowNetwork` setting applies to post-model validation commands, not to the provider request itself.

## Compatibility validation

Before using a real repository:

1. Run `agent-harness-os doctor`.
2. Delegate a read-only research task against a disposable repository.
3. Verify that the provider calls `list_files` or `read_file` and returns a final assistant response.
4. Delegate a one-file implementation task.
5. Inspect the report and patch.
6. Apply it and rerun local validation.

A provider that can generate ordinary text but cannot preserve tool-call IDs and arguments across turns is not compatible.
