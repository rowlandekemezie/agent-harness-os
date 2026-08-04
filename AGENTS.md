# Agent instructions

## Purpose

Maintain a secure MCP worker harness. Treat filesystem authority, command execution, model output, Git patches, provider responses, and persisted artifacts as hostile inputs until deterministic validation succeeds.

## Code style

- Use TypeScript and Node.js built-ins unless a dependency has a clear operational justification.
- Use function declarations for standalone functions.
- Use tabs for indentation.
- Omit semicolons.
- Use single quotes.
- Prefer `Array<Type>` over `Type[]`.
- Prefer descriptive type names.
- Optimize for maintainability, testability, and explicit trust boundaries.
- Preserve strict TypeScript settings.

## Architecture invariants

- Codex is the orchestrator; the worker is bounded execution.
- `delegate_to_worker` must never modify the caller's checkout.
- Worker writes occur only in a detached Git worktree.
- Patch application remains a separate MCP tool.
- Never trust a worker's statement that tests passed; the worker has no command tool, and only harness-captured post-model validation results count as evidence.
- Never persist provider credentials, permit plaintext remote provider transport by default, or forward the host environment to child commands.
- Never redact or transform patch bytes; protect them with permissions and verify a digest.
- Never expose command execution to the worker. Harness-run validation must spawn an allowlisted executable with an argument array and no shell.
- Capture and validate the model patch before validation; invalidate the run if validation changes patch bytes, changed files, `HEAD`, or executable Git configuration.
- Keep dependency manifests, lockfiles, CI, Docker, development-container, editor, MCP, and agent-control files outside worker write authority.
- Never weaken traversal, search, context, tool-call, symlink, hard-link, secret-path, control-plane-write, explicit-allowlist, clean-tree, base-commit, container-cleanup, or patch-integrity checks to make a test pass.

## Validation

Before completing any code change, run:

```bash
npm run check
```

Add a regression test for every security or correctness bug.

## Change discipline

Keep changes small and reviewable. Document new environment variables, MCP tools, trust assumptions, provider behavior, and operational consequences. Do not add deployment, publishing, or automatic merge behavior without an explicit design review.
