---
type: chore
status: planned
created: 2026-08-10
---

# Chore: CRM 21 acceptance and deployment verification

## Chore Description

Implement ticket 21, "Run final CRM acceptance and deployment verification," from
`app/tickets.md`. Create the reproducible release gate that traces the authoritative CRM master
specification through the completed backend, UI, authorization, generated-boundary, database, and
deployment artifacts. Verify exactly five CRM entities, exactly 18 Actions, the approved routes and
resource surfaces, every required user-visible state, English/Czech localization, accessibility,
responsive behavior, migrations, RLS, contracts, and Cloudflare-compatible builds. This chore
verifies deployable repository state; it does not perform a live production deployment.

This ticket is blocked by tickets 8, 12, 16, 19, and 20, exactly as recorded in `app/tickets.md`.
The CRM master specification at `app/specs/feature-crm-microvertical.md` is the authoritative
acceptance source.

## Relevant Files

Use these files to accomplish the chore:

- `specs/feature-crm-microvertical.md` — authoritative CRM acceptance and deployment requirements.
- `tickets.md` — corresponding ticket 21 and its exact blockers.
- `specs/chore-crm-01-action-codesmith-boundary.md` through
  `specs/chore-crm-20-authorization-resource-hardening.md` — completed leaf-plan outcomes traced by
  this release gate.
- `package.json` — repository-supported validation, build, contract, database, i18n, API, and
  scaffolding commands.
- `verticals/crm/package.json` — CRM-local build, database, unit, and integration scripts
  established by ticket 2.
- `verticals/crm/src/index.ts` — final public manifest inventory.
- `verticals/crm/src/db/schema.ts` — five-entity schema and forced-RLS source.
- `verticals/crm/drizzle/` — generated owner-local migrations and migration journal artifacts.
- `verticals/crm/tests/` — focused unit, route/component, integration, RLS, and acceptance coverage.
- `scripts/scaffolding/tests/` — generator-boundary regression coverage.

### New Files

- `verticals/crm/tests/acceptance/crm-acceptance.test.ts` — machine-checkable inventory and
  end-to-end acceptance trace over final public contracts.
- `verticals/crm/tests/acceptance/crm-deployment.test.ts` — deployable-bundle, environment-contract,
  manifest, and migration readiness assertions.
- `verticals/crm/docs/acceptance-evidence.md` — concise command/evidence matrix mapped to master-
  specification sections and ticket outcomes.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Build the authoritative acceptance trace

- [ ] Translate every master-specification acceptance criterion into a stable evidence table in
      `verticals/crm/docs/acceptance-evidence.md`, mapping it to its owning ticket, implementation
      surface, focused test, and exact repository-supported validation command without restating or
      broadening the requirement.

### 2. Verify the exact public CRM inventory

- [ ] Add `verticals/crm/tests/acceptance/crm-acceptance.test.ts` using only public/generated
      contracts and assert exactly five entities, 18 Action descriptors, the approved route/navigation
      entries, Customer/Contact/Deal detail providers, and the Customer timeline provider; reject
      duplicate, missing, and unexpected public CRM exports.
- [ ] Assert the Action breakdown is Customer 3, Contact 3, primary-contact 1, Deal 3, Deal
      lifecycle 1, Offer revision 3, Offer lifecycle 1, and Activity 3. For each Action, verify typed
      payload/result/error contracts, private owner-local handler binding, generated Effect
      transport/client registration, authorization configuration, and transaction/domain-event
      evidence.

### 3. Verify schema, migrations, RLS, and concurrency

- [ ] Add acceptance assertions for the CRM owner, `drizzle.__drizzle_migrations_crm` journal,
      generated-migration freshness, five schema entities, tenant/legal-entity keys, forced RLS,
      indexes, referential constraints, unique primary-contact enforcement, Deal versions, immutable
      Offer revisions, and Activity versioning.
- [ ] Pair every new assertion with a focused fixture or regression test; do not inspect another
      vertical's private schema or executor.

### 4. Exercise the principal backend journeys

- [ ] Through public Actions and generated read clients, create/edit/delete a Customer, manage
      Contacts and primary selection, create/edit/delete and transition a Deal, create/edit/delete
      immutable Offer revisions and transition their lifecycle, create/update/delete an Activity, and
      read the deterministic paginated Customer timeline.
- [ ] Repeat representative journeys across two tenants and two legal entities and assert allowed,
      validation, forbidden, not-found, conflict, unavailable/retry, and success outcomes; verify Action
      history/domain events, no partial writes, optimistic conflicts, stable pagination, and final RLS
      boundaries.

### 5. Exercise every approved UI state

- [ ] Add or complete route/component acceptance coverage for every approved page and dialog in
      `en` and `cs`: loading, empty, validation, forbidden, not-found, conflict, unavailable/retry, and
      success; keyboard/focus behavior; labels and error association; narrow and wide layouts; long
      content; read-only/deprecated module state; pending submissions; and success navigation/refetch.
- [ ] Assert UI modules consume generated Effect clients, do not import handlers, repositories, or
      executors, and render no search control or behavior, search request, search query parameter,
      provider, shortcut, or hidden filter.

### 6. Verify generated/manual ownership and deployment readiness

- [ ] Add `verticals/crm/tests/acceptance/crm-deployment.test.ts` for Cloudflare-compatible bundle
      output, environment-binding contracts, generated public entrypoints and API clients, CRM manifest
      discovery, migration discovery, and the absence of generated private handlers or generated CRM
      persistence.
- [ ] Keep deployment tests on fakes and repository-local test infrastructure. Do not contact or
      mutate production Cloudflare, PostgreSQL, SpiceDB, or customer systems.

### 7. Run and record the final release gate

- [ ] Run every command in Validation Commands from `app/` in the listed order. If a command fails,
      fix the behavior in its owning ticket surface and add a focused regression test rather than
      weakening the acceptance assertion or deferring the failure.
- [ ] Record the final passing command/evidence links in
      `verticals/crm/docs/acceptance-evidence.md`, separate environment-specific deployment
      prerequisites from code acceptance, and confirm no new capability, Policy, Outbox Message,
      search behavior, branch, commit, issue, pull request, or live deployment was introduced.

## Testing Strategy

Add machine-checkable inventory, end-to-end acceptance, route/component, RLS, migration, and
deployment-readiness tests. Reuse focused tests from tickets 1 through 20 and add only the final
cross-surface assertions needed to prove their composition. Acceptance tests use public/generated
contracts, local databases and SpiceDB fixtures, and fake deployment bindings; they must not call
production services. The evidence matrix links each master criterion to a focused test and command.

## Acceptance Criteria

- [ ] The evidence matrix traces every master-specification acceptance criterion to a completed
      implementation surface, focused test, and supported command.
- [ ] Automated inventory proves exactly five entities, exactly 18 Actions, and only the approved
      routes, resources, and timeline surface.
- [ ] All backend, UI, authorization, RLS, concurrency, timeline, accessibility, responsive, and
      English/Czech state requirements pass through public/generated contracts.
- [ ] Generator tests prove mandatory Action and page scaffolds retain their approved ownership
      boundaries; owner-local handlers and persistence remain manual.
- [ ] Database migrations are current and owner-isolated, public entrypoints/contracts are valid,
      Cloudflare bundles build, and repository-wide checks pass.
- [ ] Automated tests explicitly prove CRM contains no search UI, request, parameter, provider,
      shortcut, or hidden search behavior.
- [ ] No live external system is modified by acceptance or deployment-readiness verification.

## Validation Commands

Execute every command to validate the chore with zero regressions.

- `mise exec -- pnpm exec tsc -p scripts/scaffolding/tsconfig.json` — Type-check the Codesmith
  generators.
- `mise exec -- pnpm exec node --test scripts/scaffolding/tests/*.test.mjs` — Validate mandatory
  scaffold ownership boundaries.
- `mise exec -- pnpm --filter @app/crm test:unit` — Run CRM unit and component tests.
- `mise exec -- pnpm --filter @app/crm test:integration` — Run CRM integration and acceptance tests.
- `mise exec -- pnpm --filter @app/crm db:generate` — Prove typed schema and committed Drizzle
  migrations have no unexplained drift.
- `mise exec -- pnpm --filter @app/crm db:migrate` — Apply the owner-local CRM migrations to the
  test database.
- `mise exec -- pnpm --filter @app/crm db:verify` — Verify owner, journal, grants, schema, indexes,
  and forced RLS.
- `mise exec -- pnpm db:test` — Run repository database integration tests.
- `mise exec -- pnpm i18n:boundaries` — Validate English/Czech translation ownership and coverage.
- `mise exec -- pnpm api:check` — Validate strict Effect BFF and API boundaries.
- `mise exec -- pnpm database-access:check` — Validate owner-local database access.
- `mise exec -- pnpm module-entrypoints:check` — Validate generated module entrypoints.
- `mise exec -- pnpm check:module-contracts` — Validate module manifests and public contracts.
- `mise exec -- pnpm contract:check` — Validate package and topology contracts.
- `mise exec -- pnpm build` — Produce all deployable Cloudflare-compatible bundles.
- `mise exec -- pnpm check` — Run the final repository quality gate.

## Review Checklist

- [ ] Every acceptance criterion is satisfied.
- [ ] The diff complies with `../AGENTS.md`, `AGENTS.md`, and all relevant referenced guidance.
- [ ] Behavioral changes have tests.
- [ ] No unrelated changes, dead code, or accidental API expansion remain.

## Notes

- Dependencies: tickets 8, 12, 16, 19, and 20.
- A live production deployment is outside this plan. Deployment readiness is established by the
  supported build, manifest, binding, migration, contract, and fake-environment checks.
- `db:generate` must produce no unexplained schema drift after committed migrations are current.
- No new CRM entity, Action, route, business rule, visual styling, Policy, Outbox Message, or search
  behavior belongs in this final verification ticket.
