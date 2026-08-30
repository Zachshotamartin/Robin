# Security Policy

## Current Status

Guarded Agent is in design and initial implementation. It is not yet a production security boundary and should not be trusted with sensitive repositories or credentials until the relevant controls are implemented and independently reviewed.

## Reporting a Vulnerability

Do not open a public issue containing exploit details, secrets, or private repository content. Contact the repository owner privately through the security-reporting channel configured on the Git hosting service.

Include:

- Affected commit or release
- Threat and impact
- Minimal reproduction using synthetic data
- Expected and observed behavior
- Whether the issue may expose secrets or escape the sandbox

## Security Claims

Every release will document implemented guarantees and residual risks. Container isolation will not be described as a formal proof of containment. Policy and approval user interfaces will not be described as enforcement unless corresponding gateway tests exist.
