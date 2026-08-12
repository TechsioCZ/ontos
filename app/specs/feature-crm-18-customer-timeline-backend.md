---
type: feature
status: planned
created: 2026-08-10
---

# Feature: CRM 18 Customer timeline backend

## Feature Description

Implement ticket 18, "Implement the Customer timeline backend," from `app/tickets.md`. Provide one
deterministic, bounded, cursor-paginated Customer relationship timeline that merges active Activity
rows with agreed Deal and Offer creation/lifecycle Domain Events for the selected Legal Entity.
Complete the generated `activity-timeline` BFF and Customer timeline provider contracts/clients,
add the narrow Core-owned Domain Event read capability required to preserve schema ownership, map
typed errors and authorization, and test mixed ordering/pagination/isolation/provider behavior.

## User Story

As an authorized CRM user
I want one chronological Customer relationship history
So that interactions and meaningful commercial progress are visible without reading technical audit logs

## Problem Statement

Activities and lifecycle Domain Events are stored by separate owners (`crm` and Core). CRM business
code may not import Core tables/repositories or receive a database executor, yet the timeline must
merge those sources, filter by selected Legal Entity, preserve safe labels after deletion, and
paginate deterministically. Core audit rows and routine edits are explicitly not timeline entries.

## Solution Statement

Add a narrow Core infrastructure service that reads bounded, producer/subject/event-type-filtered
Domain Events inside the existing scoped governed-read transaction and returns decoded safe event
records without exposing Core schema/executor. Compose it with CRM Activity/label services in the
owner-local timeline read handler, merge/sort by occurrence time plus stable timeline entry ID,
and expose identical bounded semantics through the generated BFF client and resource timeline provider.

## Relevant Files

Use these files to implement the feature:

- `specs/feature-crm-microvertical.md` — authoritative timeline sources, inclusion/exclusion, ordering, scope, and provider behavior.
- `tickets.md` — corresponding ticket 18; blocked by tickets 11, 15, and 17.
- `verticals/crm/shared/apis/activity-timeline.ts` — generated timeline contract to complete.
- `verticals/crm/src/api/activity-timeline-client.ts` — generated Effect client.
- `verticals/crm/src/activities/activity-repository.ts` — active Activity timeline source.
- `verticals/crm/src/deals/deal-service.ts` and `verticals/crm/src/offers/offer-service.ts` — safe deleted/historical labels.
- `packages/core-runtime/src/db/schema.ts` — Core-owned Domain Event storage; never imported by CRM.
- `packages/core-runtime/src/actions/events.ts` — declared Domain Event contract.
- `packages/core-runtime/src/reads/runtime.ts` — Core-owned scoped read lifecycle.
- `apps/shell-super-app/api/modules/shell-resources.ts` — resource timeline gateway/decoding/pagination integration.
- `docs/architecture/DATA_ACCESS.md`, `ERRORS.md`, and `MODULE_ENTRYPOINTS.md` — governed read/provider rules.

### New Files

- `packages/core-runtime/src/reads/domain-event-reader.ts` — narrow typed Core infrastructure capability for owner-filtered event reads.
- `verticals/crm/src/timeline/customer-timeline-service.ts` — merge, cursor, label, and view-model behavior.
- `verticals/crm/src/timeline/customer-timeline.read.ts` — owner-local generated-provider/read binding.
- `verticals/crm/tests/unit/customer-timeline-*.test.ts` — merge/cursor/contract tests.
- `verticals/crm/tests/integration/customer-timeline-*.test.ts` — mixed-source/RLS/provider/BFF tests.

## Implementation Plan

### Phase 1: Foundation

Define a closed timeline entry/cursor contract and the narrow Core Domain Event reader surface with
producer/subject/type/scope/bounds enforced before CRM receives data.

### Phase 2: Core Implementation

Merge active Activities with only agreed CRM lifecycle events, resolve safe labels, sort/paginate
deterministically, and exclude routine edits/audit rows/cross-entity records.

### Phase 3: Integration

Complete generated BFF/resource provider pagination and errors, bind owner-locally, and prove Shell
provider, selected-scope authorization, mixed-source ordering, deletion, and unavailable behavior.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Define exact timeline and cursor contracts

- [ ] Adapt generated `activity-timeline` request/response schemas for Customer ID, bounded limit, opaque cursor, entries, next cursor, and projection-lag flag. Entry discriminants cover Activity, Deal status, Offer created, and Offer status with safe IDs/labels/summary data.
- [ ] Define deterministic descending order by `occurredAt`, then stable source-qualified `timelineEntryId`; encode/decode cursor values exactly and reject excess, malformed, or unbounded input as typed validation.
- [ ] Include no routine Customer/Contact/Deal/Offer field edits, Core audit rows, raw event payloads, internal identifiers, or database diagnostics.

### 2. Add a narrow Core-owned Domain Event read capability

- [ ] Implement `packages/core-runtime/src/reads/domain-event-reader.ts` over Core's typed schema/transaction, accepting immutable scope plus exact `producerModuleKey = crm.core`, Customer subject, approved event-type set, selected Legal Entity, cursor, and limit; return only bounded decoded event fields.
- [ ] Expose the capability as a Core-built service available to a governed read service factory, not as a database executor/Core repository import. Enforce tenant/legal-entity/producer/subject/type filters and fail typed/retryably on decode/persistence uncertainty.
- [ ] Add Core unit/integration tests for bounds, exact filters, cross-tenant/entity denial, malformed payload, ordering, no schema leak, and database access boundary compliance.

### 3. Implement owner-local merge and labels

- [ ] Validate the tenant-wide Customer through CRM service and selected-context resource/module authorization. Read `limit + 1` bounded candidates from active Activities and approved event reader, then merge/sort/cut deterministically without unbounded in-memory scans.
- [ ] Include non-deleted Activities; Deal status events; Offer-created and Offer-status events agreed in their Action descriptors. Resolve shared Customer and safe Contact/Deal/Offer labels, including deleted linked records, without releasing cross-Legal-Entity commercial data.
- [ ] Return stable summaries/view models and next cursor; set projection lag only when the declared implementation genuinely uses an asynchronous projection (otherwise false). Record metadata-only governed read evidence.

### 4. Complete generated BFF and resource timeline provider

- [ ] Bind the timeline `defineRead`, strict server adapter, and generated Effect client with declared authentication `401`, permission `403`, Customer absence `404`, validation `400`, retryable context/database/event/provider `503`, and sanitized `500` outcomes.
- [ ] Adapt the generated Customer resource timeline provider and `apps/shell-super-app/api/modules/shell-resources.ts` contract/gateway only as needed to carry bounded limit/cursor/next-cursor semantics; preserve fresh audience-scoped assertion, module/resource gates, strict decoding, and no private import.
- [ ] Keep the Customer page BFF and Shell resource provider observably consistent for entry order/content/error semantics.

### 5. Add focused tests beside behavior

- [ ] Add unit tests for empty/single/mixed sources, all entry discriminants, tie ordering, source-qualified IDs, cursor encode/decode, page boundaries/no duplicates/gaps, inclusion/exclusion, safe deleted labels, and typed mappings.
- [ ] Add PostgreSQL/Core read/BFF/provider tests for selected-Legal-Entity filtering, tenant-wide Customer resolution, cross-entity lifecycle exclusion, deleted Activities/linked records, permission denial/check unavailable, malformed event payload, event/database/provider failure, 401/403/404/503/500 contracts, generated client decode/transport errors, Shell provider behavior, and private bundle/schema isolation.

### 6. Run all validation commands

- [ ] Execute every command in `Validation Commands` and resolve failures without weakening a gate.

## Testing Strategy

### Unit Tests

Table-test timeline discriminants, inclusion/exclusion, stable merge/order/cursor pagination, safe
labels, Core reader filters, exact schemas, and exhaustive errors.

### Integration Tests

Use PostgreSQL/Core governed-read/strict BFF/Shell provider fixtures for mixed Activities/events,
selected-scope filtering, authorization/evidence, pagination boundaries, provider failures, and isolation.

### Edge Cases

- Activity and event have identical occurrence timestamps.
- Page boundary cuts across sources or rows are deleted between pages.
- Customer is shared across Legal Entities with separate commercial histories.
- Linked Deal/Offer/Contact is soft-deleted.
- Event payload is malformed or Core event read is unavailable.

## Acceptance Criteria

- [ ] Timeline merges only active Activities and agreed Deal/Offer lifecycle facts in deterministic bounded pages.
- [ ] Routine edits/audit rows never appear; selected Legal Entity commercial data never leaks.
- [ ] Safe labels resolve deleted linked records and shared Customer identity correctly.
- [ ] Generated BFF/client and Customer resource timeline provider expose consistent typed auth/authz/not-found/unavailable/pagination behavior.
- [ ] Core schema remains private behind a narrow typed reader and all merge/cursor/provider/isolation tests pass.

## Validation Commands

Execute every command to validate the feature with zero regressions.

- `mise exec -- pnpm --filter @app/crm test:unit` — run timeline merge/cursor/contract tests.
- `mise exec -- pnpm --filter @app/crm test:integration` — run mixed-source BFF/provider/PostgreSQL tests.
- `mise exec -- pnpm --filter @app/core-runtime db:test` — validate the bounded Core Domain Event reader and tenant isolation.
- `mise exec -- pnpm database-access:check` — verify Core schema/executor remains unavailable to CRM.
- `mise exec -- pnpm api:check` — validate strict timeline BFF/client.
- `mise exec -- pnpm module-entrypoints:check` — validate generated timeline provider/read entrypoints.
- `mise exec -- pnpm check` — Run the final repository quality gate.

## Review Checklist

- [ ] Every acceptance criterion is satisfied.
- [ ] The diff complies with `../AGENTS.md`, `AGENTS.md`, and all relevant referenced guidance.
- [ ] MicroVertical, Action, generated BFF client, and typed Effect error boundaries are preserved.
- [ ] Tests cover every changed behavior and important failure path.
- [ ] No unrelated changes, dead code, or accidental API expansion remain.

## Notes

- Dependencies: tickets 11, 15, and 17 must all be complete.
- No new mutation Action, CRM entity table, Policy, Outbox Message, search, or audit-as-history behavior is required in this read-only leaf.
- The narrow Core event reader is infrastructure needed to obey the existing cross-owner schema prohibition; it must not become a generic evidence export.
