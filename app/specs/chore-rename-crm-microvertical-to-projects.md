---
type: chore
status: blocked
created: 2026-08-28
---

# Chore: Rename the CRM MicroVertical to Projects

## Chore Description

Rename the existing CRM MicroVertical and every live identity it owns to Projects without changing
its Customer, Contact, or ARES behavior. This is a cross-cutting identity migration, not a display-
name-only edit: the deployment slug becomes `projects`, the package becomes `@app/projects`, the
business module becomes `projects.core`, the route and API stems become `/projects` and
`/projects-api`, the source folder becomes `verticals/projects`, and code, generated contracts,
configuration, environment variables, localization namespaces, CSS prefixes, tests, topology,
deployment manifests, PostgreSQL schema/objects, and persisted module/action references follow the
same vocabulary.

Preserve Customer, Contact, ARES, tenant-isolation, authorization, and independent deployment
behavior in source and tests, but do not preserve deployed records or old runtime identities. The
developer has confirmed that every deployed database and authorization store may be erased. Perform
one clean cutover: remove the CRM deployment, rebuild PostgreSQL and SpiceDB from empty storage under
Projects, and make old routes, APIs, environment variables, package names, module IDs, schema names,
and authorization object IDs unsupported immediately. Do not implement Projects as a second business
module or add compatibility aliases that prolong the CRM identity.

Repository research found 141 tracked files under `verticals/crm`, 24 tracked Shell route files
under `apps/shell-super-app/src/routes/[lang]/crm`, and at least 145 non-spec tracked files with live
CRM identities. The relevant forms include `crm`, `CRM`, `Crm`, `crm.core`, `crm_*`, `crm-*`,
`@app/crm`, `verticalCrm`, `/crm`, `/crm-api`, `VERTICAL_CRM_*`, `ULTRAMODERN_*_CRM`,
`ZEPHYR_CRM_*`, the `crm` PostgreSQL schema, and the `__drizzle_migrations_crm` journal.

## Relevant Files

Use these files to accomplish the chore:

- `verticals/crm/**` — the complete current MicroVertical owner tree; rename it to
  `verticals/projects/**` and update every owner-local path, symbol, literal, contract, locale,
  generated owner, test, and migration reference.
- `verticals/crm/package.json` — package name, app/module metadata, build and contract-emission
  commands, exports, database scripts, and deployment identity.
- `verticals/crm/vertical.manifest.ts` and `verticals/crm/vertical.registration.ts` — Codesmith-owned
  manifest and private registration containing module, Action, API, page, component, navigation,
  route, and generated-owner identities.
- `verticals/crm/src/actions/*.action.ts` — eight typed Actions whose owner markers, module/action/
  entrypoint/policy keys, evidence query labels, error names, and tests must use Projects while
  preserving lifecycle behavior.
- `verticals/crm/shared/api.ts`, `verticals/crm/shared/apis/**`, `verticals/crm/api/**`, and
  `verticals/crm/src/api/**` — strict Effect HTTP schemas, generated BFF surface, problem/error
  types, operation contexts, CORS, readiness/OpenAPI paths, action gateway audience, and client
  symbols.
- `verticals/crm/src/routes/**`, `verticals/crm/src/federation/**`,
  `verticals/crm/src/features/**`, and `verticals/crm/src/crm-query-client.ts` — route URLs,
  component exports, Module Federation exposes, navigation, cache keys, Tailwind prefix use, and
  application/view-model integration.
- `verticals/crm/locales/{cs,en}/crm.json`, `verticals/crm/locales/{cs,en}/translation.json`, and
  `verticals/crm/src/i18n/resources.ts` — locale filenames, namespace, translated module name, and
  all user-facing read-only/unavailable copy. Czech should call the module `Projekty`; English
  should call it `Projects`.
- `verticals/crm/src/db/**`, `verticals/crm/drizzle.config.ts`, `verticals/crm/drizzle/**`, and
  `verticals/crm/scripts/verify-db-schema.mts` — typed owner schema, database service/type names,
  physical schema, constraints, indexes, RLS policies, owner journal, generated migrations, and
  exact catalog/grant verification.
- `verticals/crm/tests/**` — unit, component, integration, architecture, locale, and fixture coverage
  that must be renamed and continue proving unchanged Customer/Contact/ARES behavior.
- `apps/shell-super-app/src/routes/[lang]/crm/**` — the generated/gateway Shell route tree to rename
  to `[lang]/projects/**` while preserving route parameters and governed entrypoint loading.
- `apps/shell-super-app/src/api/vertical-clients.ts`,
  `apps/shell-super-app/module-federation.config.ts`, `apps/shell-super-app/package.json`,
  `apps/shell-super-app/src/modern-app-env.d.ts`, and `apps/shell-super-app/tsconfig.json` — Shell
  package dependency, remote alias, generated component loaders, environment contract, and project
  references.
- `apps/shell-super-app/src/routes/ultramodern-route-metadata.ts`,
  `apps/shell-super-app/src/modern-tanstack/index/router.gen.ts`, and
  `apps/shell-super-app/src/modern-tanstack/register.gen.d.ts` — generated Shell routing artifacts;
  regenerate them from renamed route metadata rather than treating them as independent sources.
- `apps/shell-super-app/tests/**` — Shell unit, integration, and browser fixtures asserting the
  deployment app ID, module/entrypoint keys, remote names, localized URLs, and Customer flows.
- `packages/core-runtime/src/install/stage-context-bootstrap.ts` — deterministic stage module state
  and SpiceDB `module_access` object identity currently tied to `crm.core`.
- `packages/core-runtime/tests/unit/{root-environment,shell-contribution,stage-context-bootstrap}.test.ts`
  — Core fixtures and installation assertions tied to CRM.
- `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, and `tsconfig.json` — aggregate database
  commands, package/importer identity, workspace project references, and final validation.
- `.env.example`, `.modernjs/ultramodern.json`, `docker-compose.yml`, and `zerops.yaml` — documented
  environment names, generated workspace provenance, local infrastructure, migration/deployment
  service identity, readiness probes, and runtime paths.
- `topology/ownership.json`, `topology/reference-topology.json`, and
  `topology/local-overlays/development.json` — authoritative owner, deployment, federation,
  backend/API, environment, port, worker, and public URL topology.
- `scripts/postgres/bootstrap-runtime-role.mts`, `scripts/run-zerops-migrator.mjs`, and
  `scripts/verify-application-db-schema.mts` — application schema grants, migration-owner sequence,
  and exact schema/journal verification.
- `scripts/validate-ultramodern-workspace.mts`, `scripts/scaffolding/cli.mts`, and
  `scripts/scaffolding/tests/scaffold-generators.test.mts` — generated workspace fixture and
  Codesmith discovery assumptions that currently hard-code the CRM exemplar.
- `README.md`, `docs/architecture/{ADDRESSING,DEPLOYMENT,MODULE_ENTRYPOINTS,MODULE_MANIFESTS}.md`, and
  `docs/integrations/ares.md` — app-local current documentation and examples that refer to this
  concrete MicroVertical.
- `specs/*crm*.md` and CRM references in other `specs/*.md` — completed implementation records to
  inventory deliberately. Preserve their historical facts and `status: done` evidence by default;
  update only references used as current instructions or prerequisites, and document the explicit
  historical allowlist in the final stale-name scan instead of mechanically rewriting history.

### New Files

- `verticals/projects/drizzle/` — freshly generated Projects migration baseline and metadata replacing
  the disposable CRM owner history.

## Cutover Contract Record

- Developer authorization was recorded on 2026-08-28 for destructive replacement of the OntOS CRM
  application state only: the shared application PostgreSQL database (including Core, Auth, CRM,
  journals, Action/audit/evidence, ResourceRefs, and fixtures), its SpiceDB authorization datastore,
  and the CRM/Shell deployment artifacts. It does not authorize deleting unrelated provider
  projects, services, databases, volumes, snapshots, or repositories.
- The local targets are Compose project `ontos`, PostgreSQL service/container `ontos-db`, database
  `ontos`, named volume `ontos_postgres_data`, and the in-memory `ontos-spicedb` datastore (which has
  no persistent volume). The stage targets are the Zerops `db` service database addressed by
  `db_hostname`/`db_port`/`db_dbName`, the PostgreSQL datastore addressed only by the `spicedb`
  service's `SPICEDB_DATASTORE_CONN_URI`, and the `crm` plus `shellsuperapp` deployment services.
  Operators must resolve those environment-scoped values and acquire the deployment lock immediately
  before deletion; the cutover fails closed if any resolved target is outside this documented set.
- The frozen rename matrix is: `crm` → `projects`, `Crm` → `Projects`, `CRM` → `Projects`,
  `@app/crm` → `@app/projects`, `crm.core` → `projects.core`, `verticalCrm` →
  `verticalProjects`, `/crm` → `/projects`, `/crm-api` → `/projects-api`, `crm_*`/`crm-*` →
  `projects_*`/`projects-*`, and every `*_CRM*` environment name → its `*_PROJECTS*`
  equivalent. Port `4101`, Customer/Contact names, ARES terminology, tenant/legal-entity scope, and
  business behavior remain unchanged.
- The cutover is intentionally incompatible: old `/crm` and `/crm-api` URLs return `404`; old
  environment variables are unsupported by the renamed topology/configuration; and no package,
  module, deployment, database, authorization, or journal alias is retained.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Record the destructive reset authorization and freeze the rename map

- [x] Record the developer decision that all deployed CRM PostgreSQL data, Core/Auth state,
      migration journals, Action/audit/evidence history, ResourceRefs, stage fixtures, and SpiceDB
      relationships are disposable for this rename. Resolve the exact environment volumes/databases
      and authorization datastore that operators must recreate; fail before deletion if a target is
      outside the documented OntOS deployment scope.
- [x] Freeze one mechanical rename matrix: `crm` to `projects`, `Crm` to `Projects`, `CRM` to
      `Projects`, `@app/crm` to `@app/projects`, `crm.core` to `projects.core`, `verticalCrm` to
      `verticalProjects`, `/crm` to `/projects`, `/crm-api` to `/projects-api`, `crm_*`/`crm-*` to
      `projects_*`/`projects-*`, and every `*_CRM*` environment name to its `*_PROJECTS*` equivalent.
      Keep port `4101`, Customer/Contact entity names, ARES terminology, tenant/legal-entity scope, and
      business behavior unchanged.
- [x] Fix the cutover contract: old `/crm` and `/crm-api` URLs return `404`, old environment variables
      are ignored or rejected according to existing configuration validation, and no package, module,
      deployment, database, or authorization alias is retained.

### 2. Rename the workspace owner and deployment topology atomically

- [x] Use history-preserving moves for `verticals/crm` to `verticals/projects`, owner-local CRM-named
      files (`crm-client.ts`, `crm-query-client.ts`, `page-crm.tsx`, `crm-page.test.tsx`, and locale
      catalogs) to Projects names, and both Shell and owner route directory trees from `crm` to
      `projects`.
- [x] Update `verticals/projects/package.json`, root `package.json`, `pnpm-lock.yaml`, root and Shell
      TypeScript references, `.modernjs/ultramodern.json`, and Shell dependencies so package discovery
      contains exactly `@app/projects` at `verticals/projects` and no live `@app/crm` importer. Refresh
      the lockfile with pnpm rather than editing dependency resolution data manually.
- [x] Update all three topology files, Shell federation configuration/client loaders, Cloudflare and
      Zephyr names, backend federation identity, public URL/manifest/worker variables, API/readiness
      paths, ownership/runbook references, Zerops service/build/materialization paths, Compose/local
      overlays, and environment declarations as one deployment contract. Preserve app ID/module ID
      separation and the existing independent MicroVertical delivery seam.
- [x] Update workspace/topology validation fixtures and Codesmith discovery tests beside the
      topology changes; prove that `projects` is the only discovered vertical and that generator
      behavior still works for arbitrary vertical names rather than special-casing Projects.

### 3. Rename the module, Action, Read, API, and generated owner contracts

- [x] Change the authored module identity to `projects.core` and update all generated-owner markers,
      manifest/registration exports, Action owners and keys, Policy/evidence keys, Read/API entrypoints,
      component/contribution/navigation/page keys, action gateway audience, operation contexts, logs,
      typed error/problem classes and tags, safe error codes, and owner-local service/database symbols
      from CRM forms to Projects forms.
- [x] Update `vertical.manifest.ts` and `vertical.registration.ts` in their existing Codesmith slots,
      preserving every Action/API/page registration and private import boundary. This chore creates no
      new Action, MicroVertical page, Outbox Message, or Policy, so no business-artifact generator is
      required; do not regenerate those artifacts as new features or lose their implemented logic.
- [x] Rename the strict Effect API/BFF surface, client filenames/exports, backend federation names,
      OpenAPI and readiness paths, CORS symbols, runtime layers, and Shell generated-client consumers.
      Preserve each operation's exact success schema and typed error union; only the owner vocabulary
      and transport paths change.
- [x] Update Action, API, BFF, contract, catalog, owner-isolation, and Shell loader tests alongside
      the contract changes. Add assertions that no `crm.core` alias is accepted after cutover and that
      every Projects descriptor resolves through the module-state gate before private code loads.

### 4. Rename routes, federation components, UI namespace, and user-facing copy

- [x] Rename canonical/localized route metadata and all links from `/crm/**` to `/projects/**` in
      both the Projects owner and Shell gateway trees, retaining the exact `id`/`contactId` parameter
      names, validation, loading, empty, forbidden, conflict, retry, inaccessible, and responsive
      behavior.
- [x] Rename `PageCrm`/`CrmPage`/`CrmHome` and Module Federation exposes to Projects equivalents;
      update the Tailwind prefix from `crm` to `projects` in the import and every class so styles remain
      scoped and no plain CSS or hard-coded design tokens are introduced.
- [x] Rename locale files and the i18n namespace to `projects`, translate the module label as
      `Projects` in English and `Projekty` in Czech, and replace user-visible phrases such as “CRM is
      currently read-only” in both locales without changing Customer/Contact terminology.
- [x] Regenerate owner and Shell route metadata/TanStack route artifacts from the renamed route
      sources using the repository route generator. Update component, locale, routing, accessibility,
      and Shell integration tests beside the source changes, including the intentional old-URL
      not-found contract.

### 5. Replace the disposable CRM database history with a clean Projects baseline

- [x] Change the typed owner schema from `crm` to `projects`, rename exported database/catalog/types
      to Projects, and rename every owner constraint, unique/index name, and RLS policy prefix. First
      remove the two CRM migration files and metadata, then run
      `mise exec -- pnpm --filter @app/projects db:generate` to produce a fresh migration history from
      the authoritative Projects typed schema. Do not hand-author an alternative schema or retain CRM
      names in the new baseline.
- [x] Configure only `drizzle.__drizzle_migrations_projects`; do not create a journal-transition
      script, compatibility view/schema, data-copy migration, or Core identity-rewrite migration.
      Existing CRM databases and journals are deleted by the deployment reset rather than consumed by
      the Projects migrator.
- [x] Prove the fresh Projects migration creates `projects.customers` and `projects.contacts` with the
      exact current columns, foreign keys, indexes, uniqueness, checks, forced RLS policies, ownership,
      and runtime grants. Existing behavioral fixtures may be reseeded, but no deployed row or UUID is
      carried across the reset.
- [x] Update stage bootstrap and tests so a fresh installation creates `projects.core` tenant state and
      Projects `module_access` relationships in SpiceDB. Do not read, update, or delete individual CRM
      tuples; recreate the authorized empty datastore and apply the existing schema/bootstrap flow.
- [x] Update runtime grant bootstrap, Zerops migration ordering, root/owner schema verifiers, README
      database documentation, and database tests for exactly `core`, `auth`, and `projects` application
      schemas plus the three owner-specific journals. Add a fresh-install migration test that rejects
      unexpected `crm` schemas/journals and proves the seeded Projects fixtures remain tenant-isolated.

### 6. Execute the destructive Projects cutover

- [ ] Follow the destructive-action safeguards: acquire the deployment lock, resolve and record each
      exact CRM application database volume and SpiceDB datastore, stop CRM and its consuming Shell,
      verify the targets again, and remove only those approved disposable stores and CRM deployment
      artifacts. Report what was erased and whether any provider snapshot remains recoverable.
- [ ] Provision empty PostgreSQL and SpiceDB state, apply Core, Auth, Projects, runtime grants,
      authorization schema, and stage/demo bootstrap in repository order, then deploy Projects before
      the consuming Shell. Do not start an old CRM binary against the rebuilt stores.
- [ ] Run readiness, module-manifest, federation, API, locale, database, stage authorization, and
      representative Customer/Contact smoke checks. Old CRM routes and services must remain absent;
      rollback means redeploying a Projects-compatible artifact and reseeding disposable data, not
      restoring the CRM identity.

### 7. Reconcile current documentation, examples, and historical plans

- [x] Update app-local README, architecture examples, ARES integration documentation, addressing
      guidance, and deployment instructions when they describe the concrete implemented CRM owner.
      Preserve generic industry “CRM” references only when they describe the CRM concept rather than
      this MicroVertical, and do not edit repository-level `../docs/**` because repository instructions
      limit writes to `app/`.
- [x] Inventory every `specs/*crm*.md` filename and CRM occurrence. Keep completed plans and their
      implementation evidence immutable as historical records unless another live plan links to their
      old paths or treats their CRM identifiers as current instructions. Maintain a small documented
      allowlist of retained historical occurrences; do not let app code, configuration, active docs, or
      planned specs hide behind that allowlist.

### 8. Prove the rename is exhaustive

- [x] Search tracked paths and contents case-insensitively for every old form, including file and
      directory names, `crm`, `CRM`, `Crm`, `crm.core`, `crm_`, `crm-`, `@app/crm`, `verticalCrm`,
      `/crm`, `CRM_*`, `*_CRM`, PostgreSQL identifiers, and generated output references. Classify every
      remaining match as an immutable historical migration/spec occurrence, a generic CRM product term,
      or an incidental dependency integrity substring; remove every unclassified live match.
- [x] Search the migrated PostgreSQL catalogs and normalized identity columns, generated module
      manifest, Module Federation manifests/types, route tree, emitted locale paths, OpenAPI document,
      deployment topology, and freshly bootstrapped SpiceDB relationships for stale CRM identity. The
      final active runtime surface must contain only Projects identities.
- [x] Review the diff for accidental Customer/Contact/ARES behavior changes, duplicate module or
      deployment identities, import-boundary violations, edited generated build output, stale ignored
      build artifacts, or unrelated formatting churn.

### 9. Run all validation commands

- [x] Execute every command under `Validation Commands` from `app/` in the listed order, including the
      fresh database and authorization bootstrap scenario. Resolve regressions without
      weakening exact catalog, module-state, typed Effect error, route, i18n, or deployment checks.

## Testing Strategy

Update unit and contract tests alongside each renamed identity so package discovery, topology,
manifest/registration ownership, Action/Read descriptors, BFF error unions, route metadata, locale
parity, CSS isolation, and Shell gateway resolution all reject stale CRM identities. Existing
Customer/Contact/ARES tests remain the behavioral regression suite: create, edit, detail, list,
archive/unarchive, conflict, validation, not-found, forbidden, unavailable/retry, loading/empty,
tenant isolation, and ARES lookup results must behave identically through Projects paths.

Database integration coverage starts only from empty PostgreSQL and SpiceDB stores. The regenerated
histories must create the exact Core, Auth, and Projects schemas, owner journals, grants,
RLS/constraints/indexes/policies, deterministic stage module state, and Projects authorization
relationships. Seed at least two tenants after migration to prove unchanged Customer/Contact behavior
and cross-tenant isolation. Add negative catalog checks proving no `crm` schema, journal, identity, or
authorization relationship exists; no upgrade or data-preservation fixture is required.

Browser or route integration coverage must prove the new localized Projects URLs and `404` behavior
for old CRM URLs. Build/runtime checks must prove both frontend and backend Module
Federation surfaces, generated Effect clients, module contract discovery, readiness, locales, and
deployment manifests agree on one Projects delivery identity.

## Acceptance Criteria

- [x] The sole live MicroVertical folder/package/deployment identity is
      `verticals/projects` / `@app/projects` / `projects`; no duplicate CRM module is introduced.
- [x] The sole live business module identity is `projects.core`, and every Action, Read, API,
      entrypoint, component, contribution, policy/evidence key, gateway audience, and runtime
      registration uses the Projects namespace.
- [x] Canonical and localized UI routes use `/projects/**`, the BFF uses `/projects-api/**`, emitted
      manifests and generated clients use Projects identities, and old CRM URLs return `404`.
- [x] English and Czech catalogs use the `projects` namespace and display `Projects` / `Projekty`;
      all loading, empty, error, forbidden, validation, conflict, retry, accessibility, and responsive
      behavior remains covered.
- [x] PostgreSQL owns exactly the `projects` business schema and
      `drizzle.__drizzle_migrations_projects` journal after the fresh rebuild, with Projects-named
      constraints, indexes, RLS policies, grants, typed schema exports, and verifiers.
- [ ] The approved destructive cutover removes deployed CRM database, journal, Action/audit/evidence,
      ResourceRef, and authorization data; the fresh Projects fixtures prove unchanged tenant-isolated
      behavior without claiming data preservation.
- [x] A fresh Projects bootstrap establishes authorization in PostgreSQL and SpiceDB, and no CRM
      `module_access` relationship or compatibility alias exists.
- [x] Topology, Shell federation, Cloudflare, Zephyr, Zerops, local development, migration runner,
      environment examples, ownership metadata, and workspace validation all describe the same
      Projects delivery unit.
- [x] Customer, Contact, and ARES domain behavior and typed Effect error contracts are unchanged
      apart from the intentional Projects names and paths.
- [x] A final tracked-path/content/runtime/database/authorization scan has no unexplained CRM match;
      retained matches are limited to a reviewed list of historical specs, generic CRM product prose,
      or incidental integrity hashes. The regenerated Projects migration history contains no CRM
      identity.
- [x] Every validation command succeeds with zero regressions.

## Validation Commands

Execute every command to validate the chore with zero regressions.

- `mise exec -- node --test scripts/scaffolding/tests/scaffold-generators.test.mts` — validate
  Codesmith discovery and generated wiring after the exemplar vertical rename.
- `mise exec -- pnpm --filter @app/core-runtime test:unit` — validate renamed installation,
  manifest/contribution, module-state, and Core identity contracts.
- `mise exec -- pnpm --filter @app/projects test:unit` — validate Projects schemas, Actions, APIs,
  errors, database catalog, locales, and architecture boundaries.
- `mise exec -- pnpm --filter @app/projects test:component` — validate Projects route, form, state,
  accessibility, and Customer/Contact UI regressions.
- `mise exec -- pnpm --filter @app/projects test:integration` — validate governed Reads, Actions,
  BFF operations, database isolation, and ARES behavior.
- `mise exec -- pnpm --filter @app/shell-super-app test:unit` — validate Shell discovery, generated
  Projects loaders, module gateway, route, and presentation contracts.
- `mise exec -- pnpm --filter @app/shell-super-app test:integration` — validate Shell runtime,
  Module Federation, locale, authentication, and installed-module composition.
- `mise exec -- pnpm db:migrate` — run the ordered Core, Auth, Projects, and runtime-grant migrations
  against the prescribed empty fixture database.
- `mise exec -- pnpm db:verify` — exact-match application schemas, journals, grants, RLS, and typed
  owner catalogs after migration.
- `mise exec -- pnpm db:test` — run Core, Shell, and Projects database/runtime regression coverage.
- `mise exec -- pnpm i18n:boundaries` — validate Projects locale ownership, namespace, and Czech/
  English parity.
- `mise exec -- pnpm api:check` — validate strict Effect API/BFF and browser import boundaries.
- `mise exec -- pnpm database-access:check` — validate Projects-only database ownership and governed
  scoped access.
- `mise exec -- pnpm module-entrypoints:check` — validate renamed Action, API, page, and generated
  Shell entrypoints.
- `mise exec -- pnpm check:module-contracts` — validate the Projects authored owner slots and emitted
  deployment contract.
- `mise exec -- pnpm contract:check` — validate package discovery, topology, federation, environment,
  deployment, database, and ownership contracts.
- `mise exec -- pnpm build` — prove the independently deployable Projects frontend/backend and
  consuming Shell production artifacts agree.
- `mise exec -- pnpm check` — Run the final repository quality gate.

## Review Checklist

- [ ] Every acceptance criterion is satisfied.
- [x] The diff complies with `../AGENTS.md`, `AGENTS.md`, and all relevant referenced guidance.
- [x] Behavioral changes have tests.
- [x] No unrelated changes, dead code, or accidental API expansion remain.

## Notes

## Implementation Evidence

### Summary

- Implemented the live CRM-to-Projects identity cutover throughout the owner, Shell routes,
  topology, deployment configuration, typed module/Action/Read/API contracts, localization,
  documentation, database schema, migration history, generators, and tests. No compatibility alias
  was added.
- Removed the disposable two-migration CRM Drizzle history and generated one clean Projects baseline.
  The documented narrow post-generation adjustment adds `FORCE ROW LEVEL SECURITY` for both owner
  tables.
- Recreated the authorized local Compose targets from empty state. The removed
  `ontos_postgres_data` volume and in-memory SpiceDB state have no retained local snapshot. The new
  database contains exactly schemas `auth`, `core`, and `projects`; exactly journals
  `__drizzle_migrations_auth`, `__drizzle_migrations_core`, and
  `__drizzle_migrations_projects`; and zero CRM values in inspected normalized identity columns.
- Preserved all 24 CRM-containing completed historical specifications. Their 1,554 occurrences are
  the reviewed historical allowlist; the 25th CRM-containing specification is this blocked cutover
  plan. There are 22 CRM-named specification files including this plan. Outside `specs/`, retained CRM
  text is limited to explicit negative cutover assertions and five incidental case-insensitive
  lockfile integrity substrings.

### Tests and validation

- Passed: Codesmith scaffolding suite (40 tests); full Core unit suite (197 tests); Projects unit suite
  (52 tests); Projects component suite (247 tests); Projects integration suite (5 tests); Shell unit
  suite (175 tests); Shell integration suite (7 tests); `db:migrate`; `db:verify`; the aggregate
  `db:test` gate (241 Core database/runtime tests plus the Shell and Projects phases);
  `i18n:boundaries`; `api:check`; `database-access:check`; `module-entrypoints:check`;
  `check:module-contracts`; `contract:check`; the committed production `pnpm build`; and the complete
  `pnpm check` repository quality gate.
- Browser/runtime proof: the authenticated localized Czech and English Projects flow passes through
  the Shell module gate; Projects readiness returns HTTP 200 with `appId: projects`; and focused
  Playwright coverage proves `/en/crm` and `/crm-api/crm/readiness` both return 404.
- Review fixes added the missing Core `test:unit` script, repaired three opaque SpiceDB bootstrap
  object IDs that still encoded `crm.core`, added the retired-URL Playwright assertion, and corrected
  the Czech Projects heading assertion. The rebuilt SpiceDB state contains seven `projects.core`
  `module_access` relationships and no decoded CRM relationship.
- Repaired stale Shell/Core test fixtures to use the current principal, binding lifecycle, role,
  module-state, generated-owner, layout-token, and configured-URL contracts. Also corrected the live
  Read runtime layer wiring so its operational-scope resolver uses the same injected context-access
  service, and made unavailable module-target resolution return the declared sanitized Read failure
  instead of a defect. The complete affected test suites now pass.
- Made the development gateway JWK values safe for both dotenv loading and the documented shell
  sourcing workflow. Added a shell-parsing regression test and an authenticated browser test that
  exercises real Shell gateway issuance, Projects verification, authorization, and the Customer read
  instead of mocking the gateway boundary. The Customer table and live ARES lookup both pass through
  the corrected runtime.

### Blockers and deviations

- Stage cutover is not executed. This environment exposes no Zerops CLI, provider/stage identifiers,
  datastore connection target, or deployment-lock mechanism. The plan deliberately fails closed
  rather than guessing or deleting an unresolved external target.
- Direct owner-only SSR of `/en/projects` still encounters the existing shared-i18n renderer
  limitation; the canonical Shell route, component suite, Module Federation integration, and
  readiness surface are validated.

### Change review

- Final tracked diff against `develop` at `1b33256af50c44e633408e0fe26698966f72d175`:
  246 files, 4,992 insertions, and 4,466 deletions, including the three generated Projects migration
  files and this implementation plan.
- `git diff --check` passes. Active paths contain no CRM-named owner or route directory, decoded
  authorization IDs contain no CRM identity, the fresh database has only the expected three schemas
  and journals, and the Customer/Contact/ARES regression suites pass.

- The developer explicitly authorized erasing all deployed data for this rename on 2026-08-28.
  Implementation must still resolve deletion targets narrowly and report the erased stores; this is
  authorization for OntOS CRM deployment data, not unrelated provider resources or repositories.
- No compatibility aliases, data migration, Core identity rewrite, journal transition, or staged
  expand/deploy/contract overlap is required. Old URLs intentionally return `404`, and old environment
  variables/configuration are unsupported after cutover.
- `crm.core` is persisted in Core and encoded into stage SpiceDB `module_access` object IDs, which is
  why the plan rebuilds both stores from empty state rather than attempting a partial database reset.
- Completed CRM specs are historical evidence and remain reviewable under an explicit allowlist. The
  disposable CRM migration history is different: remove it and generate a clean Projects baseline so
  fresh databases contain no CRM schema or object identity. “Everything” still does not justify
  falsifying completed-plan evidence or dependency integrity hashes.
- No Codesmith business-artifact generator is required because the chore creates no new Action,
  MicroVertical page, Outbox Message, or Policy. Existing generated owners and route artifacts must
  retain their generator markers/slots, and route metadata must be regenerated with repository
  tooling after the history-preserving moves.
- Repository-level `../docs/**` contains generic and historical CRM planning language but is outside
  the permitted write boundary. App-local guidance is authoritative and is included in this chore.
