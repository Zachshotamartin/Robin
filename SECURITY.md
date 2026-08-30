# Security Policy

## Current Status

Robin is in a product pivot and initial coding-agent implementation. Its
Milestones A and B policy/context substrate has deterministic evidence, but the
interactive workspace, process, credential, live-provider, session, and
extension boundaries are not yet implemented release guarantees. Do not trust
the current development build with sensitive repositories or real credentials
until the relevant Robin release gate passes and the claim is documented.

## Reporting a Vulnerability

Do not open a public issue containing exploit details, secrets, or private repository content. Contact the repository owner privately through the security-reporting channel configured on the Git hosting service.

Include:

- Affected commit or release
- Threat and impact
- Minimal reproduction using synthetic data
- Expected and observed behavior
- Whether the issue may expose secrets or escape the sandbox

## Security Claims

Every release will document implemented guarantees and residual risks. A
client-side permission is not a command sandbox, a command sandbox is not
whole-process isolation, and a container is not a formal proof of containment.
Permission and approval UI is not described as enforcement unless the exact
normalized action executed by the tool is covered by boundary tests.
