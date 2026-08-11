# Evaluation

Every new run is evaluated after candidate-patch capture and harness-run
validation, but before the run report is persisted. Evaluation consumes only
harness-captured evidence. A worker saying that tests passed is not evidence.

## Contract

Evaluators implement a provider-neutral interface:

```ts
interface Evaluator {
	readonly id: string
	evaluate(input: EvaluationInput, signal: AbortSignal): Promise<EvaluationResult>
}
```

The service always runs `deterministic-v1`. Embedders may inject additional
evaluators with unique IDs; they cannot replace the deterministic evaluator.
Results run in a stable order and aggregate as follows: any failure fails the
aggregate, otherwise any unknown result makes it inconclusive, otherwise it
passes.

`EvaluationInput` includes the task objective, base commit, allowed and
prohibited paths, bounded candidate patch, validation evidence, and absolute
deadline. This is sufficient for an independent diff review without giving the
reviewer repository or command authority. Evaluators must honor the supplied
abort signal. The harness also races them against task cancellation and timeout,
so an evaluator that ignores the signal cannot retain the worktree or lease.
That deadline remains active through evaluation-event and report publication;
cancellation before the final attempt commit cannot return an applicable run.

Evaluator output is hostile input. Exact schemas, IDs, timestamps, dimensions,
statuses, evidence bounds, uniqueness, and outcome consistency are validated
before an event or report is written. The first result must be the complete
`deterministic-v1` dimension set. Text and aggregate limits use UTF-8 bytes.
Evaluator text is redacted with the same policy as other report evidence; the
exact final report is revalidated and byte-bounded after redaction.

## Deterministic dimensions

| Dimension | Evidence |
| --- | --- |
| `worker_execution` | Harness terminal status and failure code |
| `tests` | Explicitly classified harness-run test commands |
| `lint` | Explicitly classified harness-run lint commands |
| `typecheck` | Explicitly classified harness-run type-check commands |
| `changed_files_scope` | Validated changed files, limits, and path-policy results |
| `acceptance_criteria` | Criteria plus harness validation results |
| `patch_size` | Captured patch bytes, artifact limit, or bounded-capture failure |
| `new_warnings` | Harness warnings and validation output |
| `security_policy_compliance` | Harness-captured policy violations |

An absent test, lint, or type-check command is `not_applicable`, not passed.
Command classification is explicit; a generic command named `check` does not
silently count for every dimension.

Acceptance criteria remain `unknown` when a completed run has no
criterion-specific deterministic proof. Warnings remain `unknown` when no
trusted base-commit warning comparison exists. These unknowns make the aggregate
inconclusive, but do not by themselves make the run unusable.
Truncated validation output also makes warning evidence unknown because omitted
bytes may contain warnings.

## Gates and compatibility

A failed evaluation changes an otherwise completed run to `failed` with
`EVALUATION_FAILED`; it never triggers worker fallback. A patch over the
artifact limit is not persisted. Changed-file limits and path-policy failures
remain `policy_violation` outcomes and are also recorded as evaluation evidence.
Only `completed` reports can pass the separate patch-application gate.
Only the mandatory deterministic patch-size result can suppress patch
persistence; a model reviewer can fail a run but cannot discard an in-bound
audit patch.

New reports use schema version 3 and contain an evaluation summary. Version 1
and 2 reports remain readable. New task journals use event schema version 4,
require `EvaluationCompleted` between validation and attempt completion, and
bind the selected profile's evaluation policy and resolved task policy to that
decision. Older event schema versions remain replayable without inventing newer
evidence.
Patch application for a version 3 report additionally requires its evaluator
IDs, aggregate outcome, and completed status to match the validated task event
chain. Version 1 and 2 reports remain readable for audit, but cannot pass the
patch-application gate. Relabeling a version 3 report as legacy therefore
cannot bypass evaluation.

Model-based dimensions such as correctness, maintainability, architecture fit,
and test quality are reserved by the schema, but no built-in model evaluator is
wired in yet.
