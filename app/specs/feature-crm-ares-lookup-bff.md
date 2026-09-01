---
type: feature
status: done
created: 2026-08-17
---

# Feature: CRM governed ARES lookup BFF

## Feature Description

Expose one CRM-owned, generated Effect module API read that accepts an eight-digit IČO and returns
flat Customer-compatible values from the private ARES adapter. The operation is a governed read,
not an Action, because it does not mutate OntOS state.

## User Story

As the Customer create feature
I want to look up a Czech business through the generated CRM BFF client
So that the browser never calls ARES or a private backend implementation directly

## Problem Statement

The private adapter alone is not a legal frontend boundary. OntOS requires every module API to use
the generated descriptor, Read runtime, registered server, shared HttpApi contract, and generated
Effect client with typed errors.

## Solution Statement

Generate `customer-ares-lookup` with Codesmith before editing any API files. Adapt its request,
response, read handler, server mapping, registration, and client to use the private adapter. Publish
only invalid/authentication/forbidden/not-found/unavailable/internal Problem Details supported by
the current governed Read runtime; retain upstream timeout/throttling distinctions in internal
diagnostics while exposing them safely as retryable unavailability.

## Relevant Files

Use these files to implement the feature:

- `AGENTS.md` — generated module API and governed entrypoint requirements.
- `docs/architecture/MODULE_ENTRYPOINTS.md` — API entrypoint gating and registration.
- `docs/architecture/MICROVERTICALS.md` — generated Effect client seam.
- `docs/architecture/ERRORS.md` — public Problem Details and typed client errors.
- `scripts/scaffolding/cli.mts` — authoritative `scaffold:module-api --name` interface.
- `verticals/crm/shared/apis/customer-detail.ts` — canonical Customer-compatible field schemas.
- `verticals/crm/api/read-server-support.ts` — shared CRM Read runtime mappings.
- `verticals/crm/shared/api.ts` — composed CRM HttpApi.
- `verticals/crm/api/index.ts` — CRM BFF runtime layers.
- `verticals/crm/vertical.manifest.ts` — generated API contribution.
- `verticals/crm/vertical.registration.ts` — owner-private read registration.

### New Files

- `verticals/crm/shared/apis/customer-ares-lookup.ts` — generated lookup HttpApi contract.
- `verticals/crm/src/api/customer-ares-lookup.read.ts` — generated governed Read descriptor.
- `verticals/crm/src/api/customer-ares-lookup-client.ts` — generated Effect client adapter.
- `verticals/crm/api/customer-ares-lookup-read-server.ts` — generated server handler and Problem Details mapping.

## Implementation Plan

### Phase 1: Foundation

Run the mandatory module API generator and retain all generated identities and wiring before adapting
the skeleton contract.

### Phase 2: Core Implementation

Connect the governed read to the private adapter, normalize the response to flat Customer fields,
and exhaustively map all Read/runtime/integration failures.

### Phase 3: Integration

Prove the generated client reaches the registered read through the real BFF and never exposes raw
ARES JSON, address, or private implementation types.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Generate the governed module API

- [x] From `app/`, make the first implementation change by running `mise exec -- pnpm scaffold:module-api -- --vertical crm --name customer-ares-lookup`; do not hand-create its contract, descriptor, client, server, manifest, registration, or API-composition wiring.
- [x] Inspect the generated output and retain stable API/read identity `crm.core.api.customer-ares-lookup`, tenant read access, owner-private registration, evidence policy, and generated headers.

### 2. Define the public lookup contract

- [x] Adapt the generated request to `{ ico }` with exact eight-digit validation and the success to flat `{ name, ico, dic, legalFormCode, establishedOn, dissolvedOn }` values using canonical Customer field schemas.
- [x] Declare typed `400`, `401`, `403`, `404`, retryable `503`, and sanitized `500` RFC Problem Details; do not return upstream error bodies, address, ARES metadata, CZ-NACE, or activities.

### 3. Implement the governed Read handler

- [x] Inject the private ARES service into the generated `defineRead` service factory without exposing an HTTP client or database executor to frontend code.
- [x] Map adapter not-found to `ReadHandlerNotFound`; map denied, throttled, timeout, transport, and upstream unavailability to `ReadHandlerUnavailable`; treat decode defects as a safely logged internal failure according to the repository Read/error rules.

### 4. Complete server and client wiring

- [x] Adapt the generated server handler to verify correlation/principal/module access, invoke `ReadRuntime`, exhaustively map its closed error union, and add the group layer to the CRM BFF.
- [x] Export the generated Effect client through the approved CRM client seam and retain typed declared, transport, and response-decoding errors.

### 5. Add unit and integration tests

- [x] Extend module/API contract tests for exact descriptor, request/result codecs, Problem Details statuses, manifest/registration, and absence of a lookup Action.
- [x] Add real BFF tests for success, invalid IČO, authentication, forbidden module access, not found, unavailable, internal/decode behavior, correlation propagation, and complete generated-client decoding with a substituted ARES service.

### 6. Run all validation commands

- [x] Execute every command in `Validation Commands` and resolve failures without bypassing the generated seam.

## Testing Strategy

### Unit Tests

Verify exact generated identities, schema decoding, public errors, adapter-error mapping, and complete
registration/API composition.

### Integration Tests

Run the generated client against the CRM Effect BFF and governed Read runtime with a deterministic
ARES layer, proving authentication, module access, evidence, typed errors, and response decoding.

### Edge Cases

- Structurally invalid IČO is rejected before an upstream call.
- Valid but unknown IČO returns `404`.
- Upstream timeout or throttling returns retryable `503` without leaking provider details.
- A response contains unexpected address/activity fields.

## Acceptance Criteria

- [x] Lookup is reachable only through the generated governed CRM read client.
- [x] The response is flat and Customer-compatible.
- [x] Every expected public failure is declared and typed end to end.
- [x] There is no ARES mutation Action or browser-to-ARES request.

## Validation Commands

Execute every command to validate the feature with zero regressions.

- `mise exec -- pnpm --filter @app/crm test:unit` — validate lookup schemas, descriptor, and server mappings.
- `mise exec -- pnpm --filter @app/crm test:integration` — validate the generated client/BFF/Read runtime path.
- `mise exec -- pnpm --filter @app/crm typecheck` — validate generated and adapted Effect types.
- `mise exec -- pnpm api:check` — enforce the strict generated API seam.
- `mise exec -- pnpm module-entrypoints:check` — validate governed API descriptor/registration.
- `mise exec -- pnpm check:module-contracts` — validate serialized CRM API contribution.
- `mise exec -- pnpm --filter @app/crm build` — build the independently deployable CRM API/client.
- `mise exec -- pnpm check` — Run the final repository quality gate.

## Review Checklist

- [x] Every acceptance criterion is satisfied.
- [x] The diff complies with `../AGENTS.md`, `AGENTS.md`, and all relevant referenced guidance.
- [x] MicroVertical, Action, generated BFF client, and typed Effect error boundaries are preserved.
- [x] Tests cover every changed behavior and important failure path.
- [x] No unrelated changes, dead code, or accidental API expansion remain.

## Notes

- Depends on `feature-crm-ares-adapter.md` and the field schemas from `feature-crm-customer-business-fields.md`.
- The current governed Read error vocabulary intentionally exposes provider timeout/throttling as safe retryable `503`; changing Core to publish provider-specific `429`/`504` is outside this feature.

## Implementation Evidence

### Summary

- Generated the CRM `customer-ares-lookup` module API with Codesmith, then adapted its contract,
  governed Read, server, generated Effect client, manifest, private registration, and CRM client seam.
- Connected the owner-private ARES service through a substitutable Effect layer and exposed only the
  flat Customer-compatible result with the required sanitized Problem Details union.
- Added unit and real BFF/Read-runtime integration coverage for success, authorization, evidence,
  correlation, validation, provider failures, decoding defects, and information-leak prevention.

### Changed Files

- 13 files changed, 1,092 insertions, 0 deletions: CRM API/runtime/client wiring, four generated
  module-API files, manifest and private registration, two new CRM test files, one existing
  API-contract test, and this plan.

### Tests Written or Updated

- `verticals/crm/tests/unit/customer-ares-lookup.test.ts` — proves the exact descriptor, codecs,
  public status union, complete adapter-error mapping, correlation/evidence, generated publication,
  and absence of an ARES Action.
- `verticals/crm/tests/integration/customer-ares-lookup-bff.test.ts` — proves the generated client
  through the real CRM BFF and governed Read runtime for success, invalid input, authentication,
  permission denial, not found, retryable unavailability, sanitized internal failure, correlation,
  and durable metadata-only evidence with a substituted ARES service.
- `verticals/crm/tests/unit/customer-contact-api-contract.test.ts` — extends the exact CRM operation
  surface with `lookupCustomerAres`.

### Validation

- `mise exec -- pnpm --filter @app/crm test:unit` — passed (40 tests).
- `mise exec -- pnpm --filter @app/crm test:integration` — passed (4 tests).
- `mise exec -- pnpm --filter @app/crm typecheck` — passed.
- `mise exec -- pnpm api:check` — passed.
- `mise exec -- pnpm module-entrypoints:check` — passed.
- `mise exec -- pnpm check:module-contracts` — passed.
- `mise exec -- pnpm --filter @app/crm build` — the dirty implementation worktree correctly refused
  a promotable envelope with `sourceRevision "workspace"`; the same source in an isolated clean
  snapshot passed the complete CRM build and Node deployment package with an explicit Git revision.
- `mise exec -- pnpm check` — passed, including format, lint, Core Action tests, type checking,
  skills, i18n/API/database/module-entrypoint/module-contract/workspace checks, and performance readiness.
- `mise exec -- pnpm build` — the dirty implementation worktree stopped at the same provenance
  guard; the source-equivalent clean snapshot passed the complete CRM and Shell build, deployment
  packaging, Module Federation type assertion, and performance readiness.

### Review

- Re-read `../AGENTS.md`, `AGENTS.md`, `docs/architecture/MICROVERTICALS.md`,
  `docs/architecture/ACTIONS.md`, `docs/architecture/ERRORS.md`,
  `docs/architecture/ULTRAMODERN.md`, `docs/architecture/MODULE_ENTRYPOINTS.md`,
  `docs/architecture/MODULE_MANIFESTS.md`, `docs/architecture/DATA_ACCESS.md`,
  `docs/integrations/ares.md`, and both dependency specifications.
- Final review confirmed the generated Effect client remains the only public seam, the private ARES
  adapter remains owner-local, the operation is a metadata-evidenced governed Read rather than an
  Action, and every public failure is declared, status-matched, typed, and sanitized.
- Fixed the review findings surfaced by the repository gate: switch-case style, Effect-catch lint
  annotation, type-only imports, Promise callback structure, and sequential test assertions.
- No UI/browser review or screenshots were applicable because this specification changes only the
  CRM BFF/read boundary.

### Deviations and Follow-ups

- Promotable release envelopes intentionally require a clean Git tree. Because this implementation
  may not create a commit, build validation used a source-equivalent clean snapshot with the current
  HEAD revision; no product-code bypass or build-configuration change was introduced.
