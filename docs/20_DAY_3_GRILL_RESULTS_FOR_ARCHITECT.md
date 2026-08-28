# Day 3 Grill Results For Project Architect

Date: 2026-06-10

> [!IMPORTANT]
> **Historical record:** Decisions 16 and 17 were superseded by [OntOS #78](https://github.com/TechsioCZ/ontos/issues/78) and [ADR-0014](./adr/0014-authenticated-principal-session.md). One BetterAuth user may now access multiple Tenants through distinct tenant-scoped Principals, while each session activates exactly one Tenant. Do not use the one-user/one-Tenant or no-selector statements below as current architecture.

This document summarizes the `/grill-with-docs` decisions made before continuing the PoC/MVP work from Day 3 onward in `16_JUNE_2026_V0_PREP_AND_V1_DELIVERY_HANDOFF.md`. The goal is to remove ambiguity before implementing the database, identity, authorization, policy, action runtime, and persistence proof in `mvp/`.

## Scope Confirmed

Day 3 no longer proves the Core Action Runtime directly. The next work should be reordered so database, seeded tenant/legal-entity/principal context, BetterAuth-shaped principal resolution, SpiceDB-shaped authorization, module state, and policy gates exist before the Core Action Runtime integration proof.

The UI may include button-click harnesses so a developer can trigger action and gate scenarios from MicroVertical screens, but the buttons are only an invocation/demo surface. The remaining PoC work should not add special routing, form architecture, HTTP endpoint design, product UX, or real ERP behavior.

## Grilling Results

### 1. What execution surface should the Action proof use?

Question: Should Day 3 prove an in-process action runtime, an HTTP endpoint, or a full UI/form path?

Decision: Prove an in-process Core Action Runtime and expose it through a minimal UI button harness after database/context/authz/policy foundations exist.

Rationale: The architecture needs to prove that registered Actions go through Core checks before private handlers run. A button click is useful evidence that a MicroVertical can invoke the runtime, but transport, forms, and product workflow are not the Day 3 subject.

### 2. Should the second MicroVertical add multiple public probe Actions?

Question: Should `accounting.core` add several public Actions just to test authorization, policy, validation, and context failure paths?

Decision: No. Keep the public action set small. Use scenario buttons in the second MicroVertical to exercise different fixture/runtime envelopes against the existing placeholder Action.

Required PoC Actions:

- `property.registry.createUnit`: success-path proof when all Core checks pass.
- `accounting.core.createDraftEntry`: negative-path/probe proof from the second MicroVertical.

The `accounting.core` screen may include multiple scenario buttons for missing tenant context, missing principal context, blocked module state, authorization denied, policy denied, validation failure, and optionally a happy path. These buttons are scenario launchers, not distinct business Actions.

### 3. Should Core Action Runtime come before tenant/auth/database foundations?

Question: Should Day 3 implement `executeAction` first with fixture tenant/principal values, or should the PoC prove persisted tenant/legal-entity/principal context before Actions?

Decision: Reorder the next PoC work. Tenant/legal-entity/principal persistence and context resolution should come before the Core Action Runtime integration proof.

Rationale: A button-click Action with raw fixture context proves function-call plumbing, but it does not prove the stronger OntOS invariant that Actions execute inside a real tenant, legal-entity, and principal boundary. The action proof should consume established Core context rather than inventing tenant/principal values at the call site.

### 4. Should database tables be added gradually or up front?

Question: When establishing the database foundation, should tables be added one by one as each scenario needs them, or should the MVP create the Core schema tables together and use them gradually?

Decision: Create the full documented initial SQL schema together, then wire individual tables into the runtime over the following steps.

Rationale: The schema is treated as locked for the PoC/MVP sequencing discussion. Creating it up front gives the team one database initialization surface while still allowing the implementation to use tables gradually.

Schema changes may still happen later if grilling uncovers new needs, but Day 3 planning should not reopen the table set.

### 5. What is the final reordered Day 3-5 plan?

Question: Can the remaining work stay within the current five-day PoC by joining the database/context and authz/policy foundation work?

Decision: Yes. Join the proposed database/context foundation and authz/policy foundation into the new Day 3. Move the Core Action Runtime proof to Day 4. Move action invocation/audit/domain event/outbox/idempotency persistence and the final PoC note to Day 5.

This keeps all tasks from the existing Day 3-5 plan:

- `property.registry.createUnit` Action proof.
- Effect Schema validation.
- tenant context resolution.
- principal context resolution.
- module state checks.
- authorization adapter checks.
- policy hook.
- private handler execution through Core.
- typed result.
- Effect SQL/Drizzle spike and recommendation.
- documented initial SQL schema.
- tenant-safe constraint evidence.
- idempotency uniqueness or documented exception.
- real self-hosted BetterAuth integration.
- principal binding logic.
- SpiceDB adapter or strict fake with the same contract.
- action invocation row.
- audit row.
- outbox row.
- final runnable demo and PoC result note.

## Reordered Implementation List

### Day 3: Database, Context, BetterAuth, SpiceDB, And Policy Gates

Tasks:

1. Add local database setup and one full documented initial SQL schema from the current docs.
2. Spike `@effect/sql-pg` and `@effect/sql-drizzle`; keep raw SQL where constraints must stay explicit.
3. Seed demo tenant, legal entity, principal, principal auth binding, and tenant module states for `property.registry` and `accounting.core`.
4. Add real self-hosted BetterAuth using Postgres.
5. Add runtime tenant/legal-entity/principal context resolution from the seeded database.
6. Add SpiceDB in Docker, a minimal SpiceDB schema, relationship seed/setup, and a real SpiceDB-backed authorization adapter.
7. Add module-state write gate and a trivial policy hook.
8. Add scenario buttons in `accounting.core` to exercise missing context, blocked module state, authorization denied, policy denied, and validation denied without adding extra public Actions.
9. Include tenant-safe constraint evidence and idempotency uniqueness or an explicit note if idempotency enforcement is postponed.

Acceptance:

- Database initializes locally from the full documented PoC schema.
- Demo tenant, legal entity, principal, auth binding, and module states are loaded from the database, not hard-coded at the button call site.
- BetterAuth subject resolution maps to an OntOS Principal through Core binding logic.
- SpiceDB authorization fails closed.
- Module active/read-only/inactive state is checked from persisted state.
- Policy hook can allow and deny.
- The developer can explain how tenant isolation will be enforced.
- Critical constraints are not hidden behind unclear ORM behavior.

Deliverables:

- init SQL schema and seed path.
- schema notes and Effect SQL/Drizzle recommendation.
- BetterAuth/principal binding integration.
- SpiceDB Docker setup, schema, seed/setup, and adapter contract.
- module-state and policy gate demo output.

### Day 4: Core Action Runtime And Canonical Write

Tasks:

1. Implement `executeAction` as the Core runtime wrapper.
2. Keep `OperationalContext` or any runtime attempt object internal to Core; do not introduce public `SystemIntent` APIs or generic intent persistence.
3. Resolve Action descriptors from the Installed Vertical Registry.
4. Run `property.registry.createUnit` through Core.
5. Validate Action input with Effect Schema.
6. Resolve tenant, legal entity, and principal context through the Day 3 context path.
7. Check module state, authorization, and policy through the Day 3 gates.
8. Execute the private handler only through Core.
9. Have the successful handler write a minimal tenant-scoped canonical row through the chosen SQL path.
10. Return a typed result, preferably a ResourceRef-shaped value.
11. Keep `accounting.core.createDraftEntry` as the probe Action for negative-path buttons.

Acceptance:

- Action cannot run without tenant and principal context.
- Action cannot run if module state blocks writes.
- Unauthorized Action fails closed.
- Invalid input is rejected before handler execution.
- Handler does not bypass Core runtime.
- Successful Action writes tenant-scoped canonical data through Effect SQL/Drizzle or the selected SQL path.
- Action has a stable descriptor.
- Shell BFF handlers remain typed transport adapters and do not own business workflow, audit, outbox, or action evidence behavior.

Deliverables:

- action runtime wrapper.
- widened Action descriptor shape if needed.
- create-unit handler implementation for the proof row only.
- demo request/result from button harness and/or test.

### Day 5: Action Invocation, Audit, Outbox, Idempotency, And Final Demo

Tasks:

1. Write `CORE_ACTION_INVOCATIONS` lifecycle rows.
2. Enforce idempotency handling for non-idempotent writes: required key, request hash, replay, running/pending, conflict, and failure retry policy.
3. Write audit checkpoints for received/authn/authz/policy/validation/executed/rejected/failed as appropriate for the proof.
4. Write denial evidence for context/authz/policy/validation rejection without invoking the handler.
5. Write a domain event for successful `property.registry.createUnit`.
6. Write an outbox message for the successful domain event.
7. Commit successful domain row, action status, executed audit, domain event, and outbox in one canonical Postgres transaction.
8. Prove failure evidence survives when handler/canonical work fails.
9. Add a minimal read/list path through a Core data-access evidence wrapper and record denied read/search evidence.
10. Run the create-unit demo end to end from button click through Core checks, canonical write, action invocation, audit, domain event, and outbox.
11. Keep failure-path buttons proving context/authz/policy/validation rejection behavior.
12. Write the final PoC result note.

Acceptance:

- Successful Action produces canonical row, action invocation, executed audit event, domain event, and outbox message in the intended transaction boundary.
- Rejected Action produces useful action/audit evidence without running the handler.
- Failed Action produces useful failure evidence without leaving partial canonical state.
- Idempotency behavior is enforced, including replay and conflict cases, or the exception is explicit and bounded.
- Read/list access evidence records allowed and denied outcomes.
- PoC result note says proceed/revise/drop for major decisions: SQL path, BetterAuth approach, SpiceDB approach, Core Action Runtime, module state gating, audit/outbox shape.

Deliverables:

- runnable demo.
- screenshots or short video.
- final PoC notes.
- list of proven assumptions.
- list of failed assumptions.
- transaction-boundary notes for denial, success, failure, and idempotency replay.
- recommended ADR status updates.

### 6. How should Day 3 provide local Postgres?

Question: Should Day 3 use Docker Compose or rely on a locally installed Postgres service?

Decision: Use Docker Compose.

Required file layout:

- `mvp/docker-compose.yml`
- `mvp/scripts/init.sql`
- `mvp/.env.example`

Rationale: Docker gives the MVP a repeatable local database startup path without requiring every developer to install and configure Postgres manually. The init SQL should live under `mvp/scripts/` as an explicit project artifact, and connection defaults should be documented in `mvp/.env.example`.

### 7. What is the source of truth for `init.sql`?

Question: Should `mvp/scripts/init.sql` be generated from broad prose interpretation, or from a single schema source?

Decision: `diagrams/core-db-resource-ref-v0.mmd` is the only source of truth for the Day 3 `init.sql` table and column set.

The init script should also add indexes on the right columns needed by the documented schema and expected access patterns.

Rationale: The ERD is the locked schema source for this PoC/MVP step. Day 3 should not reopen schema design by freely combining prose into new columns or table shapes. Indexes are part of making the schema usable, but they should support documented keys, foreign keys, uniqueness, tenant scoping, and known lookup paths rather than inventing product behavior.

### 8. What index rules should Day 3 use?

Question: Because the ERD does not list every index explicitly, which indexes count as "right columns" for the Day 3 init script?

Decision: Add practical indexes for documented access paths and foreign-key joins, without optimizing speculative future product queries.

Rules:

- Primary keys rely on their implicit indexes.
- Foreign key columns get indexes unless already covered by a composite index.
- Tenant-scoped tables get `tenant_id`-leading indexes where useful for list/query paths.
- Documented unique lookups get unique indexes, including tenant slug, principal auth binding lookup, tenant module state lookup, tenant domain-event sequence, and action idempotency scope.
- ResourceRef-style target, subject, and source lookups get composite tenant-scoped indexes.
- Outbox worker claiming gets an index for pending/status plus availability.
- Search/data-access/reporting indexes stay basic unless the ERD names a clear lookup.

### 9. How should Docker run schema and seed SQL?

Question: Should `init.sql` include demo seed data, and should Docker or a manual script run initialization?

Decision: Separate schema and seed data.

Required files and behavior:

- `mvp/scripts/init.sql` contains schema only.
- `mvp/scripts/seed.sql` contains demo tenant, legal entity, principal, auth binding, tenant module states, and any Day 3 fixture data.
- `mvp/docker-compose.yml` mounts `./scripts/init.sql` into `/docker-entrypoint-initdb.d/001-init.sql` so a fresh Postgres volume initializes automatically.
- `pnpm db:reset` should be the authoritative repeatable reset path: destroy the DB volume and recreate it so Docker's init path runs again.
- `pnpm db:seed` should apply demo data separately.
- `pnpm db:init` may exist for an already-running empty database, but normal local reset should not depend on it.

Rationale: Schema and demo fixtures have different lifecycles. Keeping them separate lets future tests initialize schema without demo data and makes the reset behavior explicit.

### 10. Should Day 3 use a BetterAuth stub or real BetterAuth?

Question: Since `mvp/` has no BetterAuth implementation yet, is a strict BetterAuth-shaped stub acceptable for Day 3?

Decision: No. Day 3 should use real self-hosted BetterAuth backed by Postgres.

Rationale: The PoC is meant to prove the real authentication-to-principal boundary, not only the shape of that boundary. BetterAuth owns authentication/session mechanics; Core owns the Principal Auth Binding that resolves the authenticated BetterAuth subject to an OntOS Principal.

### 11. Where do BetterAuth tables live?

Question: If `mvp/scripts/init.sql` uses the ERD as the OntOS schema source of truth, where should BetterAuth's own tables be defined?

Decision: BetterAuth uses the same Postgres database for now, and its local MVP tables are initialized by `mvp/scripts/init.sql` in the `auth` schema.

Required behavior:

- `mvp/scripts/init.sql`: OntOS schema from the ERD plus BetterAuth's required local tables in `auth`.
- `mvp/scripts/seed.sql`: demo seed data after the schema is available.

The ERD remains the source of truth for OntOS tables only. BetterAuth is the explicit exception because it owns its own authentication/session persistence model.

Rationale: Day 3 now uses a scratch-only database bootstrap. Keeping the auth table definitions in `init.sql` makes a fresh local database deterministic without a separate schema-management step.

### 12. Should Day 3 use real SpiceDB or a strict fake?

Question: Should Day 3 run real SpiceDB in Docker, or use a strict SpiceDB-shaped fake?

Decision: Use real SpiceDB in Docker.

Required behavior:

- Add a SpiceDB service to `mvp/docker-compose.yml`.
- Add a minimal SpiceDB schema under `mvp/scripts/spicedb/`.
- Add relationship setup for the demo tenant/principal/module-action permission.
- Add scripts to write the SpiceDB schema and seed relationships.
- Core authorization uses a real SpiceDB-backed adapter.

Rationale: SpiceDB is a foundation-level authorization decision. Day 3 should expose real integration friction early rather than proving authn with real BetterAuth while leaving authz as a fake. The SpiceDB model must remain small and access-focused; it must not mirror the business ontology.

### 13. What must the Day 3 SpiceDB proof demonstrate?

Question: What authorization scenarios must Day 3 prove?

Decision: Day 3 must prove both variants:

- an authenticated OntOS Principal is allowed to do something.
- an authenticated OntOS Principal is not allowed to do something.

Required authorization-check scenarios:

- `demo-admin` has module write permission for `property.registry`.
- `demo-admin` does not have module write permission for `accounting.core`.
- `demo-viewer` does not have module write permission for `property.registry`.
- two BetterAuth logins map into two different tenants so SpiceDB access is proven tenant-scoped, not only module-scoped.

Exact seed model:

- Tenants: `tenant-a`, `tenant-b`.
- BetterAuth users: `demo-admin-a`, `demo-viewer-a`, `demo-admin-b`.
- Principal Auth Bindings:
  - `demo-admin-a` resolves to a Principal in `tenant-a`.
  - `demo-viewer-a` resolves to a Principal in `tenant-a`.
  - `demo-admin-b` resolves to a Principal in `tenant-b`.
- Legal entities:
  - `tenant-a-main-legal-entity`.
  - `tenant-b-main-legal-entity`.
- Module states:
  - `property.registry` active in both tenants.
  - `accounting.core` active in both tenants.
- SpiceDB relationships:
  - `demo-admin-a` has module write permission for `property.registry` in `tenant-a`.
  - `demo-admin-a` does not have module write permission for `accounting.core` in `tenant-a`.
  - `demo-viewer-a` does not have module write permission for `property.registry` in `tenant-a`.
  - `demo-admin-b` has module write permission for `property.registry` in `tenant-b`.
  - `demo-admin-b` does not have module write permission for `property.registry` in `tenant-a`.

Rationale: A single allowed path does not prove fail-closed authorization. The PoC must show both allow and deny behavior through real SpiceDB checks, with denial happening before a private handler can run.

### 14. Should Day 3 perform canonical business writes?

Question: Should Day 3 write any module-owned business/canonical data?

Decision: No. Day 3 performs setup and gate checks only.

Day 3 may initialize schema, seed data, authenticate users, resolve context, check module write permission, check module state, check policy, and display results. After setup/seed, Day 3 runtime checks must not write canonical rows, Action rows, audit rows, domain events, outbox messages, or other application evidence rows. The first runtime canonical module-owned write should happen on Day 4 through `property.registry.createUnit`.

Rationale: Day 3 proves foundations and access gates. Day 4 proves Action execution and canonical writes.

### 15. How should the UI switch between demo principals?

Question: With real BetterAuth, should the Day 3 UI use a fake principal dropdown or real authenticated demo users?

Decision: Seed real BetterAuth demo users and expose simple demo login buttons:

- sign in as `demo-admin`
- sign in as `demo-viewer`
- sign in as a second-tenant demo user
- sign out

Scenario buttons use the current BetterAuth session. They must not set the OntOS Principal directly.

Rationale: This keeps the proof honest. BetterAuth resolves the authenticated subject, Core maps that subject through Principal Auth Binding to an OntOS Principal, and SpiceDB checks authorization for that Principal.

### 16. Is a BetterAuth user global across tenants?

Question: Can one BetterAuth user belong to multiple OntOS tenants, or does one BetterAuth user belong to exactly one tenant?

Decision: One BetterAuth user belongs to exactly one OntOS tenant in the current product model.

If the same real person needs access to multiple tenants, they use separate tenant-scoped BetterAuth user accounts. This was added to `CONTEXT.md` as `Tenant-Scoped BetterAuth User`.

Rationale: This removes the ambiguous tenant-scoped auth binding problem for the current product model. Context resolution can resolve the tenant from the authenticated BetterAuth user binding instead of asking the UI to disambiguate multiple tenant memberships for one user.

### 17. Should Shell show a tenant selector on Day 3?

Question: Given one BetterAuth user belongs to exactly one tenant, should Shell expose a tenant selector?

Decision: No selector. Shell must visibly display the resolved tenant on the page so the user can confirm the current tenant context.

Rationale: A selector would imply multi-tenant switching for one BetterAuth user, which is not the current product model. Visible read-only tenant context still supports the Day 3 proof and makes tenant-scoped authz behavior inspectable.

### 18. Should Shell show legal entity context on Day 3?

Question: Should the legal entity also be visible, and how is it selected?

Decision: Shell should visibly display the resolved legal entity as read-only context. Each Day 3 demo tenant has one seeded legal entity, so Core can resolve it automatically.

Rationale: Legal entity is part of the runtime context for future Actions. Day 3 should make it visible without adding selector UX.

### 19. Where should Day 3 runtime services live?

Question: Should context, BetterAuth, SpiceDB, module-state, and policy code live in Shell, in a MicroVertical, or in a Core package?

Decision: Add `mvp/packages/core-runtime` as the Day 3 home for Core runtime services.

Core runtime owns:

- BetterAuth configuration and integration helpers.
- Principal Auth Binding resolution.
- tenant/legal-entity context resolution.
- module-state reader and gate.
- SpiceDB authorization adapter.
- policy gate.
- shared Day 3 scenario result types.

MicroVerticals may import public Core runtime APIs, but they must not import DB table internals, BetterAuth internals, or SpiceDB clients directly.

Rationale: Core is the kernel/runtime layer, not a business MicroVertical. Putting this logic inside `property.registry` or `accounting.core` would prove the wrong boundary.

### 20. Where should the Day 3 UI scenario harness live?

Question: Should auth/context controls and gate-test buttons all live in one MicroVertical, or should they be split by ownership?

Decision: Split them.

Shell owns app-wide auth and context display:

- current BetterAuth session.
- resolved OntOS Principal.
- selected demo tenant.
- selected demo legal entity.
- sign in as `demo-admin`.
- sign in as `demo-viewer`.
- sign in as a second-tenant demo user.
- sign out.

`accounting.core` owns gate-test scenario buttons:

- check `property.registry` write as the current user.
- check `accounting.core` write as the current user.
- run missing-context scenario.
- run policy-denied scenario.
- run validation-denied scenario.

`property.registry` stays focused on the later Day 4 success-path Action button.

Rationale: Shell owns global identity/context visibility. `accounting.core` remains the probe MicroVertical for negative and gate scenarios.

### 21. Where should Day 3 gate logic execute?

Question: Can Day 3 scenario buttons evaluate permission/context/policy logic in the browser?

Decision: No. All meaningful Day 3 logic runs on the server through Core runtime APIs.

The browser may render buttons and results only. Server-side Core runtime code resolves the BetterAuth session, Principal Auth Binding, tenant, legal entity, SpiceDB authorization, module state, and policy decision.

Rationale: Permission, context, and policy decisions are security-sensitive runtime behavior. Client code must not become the source of truth for access decisions.

### 22. What server invocation surface should Day 3 use?

Question: How should browser buttons call server-side Core runtime checks in the UltraModern MVP?

Decision: Use the UltraModern/Effect BFF-style server surface from the Shell app. Shared request/response contracts belong in `@mvp/shared-effect-api`; server implementation calls `@mvp/core-runtime`.

Day 3 call shape:

```text
UI button
  -> typed Effect/BFF client
    -> Shell server handler
      -> @mvp/core-runtime
        -> BetterAuth session
        -> Principal Auth Binding
        -> Postgres context/module-state
        -> SpiceDB check
        -> policy gate
      -> typed result
  -> UI renders result
```

Rationale: This matches the existing UltraModern/Effect direction in the docs and keeps security-sensitive logic server-side.

### 23. Should Day 3 server handlers live in Shell or MicroVerticals?

Question: Should Day 3 expose server handlers from Shell only, or from each MicroVertical?

Decision: Shell only for Day 3.

Rationale: Day 3 proves Core platform gates, not module-owned business APIs. Shell can host demo auth/context/scenario handlers and call Core runtime. Day 4 can prove registered Action dispatch into vertical handlers.

### 24. Which Day 3 server operations are required?

Question: Which server operations should the Shell BFF expose for Day 3?

Decision: Expose six Day 3 operations:

1. `signInDemoUser`
   - input: `userKey: "demo-admin-a" | "demo-viewer-a" | "demo-admin-b"`
   - output: current session/context summary
2. `signOutDemoUser`
   - input: none
   - output: signed-out context summary
3. `getCurrentRuntimeContext`
   - input: none
   - output: BetterAuth user, OntOS Principal, tenant, legal entity, and module states for `property.registry` and `accounting.core`
4. `checkModuleWritePermission`
   - input: tenant key and module key
   - output: allowed/denied, reason/stage, resolved principal/tenant/module summary
5. `checkModuleStateGate`
   - input: module key and requested write operation marker
   - output: allowed/denied, current module state, reason
6. `checkPolicyGate`
   - input: scenario key such as `allow` or `deny`
   - output: allowed/denied and policy reason

Rationale: These operations cover Day 3 setup proof, context proof, authorization proof, module-state proof, and policy proof without introducing Actions, audit, outbox, or canonical writes.

### 25. Should Day 3 use Effect for server contracts and checks?

Question: Should Day 3 use loose TypeScript types for server operation payloads, or Effect Schema and Effect programs?

Decision: Use Effect.

Rules:

- Define Day 3 server operation request/response contracts with Effect Schema in `@mvp/shared-effect-api`.
- Implement Core checks as Effect programs in `@mvp/core-runtime`.
- BFF handlers run the Effect programs and return serializable results to React.
- Expected denial is represented as a typed decision result, not as an untyped thrown exception.
- Unexpected system failures may still surface as errors.

Rationale: This matches the OntOS design direction: Effect Schema for runtime boundaries and Effect for visible server-side dependencies/errors.

### 26. How should Effect dependencies be declared?

Question: Should Day 3 rely on transitive/root Effect availability, or declare `effect` in every package that imports it?

Decision: Declare `effect` explicitly in each package that imports it.

For Day 3:

- `@mvp/shared-effect-api` should depend on `effect`.
- `@mvp/core-runtime` should depend on `effect`.
- `@mvp/shell-super-app` should depend on `effect` if its BFF handler files import or run Effect directly.
- Keep the version aligned with existing verticals: `4.0.0-beta.66`.

Rationale: Workspace package boundaries should be honest. Packages must declare the runtime libraries they import.

### 27. What is RuntimeContext?

Question: What exactly does `RuntimeContext` mean in Day 3?

Decision: `RuntimeContext` is the server-side resolved execution context containing the current BetterAuth user/session summary, OntOS Principal, Tenant, and Legal Entity.

It is not React context, a global mutable singleton, a tenant selector, or a browser-side state object.

For Day 3, Core resolves `RuntimeContext` from:

1. BetterAuth session/user.
2. Principal Auth Binding.
3. OntOS Principal.
4. Tenant.
5. Legal Entity.

Shell displays the resolved RuntimeContext read-only so the user can visually confirm the current principal, tenant, and legal entity. Day 4 `executeAction` will require this context before an Action can run.

Rationale: Core needs one consistent server-side execution context so authn, tenant isolation, legal-entity scope, authorization, policy, and later audit/action runtime do not pass around unrelated raw ids.

### 28. What package/export shape should Core runtime use?

Question: What should the new Core runtime package be named and what should it export for Day 3?

Decision: Add `mvp/packages/core-runtime` named `@mvp/core-runtime`.

Day 3 exports:

```json
{
  ".": "./src/index.ts",
  "./auth": "./src/auth/index.ts",
  "./context": "./src/context/index.ts",
  "./authorization": "./src/authorization/index.ts",
  "./module-state": "./src/module-state/index.ts",
  "./policy": "./src/policy/index.ts"
}
```

Core runtime owns these Day 3 areas:

- `./auth`: BetterAuth config/helpers and Principal Auth Binding resolution.
- `./context`: `RuntimeContext` and `resolveRuntimeContext`.
- `./authorization`: SpiceDB adapter and module write permission check.
- `./module-state`: module-state gate.
- `./policy`: trivial policy gate.

Rationale: Shell BFF needs a stable Core import surface, while Core internals such as DB queries, BetterAuth wiring details, and SpiceDB client setup should remain private.

### 29. What DB access path should Day 3 use?

Question: Should Day 3 merely spike Drizzle, or should runtime code actually use it?

Decision: Day 3 must use Drizzle for OntOS/Core runtime reads used by context resolution and module-state gates.

Rules:

- BetterAuth may use its standard PostgreSQL adapter path.
- OntOS/Core runtime reads should use Drizzle.
- `@effect/sql-drizzle` should be tested by running or wrapping those Drizzle operations in Effect.
- `mvp/scripts/init.sql` and `mvp/scripts/seed.sql` remain raw SQL files.
- At minimum, Day 3 needs Drizzle definitions for the tables used by runtime reads:
  - `core_tenants`
  - `core_legal_entities`
  - `core_principals`
  - `core_principal_auth_bindings`
  - `core_tenant_module_states`
- Defining additional ERD tables in Drizzle is optional for Day 3 unless it is straightforward.

Rationale: The PoC must evaluate Drizzle with real Core runtime usage, not only as a disconnected experiment.

### 30. Where should Drizzle schema and queries live?

Question: Should Drizzle schema definitions be shared broadly or kept inside Core runtime?

Decision: Keep Drizzle schema/client/query files private inside `@mvp/core-runtime`.

Suggested layout:

```text
mvp/packages/core-runtime/src/db/
  client.ts
  schema.ts
  queries.ts
```

Only Core runtime imports these files. Shell and MicroVerticals should call Core runtime APIs instead of importing database schema or queries directly.

Rationale: Core owns tenant, principal, auth binding, and module-state data access. Exposing Drizzle internals outside Core would weaken the boundary Day 3 is trying to prove.

### 31. How should BetterAuth demo users be seeded?

Question: Should BetterAuth demo users be inserted with raw SQL, or created through BetterAuth APIs/tooling?

Decision: Use the best standard BetterAuth-compatible path discovered during implementation, with a strong preference for BetterAuth APIs/tooling over raw inserts into BetterAuth-owned tables.

Rules:

- Do not guess BetterAuth table internals if BetterAuth exposes a supported create-user/sign-up path.
- `mvp/scripts/seed.sql` may seed OntOS-owned tables.
- A TypeScript seed helper may create BetterAuth users and then write OntOS Principal Auth Binding rows using the resulting BetterAuth user ids.
- Raw inserts into BetterAuth-owned tables are fallback only and must be documented in Day 3 evidence if used.

Rationale: BetterAuth owns authentication/session persistence. The PoC should use its standard behavior where possible instead of hand-maintaining auth internals.

### 32. How should demo credentials be handled?

Question: Do Day 3 demo email/password values need to be predetermined in architecture docs?

Decision: No. The implementer may choose local-only demo credentials, but they must be recorded in the Day 3 implementation summary so the team can find and use them.

Rationale: The exact local demo credentials are not architectural. Discoverability matters, so they belong in the implementation summary/evidence, not in the glossary or ADRs.

### 33. Where should the Day 3 implementation summary live?

Question: Should the Day 3 implementation summary live inside `mvp/` or at the repository root?

Decision: Create the Day 3 implementation summary at the repository root.

Recommended path:

```text
21_DAY_3_IMPLEMENTATION_SUMMARY.md
```

The summary should include Docker commands, DB connection/env names, schema initialization command, seed command, demo credentials, SpiceDB schema/seed command, scenario descriptions, what was proven, what failed or was deferred, and recommendations for SQL/Drizzle, BetterAuth, and SpiceDB.

Rationale: The project architecture and handoff documents live at the repository root, so Day 3 evidence should be discoverable alongside them.

### 34. Should README files be updated on Day 3?

Question: Should Day 3 only create the root implementation summary, or also update README documentation?

Decision: Update README documentation where meaningful as part of Day 3.

At minimum:

- `mvp/README.md` should document durable local run/setup commands for the database, BetterAuth, SpiceDB, seed data, and dev server once implemented.
- `21_DAY_3_IMPLEMENTATION_SUMMARY.md` should contain Day 3 evidence, demo credentials, decisions, failures, and recommendations.

Root `README.md` may be updated if a pointer to the new Day 3 summary or changed reading order is useful.

Rationale: The database/auth/authz startup flow becomes part of how developers run the MVP locally. It should not live only in a one-off evidence summary.

### 35. What is the Day 3 done checklist?

Decision: Day 3 is done when:

1. `pnpm install` succeeds after new dependencies.
2. `pnpm db:reset` starts Postgres and applies OntOS schema.
3. BetterAuth tables initialize in the same Postgres database.
4. Seed command creates tenants, legal entities, principals, bindings, module states, BetterAuth demo users, and SpiceDB relationships.
5. SpiceDB runs in Docker and has schema plus relationships loaded.
6. `pnpm check` passes, or any failing gate is documented with exact reason.
7. `pnpm dev` runs.
8. Shell shows the signed-in BetterAuth user, resolved OntOS Principal, tenant, and legal entity.
9. Scenario buttons show expected results:
   - `demo-admin-a` has module write permission for `property.registry` in `tenant-a`.
   - `demo-admin-a` does not have module write permission for `accounting.core` in `tenant-a`.
   - `demo-viewer-a` does not have module write permission for `property.registry` in `tenant-a`.
   - `demo-admin-b` has module write permission for `property.registry` in `tenant-b`.
   - `demo-admin-b` does not have module write permission for `property.registry` in `tenant-a`.
   - module-state deny works.
   - policy deny works.
10. No runtime Action, audit, outbox, domain-event, evidence, or canonical business writes happen.
11. `21_DAY_3_IMPLEMENTATION_SUMMARY.md` exists.
12. Meaningful README documentation is updated.
