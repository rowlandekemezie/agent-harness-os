# Security policy

## Supported versions

The latest released minor version receives security fixes.

## Reporting a vulnerability

Do not open a public issue for a vulnerability that could expose credentials, escape repository boundaries, execute unapproved commands, corrupt patches, or bypass application gates.

Use GitHub's private vulnerability reporting feature for this repository. Include:

- affected version or commit
- operating system and Node.js version
- execution backend
- minimal reproduction
- expected and actual behavior
- impact
- suggested mitigation, when available

Avoid including real credentials or proprietary source code. Acknowledgement and remediation timing will depend on severity and reproducibility.

## Security guarantees

Security guarantees are limited to the boundaries documented in `docs/threat-model.md`. Enabling unsandboxed local execution is an explicit trust decision.
