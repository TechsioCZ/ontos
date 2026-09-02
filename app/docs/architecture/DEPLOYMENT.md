# Deployment Architecture and Release Playbook

This document is the authoritative release guidance for OntOS application delivery. It applies to
deployment configuration, CI/CD, PostgreSQL and SpiceDB changes, runtime packaging, Shell changes,
and every new or changed MicroVertical.

The rules exist because the first Zerops stage rollout was merged after source-level validation and
then required 43 linear repair commits. Stage had become the first production-shaped integration
test. Future releases must prove the target artifact and the distributed user journey before
promotion.

## Release invariants

These are non-negotiable:

1. **Topology is the delivery inventory.** Every deployable `appId`, service, package path, port,
   readiness route, public URL, migration owner, dependency edge, and Shell remote must derive from
   one generated or mechanically validated topology contract. Do not add a second hand-maintained
   registry.
2. **Build once, promote unchanged.** A release deploys immutable artifacts identified by source SHA
   and digest. Do not rebuild the same revision separately for stage and production.
3. **Prove the real artifact.** A successful source build is not a deploy test. CI must build,
   materialize, install, start, and probe the same runtime artifact shape used by the provider.
4. **Providers precede consumers.** Migrations and compatible authorization schema precede
   MicroVertical services; referenced MicroVertical remotes precede Shell; activation follows all
   deployed smoke tests.
5. **Installation is not activation.** Deploy a new MicroVertical dark. Tenant module state is the
   authoritative release flag and defaults inactive until canary verification succeeds.
6. **Every overlap is backward compatible.** Database, authorization, manifest, BFF, Module
   Federation, and Shell/MicroVertical boundaries must work while old and new versions coexist.
7. **Rollback is prepared before rollout.** Record a last-known-good immutable artifact for every
   affected delivery unit. Application rollback must not depend on reversing a schema migration.
8. **One failed gate stops promotion.** Preserve the artifact and evidence, reproduce in the parity
   environment, fix the failure class, and rerun the release sequence from its first gate.
9. **Continuous product delivery is not customer version pinning.** OntOS controls promotion of
   immutable artifacts. Customer Configuration selects permitted modules/implementations and
   activation state, never a separate whole-product release line.

## Delivery-unit contract

A new MicroVertical is not deployable until its delivery contract accounts for all of these fields:

- topology `appId`, dotted Module Contract Identity `moduleId`, and explicit `implementationId`,
  kept distinct;
- package name and workspace-relative owner path;
- provider service/setup identity and environment service-ID key;
- build and runtime Node/pnpm versions;
- declared `PORT`, service-specific port variable, and readiness route;
- immutable artifact build/materialization command;
- immutable build revision/digest, public-contract hash/version, and migration-set identity;
- owned PostgreSQL schema, Drizzle journal, migration, grant, and verifier commands;
- compatible SpiceDB schema requirements;
- public URL and module-manifest URL;
- Module Federation remote and required strict shared runtime cohort;
- Shell allowlist/composition dependency;
- change-impact rules;
- failure-log collection, smoke checks, and rollback target.

Codesmith or another approved generator must update these surfaces atomically. Until the generator
exists, do not add another copied Contacts block to the workflow, `zerops.yaml`, migration runner, or
validator. Extend and test the generator first.

Change planning must fail closed when a changed path under `apps/*`, `packages/*`, or `verticals/*`
cannot be mapped to known delivery units. An unknown new vertical must never produce a no-op deploy.

### Change-impact rules

The generated plan must conservatively include:

- an owner migration whenever the owner's Drizzle schema, migrations, migration config, or verifier
  changes;
- every consumer when a shared runtime package or public contract changes;
- SpiceDB whenever its schema, image, datastore bootstrap, transport, or client contract changes;
- Shell whenever its code/config changes or a referenced public remote URL/contract changes;
- a MicroVertical whenever its owner-local code, manifest, registration, migrations, configuration,
  or runtime dependencies change;
- all Node delivery units whenever the common lockfile, workspace dependency policy, runtime
  materializer, Node installer, or deployment manifest changes.

The deployment plan, not a hand-written `case` statement, is the reviewable output.

## Production-parity artifact gate

Before merge or promotion, build from a clean checkout with the frozen lockfile in a target-equivalent
Linux profile:

1. use the exact pinned Node and pnpm versions;
2. remove stale workspace `node_modules` links and host-global virtual-store state;
3. install into a project-local virtual store;
4. run each Modern.js Node build with bounded heap and dependency-trace concurrency;
5. materialize each generated `.output` into its final runtime package;
6. install production-only runtime dependencies outside the copied workspace tree;
7. reject build-host system/home paths and incompatible OS/CPU packages;
8. start every resulting artifact on its declared port;
9. probe readiness and the delivery unit's public contract;
10. publish the source SHA, artifact digest, dependency cohort, and gate result.

The artifact deployed later must match that digest. If the provider cannot accept a prebuilt
artifact, the provider build itself must emit and verify the digest and use an identical, pinned
build profile in every environment.

Commands run by agents, developers, and ordinary CI from `app/` use:

```bash
mise exec -- pnpm <command>
```

Commands embedded in a minimal provider image may use the deployment-pinned Node/pnpm bootstrap
when mise is deliberately absent. This is a narrow deployment-runtime exception, not permission to
run arbitrary local pnpm commands outside mise.

## Typed configuration preflight

Configuration validation happens before the first service changes. It must verify, without printing
secrets:

- all required project and service IDs;
- administrative and runtime PostgreSQL URLs use distinct identities;
- the configured canonical authentication origin and external protocol;
- SpiceDB endpoint, security mode, pre-shared-key presence, and environment restrictions;
- generic `PORT` and service-specific port variables agree with provider declarations;
- every MicroVertical public URL, module-manifest URL, and Shell remote URL;
- build-time deployment environment and source revision;
- gateway issuer/JWKS configuration and topology audiences;
- required dependency/patch versions and provider CLI version;
- readiness paths, timeouts, and retry periods with explicit units.

Do not infer the canonical authentication origin from a reverse-proxied request. Do not use a
runtime database identity for role, database, schema, or migration work. Do not silently fall back
to localhost or another environment.

## Migration and authorization sequence

### PostgreSQL

Every owner retains its own schema and Drizzle journal. Run the release phase in this order:

1. acquire the environment deployment lock;
2. run expand-only Core migrations with the administrative identity;
3. run expand-only Auth migrations;
4. run expand-only migrations for every affected MicroVertical in dependency order;
5. refresh least-privilege runtime grants after each owner migration;
6. run each owner verifier and the root exact schema/journal verifier;
7. prove the previous and candidate application versions can use the expanded schema.

Never share a migration journal between owners. Never omit a migration because only an owner-local
path changed. Never execute deployment migrations through an assumed workspace pnpm layout after
artifact relocation; use the verified owner-local runtime binary or an explicit migration artifact.

Destructive contraction is a later release after all old readers and writers are gone. Ordinary
rollback leaves additive schema changes in place.

### SpiceDB

Distinguish Authzed datastore migrations from the OntOS authorization schema. A datastore migration
does not publish a changed permission model.

For every authorization-schema change:

1. diff the currently deployed and candidate schema;
2. reject incompatible changes unless a staged compatibility plan is documented;
3. serialize the SpiceDB service upgrade so connection pools do not overlap;
4. apply the candidate authorization schema even when the database is already initialized;
5. verify representative existing and candidate permissions;
6. retain a compatible rollback plan for application versions and relationship writers.

Bootstrap files are only for an empty installation. They are not the ongoing authorization-schema
deployment mechanism.

The fail-closed Action authorization rollout uses an explicit expand/provision/verify/deploy gate:

1. deploy or run the candidate migration artifact while the previous runtime remains active;
2. ensure the two fixed stage contexts and their Tenant membership relationships already exist;
3. run `mise exec -- pnpm authorization:provision-current-actions` in the stage-gated artifact to
   publish the compatible schema and `TOUCH` 32 membership-set executor grants for the 16 current
   Actions across the two fixed stage Tenants;
4. verify every Action for both fixed stage Principals and verify a representative non-member is
   denied;
5. only then deploy the runtime that treats missing `action#execute` permission as denial;
6. smoke one provisioned Action and one deliberately unconfigured Action denial.

The command is operator-invoked, idempotent, accepts no scope arguments, and must not be attached to
PostgreSQL migrations, SpiceDB startup, application startup, or automatic deployment. A failure or
catalog mismatch blocks promotion. Rollback restores the previous application artifact while
leaving the additive schema and relationships in place.

### Stage/demo bootstrap

Stage bootstrap is an operator action, not a migration, startup hook, or automatic deploy step. It
must remain:

- limited to a fixed context set in source control;
- explicitly gated to stage;
- idempotent and conflict detecting;
- interactive or otherwise secret-safe;
- outside normal application startup;
- responsible only for the documented initial installation exception.

Every later canonical state change uses a typed Action.

## Compatibility rules

### Database and authorization

Use expand/deploy/contract. During a rolling overlap, both previous and candidate code must tolerate
the expanded PostgreSQL and SpiceDB models.

### Module contracts and BFFs

- Public contracts are versioned, bounded, and JSON-safe.
- Normalize values to serializable primitives before public schema validation.
- Test candidate Shell against the previous MicroVertical contract and candidate MicroVertical
  against the previous Shell contract.
- A dependency outage produces a typed unavailable/degraded state; it must not corrupt persisted
  module state or disable unrelated modules.
- Server-governed schemas stay server-local and use the Core Effect runtime. Do not reuse a client
  package's runtime schema object inside the governed server registration.
- A Customer Configuration resolves exactly one permitted healthy `implementationId` for each
  selected `moduleId`; reject missing, ambiguous, invisible, or contract-incompatible alternatives.
- Compatibility versions and immutable build revisions are rollout evidence, not customer-selectable
  product releases.

### Commerce applications

Follow [Commerce Application Boundaries](./COMMERCE_APPLICATIONS.md). Storefront Applications and
their local BFF/proxies deploy independently from OntOS. Promotion must verify each tenant-bound
Storefront Client, the separate Portal Account realm, native Commerce Storefront API contracts, and
any declared Medusa compatibility subset. Commerce Operations deploys as a purpose-built staff
consumer of public module contracts, not as Shell/Core business behavior.

### Module Federation and CSS

- React, Modern runtime, and provider-context packages such as i18n must be exact strict singletons
  on both Shell and remotes.
- Every app owns a CSS prefix/namespace. A Shell or MicroVertical build must not scan, erase, or
  collide with another delivery unit's utility classes.
- A remote is healthy only when its manifest, remote entry, chunks, shared runtime, localized page,
  and Shell integration all load successfully.

## Release sequence

Use this sequence for a new or changed MicroVertical:

1. **Plan:** generate the impacted delivery-unit graph from topology and capture compatibility,
   migration, flag, smoke, and rollback declarations.
2. **Preflight:** validate configuration and record last-known-good artifacts.
3. **Build:** produce and verify immutable target-shaped artifacts.
4. **Migrate:** expand PostgreSQL, refresh grants, verify schemas, then compatibly update SpiceDB
   and complete any required operator-controlled relationship provisioning before deploying a
   fail-closed consumer.
5. **Deploy providers:** deploy affected MicroVerticals in dependency order, initially dark.
6. **Expose providers:** verify readiness, module manifest, BFF, remote assets, and public endpoint;
   make endpoint provisioning idempotent by checking its final state.
7. **Deploy Shell:** deploy only after every referenced provider is healthy.
8. **Smoke:** execute the authenticated distributed smoke suite.
9. **Canary:** activate the selected module implementation and affected Storefront Clients for one
   approved tenant/cohort.
10. **Observe:** hold expansion until the canary window and required signals are healthy.
11. **Expand:** activate additional tenants gradually.
12. **Close:** record deployed digests, smoke evidence, and the new last-known-good set.

Do not report release success before all required smoke checks pass.

## Required smoke suite

Provider readiness alone is insufficient. The post-deploy release gate exercises:

- readiness for every affected service;
- PostgreSQL schema/journal/grant verification;
- candidate SpiceDB schema and representative permissions;
- Shell login and session resolution through the configured HTTPS origin;
- tenant and legal-entity selection;
- governed Shell composition and navigation;
- module-manifest fetch;
- Module Federation remote entry and chunk loading;
- localized MicroVertical rendering with shared i18n context;
- gateway assertion issuance and one authorized BFF read;
- logout redirect and cookie clearing;
- isolation of staff and Commerce Portal BetterAuth cookies/sessions;
- one Storefront Client plus anonymous, B2C, and B2B customer-context checks when Commerce is affected;
- implementation-selection and contract/build-skew rejection;
- native Commerce Storefront API and declared Medusa compatibility-route checks when present;
- basic responsive layout/CSS geometry;
- absence of unexpected browser errors and HTTP 5xx responses.

Run affected unit, integration, database, contract, and browser tests in CI as well. A root `/`
health probe cannot substitute for this suite.

## Observability

Observability is part of the deployable contract, not a response to a failed release.

Every deploy and smoke record includes:

- environment, source SHA, artifact digest, delivery-unit `appId`, and version;
- deployment phase, operation, correlation ID, start/end time, and duration;
- readiness/smoke result and stable failure code/stage;
- previous and candidate versions for rollback;
- bounded logs for the failing service and direct dependencies.

Automatically collect failed-service logs. Alert if the administrative migrator remains running
after the migration phase.

Never log credentials, signing material, cookies, raw assertions, complete tenant/composition
payloads, or unbounded schema diagnostics. Unexpected defects keep full internal Effect causes at
the owning server boundary with correlation context; public errors remain typed and sanitized.

## Rollback

Rollback must be executable and tested before rollout:

1. deactivate the affected tenant module state/canary;
2. stop further promotion;
3. identify the failed unit and the last successful phase from structured evidence;
4. restore Shell first when it references an invalid remote; otherwise restore units in reverse
   dependency order;
5. restore each affected unit to its recorded last-known-good artifact;
6. leave additive PostgreSQL and compatible SpiceDB changes in place;
7. rerun the complete authenticated smoke suite;
8. record the rollback artifacts and outcome.

If cleanup or endpoint provisioning returns an error, accept only a recognized idempotent state and
verify the final state. `continue-on-error` without final-state verification is not rollback or
idempotence.

## Pull-request and release hygiene

Every deploy-affecting PR includes a deployment-impact section containing:

- affected delivery units and dependency order;
- configuration/secrets additions and preflight evidence;
- PostgreSQL and SpiceDB compatibility classification;
- N/N-1 public contract evidence;
- installation and tenant-activation plan;
- immutable artifact digest and parity-gate result;
- smoke commands and expected signals;
- last-known-good versions and rollback commands;
- observability fields/dashboard location;
- generator changes required for future MicroVerticals.

Separate review concerns when useful—normally deployment generator/infrastructure, compatible
schema, application behavior, and activation—but assemble and prove one immutable release candidate
before merge. Do not merge a release and then use stage to discover one failure per follow-up PR.

After any failed rehearsal or rollout:

1. stop the train;
2. preserve the exact artifact, deployment plan, and logs;
3. reproduce the failure in the parity environment;
4. fix the entire failure class and add a regression test;
5. rebuild once and rerun the ordered gates from the beginning.

Use the CI provider's rerun or manual dispatch for a genuine retry. Do not create empty commits to
retrigger a pipeline.

## Historical failure map

These commits are retained as examples of the failure classes this playbook prevents:

- provider syntax and process semantics: `eb57b335`, `ef96d729`;
- minimal runtime, cache, home, and artifact relocation: `d3ccf9a8`–`66e08e50`;
- administrative database identity and serialized SpiceDB: `3dc494a8`, `a41d400f`;
- pnpm store contamination: `1e8e5dd3`, `6e4cc89e`, `900ff534`, `c32c8312`;
- dependency tracing, memory, host paths, OS/CPU, and generated plugin loading:
  `d394f133`–`ab978ab8`;
- ports and provider-before-Shell ordering: `46aced42`, `780d30f2`;
- stage contexts and idempotent endpoint setup: `112571c8`, `4329b058`;
- canonical auth origin and build-time stage discovery: `727a5c28`, `64b7f76b`;
- public schema/runtime normalization: `61f3d96d`, `a86503d0`, `8a09f710`, `3ebf0569`;
- federated i18n and CSS/runtime isolation: `1475532d`, `47e3ecb9`;
- missing diagnostics discovered during rollout: `18716eba`, `83f79b5d`–`9eef5a3f`.

When changing deployment behavior, convert the relevant historical failure into a permanent
automated contract test rather than relying on this list as institutional memory.
