# Codex setup

## Authentication

Use Codex's supported ChatGPT sign-in flow when you want Codex activity to use your ChatGPT subscription:

```bash
codex login
```

Choose ChatGPT sign-in rather than API-key authentication.

The worker model remains a separate provider integration and requires its own endpoint and credential.

## MCP configuration

Generate a configuration block from the installed path:

```bash
agent-harness-os codex-config
```

The server retains the legacy MCP initialization flow currently used by Codex and also supports stateless MCP `2026-07-28` clients.

The generated block uses:

- a local STDIO server
- named environment-variable forwarding
- required server startup
- a one-hour tool timeout
- `writes` as the default tool approval mode
- automatic approval for read-only health and report tools
- prompts for delegation and application

Store the block in `~/.codex/config.toml` for all trusted projects or `.codex/config.toml` for one trusted repository.

Restart the Codex host after editing configuration, then use:

```bash
codex mcp list
```

## Recommended Codex policy

Keep the following distinction in `AGENTS.md`:

- Codex may inspect, plan, and run non-destructive validation directly.
- Codex may delegate bounded mechanical work.
- Codex must review worker evidence.
- Codex must not treat a completed run as proof that acceptance criteria passed.
- Applying a patch requires a separate tool call.
- Merging, pushing, deploying, migrating, or contacting users remains outside the harness.
