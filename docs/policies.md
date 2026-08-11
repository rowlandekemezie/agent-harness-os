# Policies as code

Agent Harness OS can apply organization and repository constraints to every
delegation. Policies only reduce task authority; they cannot widen paths,
network access, execution time, iterations, changed-file limits, routing tiers,
fallback, or attempt counts.

## Sources and precedence

The harness composes these inputs in order:

1. process configuration and the task contract
2. optional organization policy from `AGENT_OS_ORGANIZATION_POLICY_PATH`
3. optional repository policy at `.agent-os/policy.json`

Composition always selects the restrictive result: numeric limits use the
minimum, prohibited paths and required capabilities use a de-duplicated union,
cost and latency use the strictest tier, and network/fallback permissions must
be allowed by every source. This means "precedence" never grants an override
that expands authority.

Repository policy is read from the verified base commit, not the mutable
checkout. It must be a non-executable regular Git blob. The `.agent-os` tree is
outside worker read and write authority. Organization policy must be an
absolute-path, owner-owned regular file with one link and no group or other
write permission. Both files are UTF-8 JSON, use an exact schema, and are
limited to 64 KiB.

## Schema

Every field except `schemaVersion` is optional:

```json
{
  "schemaVersion": 1,
  "maxChangedFiles": 30,
  "maxIterations": 20,
  "maxTaskSeconds": 900,
  "allowNetwork": false,
  "prohibitedPaths": ["infra/**", "migrations/**"],
  "routing": {
    "requiredCapabilities": ["private"],
    "maxCostTier": "medium",
    "maxLatencyTier": "standard",
    "allowFallback": false,
    "maxAttempts": 1
  }
}
```

Unknown fields, duplicate capabilities, invalid tiers, and out-of-range values
fail before a worker is selected or contacted. Policy metadata that would
require credential redaction also fails rather than persisting a transformed,
misleading policy digest. Bounds are:

- `maxChangedFiles`: 1–10,000
- `maxIterations`: 1–64
- `maxTaskSeconds`: 30–3,600
- `prohibitedPaths`: at most 100 patterns, 1,024 characters each
- `routing.requiredCapabilities`: at most 16 known capabilities
- `routing.maxAttempts`: 1–8

Glob evaluation uses a bounded state-machine matcher, not dynamically generated
regular expressions. One aggregate work budget covers every allow and deny
pattern in a path check, and changed-file checks observe task cancellation.

## Audit and operation

Each new run report contains the fully resolved policy, its SHA-256 digest, and
the SHA-256 digest of each source document. Event-schema-version-4 task history
binds that policy digest and source count to the task. Removing or changing the
report policy makes the patch fail the application history gate.

Use `get_worker_run` and `get_task_timeline` to inspect the effective policy and
its binding. `route_worker` remains a registry-and-request preview because it
does not accept a repository or base commit; repository policy may further
narrow the route during delegation.

Changing an organization policy affects subsequent delegations only. Changing
a repository policy affects tasks whose resolved base commit includes that
change. Existing reports stay bound to the policy used for their original run.

Human approval rules are intentionally not part of this schema. Durable
workflows can pause at an MCP approval node, but the transport authenticates the
caller and the policy engine does not authenticate a person. Patch application
remains a separate destructive MCP call.
