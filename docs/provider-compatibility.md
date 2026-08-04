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

The adapter does not currently support provider-native Responses APIs, streaming-only endpoints, XML tool calls, or proprietary tool-call formats. Responses are capped by `QWEN_MAX_RESPONSE_BYTES`, provider requests have bounded retries and timeouts, and a single assistant turn may contain at most 32 tool calls.

## URL configuration

Use `QWEN_BASE_URL` for a conventional API root such as `https://provider.example/v1`.

Use `QWEN_CHAT_COMPLETIONS_URL` for a full endpoint override. When present, it takes precedence over `QWEN_BASE_URL`.

## Authentication

The adapter sends:

```text
Authorization: Bearer <QWEN_API_KEY>
```

Additional string headers can be supplied through `QWEN_HEADERS_JSON`. Additional headers override the default header when names collide, so treat configuration access as security-sensitive.

## Compatibility validation

Before using a real repository:

1. Run `agent-harness-os doctor`.
2. Delegate a read-only research task against a disposable repository.
3. Verify that the provider calls `list_files` or `read_file` and returns a final assistant response.
4. Delegate a one-file implementation task.
5. Inspect the report and patch.
6. Apply it and rerun local validation.

A provider that can generate ordinary text but cannot preserve tool-call IDs and arguments across turns is not compatible.
