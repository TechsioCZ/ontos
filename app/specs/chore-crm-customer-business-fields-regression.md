---
type: chore
status: done
created: 2026-08-17
---

# Chore: CRM Customer business fields cross-cutting regression gate

## Chore Description

Complete and reconcile the Czech/English copy, fixtures, architecture assertions, migration checks,
and end-to-end regression coverage after the ten Customer/ARES feature specs are implemented. This
is a final verification task, not a place to defer behavior-specific tests already required by each
feature.

## Relevant Files

Use these files to accomplish the chore:

- `verticals/crm/locales/cs/crm.json` — final Czech catalog.
- `verticals/crm/locales/en/crm.json` — final English catalog.
- `verticals/crm/tests/unit/` — schema, Action, API, and architecture contracts.
- `verticals/crm/tests/components/` — loader, form, create, edit, detail, and list regressions.
- `verticals/crm/tests/integration/` — database, Action, Read, and BFF proofs.
- `verticals/crm/tests/support/e2e-customers.ts` — complete Customer fixtures and helpers.
- `verticals/crm/scripts/verify-db-schema.mts` — physical CRM schema verification.
- `docs/integrations/ares.md` — operational assumptions and upstream field scope.
- `package.json` — repository-wide validation commands.
- `verticals/crm/package.json` — focused CRM validation commands.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Reconcile the completed feature set

- [x] Confirm the ten prerequisite specs are implemented in dependency order and every Customer representation agrees on exactly `name`, `ico`, `dic`, `legalFormCode`, `establishedOn`, and `dissolvedOn`.
- [x] Search production code, schemas, migrations, contracts, UI, and fixtures for accidental `legalName`, `aresLoadedAt`, source/update metadata, nested ARES data, Customer address fields/tables, CZ-NACE, or activity persistence and remove only scope violations introduced by this feature set.

### 2. Complete locale and fixture parity

- [x] Compare Czech/English CRM catalogs structurally and ensure every added label, validation, lookup state, conflict, retry, success, and accessibility string exists in both languages with no user-facing TSX strings.
- [x] Update shared Customer fixtures/builders to require explicit complete or nullable business fields, preserving leading-zero IČO and date-only representations.

### 3. Close cross-feature regression gaps

- [x] Add only missing cross-flow tests not already owned by a feature spec: manual create without ARES, ARES-prefilled create followed by edit/detail/list, duplicate-IČO conflict, archive/unarchive complete DTO, tenant isolation, and null clearing.
- [x] Add architecture assertions that the browser uses only generated Effect clients, ARES is server-side, lookup is a generated Read rather than an Action, presentation components contain no BFF/fetch imports, and no address/metadata/activity scope leaked.

### 4. Verify operational and migration boundaries

- [x] Run CRM schema verification against a migrated test database and confirm only the existing `customers` table changed.
- [x] Review `docs/integrations/ares.md` against the implemented adapter for endpoint, field mapping, timeouts/retries/cache, error handling, and operating-limit consistency; update documentation only if implementation decisions intentionally differ.

### 5. Run all validation commands

- [x] Execute every command in `Validation Commands`, resolve regressions within the completed feature scope, and record any unrelated pre-existing failure separately rather than weakening a check.

## Testing Strategy

Behavior-specific unit, component, and integration tests remain beside their owning changes. This
chore adds only cross-flow and architecture regression coverage, then runs the complete CRM and
repository gates to catch mismatched fixtures, locales, generated contracts, schema output, or
deployment builds.

## Acceptance Criteria

- [x] All Customer layers use one exact flat business-field model.
- [x] Czech and English copy and complete/null fixtures are structurally aligned.
- [x] Cross-flow tests prove manual and ARES-assisted Customer lifecycles.
- [x] Architecture checks prove the generated Read/BFF and Action boundaries.
- [x] No address, ARES metadata, CZ-NACE, or activity scope is present.
- [x] Every validation command succeeds.

## Validation Commands

Execute every command to validate the chore with zero regressions.

- `mise exec -- pnpm --filter @app/crm db:verify` — verify the final CRM physical schema.
- `mise exec -- pnpm --filter @app/crm test:unit` — run final CRM schema, Action, API, and architecture tests.
- `mise exec -- pnpm --filter @app/crm test:component` — run loader/form/create/edit/detail/list regressions.
- `mise exec -- pnpm --filter @app/crm test:integration` — run database, Read, Action, BFF, and cross-flow proofs.
- `mise exec -- pnpm --filter @app/crm typecheck` — validate final CRM types.
- `mise exec -- pnpm i18n:boundaries` — validate locale ownership and parity.
- `mise exec -- pnpm api:check` — validate strict API and browser boundaries.
- `mise exec -- pnpm database-access:check` — validate CRM database ownership.
- `mise exec -- pnpm module-entrypoints:check` — validate generated API/page entrypoints.
- `mise exec -- pnpm check:module-contracts` — validate serialized CRM contributions.
- `mise exec -- pnpm --filter @app/crm build` — build the final independently deployable CRM vertical.
- `mise exec -- pnpm check` — Run the final repository quality gate.

## Review Checklist

- [x] Every acceptance criterion is satisfied.
- [x] The diff complies with `../AGENTS.md`, `AGENTS.md`, and all relevant referenced guidance.
- [x] Behavioral changes have tests.
- [x] No unrelated changes, dead code, or accidental API expansion remain.

## Notes

- Depends on all ten feature specs in this series and must be implemented last.
- This task must not become a substitute for tests specified alongside each behavior.

## Implementation Evidence

### Summary

- Reconciled all ten completed Customer/ARES specifications into one cross-cutting regression gate
  for the canonical flat Customer fields, Czech/English copy, complete/null fixtures, browser/BFF
  boundaries, ARES server ownership, and excluded address/metadata/activity scope.
- Extended the existing governed integration scenario only for the missing ARES-prefill followed by
  edit/detail/list flow; the already-owned manual-create, duplicate-IČO, archive/unarchive, tenant,
  and null-clearing proofs remain in their feature tests.
- Strengthened physical schema verification to reject any unexpected CRM Customer/Contact column,
  and corrected the contact-detail route boundary exposed by a clean final typecheck.

### Changed Files

- Seven files changed with 498 insertions and 24 deletions: five tracked implementation,
  documentation, fixture, and integration-test files plus one new architecture regression test and
  this completed specification.

### Tests Written or Updated

- `verticals/crm/tests/unit/customer-business-fields-regression.test.ts` — proves locale/fixture
  parity, leading-zero/date-only fixtures, generated Effect-client browser access, server-only ARES,
  generated Read ownership, presentation isolation, and absence of excluded business scope.
- `verticals/crm/tests/integration/customer-contact-operations.test.ts` — extends the governed
  runtime proof through leading-zero ARES lookup, reviewed create, edit, detail, and list parity.
- `verticals/crm/tests/support/e2e-customers.ts` — makes complete and nullable business fields
  explicit in both typed fixtures and database seed SQL.
- `verticals/crm/scripts/verify-db-schema.mts` — validates the exact physical CRM column inventory.
- Existing component tests cover the contact-detail route behavior; typecheck and the production
  build prove its corrected router-component contract.

### Validation

- `mise exec -- pnpm --filter @app/crm db:verify` — passed against a migrated isolated PostgreSQL 17 database.
- `mise exec -- pnpm --filter @app/crm test:unit` — passed, 49 tests.
- `mise exec -- pnpm --filter @app/crm test:component` — passed, 10 files and 236 tests.
- `mise exec -- pnpm --filter @app/crm test:integration` — passed, 4 tests.
- `mise exec -- pnpm --filter @app/crm typecheck` — passed.
- `mise exec -- pnpm i18n:boundaries` — passed.
- `mise exec -- pnpm api:check` — passed.
- `mise exec -- pnpm database-access:check` — passed.
- `mise exec -- pnpm module-entrypoints:check` — passed.
- `mise exec -- pnpm check:module-contracts` — passed.
- `GIT_CEILING_DIRECTORIES=<worktree> ULTRAMODERN_SOURCE_REVISION=5b43725383fdb1362caf7ae17a063123645aaab5 mise exec -- pnpm --filter @app/crm build` — passed, including TypeScript, federated types, CRM client/server bundles, module/public-surface artifacts, and Node deploy output.
- `mise exec -- pnpm check` — passed after review fixes.

### Review

- Re-read and reviewed the final diff against `../AGENTS.md`, `AGENTS.md`, the full specification,
  `MICROVERTICALS.md`, `ACTIONS.md`, `ERRORS.md`, `DATABASE.md`, `DATA_ACCESS.md`,
  `MODULE_ENTRYPOINTS.md`, `MODULE_MANIFESTS.md`, `ULTRAMODERN.md`, `FRONTEND.md`, and the ARES
  integration guidance.
- Fixed the review findings: lint-safe parallel architecture scans, exact schema-column validation,
  an internally consistent exact-eight-digit ARES policy, and a prop-free default contact-detail
  route export. The final diff has no remaining blocker, dead code, unrelated change, boundary
  violation, accidental API expansion, or untested behavior.
- No browser screenshot was retained because this chore changes regression infrastructure and a
  router boundary without changing the rendered UI; deterministic component tests and the final
  production build provide the relevant evidence.

### Deviations and Follow-ups

- A fresh worktree required dependency installation, database migration, and no-check declaration
  materialization for referenced packages before the exact CRM package typecheck could run. The
  final exact command passed without weakening its checks.
- The literal dirty-worktree build compiled successfully but its release-envelope guard correctly
  rejected `sourceRevision "workspace"`; the same final source passed with the immutable base revision.
- No product or architecture follow-up remains.
