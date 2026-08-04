# Contributing

## Development environment

Use Node.js 22 or newer and a current Git release.

```bash
npm install
npm run check
```

## Pull requests

- Keep one security or behavior change per pull request when practical.
- Add regression tests for every bug.
- Update documentation when changing tools, environment variables, provider behavior, artifact format, or trust boundaries.
- Preserve the two-step delegate/apply workflow.
- Explain threat-model consequences in the pull-request description.

## Style

- TypeScript
- Tabs
- No semicolons
- Single quotes
- Function declarations for standalone functions
- `Array<Type>` syntax
- Descriptive names
- Strict type checking

## Security-sensitive changes

Changes to path handling, command execution, environment forwarding, provider errors, artifact storage, worktree behavior, patch application, or MCP approval metadata require explicit adversarial tests.
