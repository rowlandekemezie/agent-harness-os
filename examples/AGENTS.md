# Engineering agent instructions

## Delegated work

Use the `qwen_worker` MCP server for bounded repository inspection, mechanical implementation, test generation, repetitive refactoring, and independent review.

Before calling `delegate_to_worker`, provide:

- one concrete objective
- explicit allowed paths
- explicit prohibited paths
- acceptance criteria
- deterministic validation commands
- the current base ref
- a bounded timeout and iteration limit

Never delegate product interpretation, architecture approval, secret handling, production operations, database migration execution, merge decisions, or final acceptance.

After delegation:

1. Read the worker report.
2. Inspect the changed-file list and patch.
3. Confirm no scope expansion occurred.
4. Evaluate acceptance criteria independently.
5. Apply only through `apply_worker_patch`.
6. Rerun validation in the real checkout.
7. Review the final diff before committing.

## Project validation

Run the repository's formatting, linting, type-checking, unit-test, and relevant integration-test commands. Do not claim success unless the captured exit code is zero.
