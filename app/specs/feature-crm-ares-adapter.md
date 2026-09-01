---
type: feature
status: done
created: 2026-08-17
---

# Feature: CRM private ARES subject adapter

## Feature Description

Add a private CRM-owned Effect adapter for the Czech ARES consolidated economic-subject endpoint.
The adapter normalizes one valid IČO into Customer-compatible business fields and deliberately drops
all address, provenance, CZ-NACE, and activity data.

## User Story

As the CRM ARES lookup API
I want a typed and resilient server-side ARES adapter
So that upstream transport and schema details never leak into Customer UI or contracts

## Problem Statement

ARES is an external public service with documented input, availability, and blocking conditions.
Calling it directly from a browser would duplicate validation and couple the UI to unstable CORS,
raw Czech field names, upstream errors, and response evolution.

## Solution Statement

Create a private `verticals/crm/src/integrations/ares/` Effect service using the repository's Effect
HTTP facilities. Decode only the consolidated response fields required by Customer, map them to the
canonical names, apply one request per valid IČO with timeout and bounded retry, and expose a closed
internal error union for the governed lookup read.

## Relevant Files

Use these files to implement the feature:

- `docs/integrations/ares.md` — researched official endpoint, schemas, limits, and error behavior.
- `docs/architecture/ULTRAMODERN.md` — Effect-first I/O and private implementation rules.
- `docs/architecture/ERRORS.md` — typed expected failures and safe diagnostics.
- `verticals/crm/package.json` — available Effect and HTTP runtime dependencies.
- `verticals/crm/src/api/customer-detail.read.ts` — owner-local Effect service composition pattern.
- `verticals/crm/tests/unit/` — focused private adapter contract tests.

### New Files

- `verticals/crm/src/integrations/ares/ares-subject.service.ts` — private Effect service, request execution, decoding, mapping, and errors.
- `verticals/crm/tests/unit/ares-subject.service.test.ts` — deterministic adapter tests with a substituted HTTP client.

## Implementation Plan

### Phase 1: Foundation

Define internal raw ARES response codecs, a Customer-prefill value, and tagged failures without
publishing them as a module API or importing browser/framework concerns.

### Phase 2: Core Implementation

Implement the exact consolidated GET, safe URL construction, timeout, cache/coalescing, concurrency
limit, and retry/error classification in Effect.

### Phase 3: Integration

Verify mapping and resilience with deterministic fake HTTP responses and document operational
limits without requiring live ARES in automated tests.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Define the private integration contract

- [x] Create internal schemas for exact eight-digit IČO and only the required ARES fields: `ico`, `obchodniJmeno`, optional `dic`, `pravniForma`, `datumVzniku`, and `datumZaniku`.
- [x] Define a flat result `{ name, ico, dic, legalFormCode, establishedOn, dissolvedOn }` and tagged invalid/not-found/denied/throttled/timeout/unavailable/decode failures; exclude `sidlo`, update/source metadata, CZ-NACE, registrations, and activities.

### 2. Implement the Effect HTTP adapter

- [x] Call `GET https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty/{ico}` server-side with JSON accept headers, safe path construction, no credentials, and no ad hoc browser fetch.
- [x] Decode success before mapping Czech upstream names to Customer names; log full internal causes with correlation context while keeping public-safe failure data.

### 3. Respect ARES operating limits

- [x] Add a finite timeout, bounded retry/backoff only for retryable transport/upstream failures, one-flight coalescing and short-lived cache by valid IČO, and bounded concurrency well below the documented 500 requests/minute blocking threshold.
- [x] Never retry invalid, not-found, denied, or decode failures and never probe random/partially valid IČOs.

### 4. Add deterministic adapter tests

- [x] Test complete and partial success, leading-zero IČO, omitted/null optional fields, unknown extra/address fields being ignored, and exact flat mapping.
- [x] Test `400`, `401`, `403`, `404`, throttling-like responses, `500`, timeout, malformed JSON/schema, retry bounds, cache/coalescing, cancellation, and sanitized diagnostics without making live network calls.

### 5. Run all validation commands

- [x] Execute every command in `Validation Commands` and resolve only adapter-related failures.

## Testing Strategy

### Unit Tests

Substitute the Effect HTTP client and a test clock to prove request construction, decoding, failure
classification, retry timing, cache/coalescing, and cancellation deterministically.

### Integration Tests

Not required for this task: the following governed BFF spec provides the cross-boundary integration
test. Automated validation must not depend on ARES availability.

### Edge Cases

- Valid IČO whose subject is not found.
- ARES returns optional fields as absent or null.
- Extra address and activity fields appear in the response.
- Multiple simultaneous lookups request the same IČO.

## Acceptance Criteria

- [x] ARES is called only from the CRM server-side adapter for a valid eight-digit IČO.
- [x] The adapter returns only flat Customer-compatible business fields.
- [x] Expected upstream failures remain typed and retry behavior respects ARES limits.
- [x] No address or ARES metadata reaches the result.

## Validation Commands

Execute every command to validate the feature with zero regressions.

- `mise exec -- pnpm --filter @app/crm test:unit` — validate adapter mapping and resilience deterministically.
- `mise exec -- pnpm --filter @app/crm typecheck` — validate Effect service, schema, and error types.
- `mise exec -- pnpm lint` — validate implementation boundaries and style.
- `mise exec -- pnpm check` — Run the final repository quality gate.

## Review Checklist

- [x] Every acceptance criterion is satisfied.
- [x] The diff complies with `../AGENTS.md`, `AGENTS.md`, and all relevant referenced guidance.
- [x] MicroVertical, Action, generated BFF client, and typed Effect error boundaries are preserved.
- [x] Tests cover every changed behavior and important failure path.
- [x] No unrelated changes, dead code, or accidental API expansion remain.

## Implementation Evidence

- Generated the private adapter from `app/` with `mise exec -- pnpm scaffold:external-http-adapter -- --vertical crm --provider ares --operation subject`, then adapted the fail-closed scaffold with ARES-owned schemas, errors, request policy, diagnostics, and mapping.
- `mise exec -- pnpm --filter @app/crm test:unit` passed: 34 tests, 0 failures; all ARES HTTP behavior used a substituted Effect `HttpClient` and deterministic test clock with no live network calls.
- `mise exec -- pnpm --filter @app/crm typecheck` passed after materializing the fresh worktree's referenced declaration cache.
- `mise exec -- pnpm lint` passed with no findings.
- `mise exec -- pnpm check` passed, including formatting, lint, Core Action tests, root type checking, skills, i18n/API/database/module-entrypoint/module-contract boundaries, workspace contracts, and performance readiness.
- `mise exec -- pnpm --filter @app/crm test:component -- tests/components/customer-ares-loader.test.tsx` passed: 208 tests, 0 failures, after updating the pre-existing ARES loader fixture to the current Customer form contract.
- Final review confirmed the adapter remains CRM-private: no module manifest, runtime registration, package export, Module Federation exposure, generated BFF client, or Shell surface was added or changed. No production build was required because this task adds no public/UI/build-output surface.

## Notes

- This is dependency 4 of 11 and can be implemented after the canonical Customer field names are fixed.
- A private Effect integration service is an owner-local implementation detail, not a governed module entrypoint; the public API is generated in the next spec.
- ARES data is informational; this feature performs lookup, not authoritative verification or synchronization.
