---
type: chore
status: in_progress
created: 2026-09-01
---

# Chore: Rename the CRM MicroVertical to Contacts

## Chore Description

Rename the existing CRM MicroVertical to Contacts across every current application, deployment,
database, route, contract, translation, test, and documentation surface without changing its
Customer and Contact behavior. This is a coordinated identity migration, not a second module and
not a rewrite: the independently deployable MicroVertical seam, generated Effect BFF client,
governed read/Action boundaries, tenant state, PostgreSQL data, SpiceDB access, and user-visible
states must survive intact.

The target naming contract is:

| Surface                     | Current                                         | Target                                                         |
| --------------------------- | ----------------------------------------------- | -------------------------------------------------------------- |
| Display name                | `CRM` / `Crm`                                   | `Contacts`                                                     |
| Deployment/topology `appId` | `crm`                                           | `contacts`                                                     |
| Module Contract Identity    | `crm.core`                                      | `contacts.core`                                                |
| Workspace path/package      | `verticals/crm`, `@app/crm`                     | `verticals/contacts`, `@app/contacts`                          |
| Shell and owner routes      | `/crm/**`                                       | `/contacts/**`                                                 |
| BFF prefix/base             | `/crm-api/crm/**`                               | `/contacts-api/contacts/**`                                    |
| Module Federation           | `crm`, `verticalCrm`, `PageCrm`                 | `contacts`, `verticalContacts`, `PageContacts`                 |
| Locale namespace/catalog    | `crm`, `crm.json`                               | `contacts`, `contacts.json`                                    |
| PostgreSQL ownership        | schema/object prefix/journal `crm`              | schema/object prefix/journal `contacts`                        |
| Environment/CI names        | `*_CRM_*`, `*_URL_CRM`, `ZEROPS_CRM_SERVICE_ID` | `*_CONTACTS_*`, `*_URL_CONTACTS`, `ZEROPS_CONTACTS_SERVICE_ID` |
| Zerops/Cloudflare identity  | `crm`, `app-crm`                                | `contacts`, `app-contacts`                                     |

The migration must preserve existing Customer and Contact rows, tenant module state, authorization,
and structured Core references. It must fail closed on ambiguous mixed CRM/Contacts database or
authorization state. Historical specifications, ADRs, and already-applied Drizzle migrations remain
immutable provenance and are the only allowed legacy-name exceptions; new compatibility migrations
may mention the old identifiers only where required to recognize and migrate them.

## Relevant Files

Use these files to accomplish the chore:

- `verticals/crm/**` — the complete owner-local MicroVertical to move to `verticals/contacts/**`, including package identity, Effect contracts/clients, Actions, governed reads, routes, features, persistence, Module Federation, translations, tests, and generated module registration.
- `verticals/crm/package.json`, `modern.config.ts`, `module-federation.config.ts`, `backend-federation.config.ts`, and `api/backend-federation.ts` — deployment, BFF, Cloudflare, Zephyr, backend-federation, public URL, port, readiness, and remote identities.
- `verticals/crm/vertical.manifest.ts` and `vertical.registration.ts` — generated module/deployment markers, `contacts.core` manifest identity, renamed Contacts page/component keys, canonical routes, and private lazy registrations.
- `verticals/crm/src/actions/**`, `src/api/**`, `shared/api.ts`, `shared/apis/**`, and `api/**` — Action/read/Policy/evidence keys, tagged error and Problem Details names/codes/types, API paths, spans, CORS names, and generated Effect client symbols.
- `verticals/crm/src/routes/**`, `src/federation/**`, `src/i18n/resources.ts`, and `locales/{cs,en}/**` — owner route paths, page/component names, i18n namespace and catalog filenames, English `Contacts` copy, Czech `Kontakty` copy, and every loading/empty/error/forbidden/read-only/retry state that mentions CRM.
- `verticals/crm/src/db/**`, `drizzle.config.ts`, `drizzle/**`, and `scripts/verify-db-schema.mts` — PostgreSQL schema, table bindings, object identifiers, RLS policies, migration journal, upgrade migration, and exact database verification.
- `apps/shell-super-app/src/routes/[lang]/crm/**`, `src/routes/ultramodern-route-metadata.ts`, `src/api/vertical-clients.ts`, `src/modern-app-env.d.ts`, `module-federation.config.ts`, `package.json`, `tsconfig.json`, and Shell tests — localized Contacts URLs, lazy remote allowlist, generated route metadata/types, package dependency, gateway audience, and browser/runtime expectations.
- `topology/reference-topology.json`, `topology/ownership.json`, `topology/local-overlays/development.json`, and `.modernjs/ultramodern.json` — authoritative app ID, package/path, delivery-unit, public URL, environment, API, worker, manifest, smoke, and ownership metadata.
- `package.json`, `pnpm-lock.yaml`, and `tsconfig.json` — workspace filters, database command ordering, package links, and project references.
- `packages/core-runtime/src/install/stage-context-bootstrap.ts`, `packages/core-runtime/drizzle/**`, and relevant Core database tests — persisted module identity migration and stage activation/access configuration.
- `scripts/initialize-local-development.mts`, `scripts/run-zerops-migrator.mjs`, `scripts/postgres/bootstrap-runtime-role.mts`, `scripts/verify-application-db-schema.mts`, and their tests — local activation, owner migration ordering, schema grants, journal inventory, and owner verification imports.
- `scripts/scaffolding/cli.mts`, `scripts/scaffolding/tests/scaffold-generators.test.mts`, and `scripts/validate-ultramodern-workspace.mts` — current examples/fixtures plus repository contracts that must recognize Contacts and reject unintended live CRM remnants.
- `zerops.yaml` and `../.github/workflows/ultramodern-workspace-gates.yml` — Contacts setup/service deployment, materialization, readiness, change impact, logs, public subdomain, and `ZEROPS_CONTACTS_SERVICE_ID` wiring.
- `README.md`, `DEVELOPMENT.md`, `docs/architecture/{COMMERCE_APPLICATIONS,DEPLOYMENT,MODULE_ENTRYPOINTS,MODULE_MANIFESTS}.md`, `docs/integrations/ares.md`, and `../docs/PRODUCT.md` — current guidance and product language that name the live CRM implementation.

### New Files

- `verticals/contacts/**` — rename destination for the complete existing MicroVertical; Git history should record moves rather than a duplicate CRM/Contacts implementation.
- `verticals/contacts/drizzle/` next custom migration and snapshot/journal entry — data-preserving PostgreSQL schema/object rename from CRM to Contacts.
- `verticals/contacts/scripts/prepare-contacts-migration.mts` — idempotent, fail-closed handoff of the existing Drizzle journal name before the normal Contacts migration chain runs.
- `packages/core-runtime/drizzle/` next custom migration and snapshot/journal entry — migrate persisted structured `crm.core` and `crm.core.*` identities to `contacts.core` and `contacts.core.*` without changing payloads or unrelated records.
- `scripts/migrate-contacts-authorization.mts` — bounded, idempotent SpiceDB relationship migration for module access from `crm.core` to `contacts.core`, with prepare/verify/finalize modes for the coordinated cutover.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Lock the rename contract and stale-name boundary

- [x] Add focused contract coverage in `scripts/validate-ultramodern-workspace.mts` and existing validator/scaffolding tests for the complete target mapping above. Reject `crm`, `CRM`, and `Crm` in active application, topology, deployment, translation, and documentation surfaces except an explicit narrow allowlist for historical ADR/spec files, immutable already-applied Drizzle artifacts, and the new compatibility migrations.
- [x] Update neutral Codesmith help/examples and test fixtures from CRM to Contacts (or another neutral fixture where the example is not about the live module) without adding a rename generator or regenerating unrelated business artifacts.

### 2. Move and rename the MicroVertical ownership surface

- [x] Move `verticals/crm` to `verticals/contacts`; rename `@app/crm` to `@app/contacts`, the app ID to `contacts`, the module ID to `contacts.core`, the domain/namespace to `contacts`, and every `Crm*`/`crm*` owner-local symbol or filename to `Contacts*`/`contacts*` where it describes the MicroVertical rather than the Customer/Contact domain object.
- [x] Rename `src/api/crm-client.ts`, `src/crm-query-client.ts`, `src/federation/page-crm.tsx`, `tests/components/crm-page.test.tsx`, locale catalog filenames, and all imports/exports; preserve Customer- and Contact-specific filenames and public types whose names do not contain CRM.
- [x] Update package exports, scripts, TypeScript references, CSS/Tailwind namespace, Modern build/cache IDs, Cloudflare worker, Zephyr metadata, backend federation, CORS symbols, readiness metadata, and generated build markers. Update package-lock links through the repository-managed install rather than hand-editing dependency resolution data.
- [x] Update package unit/component/integration tests beside these changes to assert only the Contacts package/app/remote/namespace identities and to prove the Effect client remains the sole frontend BFF seam.

### 3. Rename module contracts, governed operations, and public protocol identity

- [x] Update `vertical.manifest.ts` and `vertical.registration.ts` generator markers and exported names to Contacts, changing every module, entrypoint, contribution, component, Action, read, Policy/evidence, and owner key from `crm.core...` to `contacts.core...`; rename `page-crm`/`CrmPage` to `page-contacts`/`ContactsPage` while retaining the existing Customer and Contact capabilities.
- [x] Rename the public Effect API/client family (`CrmApi`, `CrmProblem`, `CrmPersistenceUnavailable`, related tagged errors/options/markers/readiness values, operation contexts, and client factories) to Contacts equivalents. Change `/crm-api` and nested `/crm/**` endpoints, OpenAPI operation IDs, Problem Details types, stable error codes, trace/span names, and log messages to Contacts equivalents without widening any success/error union.
- [x] Update every Action/read descriptor, target, evidence key, query-label prefix, Action gateway audience, server verifier, and BFF adapter. Preserve the existing typed errors, Core-owned Action/read lifecycles, owner-local services, idempotency behavior, authentication, authorization, and fail-closed mappings.
- [x] Update contract, Action, read, transport, runtime, and gateway tests in the same step, including explicit assertions that no public Contacts payload, error, or OpenAPI surface exposes a CRM identifier.

### 4. Rename owner and Shell routes, federation, and navigation

- [x] Move both owner and Shell filesystem route trees from `[lang]/crm/**` to `[lang]/contacts/**`; change canonical/localized URLs to `/contacts/**`, route IDs/metadata/title keys to Contacts, and all Customer/Contact navigation targets, redirects, and return links to the new paths.
- [x] Rename the Module Federation remote and exposes to `contacts`, `verticalContacts`, and `PageContacts`; update Shell declarations, generated lazy-client allowlists, manifest component keys, route loaders, route metadata, router output, installed-vertical expectations, and gateway audience requests.
- [x] Update Shell unit/integration/e2e tests for English and Czech Contacts URLs, exact parameter forwarding, module-state outcomes, forbidden/unavailable/retry states, login/logout navigation, Customer and Contact CRUD journeys, and absence of unexpected browser errors. Do not retain `/crm` aliases in the final application; the cutover procedure must stop old traffic rather than leave an ungoverned duplicate route.

### 5. Rename all English and Czech translation surfaces

- [x] Rename the i18n namespace and catalogs from `crm`/`crm.json` to `contacts`/`contacts.json`, update flattened federated resources and default namespaces, and change all title/description/role/read-only/error text that names CRM. Use `Contacts` in English and `Kontakty` in Czech while leaving the established Customer/Contact terminology otherwise intact.
- [x] Update locale-boundary and component tests to prove key parity across `en` and `cs`, localized SSR/federation resolution, accessible labels, and every existing loading, empty, validation, conflict, forbidden, unavailable, and retry state after the namespace move.

### 6. Add the data-preserving Contacts PostgreSQL migration

- [x] Change the current typed schema and database symbols from CRM to Contacts, including PostgreSQL schema `contacts`, constraint/index/policy prefixes, RLS policy names, catalog constants, Effect database service names, Context tags, error tags/messages, and journal `drizzle.__drizzle_migrations_contacts`.
- [x] Before generating the custom migration, retain the already-applied `0000`/`0001` SQL and snapshots unchanged as historical upgrade provenance. Add `prepare-contacts-migration.mts` to atomically rename only `drizzle.__drizzle_migrations_crm` to `__drizzle_migrations_contacts` when the old journal exists; make fresh/no-op, resumable, already-migrated, and conflicting-both-journals states explicit and tested.
- [x] Run the Contacts Drizzle custom-migration command through `mise exec -- pnpm` with `--custom --name rename-crm-database-identity`, then author the generated next migration to rename schema `crm` to `contacts` and rename every live `crm_*` constraint, index, foreign key, and RLS policy to `contacts_*`. The migration must preserve table OIDs, rows, timestamps, keys, RLS enforcement, owners, and grants and must not copy/recreate Customer or Contact data.
- [x] Wire the journal handoff immediately before Contacts `drizzle-kit migrate` in both local and Zerops migration paths; update runtime-role grants, exact owner/root verifiers, schema inventories, journal inventories, and tests.
- [x] Add database upgrade coverage that starts from the committed CRM `0000`/`0001` state with representative active/archived Customers and Contacts, runs the new path twice, and proves row/ID/timestamp preservation, foreign-key behavior, forced RLS, tenant isolation, runtime least privilege, exact Contacts-only schema/journal/object inventories, fresh-install success, and fail-closed ambiguous-state handling.

### 7. Migrate Core and SpiceDB module identity safely

- [x] Generate a Core custom migration through `mise exec -- pnpm` with `--custom --name rename-crm-module-identity`. Update exact structured identity columns that can contain the old module/action prefixes, including tenant module state/change records, Action invocation keys/targets, audit/data-access module fields, evidence Policy keys, domain/outbox producer/subject/consumer keys, media/evidence/search module references, and other schema-backed module-key fields discovered by the migration test. Do not rewrite arbitrary JSON payloads, hashes, free-form evidence, or unrelated historical text.
- [x] Preserve UUIDs, tenant scope, lifecycle state, `lastChangeId`, Action idempotency uniqueness, evidence linkage, event sequence, outbox linkage, and timestamps. Abort on mixed old/new rows that would collide instead of merging silently; add focused Core migration tests covering populated state, historical references, idempotent rerun, collision failure, and zero changes to unrelated modules.
- [x] Add the bounded SpiceDB migration to create/verify `contacts.core` module access relationships before removing their exact `crm.core` counterparts. It must use the existing typed Authzed client/configuration, operate only on relationships derived from authoritative tenant/legal-entity/principal context, be resumable, log no secret or unbounded identifiers, prove representative permissions before cleanup, and fail closed on partial/ambiguous state.
- [x] Update local and stage initialization plus their tests to activate only the Contacts topology/manifest identity and to create Contacts module-access relationships on fresh environments. Do not turn stage bootstrap into the general migration mechanism.

### 8. Rename topology, workspace, generators, and current documentation

- [x] Update the reference topology, ownership map, development overlay, `.modernjs` provenance, workspace scripts, package lock, TypeScript project references, build/materialization helpers, public-surface/proof inputs, backend federation, performance budgets, change-impact rules, and validation fixtures from CRM to Contacts. Keep topology as the single delivery inventory.
- [x] Update all active `README.md`, `DEVELOPMENT.md`, architecture examples, ARES integration guidance, product text, and current comments from CRM to Contacts or to neutral MicroVertical wording. Do not rewrite completed specifications or accepted historical ADR text; if an ADR or immutable migration needs current clarification, add a new current note outside the historical artifact.
- [x] Extend the repository validation test from task 1 so the final active tree cannot regress to CRM package paths, symbols, URLs, API/problem identifiers, translation keys, topology values, deployment variables, database object names, or current documentation language.

### 9. Rename CI, Zerops, and release configuration

- [x] Update `zerops.yaml` and the root GitHub workflow to build/deploy `contacts`, materialize `@app/contacts` from `verticals/contacts`, probe `/contacts-api/contacts/readiness`, set `VERTICAL_CONTACTS_PORT` and `ULTRAMODERN_ZEROPS_SERVICE=contacts`, consume `ZEROPS_CONTACTS_SERVICE_ID`, collect Contacts logs, and enable the Contacts public subdomain. Preserve provider-before-Shell ordering and migrator/database dependencies.
- [ ] Prepare the external configuration cutover: provision or rename the Zerops service to `contacts`; replace project variable `ULTRAMODERN_PUBLIC_URL_CRM` with `ULTRAMODERN_PUBLIC_URL_CONTACTS`; replace the GitHub repository variable with `ZEROPS_CONTACTS_SERVICE_ID`; retain the existing `DATABASE_URL`, `SPICEDB_PRESHARED_KEY`, and `ONTOS_GATEWAY_PUBLIC_JWKS` secret values without printing or copying them into source; update Cloudflare/Zephyr variables if those execution surfaces are enabled.
- [ ] Execute the identity/database cutover under the environment deployment lock with old CRM writes and Shell traffic stopped: record last-known-good artifacts, prepare the Contacts service dark, run Core/Auth/Contacts migrations and grants, migrate/verify SpiceDB access, deploy/probe Contacts, deploy Shell, run the authenticated distributed smoke suite, then remove the old CRM service/variables/relationships only after success. Roll back application artifacts without reversing additive migration work; do not report success before the Contacts manifest, remote chunks, localized routes, authorized BFF read/write, database verification, and browser journey pass.

### 10. Run the complete validation suite

- [x] Execute every command in `Validation Commands` from `app/`, review the final rename guard for only approved historical/migration exceptions, inspect the final diff for move detection and accidental generated churn, and confirm no CRM route, package, live identifier, environment variable, service, or current translated label remains.

## Testing Strategy

Update existing unit, component, integration, database, contract, topology, and browser tests alongside
each renamed surface. Add dedicated upgrade tests for the legacy Drizzle journal/schema, Core module
identity rows, and SpiceDB relationships; run each migration twice and cover fresh, legacy,
already-migrated, partial, and conflicting states. Existing Customer/Contact CRUD, ARES lookup,
archival, authentication, module gating, legal-entity/tenant isolation, forbidden, unavailable,
validation, conflict, retry, accessibility, localization, responsive layout, Module Federation,
and deployment-readiness behaviors must remain unchanged except for Contacts naming and URLs.

## Acceptance Criteria

- [x] The only live MicroVertical directory/package is `verticals/contacts` / `@app/contacts`; no duplicate CRM implementation exists.
- [x] The authoritative deployment and module identities are `contacts` and `contacts.core`, and all Action/read/entrypoint/contribution keys use the Contacts prefix.
- [x] English UI uses `Contacts`, Czech UI uses `Kontakty`, the i18n namespace/catalog is `contacts`, and both locale catalogs have identical keys.
- [x] All canonical and localized Shell/owner paths use `/contacts/**`; all BFF/OpenAPI/readiness paths use `/contacts-api/contacts/**`; no final `/crm` alias remains.
- [x] Module Federation, generated lazy clients/types, topology, gateway audience, backend federation, Cloudflare, Zephyr, and public URL configuration consistently use Contacts.
- [x] Existing Customer and Contact rows, IDs, timestamps, archive state, foreign keys, forced RLS, ownership, and least-privilege access survive the PostgreSQL migration.
- [x] PostgreSQL exposes schema `contacts`, journal `__drizzle_migrations_contacts`, and only `contacts_*` live object names; fresh and CRM-upgrade databases both verify exactly.
- [x] Existing tenant module lifecycle state and structured Core module/action/evidence/outbox/resource references migrate to Contacts without changing unrelated modules or breaking uniqueness/linkage.
- [x] SpiceDB grants equivalent authorized Contacts access before legacy CRM relationships are removed, and representative denied/allowed permissions are verified.
- [x] Local/stage initialization installs and activates Contacts only on fresh environments.
- [ ] Zerops and GitHub configuration use the Contacts service/public URL/service-ID names, required secrets stay secret, and provider-before-Shell deployment ordering remains enforced.
- [x] Customer/Contact CRUD, ARES, auth, tenant/legal-entity isolation, module state, typed errors, localized SSR, responsive UI, and authenticated e2e journeys pass under Contacts URLs.
- [x] Active code/current documentation contains no unapproved `crm`, `CRM`, or `Crm` occurrence; immutable historical ADR/spec/migration provenance and bounded compatibility migrations are the only documented exceptions.

## Validation Commands

Execute every command to validate the chore with zero regressions.

- `mise exec -- pnpm install --frozen-lockfile` — Verify the renamed workspace/package graph and lockfile are reproducible.
- `mise exec -- pnpm --filter @app/core-runtime db:test` — Validate the Core identity migration and preserved governed runtime behavior.
- `mise exec -- pnpm --filter @app/contacts test:unit` — Validate Contacts domain, contract, Action, read, persistence, CORS, and database units.
- `mise exec -- pnpm --filter @app/contacts test:integration` — Validate Contacts BFF, database, Action, ARES, tenant isolation, and migration integration.
- `mise exec -- pnpm --filter @app/contacts test:component` — Validate renamed Contacts pages, translations, and UI states.
- `mise exec -- pnpm --filter @app/shell-super-app test:unit` — Validate Shell routes, loaders, generated remote clients, module catalog, and Contacts navigation.
- `mise exec -- pnpm --filter @app/shell-super-app test:integration` — Validate Shell/module contract and federated i18n runtime integration.
- `mise exec -- pnpm db:migrate` — Exercise the complete ordered Core/Auth/Contacts migration path on the prepared test database.
- `mise exec -- pnpm db:verify` — Exact-match schemas, journals, grants, RLS, constraints, and owner verifiers after migration.
- `mise exec -- pnpm --filter @app/shell-super-app test:e2e` — Exercise authenticated English/Czech Contacts navigation and Customer/Contact journeys.
- `mise exec -- pnpm check:module-contracts` — Validate Contacts module identity, deployment contract, manifest, and registration consistency.
- `mise exec -- pnpm module-entrypoints:check` — Validate all renamed governed entrypoints and lazy owner boundaries.
- `mise exec -- pnpm i18n:boundaries` — Validate Contacts namespace ownership and locale parity.
- `mise exec -- pnpm contract:check` — Validate topology, workspace, deployment, database, API, and stale-name contracts.
- `mise exec -- pnpm build` — Build the Contacts remote and Shell with Module Federation/type outputs.
- `mise exec -- pnpm check` — Run the final repository quality gate.

## Review Checklist

- [ ] Every acceptance criterion is satisfied.
- [x] The diff complies with `../AGENTS.md`, `AGENTS.md`, and all relevant referenced guidance.
- [x] Behavioral changes have tests.
- [x] No unrelated changes, dead code, or accidental API expansion remain.

## Notes

- The request explicitly includes code names and the MicroVertical itself, so this plan treats the rename as an approved one-time migration of both topology `appId` and stable Module Contract Identity. Because those values normally remain stable, implementation and rollout must be reviewed as an identity migration rather than a cosmetic refactor.
- Existing `0000`/`0001` CRM Drizzle SQL/snapshots, completed specifications, and historical ADRs are immutable provenance. They are intentionally excluded from the zero-CRM-text rule; rewriting them would make upgrades unverifiable and falsify decision/migration history.
- The final state intentionally has no `/crm` redirect or long-lived runtime alias. A deployment lock and coordinated maintenance cutover prevent old and new writers from overlapping while the PostgreSQL schema, JWT audience, module identity, and service identity change together.
- The current checkout is `main`, matches `main` exactly, and was clean before this plan was created. The local pnpm install metadata reported a stale workspace structure during research, so implementation must run the repository-managed install after the package/path rename before relying on pnpm validation commands.

## Implementation Evidence

### Summary

- Renamed the live MicroVertical, package, contracts, governed operations, routes, federation,
  translations, topology, deployment configuration, and current documentation to Contacts.
- Added data-preserving PostgreSQL and structured Core identity migrations, including exact journal,
  schema, database-object, and runtime-role verification.
- Added a bounded prepare/verify/finalize SpiceDB migration and changed fresh local, stage, and
  development-bootstrap authorization to `contacts.core`.
- Added an active-tree legacy-name guard while retaining byte-identical historical `0000`/`0001`
  migration provenance.

### Changed Files

- 259 paths appear in the final staged diff, including 10 new migration, specification, script, and
  test files across the root workflow, Shell, Core, Contacts, topology, deployment configuration,
  and current documentation. The final line totals are recorded in the implementation report.

### Tests Written or Updated

- `packages/core-runtime/tests/integration/contacts-identity-migration.test.ts` — proves populated
  structured identity migration, UUID/timestamp/payload preservation, rerun behavior, unrelated-row
  isolation, and collision failure.
- `scripts/tests/migrate-contacts-authorization.test.mts` — proves fresh, legacy-only, prepared,
  finalized, divergent, and partial authorization migration planning.
- `scripts/tests/initialize-local-development.test.mts` — proves Contacts-only activation and that a
  migrated module-state UUID is preserved while identity collisions fail closed.
- `packages/core-runtime/tests/unit/spicedb-database-bootstrap.test.ts` — proves fresh development
  authorization grants target only the encoded Contacts module-access object.
- `verticals/contacts/tests/unit/prepare-contacts-migration.test.ts` and
  `verticals/contacts/tests/unit/schema-contract.test.ts` — prove journal state classification,
  immutable historical provenance, and the data-preserving schema rename contract.
- Contacts unit/component/integration tests plus Shell unit/integration/e2e tests were renamed and
  updated for Contacts package, API, federation, route, gateway, and localized UI identities.

### Validation

- `mise exec -- pnpm install --frozen-lockfile` — passed.
- `mise exec -- pnpm --filter @app/core-runtime db:test` — passed, 243/243.
- `mise exec -- node --test packages/core-runtime/tests/integration/contacts-identity-migration.test.ts`
  — passed.
- `mise exec -- node --test scripts/tests/migrate-contacts-authorization.test.mts` — passed, 6/6.
- `mise exec -- node --test scripts/tests/initialize-local-development.test.mts` — passed, 6/6.
- `mise exec -- node --test packages/core-runtime/tests/unit/spicedb-database-bootstrap.test.ts` —
  passed, 4/4.
- `mise exec -- pnpm --filter @app/contacts test:unit` — passed, 53/53.
- `mise exec -- pnpm --filter @app/contacts test:integration` — passed, 4/4.
- `mise exec -- pnpm --filter @app/contacts test:component` — passed, 247/247.
- `mise exec -- pnpm --filter @app/shell-super-app test:unit` — passed, 173/173.
- `mise exec -- pnpm --filter @app/shell-super-app test:integration` — passed, 7/7.
- `mise exec -- pnpm db:migrate` — passed for the legacy-to-Contacts path and passed again as an
  already-migrated no-op.
- `mise exec -- pnpm db:verify` — passed with exact Core/Auth/Contacts schema, journal, table, owner,
  RLS, grant, constraint, and index inventories.
- `mise exec -- node scripts/migrate-contacts-authorization.mts prepare`, `verify`, and `finalize` —
  all passed against the local authoritative context; focused tests cover legacy and divergent
  relationship states.
- `mise exec -- pnpm local:initialize` — passed after the Core identity migration while preserving
  the existing tenant module-state UUID.
- `mise exec -- pnpm --filter @app/shell-super-app test:e2e` — passed, 32/32, including authenticated
  Contacts navigation, Customer/Contact CRUD/read journeys, localized login/logout, tenant switching,
  keyboard retry, and mobile layout coverage.
- `mise exec -- pnpm check:module-contracts` — passed.
- `mise exec -- pnpm module-entrypoints:check` — passed.
- `mise exec -- pnpm i18n:boundaries` — passed.
- `mise exec -- pnpm contract:check` — passed, including the active-tree stale-name guard.
- `mise exec -- pnpm build` — the literal local command correctly stopped at the promotable-envelope
  guard because its revision was `workspace`; rerunning with
  `ULTRAMODERN_SOURCE_REVISION=c7fb88eb33f91973d04fadc6e8ee2b5c28b61a8b` passed the full Contacts,
  Shell, Module Federation type, deploy-output, and performance build.
- `mise exec -- pnpm check` — passed completely after the final fixes.
- SHA-256 comparison of Contacts `0000`/`0001` SQL and snapshots against their CRM source paths —
  passed byte-for-byte.
- `git diff --check` — passed.

### Review

- Re-read `../AGENTS.md`, `AGENTS.md`, `README.md`, `DEVELOPMENT.md`, the routed architecture and
  integration documents named by this specification, and the complete specification before final
  review.
- Reviewed the status, diff check/stat, key migrations, authorization cutover, database bootstrap,
  generated route/federation identities, residual legacy-token inventory, and move detection.
- Fixed review findings in local module-state reconciliation and fresh SpiceDB bootstrap identity;
  reran focused tests, browser validation, database verification, and the complete quality gate.
- No screenshots were retained because this chore changes identity/copy/routes rather than visual
  design; Playwright directly verified the localized rendered Contacts surfaces and critical flows.

### Deviations and Follow-ups

- The external Zerops service/project-variable and GitHub repository-variable cutover, the
  deployment lock, dark Contacts deployment, distributed smoke test, and old-service removal require
  external environment authority and remain the post-merge rollout work.
- The code implementation and all local validation gates are complete. The plan remains
  `in_progress`, rather than `done`, until the two external cutover tasks and the external
  Zerops/GitHub acceptance criterion are completed.
