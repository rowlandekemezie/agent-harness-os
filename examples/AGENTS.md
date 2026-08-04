# Engineering agent instructions

## Delegated work

Use the `qwen_worker` MCP server for bounded repository inspection, mechanical implementation, test generation, repetitive refactoring, and independent review.

Before calling `delegate_to_worker`, provide:

- one concrete objective
- explicit allowed paths
- explicit prohibited paths
- acceptance criteria
- deterministic, non-mutating validation commands that the harness will run after the model loop
- the current base ref
- a bounded timeout and iteration limit

Never delegate product interpretation, architecture approval, secret handling, production operations, database migration execution, dependency or CI control-plane changes, merge decisions, or final acceptance. The worker receives file tools only and cannot choose or run commands.

After delegation:

1. Read the worker report.
2. Inspect the changed-file list and patch.
3. Confirm no scope expansion or control-plane change occurred.
4. Evaluate acceptance criteria and harness-run validation independently. A completed command does not prove the natural-language criterion.
5. Apply only through `apply_worker_patch`.
6. Rerun validation in the real checkout.
7. Review the final diff before committing.

## Project validation

Run the repository's formatting, linting, type-checking, unit-test, and relevant integration-test commands. Do not claim success unless the captured exit code is zero.
