# Engineering agent instructions

## Delegated work

Use the `agent_os` MCP server for bounded repository inspection, mechanical implementation, test generation, repetitive refactoring, and independent review.

Before calling `delegate_to_worker`, preview routing when cost, privacy, latency, or model specialization matters. Then provide:

- one concrete objective
- explicit allowed paths
- explicit prohibited paths
- acceptance criteria
- deterministic, non-mutating validation commands that the harness will run after the model loop
- the current base ref
- a bounded timeout and iteration limit
- explicit routing constraints only when they are material; otherwise use the configured deterministic defaults
- inspect report routing evidence and score reasons when history changes worker order

Check `.agent-os/policy.json` when present. A route preview does not read the
repository; delegation may narrow its result using organization and fixed-base
repository policy. Confirm the resolved policy and source digests in the report.

Never delegate product interpretation, architecture approval, secret handling, production operations, database migration execution, dependency or CI control-plane changes, merge decisions, or final acceptance. The worker receives file tools only and cannot choose or run commands.

For multi-stage work, prefer `create_coding_workflow` and `run_workflow` when
crash-safe resume, specialist testing/review, bounded repair, dependencies, or
an explicit approval pause matter. Every later stage must allow every path in
the cumulative candidate. Workflow approval never replaces final review or
`apply_worker_patch`.

After delegation:

1. Read the worker report, selected worker, route, and prior fallback attempts.
2. Inspect the changed-file list and patch.
3. Confirm no scope expansion or control-plane change occurred.
4. Evaluate acceptance criteria and harness-run validation independently. A completed command does not prove the natural-language criterion.
5. Apply only through `apply_worker_patch`.
6. Rerun validation in the real checkout.
7. Review the final diff before committing.

## Project validation

Run the repository's formatting, linting, type-checking, unit-test, and relevant integration-test commands. Do not claim success unless the captured exit code is zero.
