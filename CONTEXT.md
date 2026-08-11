# Agent OS

Agent OS coordinates bounded coding work while keeping orchestration authority
separate from untrusted worker execution.

## Language

**Delegation**:
One bounded coding task routed to one or more fallback workers against a single
verified base commit.
_Avoid_: Job, workflow step, worker run

**Attempt**:
One worker's execution within a delegation. Fallback creates a new attempt in a
fresh worktree.
_Avoid_: Retry, delegation

**Workflow**:
A durable, resumable sequence of coding stages whose state is reconstructed from
validated history.
_Avoid_: Task, delegation, pipeline

**Stage**:
One named unit of workflow progress: plan, implement, test, review, repair, or
approval.
_Avoid_: Node, task, phase

**Candidate**:
The cumulative patch produced by the latest successful patch-bearing workflow
stage and used as input to a later stage.
_Avoid_: Change set, result, working tree

**Approval**:
An explicit workflow decision that accepts or rejects a candidate without
applying it to the caller's checkout.
_Avoid_: Merge, apply, authorization

**Resume**:
Continue a workflow by replaying its history and starting unfinished work in a
fresh attempt; it never continues a stopped provider process in place.
_Avoid_: Replay, restart
