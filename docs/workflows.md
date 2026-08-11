# Durable coding workflows

A workflow coordinates bounded delegations without weakening their trust
boundaries. It can plan, implement, test, review, repair, and request approval;
approval records a decision but never applies a patch.

```text
plan? -> implement -> test? -> review? -> approval
                           ^                 |
                           +---- repair? <---+ rejected
```

`implement` is required. The other worker stages are optional, and approval is
always present. Each worker stage has its own path authority, validation
commands, timeout, iteration bound, routing policy, and retry limit. Plan and
review are read-only modes and cannot run validation commands.

## Candidate model

The latest successful patch-bearing run is the workflow candidate. A failed
validation or evaluation patch can become repair input, but never retry input.
Test, review, and repair receive the candidate in a fresh detached worktree at
the workflow's verified base commit. The harness checks the source report, task
history, patch digest, changed files, and next-stage path policy in the same
bounded report snapshot that supplies candidate bytes, before contacting a
provider. Plan and repair summaries are likewise validated before reuse.
Before requesting or recording approval, it revalidates
the candidate and every completed stage run against task history. Each run is
bound to the workflow ID, stage, execution ID, stage-contract digest, and source
candidate, so another valid run cannot be substituted during replay. Later
stages return a cumulative patch against the original base.

Every later stage's `allowedPaths` must therefore cover the whole candidate,
not only files that stage might add. A failed deterministic evaluation may feed
repair only when its exact patch was retained and its history remains valid.
Retry limits count same-stage failure retries; repaired candidates re-enter
verification under the repair and global transition bounds.

A review-stage worker produces an auditable run summary; its prose is not a
trusted pass/fail signal. Harness evaluation policy still decides the run
status, and the MCP caller must inspect the review run before approval.

## Durability and bounds

Workflow state is replayed from an append-only, digest-chained journal. A stage
left active by a crash is recorded as interrupted on resume, then starts a new
bounded delegation; provider processes are never resumed in place. Interrupted
starts remain auditable but do not consume the stage retry or repair-attempt
budget. They still consume the total transition bound. Each workflow also has:

- an absolute deadline of 60 seconds to 24 hours
- 1 to 64 total stage starts
- up to two retries per non-repair stage
- up to five repair attempts
- up to sixteen previously created, same-repository dependencies
- at most 128 lease claims inspected for one workflow during recovery

The absolute deadline covers delegation, evidence validation, approval events,
and terminal publication. Cancellation covers active runs and approvals; the
first committed terminal event wins.

The journal records `WorkflowCreated`, dependency state changes, stage starts,
interruptions and completions, approval requests and decisions, and one terminal
`WorkflowCompleted`. Failure status and code are task-history-bound before a
retry or repair branch starts. One timeline is capped at 512 events and 2 MiB.
Listing is capped at 10,000 workflow directories, 25,000 events, and 8 MiB per
request.

Dependency waits are persisted. A failed dependency blocks the dependent
workflow. Definitions are immutable, so requiring an existing dependency also
prevents cycles.

Owner-private, uniquely named workflow claims prevent concurrent runners
without reusing a reclaimed claim pathname. A local claim from a dead process,
including a validated crash-left publication link, is reclaimed; an invalid or
live claim fails closed. Cancellation aborts an active delegation or approval
only after repository ownership is validated. After a crash, resume or cancel
once the stale claim is reclaimable.

## Tools

Use the tools in this order:

1. `create_coding_workflow` stores the fixed-base definition without invoking a worker.
2. `run_workflow` runs or resumes until terminal, dependency wait, or approval.
3. `get_workflow` and `list_workflows` inspect validated state.
4. `approve_workflow` accepts or rejects the candidate; rejection may enter repair.
5. `cancel_workflow` records cancellation and aborts locally owned active work.
6. `apply_worker_patch` applies an approved workflow's `candidateRunId` after an independent review.

Approval trusts the authenticated MCP caller; Agent Harness OS does not identify
or authenticate a human approver. An approved workflow is evidence, not checkout
authority. Apply remains a separate destructive call with the existing report,
history, repository, base-commit, and patch-integrity gates.

See [`examples/workflow.json`](../examples/workflow.json) for a complete create
request and [Execution history](execution-history.md) for delegation/run
identity.
