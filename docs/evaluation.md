# Evaluation

Every new run is evaluated after candidate-patch capture and harness-run
validation, but before the run report is persisted. Evaluation consumes only
harness-captured evidence. A worker saying that tests passed is not evidence.

## Contract

Evaluators implement a provider-neutral interface:

```ts
interface Evaluator {
	readonly id: string
	evaluate(input: EvaluationInput): Promise<EvaluationResult>
}
```

The service always runs `deterministic-v1`. Embedders may inject additional
evaluators with unique IDs; they cannot replace the deterministic evaluator.
Results run in a stable order and aggregate as follows: any failure fails the
aggregate, otherwise any unknown result makes it inconclusive, otherwise it
passes.

Evaluator output is hostile input. Exact schemas, IDs, timestamps, dimensions,
statuses, evidence bounds, uniqueness, and outcome consistency are validated
before an event or report is written. Evaluator text is redacted with the same
policy as other report evidence.

## Deterministic dimensions

| Dimension | Evidence |
| --- | --- |
| `worker_execution` | Harness terminal status and failure code |
| `tests` | Explicitly classified harness-run test commands |
| `lint` | Explicitly classified harness-run lint commands |
| `typecheck` | Explicitly classified harness-run type-check commands |
| `changed_files_scope` | Validated changed files, limits, and path-policy results |
| `acceptance_criteria` | Criteria plus harness validation results |
| `patch_size` | Captured patch bytes and artifact limit |
| `new_warnings` | Harness warnings and validation output |
| `security_policy_compliance` | Harness-captured policy violations |

An absent test, lint, or type-check command is `not_applicable`, not passed.
Command classification is explicit; a generic command named `check` does not
silently count for every dimension.

Acceptance criteria remain `unknown` when a completed run has no
criterion-specific deterministic proof. Warnings remain `unknown` when no
trusted base-commit warning comparison exists. These unknowns make the aggregate
inconclusive, but do not by themselves make the run unusable.

## Gates and compatibility

A failed evaluation changes an otherwise completed run to `failed` with
`EVALUATION_FAILED`; it never triggers worker fallback. A patch over the
artifact limit is not persisted. Changed-file limits and path-policy failures
remain `policy_violation` outcomes and are also recorded as evaluation evidence.
Only `completed` reports can pass the separate patch-application gate.

New reports use schema version 3 and contain an evaluation summary. Version 1
and 2 reports remain readable. New task journals use event schema version 2 and
require `EvaluationCompleted` between validation and attempt completion.
Version 1 journals remain replayable without synthesizing evaluation evidence.

Model-based dimensions such as correctness, maintainability, architecture fit,
and test quality are reserved by the schema, but no built-in model evaluator is
wired in yet.
