---
type: feature
status: done
created: 2026-08-17
---

# Feature: CRM Customer business fields persistence

## Feature Description

Extend the CRM-owned Customer record with the Czech business identity fields needed for manual entry
and ARES-assisted creation. Store the fields directly on `crm.customers`; do not introduce an ARES
subobject, synchronization metadata, address columns, an address table, CZ-NACE codes, or registered
activity records.

## User Story

As a CRM user
I want a Customer to retain its Czech business identity
So that the same canonical record can be created manually or prefilled from ARES

## Problem Statement

The physical Customer record currently persists only `name`. Later contracts, Actions, and pages
cannot safely adopt IČO, DIČ, legal form, and lifecycle dates until the owning schema has typed
columns, tenant invariants, a generated migration, and verified DTO support.

## Solution Statement

Add nullable `ico`, `dic`, `legalFormCode`, `establishedOn`, and `dissolvedOn` columns to the existing
Customer table. Keep `name` as the canonical business name populated from ARES `obchodniJmeno`.
Constrain normalized formats in Drizzle, make non-null IČO unique per tenant across active and
archived Customers, generate the CRM-owned migration, and update persistence mapping/tests.

## Relevant Files

Use these files to implement the feature:

- `../AGENTS.md` — app-only scope and generator constraints.
- `AGENTS.md` — database, Action, and MicroVertical rules.
- `docs/architecture/DATABASE.md` — typed Drizzle, schema ownership, migration, and verification rules.
- `docs/architecture/DATA_ACCESS.md` — tenant-scoped owner persistence rules.
- `verticals/crm/shared/apis/customer-detail.ts` — canonical Customer result and reusable field schemas.
- `verticals/crm/src/db/schema.ts` — authoritative CRM table definitions and inventory.
- `verticals/crm/src/services/customer-contact-persistence.service.ts` — Customer row writes and DTO mapping.
- `verticals/crm/drizzle.config.ts` — CRM-owned migration configuration.
- `verticals/crm/scripts/verify-db-schema.mts` — exact physical schema verification.
- `verticals/crm/tests/unit/schema-contract.test.ts` — typed schema invariants.
- `verticals/crm/tests/integration/database-boundary.test.ts` — schema ownership and isolation proof.

### New Files

- `verticals/crm/drizzle/` — the next Drizzle-generated CRM migration containing the Customer column, check, and unique-index changes.
- `verticals/crm/drizzle/meta/` — the corresponding generated schema snapshot and journal update.

## Implementation Plan

### Phase 1: Foundation

Define canonical result/field schemas plus normalized columns and constraints directly on
`crm.customers`, preserving all existing IDs, timestamps, lifecycle behavior, RLS, and table
inventory.

### Phase 2: Core Implementation

Generate the CRM migration and expand Customer result/DTO mapping. Mutation payloads, write-service
mapping, and duplicate-IČO domain errors remain in the later Action task.

### Phase 3: Integration

Verify migration output, exact schema inventory, tenant isolation, archived-record uniqueness, and
compatibility with existing rows whose new fields are null.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Define canonical Customer field schemas

- [x] Add reusable exact IČO/legal-form/date schemas and top-level nullable `ico`, `dic`, `legalFormCode`, `establishedOn`, and `dissolvedOn` members to `CustomerSchema`; retain `name` as the only business-name field and leave create/edit payload expansion to the Action spec.
- [x] Define JSON date-only values as `YYYY-MM-DD`, align nullable output semantics with persistence, and reject unknown nested ARES/address data.

### 2. Extend the typed Customer table

- [x] Add nullable `ico` and `dic` text columns, nullable `legal_form_code` text, and nullable date-only `established_on` and `dissolved_on` columns to `verticals/crm/src/db/schema.ts`; do not add any ARES-prefixed field or address storage.
- [x] Add checks for exact eight-digit IČO, normalized non-empty bounded DIČ, exact three-digit legal-form code, and `dissolved_on >= established_on` when both dates exist.
- [x] Add a tenant-scoped unique index on `(tenant_id, ico)` that permits multiple null values and applies to active and archived Customers.

### 3. Generate and inspect the migration

- [x] From `app/`, run `mise exec -- pnpm --filter @app/crm db:generate`; retain only the generated CRM migration and metadata for the intended columns, checks, and index.
- [x] Verify the migration alters `crm.customers` in place, preserves existing rows with null defaults, and does not change the exact `contacts`/`customers` table inventory.

### 4. Expand Customer result mapping

- [x] Update Customer DTO mapping in `customer-contact-persistence.service.ts` so selected rows expose all six canonical business fields with date-only values and nulls without adding a nested ARES model.
- [x] Leave create/edit payload consumption, write mapping, and constraint-specific domain-error conversion to `feature-crm-customer-action-fields.md` so this dependency remains independently buildable.

### 5. Add focused schema and persistence tests

- [x] Extend schema/unit tests for column names/types/nullability, checks, the tenant IČO unique index, lifecycle-date ordering, table inventory, and absence of address/ARES metadata columns.
- [x] Extend database integration coverage with typed Drizzle setup for legacy null rows, complete-field insert/select round trips, same-IČO rejection within one tenant, same-IČO allowance across tenants, and archived-record uniqueness.

### 6. Run all validation commands

- [x] Execute every command in `Validation Commands` and resolve feature-related failures without expanding Customer scope.

## Testing Strategy

### Unit Tests

Assert the typed Drizzle schema, exact inventory, normalized checks, index identity, inferred record
types, and DTO date/null conversion.

### Integration Tests

Apply the CRM migration to the test database and prove tenant isolation, uniqueness, compatibility
with existing rows, and complete persistence round trips.

### Edge Cases

- Null optional fields and pre-existing Customers.
- IČO with leading zeroes, non-digits, or the wrong length.
- Duplicate IČO on active or archived Customers in the same tenant.
- Equal establishment/dissolution dates and reversed dates.

## Acceptance Criteria

- [x] Customer directly persists `name`, `ico`, `dic`, `legalFormCode`, `establishedOn`, and `dissolvedOn`.
- [x] Non-null IČO is exactly eight digits and unique per tenant across lifecycle states.
- [x] Existing Customers migrate safely with null optional values.
- [x] No address, ARES metadata, activity, or additional table is introduced.

## Validation Commands

Execute every command to validate the feature with zero regressions.

- `mise exec -- pnpm --filter @app/crm db:verify` — verify the CRM physical schema and migration inventory.
- `mise exec -- pnpm --filter @app/crm test:unit` — validate schema and persistence contracts.
- `mise exec -- pnpm --filter @app/crm test:integration` — validate migrations, tenant isolation, uniqueness, and round trips.
- `mise exec -- pnpm --filter @app/crm typecheck` — validate inferred Drizzle and DTO types.
- `mise exec -- pnpm database-access:check` — enforce CRM database ownership and typed access.
- `mise exec -- pnpm check` — Run the final repository quality gate.

## Review Checklist

- [x] Every acceptance criterion is satisfied.
- [x] The diff complies with `../AGENTS.md`, `AGENTS.md`, and all relevant referenced guidance.
- [x] MicroVertical, Action, generated BFF client, and typed Effect error boundaries are preserved.
- [x] Tests cover every changed behavior and important failure path.
- [x] No unrelated changes, dead code, or accidental API expansion remain.

## Notes

- This is dependency 1 of 11.
- `name` is the ARES `obchodniJmeno` destination; there is no separate `legalName` column.
- DIČ is normalized and bounded but should not be coupled to IČO because valid Czech DIČ values are not universally identical to IČO.

## Implementation Evidence

### Summary

- Added flat reusable Customer business-field schemas, nullable CRM-owned columns, normalized checks,
  lifecycle-date ordering, and a tenant/IČO unique index that includes archived Customers.
- Generated the in-place CRM migration and metadata, expanded flat Customer DTO mapping, and made
  physical verification select every typed CRM column.
- Added unit and live PostgreSQL coverage for complete and legacy-null records, normalized formats,
  multiple null IČOs, tenant uniqueness, archived uniqueness, and lifecycle dates.

### Changed Files

- CRM contract, typed schema, persistence DTO mapper, and physical verifier.
- One generated migration plus its Drizzle journal and schema snapshot.
- CRM unit/integration tests and this implementation plan/evidence file.

### Tests Written or Updated

- `verticals/crm/tests/unit/customer-contact-persistence.service.test.ts` — proves complete and
  legacy-null rows map to flat date-only/null Customer DTOs.
- `verticals/crm/tests/unit/customer-contact-action-contract.test.ts` — proves reusable IČO, DIČ,
  legal-form, and real calendar-date schemas plus strict flat Customer results.
- `verticals/crm/tests/unit/schema-contract.test.ts` — proves inferred record shapes, exact columns,
  checks, index identity, migration scope, and unchanged table inventory.
- `verticals/crm/tests/integration/database-boundary.test.ts` — proves nullable migration
  compatibility, complete round trips, invalid-value rejection, multiple null IČOs, same-tenant
  active/archived uniqueness, cross-tenant allowance, and equal/reversed lifecycle dates.
- `verticals/crm/tests/integration/customer-contact-bff.test.ts` — keeps the real BFF fixture aligned
  with the expanded canonical Customer result.

### Validation

- `mise exec -- pnpm --filter @app/crm exec node --test tests/unit/customer-contact-action-contract.test.ts` — passed (6 tests).
- `mise exec -- pnpm --filter @app/crm exec node --test tests/unit/schema-contract.test.ts tests/unit/customer-contact-persistence.service.test.ts` — passed (9 tests).
- `mise exec -- pnpm --filter @app/crm exec node --test tests/integration/database-boundary.test.ts` — passed against a disposable migrated PostgreSQL database.
- `mise exec -- pnpm --filter @app/crm db:verify` — passed against a disposable migrated PostgreSQL database; verified 2 typed CRM tables.
- `mise exec -- pnpm --filter @app/crm test:unit` — passed (23 tests).
- `mise exec -- pnpm --filter @app/crm test:integration` — passed (3 tests) against a disposable migrated PostgreSQL database.
- `mise exec -- pnpm --filter @app/crm typecheck` — passed after bootstrapping fresh-worktree dependency declarations.
- `mise exec -- pnpm database-access:check` — passed.
- `mise exec -- pnpm check` — passed, including format, lint, Action tests, workspace typecheck, API,
  database, module-entrypoint, contract, and performance gates.

### Review

- Re-read `../AGENTS.md`, `AGENTS.md`, `docs/architecture/MICROVERTICALS.md`,
  `docs/architecture/ACTIONS.md`, `docs/architecture/ERRORS.md`,
  `docs/architecture/ULTRAMODERN.md`, `docs/architecture/DATABASE.md`, and
  `docs/architecture/DATA_ACCESS.md`; no generator, Action, Effect error, data-access, or deployment
  seam was bypassed.
- Fixed review findings by making `db:verify` touch every typed CRM column and explicitly proving
  multiple null IČOs in one tenant. Also fixed the formatter and lint findings surfaced by the gate.
- DIČ uses one trimmed non-empty 20-character bound consistently in the contract and database; the
  related ARES schema publishes no maximum, and no DIČ/IČO coupling was introduced.
- No browser review or screenshots were applicable because this change has no user-facing UI.

### Deviations and Follow-ups

- None.
