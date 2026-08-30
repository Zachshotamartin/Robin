# Contributing

## Before Making a Change

Read the build plan and detailed implementation guide. Identify the trust boundary, domain event, failure behavior, and verification evidence affected by the change.

## Change Requirements

A new tool or consequential operation must define:

1. Versioned input and output schemas
2. Semantic normalization
3. Capability and policy attributes
4. Default policy effect
5. Approval display and binding when required
6. Sandbox profile
7. Idempotency and reconciliation behavior
8. Event and audit representation
9. Cancellation and timeout behavior
10. Unit, integration, and adversarial tests
11. Residual-risk documentation

## Local Checks

```bash
npm test
```

Additional implementation checks will be added to the root `check` script as packages are introduced.

## Commit Style

Use focused commits with imperative subjects. Security fixes should include the smallest reproducible regression fixture that demonstrates the former bypass.

## Pull Requests

Describe the behavior changed, enforcement point, failure semantics, tests, and any new residual risk. Do not include provider credentials or real private-repository artifacts in logs, screenshots, or fixtures.
