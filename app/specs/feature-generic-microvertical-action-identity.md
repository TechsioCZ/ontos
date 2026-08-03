---
type: feature
status: done
created: 2026-08-03
---

# Feature: Generic MicroVertical Action Identity Propagation

## Feature Description

Add one reusable, Shell-owned mechanism for propagating the authenticated OntOS principal from
`shell-super-app` to an independently deployed MicroVertical BFF, plus one repository-owned
Codesmith generator that prepares an existing MicroVertical to consume that identity for Action
endpoints. The mechanism must remove per-Action Shell endpoints and loader-held tokens, preserve the
strict MicroVertical deployment seam, and deliver a verified `TrustedPrincipalContext` to the
existing Core Action runtime without moving credentials, sessions, or authorization into the
MicroVertical.

The Shell will validate the Better Auth session and issue a short-lived, audience-scoped,
asymmetrically signed assertion. The private signing key remains Shell-only. A generated
MicroVertical BFF adapter will verify the assertion with public key material, validate all claims,
and expose the trusted principal through an Effect interface. The token proves authentication and
context only: it must contain no Action permission grant, and Core must continue to enforce
SpiceDB permissions and executable Policies for each Action.

## User Story

As an OntOS developer
I want an existing MicroVertical to gain the standard Shell-user Action identity boundary through one generator command
So that I can expose Action BFF operations without copying authentication, token, configuration, and client-refresh code or modifying Shell for every Action

## Problem Statement

The Core Action runtime already requires a trusted principal separately from the business payload,
but OntOS has no reusable production seam that supplies that context to an independently deployed
MicroVertical BFF. The disposable Testing spike proved the runtime path with a five-minute HMAC
token, but hardcoded `testing.testing` into the Shell endpoint, Shell contract, Shell client, home
loader, Testing BFF, and Testing client. Repeating that shape would cause every new Action or
MicroVertical to require coordinated Shell edits.

The prototype also places a shared signing secret and issuer/verifier implementation in Core,
contrary to the rule that Core owns only non-secret principal bindings and context while Shell owns
credentials and authentication mechanics. Its globally constructed `Layer.orDie` makes unrelated
login/session operations depend on gateway configuration, and the page loader obtains a token only
once, so a retry cannot combine a refreshed token with the original idempotency key. The HMAC design
also gives every verifier the ability to mint assertions.

Without a generic identity module and a generator, developers must reproduce security-sensitive
claims, Bearer parsing, signature checks, audience validation, error mapping, configuration, and
client token acquisition. That is repetitive, easy to get wrong, and incompatible with independently
deployable MicroVerticals authenticating each request themselves.

## Solution Statement

Keep the existing `shell-super-app` as the only deployed authentication authority. Add one generic
strict Effect BFF operation, `issueGatewayContext`, which accepts a MicroVertical audience, validates
the current Better Auth session, verifies that the audience is an existing vertical ID in the
authoritative topology, and returns a five-minute EdDSA JWT plus its expiry. Do not add an Auth
MicroVertical, another app, a package, a delivery unit, or a Module Federation remote.

Publish the non-secret assertion schemas and the contract-derived Effect client through the existing
`@app/shared-contracts` package. The protected header will contain algorithm, type, and key ID; the
signed claims will contain issuer, audience, subject, issued-at, expiry, unique token ID, assertion
version, and the safe `TrustedPrincipalContext` fields. They will
contain no email, display name, credential, cookie, session token, Action key, permission, Policy
decision, or business payload. Require the standard subject claim to equal the nested principal ID.

Use a Shell-private Ed25519 JWK with a required `kid` to sign. Give MicroVerticals only a JWKS of
public verification keys. Permit current and retiring public keys so rotation can overlap for at
least token TTL plus clock skew; reject unknown keys, algorithms other than EdDSA, invalid issuer or
audience, malformed claims, future issue times outside the allowed skew, and expired assertions.

Add `mise exec -- pnpm scaffold:microvertical-action-boundary -- --vertical <vertical>`. Run it once
after the UltraModern CLI creates a vertical and before that vertical exposes Shell-user Action BFF
operations. The generator will discover the vertical from package metadata and topology, add only
the required direct dependencies, and emit a server-side Effect verifier adapter plus a client-side
Effect token-acquisition adapter with the vertical app ID embedded as its audience. Endpoint authors
will call the generated server adapter and exhaustively map its typed authentication/unavailability
errors in the endpoint-specific Problem Details contract. Client Action methods will compose through
the generated client adapter so every new attempt obtains a fresh assertion while the feature keeps
its existing idempotency key.

The generator must not create an Action, generic Action endpoint, permission, Policy, Outbox Message,
UI, or business vertical; those remain owned by their existing generators and feature code. The Core
Action runtime, permission service, Policy evaluator, transaction, Domain Event, and Outbox logic
remain unchanged.

## Relevant Files

Use these files to implement the feature:

- `../AGENTS.md` — limits work to `app/` and defines the existing mandatory Codesmith commands.
- `AGENTS.md` — authoritative application ownership, Effect, MicroVertical, Action, and toolchain rules.
- `README.md` — documents the generated UltraModern workspace, strict Effect BFF topology, and Shell-owned authentication surface.
- `docs/architecture/MICROVERTICALS.md` — requires independent request authentication and assigns credentials/sessions to Shell rather than a MicroVertical.
- `docs/architecture/ACTIONS.md` — requires trusted identity outside the payload and preserves per-Action permission and Policy enforcement.
- `docs/architecture/ERRORS.md` — governs typed authentication/unavailability errors, `WWW-Authenticate`, and endpoint-specific Problem Details mapping.
- `docs/architecture/ULTRAMODERN.md` — permits direct infrastructure work while requiring generated business artifacts and strict vertical seams.
- `../docs/09_AUTHN_AUTHZ_MODEL.md` — distinguishes authentication, Core principal resolution, SpiceDB authorization, and business Policy.
- `.env.example` — document Shell-private signing JWK, public verification JWKS, and issuer configuration without a usable key.
- `package.json` — register the new Codesmith command and focused validation entrypoints.
- `pnpm-lock.yaml` — record exact direct JOSE dependencies without unrelated upgrades.
- `apps/shell-super-app/package.json` — own the direct signing dependency and preserve the existing Shell runtime cohort.
- `apps/shell-super-app/shared/api.ts` — replace any Testing-specific gateway operation with the one generic strict Effect operation.
- `apps/shell-super-app/api/index.ts` — compose generic issuance with the existing Better Auth session service without coupling other authentication operations to signing configuration.
- `apps/shell-super-app/api/auth/config.ts` — continue to own Better Auth configuration; gateway signing configuration must remain separate and lazily used.
- `apps/shell-super-app/api/auth/service.ts` — authoritative current-session resolution used before assertion issuance.
- `apps/shell-super-app/src/api/auth-client.ts` — keep sign-in/session/sign-out behavior unchanged while consuming the published generic gateway contract.
- `apps/shell-super-app/tests/unit/auth-contract.test.ts` — prove the exact generic operation and absence of Testing/Action-specific endpoints.
- `apps/shell-super-app/tests/unit/auth-config.test.ts` — prove gateway configuration cannot break ordinary Better Auth configuration.
- `apps/shell-super-app/tests/integration/auth-runtime.test.ts` — prove authenticated issuance and login/session availability when gateway signing is unavailable.
- `packages/shared-contracts/package.json` — add only dependencies required for the non-secret Effect schema and contract-derived client.
- `packages/shared-contracts/src/index.ts` — export the stable assertion contract and client surface.
- `packages/core-runtime/src/actions/context.ts` — authoritative `TrustedPrincipalContext` fields that the assertion must faithfully carry and the verifier must decode.
- `packages/core-runtime/src/index.ts` — remove any prototype secret-bearing gateway exports and retain only the existing trusted-context and Action surfaces.
- `scripts/scaffolding/cli.mts` — register the new command, flags, help text, and typed result.
- `scripts/scaffolding/shared.mts` — reuse authoritative vertical discovery, path containment, dependency patching, formatting, and preflight primitives.
- `scripts/scaffolding/tests/scaffold-generators.test.mts` — add disposable-fixture coverage for generated server/client adapters and mutation boundaries.
- `scripts/scaffolding/tsconfig.json` — strictly typecheck the new generator and generated-output fixtures.
- `scripts/validate-ultramodern-workspace.mts` — validate the new command contract and action-boundary metadata without weakening existing workspace checks.
- `topology/reference-topology.json` — authoritative set of allowed MicroVertical audience IDs; do not maintain a second hand-written Shell registry.
- `verticals/testing/**` — disposable spike evidence only when still present; production implementation must not retain Testing-specific gateway wiring or depend on this vertical.

### New Files

- `packages/shared-contracts/src/gateway-context.ts` — non-secret Effect schemas, generic Shell gateway HttpApi contract, typed client, assertion version, protected-header contract, and public claim types.
- `apps/shell-super-app/api/auth/gateway-issuer-config.ts` — lazy, typed validation of the Shell-private Ed25519 signing JWK and issuer.
- `apps/shell-super-app/api/auth/gateway-issuer.ts` — Shell-private Effect issuer that signs audience-scoped assertions only after session resolution.
- `apps/shell-super-app/api/auth/gateway-audiences.ts` — build-safe adapter over authoritative topology vertical IDs with no per-vertical hand-maintained entries.
- `apps/shell-super-app/tests/unit/gateway-issuer.test.ts` — deterministic claims, signing, expiry, audience, key, and configuration tests.
- `scripts/scaffolding/microvertical-action-boundary/scaffold.mts` — Codesmith planner/renderer for one existing MicroVertical Action identity boundary.
- `verticals/<vertical>/api/auth/action-principal.ts` — generated server output that verifies Bearer assertions with public JWKS and returns `TrustedPrincipalContext` through typed Effect errors.
- `verticals/<vertical>/src/api/action-gateway.ts` — generated client output that obtains a fresh audience-scoped assertion through the published Effect client before invoking an Action request.

## Implementation Plan

### Phase 1: Foundation

Document the exact authentication seam and assertion security contract before changing runtime code.
Move the non-secret gateway wire contract into the existing shared-contract package, select EdDSA
with explicit key IDs and rotation overlap, and keep Core's trusted principal type as the canonical
decoded context. Remove the disposable HMAC prototype from Core if it is still present. Add focused
schema tests for required claims, safe fields, subject/principal equality, and rejection of identity
or authorization data outside the approved contract.

### Phase 2: Core Implementation

Implement one Shell-private lazy issuer and one generic strict Effect BFF operation. Resolve the
current Better Auth session for every issuance, derive the audience allowlist from authoritative
topology, sign only safe claims, and map missing sessions, unknown audiences, invalid configuration,
and signing failures to declared typed Problems. Keep ordinary sign-in/session/sign-out layers
independent so missing gateway keys affect only the gateway operation.

Extend Codesmith with the MicroVertical Action-boundary command. Generate one edge-safe public-key
verifier adapter and one Effect client acquisition adapter for the target app ID. Preflight every
mutation, preserve package formatting and developer code, reject incompatible dependencies or
existing outputs, and prove exact generated output in disposable fixtures. The verifier must return
typed missing/invalid/expired/scope/configuration errors and never construct a principal from unsigned
payload or headers.

### Phase 3: Integration

Prove the complete seam with an ephemeral generated vertical fixture: an authenticated Shell session
issues an assertion, the generated adapter verifies it for the matching audience, and the resulting
context is accepted by the existing Action trusted-context schema. Prove another audience, expired or
tampered assertions, unknown `kid`, missing configuration, and anonymous sessions fail closed.

Demonstrate the generated client adapter acquiring a new assertion for each attempt while a caller
retains one idempotency key across retry. Ensure an Action BFF endpoint can map authentication failure
to `401` with a Bearer challenge and verification/configuration unavailability to `503`, without
changing the Action runtime or inventing a universal Action HTTP error contract. Remove all
Testing-specific Shell identity fields if the disposable spike has not already been reverted.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Codify the generic assertion interface and ownership

- [x] Update `docs/architecture/MICROVERTICALS.md`, `docs/architecture/ACTIONS.md`, and `docs/architecture/ERRORS.md` to define Shell-owned issuance, public-key verification at the receiving BFF, authentication-versus-authorization separation, typed failure semantics, and the prohibition on an Auth app/MicroVertical/package.
- [x] Add `packages/shared-contracts/src/gateway-context.ts` and its export with Effect schemas for request `{ audience }`, response `{ token, expiresAt }` where expiry is epoch seconds, public Problems, protected header `{ alg: 'EdDSA', typ: 'JWT', kid }`, and versioned JWT claims. Require `iss`, `aud`, `sub`, `iat`, `exp`, `jti`, version `1`, and safe `TrustedPrincipalContext` fields; reject email, display name, credentials, cookies, session tokens, Action keys, permissions, Policies, and business payloads.
- [x] Add focused shared-contract tests proving structural decoding, exact public fields, non-empty topology-compatible audience, expiry ordering, and subject/principal equality validation.
- [x] If the disposable HMAC prototype remains, remove `packages/core-runtime/src/auth/gateway-context*.ts`, its public exports, tests, and `ONTOS_GATEWAY_CONTEXT_SECRET`; Core must retain no private/shared signing secret or token issuer.

### 2. Implement the Shell-owned generic issuer without login coupling

- [x] Add an exact direct `jose` dependency at the existing resolved compatible version to `apps/shell-super-app/package.json` and refresh `pnpm-lock.yaml` without unrelated resolution churn.
- [x] Add `gateway-issuer-config.ts` to validate an Ed25519 private JWK with required `kid`, `alg = EdDSA`, and `use = sig`, plus the expected issuer. Keep TTL fixed at 300 seconds and accepted clock skew fixed and bounded at 30 seconds in the versioned protocol; load configuration inside the issuance Effect rather than constructing a globally fatal layer.
- [x] Add `gateway-audiences.ts` to derive one immutable audience set from `topology/reference-topology.json` entries with `kind = vertical`; reject Shell, package, unknown, malformed, or duplicate IDs without adding a second registry.
- [x] Add `gateway-issuer.ts` as a Shell-private Effect module that signs versioned claims from an already resolved `SafeAuthenticatedIdentity`, sets `sub` to `principalId`, includes only `TrustedPrincipalContext` fields, uses Effect-managed clock/crypto where supported, and never logs assertion or key material.
- [x] Add deterministic unit tests for exact claims, TTL, issuer/audience, key ID and algorithm, optional trusted-context fields, unsupported key types, invalid time configuration, unknown audiences, and absence of credential/authorization/business fields.
- [x] Replace the Testing-specific operation in `apps/shell-super-app/shared/api.ts` and `api/index.ts` with `issueGatewayContext`. Resolve the Better Auth session first, issue only for an authenticated active OntOS identity and known audience, and declare/map anonymous `401`, invalid audience `400`, gateway unavailable `503`, and sanitized unexpected `500` Problems.
- [x] Prove with Shell unit/integration tests that sign-in, current-session, and sign-out remain operational when gateway signing configuration is absent or malformed, while only `issueGatewayContext` fails with its declared `503`.

### 3. Add the Codesmith MicroVertical Action-boundary generator

- [x] Add `scripts/scaffolding/microvertical-action-boundary/scaffold.mts`, register `microvertical-action-boundary` in `scripts/scaffolding/cli.mts`, expose `scaffold:microvertical-action-boundary` in root `package.json`, and document exact write-free `--help` for `--vertical <vertical>`.
- [x] Reuse `discoverVertical`, path containment, mutation preflight, formatting, and package patch helpers. Require exactly one topology-backed existing UltraModern MicroVertical and reject traversal, duplicate app IDs, existing outputs, incompatible dependencies, unknown flags, and partial writes.
- [x] Generate `api/auth/action-principal.ts` with the target `appId` as its immutable audience, an edge-safe Effect interface, strict Bearer parsing, direct `jose` public-JWKS verification, explicit `EdDSA`/`kid` allowlisting, issuer/audience/time/version/subject checks, `TrustedPrincipalContext` decoding, and typed missing/invalid/expired/scope/configuration failures.
- [x] Generate `src/api/action-gateway.ts` with the same immutable audience and a small Effect interface that obtains a fresh assertion from the shared contract-derived Shell client immediately before an Action call. Accept SSR base URL/cookie options, preserve typed Shell transport/schema/Problem failures, and leave idempotency-key ownership with the Action feature.
- [x] Add only exact compatible direct dependencies required by generated code to the target vertical, preserving unrelated scripts, metadata, dependency ordering, topology, Shell source, Core source, and other verticals.
- [x] Extend disposable-fixture tests for exact paths/content, audience derivation, dependency insertion, formatter stability, TypeScript compilation, rerun/overwrite refusal, no-write failures, no Shell/Core mutations, and deterministic composition with the existing Action/Policy/Outbox generators.

### 4. Prove the generated authentication seam end to end

- [x] Extend generator integration fixtures to execute the generated server verifier against assertions created by the real Shell issuer with an ephemeral Ed25519 keypair and Effect-controlled clock.
- [x] Prove matching issuer/audience/current key succeeds and returns exactly the original trusted context; anonymous, missing Bearer, malformed, tampered, expired, future-issued, wrong issuer, wrong audience, unknown `kid`, wrong algorithm, subject mismatch, and invalid context assertions fail closed without reaching an Action handler.
- [x] Prove public JWKS can contain current and retiring keys, the selected `kid` is enforced, rotation overlap accepts an unexpired assertion from the retiring key, and removal rejects it after the documented TTL-plus-skew window.
- [x] Add one strict Effect BFF fixture operation that maps verifier authentication failures to declared RFC 9457 `401` with `WWW-Authenticate: Bearer`, maps verification configuration/unavailability to declared retryable `503`, and passes the successful context to the existing Action trusted-context schema without importing another MicroVertical implementation.
- [x] Prove the generated client adapter acquires a new assertion for a later retry while the caller reuses the same idempotency key, and never stores the assertion in a route loader, reusable presentation prop, persistence, log, URL, or Action payload.

### 5. Remove prototype coupling and validate workspace integration

- [x] Remove any remaining `testingGatewayContext`, `testingGatewayToken`, `GatewayContextLive`, HMAC secret, action-scoped token claim, and Testing-specific Shell contract/client/loader code. If the disposable Testing vertical has already been reverted, verify no equivalent hardcoded vertical/action identity remains.
- [x] Update `.env.example` with non-working placeholders and ownership comments for Shell-private signing JWK, public verification JWKS, and issuer. Never commit real private or local generated keys; TTL and clock skew are versioned code constants rather than deployment overrides.
- [x] Extend `scripts/validate-ultramodern-workspace.mts` to verify the new command, shared contract, audience-from-topology invariant, and generated boundary metadata while preserving every existing release-cohort, topology, deployment, and validation check.
- [x] Update relevant architecture/README generator guidance so developers run the new command once only for a MicroVertical BFF that accepts Shell-user Action calls; state explicitly that the Action generator remains independent and no per-Action Shell edit is permitted.
- [x] Inspect the final diff for generated Module Federation declarations, keys, tokens, caches, disposable vertical code, or unrelated UltraModern rewrites and remove all such artifacts.

### 6. Run all validation commands

- [x] Execute every command in `Validation Commands` in order, resolve all failures, and confirm the generator and runtime changes are the only implementation diff.

## Testing Strategy

### Unit Tests

Use Effect-controlled clocks and ephemeral Ed25519 keypairs to test claim construction, safe-field
selection, topology audience validation, configuration isolation, signature verification, token
times, subject consistency, key IDs, algorithm allowlisting, and typed errors. Use Node disposable
fixtures for generator arguments, path containment, dependency patches, exact templates, formatting,
typechecking, and no-partial-write behavior. Keep private keys and complete assertions out of test
failure output.

### Integration Tests

Use the real Shell authentication service with isolated Better Auth/Core identity fixtures to prove
only authenticated active identities can obtain an assertion. Render a disposable generated
MicroVertical adapter, verify a real Shell-issued assertion through it, and pass the result through
the existing Action trusted-context schema. Add a strict Effect BFF fixture to prove declared `401`
and `503` transport behavior and a client retry test that refreshes authentication independently of
the Action idempotency key.

Do not add or retain a demonstration business MicroVertical. The generator/runtime seam can be
proved in OS-temporary fixtures, and the existing Core tests remain authoritative for permission,
Policy, transaction, Domain Event, and Outbox behavior after trusted context is supplied.

### Edge Cases

- Shell has a valid Better Auth configuration but missing or malformed gateway signing configuration.
- The caller is anonymous, the Better Auth session is expired/revoked, or Core principal resolution is no longer active.
- The requested audience is malformed, unknown, duplicated in topology, the Shell ID, or a non-vertical topology entry.
- The assertion is missing, malformed, tampered, expired, issued too far in the future, signed with the wrong algorithm, references an unknown `kid`, or has a wrong issuer/audience/version.
- JWT `sub` differs from the nested trusted principal ID, or any trusted-context UUID/method is invalid.
- Current and retiring keys overlap during rotation; an old assertion is rejected after TTL plus skew.
- A MicroVertical is independently deployed on Node or Cloudflare and receives only public verification material.
- SSR token acquisition needs explicit base URL and cookie forwarding; browser acquisition uses the Shell cookie without exposing it to JavaScript.
- A retry occurs after the prior assertion expires but must reuse the original Action idempotency key.
- Gateway authentication is unavailable while unrelated Shell login/session/logout and unrelated MicroVertical readiness/read endpoints remain available.
- The generator targets a missing/non-vertical package, encounters existing output, incompatible dependencies, invalid metadata, or a failed preflight after other mutations were planned.

## Acceptance Criteria

- [x] `shell-super-app` exposes one generic `issueGatewayContext` strict Effect operation and no Action- or MicroVertical-specific identity endpoint.
- [x] No Auth MicroVertical, app, package, delivery unit, Module Federation remote, or generic Action HTTP endpoint is introduced.
- [x] Shell alone holds the private signing JWK; Core and MicroVerticals contain no private/shared signing secret and receive only public JWKS material.
- [x] Assertions use EdDSA, required protected-header `kid`, issuer, exact topology-backed audience, subject, issued-at, expiry, token ID, and version; token TTL is five minutes with 30-second documented skew.
- [x] Assertions carry only safe `TrustedPrincipalContext` fields and no credentials, cookies, session tokens, display data, Action keys, permissions, Policy results, or business payload.
- [x] The receiving MicroVertical independently verifies signature, algorithm, key, issuer, audience, times, version, subject consistency, and trusted-context schema before calling an Action.
- [x] Missing/invalid authentication is a declared `401` with a Bearer challenge; gateway configuration or verification unavailability is a declared retryable `503`; no expected failure escapes as an exception or ad hoc response.
- [x] Missing gateway configuration cannot break Shell sign-in, current-session, or sign-out and cannot break unrelated MicroVertical operations.
- [x] `mise exec -- pnpm scaffold:microvertical-action-boundary -- --vertical <vertical>` prepares one existing topology-backed MicroVertical exactly once with generated server and client Effect adapters and required dependencies.
- [x] The generator performs complete preflight, refuses overwrite/traversal/incompatible metadata, makes no partial writes, and never edits another vertical or Action/Policy/permission/Outbox business behavior.
- [x] Generated client integration obtains a fresh assertion for each invocation attempt, supports SSR cookie forwarding, and allows retries to preserve the caller-owned idempotency key after token expiry.
- [x] The Core Action runtime, SpiceDB permission enforcement, executable Policy evaluation, transaction handling, Domain Events, and Outbox persistence are unchanged and remain authoritative.
- [x] Disposable fixture tests prove real Shell issuance, generated MicroVertical verification, key rotation, typed BFF failures, exact context propagation, and generator composition without committing a demonstration vertical.
- [x] All Testing-spike hardcoding, HMAC gateway infrastructure, generated build artifacts, and unrelated UltraModern mutations are absent from the final implementation diff.

## Validation Commands

Execute every command to validate the feature with zero regressions.

- `mise exec -- pnpm install --frozen-lockfile` — prove exact direct dependencies and lockfile integrity.
- `mise exec -- pnpm exec tsc -p scripts/scaffolding/tsconfig.json` — strictly typecheck the new generator, templates, and fixture tests.
- `mise exec -- pnpm exec oxlint scripts/scaffolding` — lint generator infrastructure outside the normal application-only lint roots.
- `mise exec -- node --test scripts/scaffolding/tests/*.test.mts` — run generator and disposable generated-boundary tests.
- `mise exec -- pnpm scaffold:microvertical-action-boundary -- --help` — verify command discovery and write-free documented flags.
- `mise exec -- pnpm --filter @app/shell-super-app test:unit` — validate generic contract, issuer, configuration isolation, and existing Shell UI/auth behavior.
- `mise exec -- pnpm --filter @app/shell-super-app test:integration` — validate Better Auth session-to-assertion issuance and login independence.
- `mise exec -- pnpm action:test:unit` — prove the existing Core Action trusted-context, permission, and Policy behavior remains unchanged.
- `mise exec -- pnpm api:check` — validate strict Effect BFF topology and server/browser import boundaries.
- `mise exec -- pnpm contract:check` — validate topology-derived audiences, generated metadata, ownership, and workspace contracts.
- `mise exec -- pnpm build` — prove the Shell and all real MicroVerticals build with the generic contract and no private key in browser output.
- `git diff --check` — detect whitespace errors and conflict markers.
- `mise exec -- pnpm check` — Run the final repository quality gate.

## Implementation Evidence

- `mise exec -- pnpm install --frozen-lockfile` — passed; lockfile was already current.
- `mise exec -- pnpm exec tsc -p scripts/scaffolding/tsconfig.json` — passed.
- `mise exec -- pnpm exec oxlint scripts/scaffolding` — passed.
- `mise exec -- node --test scripts/scaffolding/tests/*.test.mts` — passed, 19/19 tests.
- `mise exec -- pnpm scaffold:microvertical-action-boundary -- --help` — passed and performed no writes.
- `mise exec -- pnpm --filter @app/shell-super-app test:unit` — passed, 30/30 tests.
- `mise exec -- pnpm --filter @app/shell-super-app test:integration` — passed, 1/1 test, with the repository-documented local Postgres/Auth environment after applying existing Core/Auth migrations.
- `mise exec -- pnpm action:test:unit` — passed, 48/48 tests.
- `mise exec -- pnpm api:check` — passed.
- `mise exec -- pnpm contract:check` — passed.
- `mise exec -- pnpm build` — passed, including TS-Go BFF compilation, Module Federation type validation, and performance readiness.
- `git diff --check` — passed.
- `mise exec -- pnpm check` — passed, including format, lint, Action tests, typecheck, skills, i18n, API, contract, and performance gates.
- Additional focused evidence: shared assertion contracts passed 4/4 tests; the disposable generated-boundary fixture executed real Shell-issued Ed25519 assertions, rotation overlap and TTL-plus-skew removal, all specified fail-closed categories, a real Effect `HttpApi` endpoint with `401`/Bearer and retryable `503` mapping, exact canonical trusted-context propagation, and fresh-token retry with a caller-owned stable idempotency key.
- Review-remediation evidence: the production BFF build embeds the authoritative tracked topology without a second registry or unresolved JSON import; the generated verifier browser bundle excludes Core database/Node-only modules; the real Better Auth session-to-Shell-BFF-to-generated-adapter flow passes; and an injected Shell issuer defect logs its correlation context while returning a sanitized declared `application/problem+json` `500`.
- Final review found no committed private key, assertion, HMAC gateway secret, Testing-specific identity endpoint, demonstration vertical, build output, or Core Action-runtime change.

## Review Checklist

- [x] Every acceptance criterion is satisfied.
- [x] The diff complies with `../AGENTS.md`, `AGENTS.md`, and all relevant referenced guidance.
- [x] MicroVertical, Action, generated BFF client, and typed Effect error boundaries are preserved.
- [x] Tests cover every changed behavior and important failure path.
- [x] No unrelated changes, dead code, or accidental API expansion remain.

## Notes

- The current Testing implementation is a disposable spike and may be reverted before this plan is implemented. Preserve this specification when reverting it; implementation must not depend on `verticals/testing` existing.
- This is infrastructure/tooling work, and no existing Codesmith generator applies to creating the new generator or Shell issuer modules. It does not require a blocking business-file decision under `docs/architecture/ULTRAMODERN.md`.
- The new command is intentionally separate from `scaffold:action`: Actions can be invoked by trusted system/service adapters without a Shell-user BFF, while the identity boundary is needed once per independently deployed BFF that accepts Shell-user Action calls.
- The authoritative audience is the generated MicroVertical `appId`, not a route name, package name supplied by the browser, Action key, or free-form tenant value.
- Five minutes matches the disposable spike and limits replay exposure; 30 seconds is the fixed clock-skew allowance. Changing either value requires a protocol/version review, key-rotation overlap updates, and tests rather than an unchecked environment override.
- Static deployment JWKS avoids making every Action call synchronously dependent on a Shell JWKS endpoint. Key rollout must deploy the new public JWKS before switching the Shell private key, retain the old public key for at least TTL plus skew, and then remove it.
- Assertions are bearer credentials even though their claims are safe. Never persist or log them, place them in URLs, expose them in Problem Details, or include them in Action request hashes/audit metadata.
- Service accounts, API keys, system jobs, and support impersonation remain represented by `TrustedPrincipalContext`; this first client acquisition flow covers Better Auth browser sessions. Additional issuer flows require separate explicit authentication lifecycle work, not changes to the Action runtime.
