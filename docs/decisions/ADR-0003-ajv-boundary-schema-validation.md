# ADR-0003: Ajv Boundary Schema Validation

- Status: accepted
- Date: 2026-08-30
- Related findings or requirements: FR-TOOL-001, FR-TOOL-002, IMPLEMENTATION_GUIDE section 7.1, OPERATIONS_TEST_PLAN section 5.1

## Context

Every advertised capability operation has versioned JSON Schemas for its untrusted input and trusted handler output. The capability registry must reject invalid schemas at startup, and the gateway must distinguish structural validation from handwritten semantic normalization without coercing or silently rewriting data. Node's standard library does not implement JSON Schema. A local partial validator would create a second, subtly incompatible schema language at a security boundary and would divert work into a standards implementation unrelated to the project thesis.

The dependency policy explicitly permits Ajv after an exact-version, maintenance, license, transitive-dependency, lifecycle, native-code, security, boundary, and removal review.

## Decision

Use exact-pinned `ajv@8.20.0` only inside `@guard/schema-validation`. Both `@guard/profile-registry` and `@guard/capability-gateway` consume that package's trusted-schema compiler rather than importing Ajv. Compile immutable schemas once when the owning registry starts. Configure strict schema checking, fail-fast validation, and no data mutation: no type coercion, default insertion, property removal, custom formats, remote schema loading, or unreviewed keywords. The capability handwritten normalizer runs only after structural validation succeeds. Handler output is structurally validated before any audit, human, or agent view is released.

Treat schemas as trusted executable configuration rather than user data. A task objective, agent proposal, provider response, repository file, or client request can supply values to validate but cannot supply or modify a schema. Operation schemas use explicit object shapes, reject unknown properties, and pair variable-size strings and arrays with semantic bounds. Ajv error details remain inside `@guard/schema-validation` and are converted into bounded domain errors; consumers receive only safe, keyword-level violations. Validation is not an authorization decision.

Dependency review performed on 2026-08-30:

- Problem solved: standards-based, strict structural validation and startup schema compilation at the capability boundary.
- Owner and maintenance: Ajv is maintained under `ajv-validator/ajv` by Evgeny Poberezkin and contributors. Version `8.20.0` was the current npm release and its GitHub release was signed.
- License: Ajv is MIT. The locked runtime dependency licenses are MIT or BSD-3-Clause and are compatible with this repository's MIT license.
- Runtime dependency closure: four packages are introduced by Ajv: `fast-deep-equal@3.1.3`, `fast-uri@3.1.6`, `json-schema-traverse@1.0.0`, and `require-from-string@2.0.2`.
- Lifecycle and binary review: the published Ajv manifest has development and publishing scripts, including `prepublish`, but no dependency `preinstall`, `install`, or `postinstall` hook is marked in the lockfile. The installed closure contains no native addon and downloads no binary.
- Security history relevant to use: Ajv's official security guidance says schemas must be treated as trusted code and warns about deep or circular schemas, unsafe regular expressions, large `uniqueItems` inputs, and continuing after errors with `allErrors: true`. The selected boundary does not accept remote or run-supplied schemas, does not enable `allErrors`, and applies operation-specific size limits. The project's review found no published Ajv advisory for the selected release; dependency and advisory scans remain release gates rather than a permanent claim of absence.
- Exact boundary: Ajv is imported only by `@guard/schema-validation`. `@guard/profile-registry` and `@guard/capability-gateway` consume its public trusted-schema compiler; the generic runtime reducer, drivers, providers, context sources, capability handlers, policy evaluator, and clients do not import Ajv.
- Removal difficulty: low to moderate. The public contract is versioned JSON Schema plus validated objects, while Ajv construction, compiled validators, and low-level error translation remain private to `@guard/schema-validation`. Replacement would require a schema-conformance corpus but no persisted-domain migration.

Primary review references are the [Ajv security guidance](https://github.com/ajv-validator/ajv/security), [Ajv v8.20.0 release](https://github.com/ajv-validator/ajv/releases/tag/v8.20.0), and the exact `package-lock.json` committed with the shared schema-validation boundary.

## Alternatives Considered

- Implement the used JSON Schema subset locally: rejected because edge cases in object, numeric, Unicode, reference, and composition semantics would create avoidable boundary risk and a proprietary schema dialect.
- Validate only in handwritten normalizers: rejected because structural and semantic validation would become inseparable, unknown fields would be inconsistently handled, and operation advertisement schemas could drift from execution.
- Add a schema-building or object-validation framework: rejected because it would replace the repository's portable JSON Schema contract, add another abstraction and dependency closure, and still require a reviewed structural validator.
- Compile standalone Ajv validators during the build: deferred. It avoids runtime code generation and may help a future browser-hosted client, but the authoritative gateway runs in the local daemon and dynamically composes reviewed installed packs. Revisit if capability installation or deployment constraints change.

## Consequences

Capability packs get one strict, versioned structural boundary, and tests can prove that malformed data never reaches handwritten semantics or handlers. Registry startup can fail before a run when a schema is invalid or collides. Ajv remains an implementation detail and cannot authorize an action.

The registry must continue to reject run-supplied schemas and must not enable mutating options or `allErrors` without a new security review. New formats, custom keywords, remote references, or externally installed pack schemas require an ADR update, explicit size/depth controls, and adversarial performance tests. Every Ajv upgrade requires exact lockfile review, lifecycle and license review, the schema conformance suite, gateway unit tests, and deterministic end-to-end tests.
