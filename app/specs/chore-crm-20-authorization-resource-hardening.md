---
type: chore
status: planned
created: 2026-08-10
---

# Chore: CRM 20 authorization and resource hardening

## Chore Description

Implement ticket 20, "Harden CRM authorization and resource access," from `app/tickets.md`.
Harden the completed CRM vertical so every CRM Action, page, governed read, and resource
contribution fails closed under the repository's SpiceDB, Action-runtime, and PostgreSQL RLS
model. Configure exactly the 18 approved CRM Action objects, preserve tenant-shared Customer and
Contact data, prove Deal/Offer/Activity legal-entity isolation, and introduce the Core-owned marker
needed to express CRM v1's intentionally unrestricted per-resource check without weakening tenant,
legal-entity, module, provider, governed-read, or database gates.

This ticket is blocked by tickets 3, 5, 7, 9, 11, 13, 15, 17, and 18, exactly as recorded in
`app/tickets.md`. The CRM master specification at `app/specs/feature-crm-microvertical.md` remains
authoritative for authorization, RLS, resource providers, Actions, and non-goals.

## Relevant Files

Use these files to accomplish the chore:

- `specs/feature-crm-microvertical.md` — authoritative CRM behavior and authorization model.
- `tickets.md` — corresponding ticket 20 and its exact blockers.
- `packages/core-runtime/spicedb/bootstrap.yaml` — repository-supported SpiceDB schema and
  local/test relationship bootstrap.
- `packages/core-runtime/src/permissions/service.ts` — configured Action-object permission
  decisions and Action-key encoding.
- `packages/core-runtime/src/permissions/context-access.ts` — module, legal-entity, resource, and
  tenant authorization checks.
- `packages/core-runtime/src/resources/contracts.ts` — Core-owned resource reference and provider
  contracts established by ticket 2.
- `packages/core-runtime/tests/integration/context-access.test.ts` — live SpiceDB context-access
  coverage.
- `packages/core-runtime/tests/integration/action-runtime.test.ts` — Action gate ordering and
  fail-closed behavior.
- `verticals/crm/src/index.ts` — CRM manifest and exact Action/provider registration.
- `verticals/crm/src/db/schema.ts` — final owner-local CRM schema and RLS policy declarations.
- `verticals/crm/tests/integration/` — CRM authorization, provider, Action, and RLS integration
  tests.

### New Files

- `packages/core-runtime/src/resources/access-mode.ts` — closed resource-access marker type,
  validation, and registration helper owned by Core.
- `packages/core-runtime/tests/unit/resource-access-mode.test.ts` — marker contract and
  invalid/duplicate registration tests.
- `verticals/crm/tests/integration/authorization-hardening.test.ts` — complete CRM authorization
  matrix using the final Action and resource inventory.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Inventory the final authorization surface

- [ ] Read the final CRM manifest and create a public-descriptor-based test inventory containing
      exactly 18 Action keys: Customer (3), Contact (3), primary-contact assignment (1), Deal (3), Deal
      lifecycle (1), Offer revision (3), Offer lifecycle (1), and Activity (3); reject missing,
      duplicate, or extra keys without importing private handlers.

### 2. Define the explicit Core resource access mode

- [ ] Add `packages/core-runtime/src/resources/access-mode.ts` as a closed marker contract for
      resource types whose v1 authorization intentionally stops at tenant, legal-entity, and module
      access; keep registration in the owning module manifest, reject unknown modes and duplicate
      resource-type registrations, and keep authorizer callbacks out of public contracts.
- [ ] Add focused unit tests beside the marker for valid registration, unknown mode, duplicate
      registration, and stable `Id`/`ResourceRef` wire shapes.

### 3. Apply the marker without weakening other gates

- [ ] Update `packages/core-runtime/src/permissions/context-access.ts` so a registered unrestricted
      marker skips only the individual SpiceDB `resource` relation; tenant, selected-legal-entity,
      module, provider, database, and governed-read checks still run, while unknown or unmarked
      resource types retain the existing per-resource check and fail closed.
- [ ] Extend Core context-access tests for marked and unmarked resources, module and legal-entity
      denial, SpiceDB conditional decisions, and client unavailability, preserving distinct `denied`
      and `unavailable` outcomes.

### 4. Register the CRM resource types

- [ ] Register Customer, Contact, Deal, and Customer-timeline resource types with the approved v1
      marker through `verticals/crm/src/index.ts`; verify their existing identifiers, `ResourceRef`
      values, provider contracts, and URLs remain unchanged and that a future real resource
      reader/writer can replace the marker through manifest/access configuration alone.
- [ ] Add manifest/contract tests for the exact marker inventory, an unknown resource type, and an
      unavailable provider.

### 5. Configure exactly the approved CRM Actions

- [ ] Define the exact local/deployment relationship inventory for all 18 CRM Action objects using
      the existing `toSpiceDbActionObjectId`; grant the normal CRM module role only its approved
      executor relationships, add no wildcard or compatibility grant, and test that deleting one
      relationship affects only that Action.
- [ ] Add table-driven Action-runtime tests for allowed, denied, unconfigured, and SpiceDB-
      unavailable decisions, proving the handler and repository do not run before authorization and
      that no unconfigured production compatibility path exists.

### 6. Prove CRM authorization and forced RLS together

- [ ] Add `verticals/crm/tests/integration/authorization-hardening.test.ts` with two tenants and two
      legal entities. Prove Customer and Contact visibility can cross legal entities only inside one
      authorized tenant, Deal/Offer/Activity remain legal-entity isolated, all five types remain tenant
      isolated, and forged foreign keys fail.
- [ ] Exercise every Action and direct Customer, Contact, Deal, and timeline resource surface under
      allowed, denied, missing, wrong-tenant, wrong-legal-entity, conditional, and unavailable cases as
      applicable; assert truthful governed-read evidence and public typed failures do not leak database
      or SpiceDB details.

### 7. Validate the complete hardening change

- [ ] Run every command in Validation Commands from `app/`, resolve failures in their owning
      behavior with a focused regression test, and confirm no search, Policy, Outbox Message, wildcard
      permission, elevated database role, or unrelated CRM scope was introduced.

## Testing Strategy

Add focused Core unit tests for the resource access marker and Core integration tests for marked,
unmarked, denied, conditional, and unavailable context access. Add a table-driven CRM integration
suite covering all 18 Actions, all direct resource providers, governed-read evidence, Action gate
ordering, and forced RLS across two tenants and two legal entities. The security suite must prove
defense in depth rather than treating SpiceDB, handler filters, providers, or RLS alone as
sufficient.

## Acceptance Criteria

- [ ] Exactly the 18 approved CRM Actions have explicit executor configuration and no production
      compatibility behavior accepts an unconfigured Action.
- [ ] Customer and Contact are tenant-scoped; Deal, Offer, and Activity are tenant-plus-legal-
      entity-scoped in both service filters and forced RLS.
- [ ] Customer, Contact, Deal, and timeline resource access fails closed for module denial, unknown
      resource types, provider unavailability, tenant mismatch, and applicable legal-entity mismatch.
- [ ] The explicit unrestricted-resource marker is Core-owned, closed, test-covered, and
      replaceable later without changing public resource identity.
- [ ] Authorization tests demonstrate defense in depth across SpiceDB, Action/runtime gates,
      governed reads, resource providers, and PostgreSQL RLS.
- [ ] No CRM search behavior or UI is introduced.

## Validation Commands

Execute every command to validate the chore with zero regressions.

- `mise exec -- pnpm --filter @app/core-runtime action:test:unit` — Validate Action authorization
  and resource-marker units.
- `mise exec -- pnpm --filter @app/core-runtime action:test:integration` — Validate live Action gate
  ordering and permission decisions.
- `mise exec -- pnpm --filter @app/core-runtime db:test` — Validate Core SpiceDB/database integration
  fixtures and context access.
- `mise exec -- pnpm --filter @app/crm test:unit` — Validate CRM manifest and authorization units.
- `mise exec -- pnpm --filter @app/crm test:integration` — Validate the complete CRM authorization,
  provider, and RLS matrix.
- `mise exec -- pnpm --filter @app/crm db:verify` — Verify CRM owner, migration journal, forced RLS,
  and grants.
- `mise exec -- pnpm database-access:check` — Preserve owner-local database access boundaries.
- `mise exec -- pnpm module-entrypoints:check` — Validate generated/public module entrypoints.
- `mise exec -- pnpm check:module-contracts` — Validate module manifests and resource registrations.
- `mise exec -- pnpm contract:check` — Validate public contract topology.
- `mise exec -- pnpm typecheck` — Type-check all affected packages.
- `mise exec -- pnpm check` — Run the final repository quality gate.

## Review Checklist

- [ ] Every acceptance criterion is satisfied.
- [ ] The diff complies with `../AGENTS.md`, `AGENTS.md`, and all relevant referenced guidance.
- [ ] Behavioral changes have tests.
- [ ] No unrelated changes, dead code, or accidental API expansion remain.

## Notes

- Dependencies: tickets 3, 5, 7, 9, 11, 13, 15, 17, and 18.
- Ticket 1's generated Action boundary and ticket 2's manifest, route, module API,
  resource-provider, and database foundations are assumed complete.
- No per-resource sharing model is introduced in CRM v1. The marker is explicit migration
  readiness for a later reader/writer, not an implicit allow fallback.
- No Policy scaffold is needed because v1 authorization uses configured Action objects,
  module/resource checks, handler invariants, and forced RLS.
- No Outbox Message scaffold is needed because this chore adds no integration consumer or
  cross-vertical delivery.
- No search controls, endpoints, parameters, or behavior are allowed.
