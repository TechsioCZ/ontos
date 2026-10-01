# Deployment Architecture and Release Playbook

This playbook is the authoritative release guidance for OntOS application delivery. It covers deployment configuration, CI/CD, PostgreSQL and SpiceDB changes, runtime packaging, Shell changes, and every new or changed MicroVertical.

> [!IMPORTANT] Explicit `implementationId`, dependency-closure selection, public-contract hashes, migration-set identity, and full artifact metadata are accepted target architecture, not fields in the current manifest/catalog schema. Requirements below that name them become mandatory with that contract. Until then, releases use one implicit `standard` implementation per `moduleId` and the current generated `buildMarker`; do not simulate missing fields with ad hoc configuration.

Application Composition validation and stage publication are implemented; live Shell loading is not. After the delivery units deploy, the deploy workflow observes the deployed artifacts and publishes the active snapshot as the `ONTOS_ACTIVE_APPLICATION_COMPOSITION_SNAPSHOT_JSON` Zerops project variable, deploys the composition consumers on it, then publishes the complete inventory and restarts them; a scheduled workflow re-publishes it before it expires (see ADR-0020). Until #374–#377 wire those paths in, remote URL and generated lazy-registry changes still require Shell regeneration and redeployment. The composition promotion sequence below is the target flow.

The rules exist because the first Zerops stage rollout was merged after source-level validation and then required 43 linear repair commits. Stage had become the first production-shaped integration test. Future releases must prove the target artifact and the distributed user journey before promotion.

## Release invariants

These are non-negotiable:

1. **Topology is the delivery inventory.** Every deployable `appId`, service, package path, port, readiness route, public URL, and migration owner derives from one generated or mechanically validated topology contract. Application Composition separately governs the approved runtime module graph and exact contract/remote artifacts; neither tenant state nor a reachable service may add an artifact.
2. **Build once, promote unchanged.** A release deploys immutable artifacts identified by source SHA and digest. Do not rebuild the same revision separately for stage and production.
3. **Prove the real artifact.** A successful source build is not a deploy test. CI must build, materialize, install, start, and probe the same runtime artifact shape used by the provider.
4. **Providers precede consumers.** Migrations and compatible authorization schema precede MicroVertical services; referenced MicroVertical remotes precede Shell; activation follows all deployed smoke tests.
5. **Installation is not activation.** Deploy a new MicroVertical dark. Tenant module state is the authoritative release flag and defaults inactive until canary verification succeeds.
6. **Every overlap is backward compatible.** Database, authorization, manifest, BFF, Module Federation, and Shell/MicroVertical boundaries must work while old and new versions coexist.
7. **Rollback is prepared before rollout.** Record a previously validated immutable composition and artifact for every affected delivery unit. Rollback is an explicit audited promotion, never an automatic persistent fallback, and must not depend on reversing a schema migration.
8. **One failed gate stops promotion.** Preserve the artifact and evidence, reproduce in the parity environment, fix the failure class, and rerun the release sequence from its first gate.
9. **Continuous product delivery is not customer version pinning.** OntOS controls promotion of immutable artifacts. Customer Configuration selects permitted modules/implementations and activation state, never a separate whole-product release line.

## Delivery-unit contract

A new MicroVertical is not deployable until its delivery contract accounts for all of these fields:

- topology `appId` and dotted Module Contract Identity `moduleId`, kept distinct; add explicit `implementationId` when the accepted target contract is implemented;
- package name and workspace-relative owner path;
- provider service/setup identity and environment service-ID key;
- build and runtime Node/pnpm versions;
- declared `PORT`, service-specific port variable, and readiness route;
- immutable artifact build/materialization command;
- current immutable `buildMarker`, plus build revision/digest, public-contract hash/version, and migration-set identity when the target metadata contract is implemented;
- owned PostgreSQL schema, Drizzle journal, migration, grant, and verifier commands;
- compatible SpiceDB schema requirements;
- public URL and module-manifest URL;
- Module Federation remote and required strict shared runtime cohort;
- Shell allowlist/composition dependency;
- change-impact rules;
- failure-log collection, smoke checks, and rollback target.

Codesmith or another approved generator must update these surfaces atomically. Until the generator exists, do not add another copied Contacts block to the workflow, `zerops.yaml`, migration runner, or validator. Extend and test the generator first.

Change planning must fail closed when a changed path under `apps/*`, `packages/*`, or `verticals/*` cannot be mapped to known delivery units. An unknown new vertical must never produce a no-op deploy.

The stage plan diffs from the commit of the last successful `stage` deployment, not from the previous push, so a failed or cancelled deploy stays in the next plan. Planning stops when no successful deployment exists or its commit is not an ancestor of `main`; seed it once with `gh workflow run ultramodern-workspace-gates.yml --ref main -f full=true`.

### Change-impact rules

The generated plan must conservatively include:

- an owner migration whenever the owner's Drizzle schema, migrations, migration config, or verifier changes;
- every consumer when a shared runtime package or public contract changes;
- SpiceDB whenever its schema, image, datastore bootstrap, transport, or client contract changes;
- Shell whenever its code/config or contribution ABI changes, including remote URL and generated lazy-registry changes until the live composition loader is integrated. After that integration, compatible remote updates move through a new composition revision without redeploying Shell;
- a MicroVertical whenever its owner-local code, manifest, registration, migrations, configuration, or runtime dependencies change;
- all Node delivery units whenever the common lockfile, workspace dependency policy, runtime materializer, Node installer, or deployment manifest changes.

The deployment plan, not a hand-written `case` statement, is the reviewable output.

## Production-parity artifact gate

Before merge or promotion, build from a clean checkout with the frozen lockfile in a target-equivalent Linux profile:

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

The artifact deployed later must match that digest. If the provider cannot accept a prebuilt artifact, the provider build itself must emit and verify the digest and use an identical, pinned build profile in every environment.

Commands run by agents, developers, and ordinary CI from `app/` use:

```bash
mise exec -- pnpm <command>
```

Commands embedded in a minimal provider image may use the deployment-pinned Node/pnpm bootstrap when mise is deliberately absent. This is a narrow deployment-runtime exception, not permission to run arbitrary local pnpm commands outside mise.

## Typed configuration preflight

Configuration validation happens before the first service changes. It must verify, without printing secrets:

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

Do not infer the canonical authentication origin from a reverse-proxied request. Do not use a runtime database identity for role, database, schema, or migration work. Do not silently fall back to localhost or another environment.

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

Never share a migration journal between owners. Never omit a migration because only an owner-local path changed. The first v1 `drizzle-kit migrate` against a database migrated before the [Drizzle v1 upgrade](./DRIZZLE_V1_UPGRADE.md) adds `name` and `applied_at` columns to that owner's bookkeeping table and backfills `name`; it applies no schema migration and needs no manual step beyond the administrative identity. Never execute deployment migrations through an assumed workspace pnpm layout after artifact relocation; use the verified owner-local runtime binary or an explicit migration artifact.

Destructive contraction is a later release after all old readers and writers are gone. Ordinary rollback leaves additive schema changes in place.

### SpiceDB

Distinguish Authzed datastore migrations from the OntOS authorization schema. A datastore migration does not publish a changed permission model.

For every authorization-schema change:

1. diff the currently deployed and candidate schema;
2. reject incompatible changes unless a staged compatibility plan is documented;
3. serialize the SpiceDB service upgrade so connection pools do not overlap;
4. apply the candidate authorization schema even when the database is already initialized;
5. verify representative existing and candidate permissions;
6. retain a compatible rollback plan for application versions and relationship writers.

Bootstrap files are only for an empty installation. They are not the ongoing authorization-schema deployment mechanism.

The fail-closed Action authorization rollout uses an explicit expand/provision/verify/deploy gate:

1. prepare the candidate application/release artifact for the operator command while the previous runtime remains active; this is separate from the PostgreSQL migration artifact;
2. ensure the fixed stage contexts and their Tenant membership relationships already exist;
3. run `mise exec -- pnpm authorization:provision-current-actions` in the stage-gated artifact to publish the compatible schema and membership-set executor grants for the complete current Action catalog across the fixed stage Tenants;
4. verify every Action for the fixed stage Principals and verify representative non-members are denied;
5. only then deploy the runtime that treats missing `action#execute` permission as denial;
6. smoke one provisioned Action and one deliberately unconfigured Action denial.

The command is operator-invoked, idempotent, accepts no scope arguments, and must not be attached to PostgreSQL migrations, SpiceDB startup, application startup, or automatic deployment. A failure or catalog mismatch blocks promotion. Rollback restores the previous application artifact while leaving the additive schema and relationships in place.

Provisioning is additive, not stale-grant reconciliation. Before narrowing an Action from `tenant_membership_default` to `explicit`, the operator must prepare its intended narrow grants, remove the obsolete `action:<encoded-key>#executor@tenant:<fixed-tenant>#member` relation for each affected fixed Tenant, and verify both the intended allowed Principal and a Tenant member who must now be denied. Removed Actions and revoked role/workload assignments likewise require an explicit, reviewed removal of their obsolete executor relations. Derive Action object IDs with `toSpiceDbActionObjectId`; never delete unrelated tuples or rely on rerunning `TOUCH` to revoke access. Record and verify this policy-data transition before promotion. An application rollback must not silently restore a revoked grant; any policy restoration needs its own reviewed decision. The fixed environment's provisioning input records at least one allowed and one denied Principal assertion for every `explicit` Action. Promotion verifies every fixed context plus the representative non-member for each `tenant_membership_default` Action; it verifies only those recorded per-Action assertions for an `explicit` Action. Missing, duplicate, unknown, allow-only, or deny-only explicit assertion sets fail before schema or relationship writes.

### Stage/demo bootstrap

Stage bootstrap is an operator action, not a migration, startup hook, or automatic deploy step. It must remain:

- limited to a fixed context set in source control;
- explicitly gated to stage;
- idempotent and conflict detecting;
- interactive or otherwise secret-safe;
- outside normal application startup;
- responsible only for the documented initial installation exception.

Every later canonical state change uses a typed Action.

## Compatibility rules

### Database and authorization

Use expand/deploy/contract. During a rolling overlap, both previous and candidate code must tolerate the expanded PostgreSQL and SpiceDB models.

### Module contracts and BFFs

- Public contracts are versioned, bounded, and JSON-safe.
- Normalize values to serializable primitives before public schema validation.
- Test candidate Shell against the previous MicroVertical contract and candidate MicroVertical against the previous Shell contract.
- A dependency outage produces a typed unavailable/degraded state; it must not corrupt persisted module state or disable unrelated modules.
- Server-governed schemas stay server-local and use the Core Effect runtime. Do not reuse a client package's runtime schema object inside the governed server registration.
- Once explicit alternatives are supported, a Customer Configuration resolves exactly one permitted healthy `implementationId` for each selected `moduleId` and rejects missing, ambiguous, invisible, or contract-incompatible alternatives. Until then, one implicit `standard` implementation exists.
- Compatibility versions and immutable build revisions are rollout evidence, not customer-selectable product releases.

### Commerce applications

Follow [Commerce Application Boundaries](./COMMERCE_APPLICATIONS.md). Storefront Applications and their local BFF/proxies deploy independently from OntOS. Promotion must verify each tenant-bound Storefront Client, the separate Portal Account realm, native Commerce Storefront API contracts, and any declared Medusa compatibility subset. Commerce Operations deploys as a purpose-built staff consumer of public module contracts, not as Shell/Core business behavior.

### Module Federation and CSS

- React, Modern runtime, and provider-context packages such as i18n must be exact strict singletons on both Shell and remotes.
- Promoted compositions pin immutable `mf-manifest.json` references and permit browser execution only. Routine upgrades wait for a new browser document; they never force-replace a loaded remote.
- Shell/Core SSR renders stable framing and typed placeholders. Any future MicroVertical SSR runs in a MicroVertical-owned isolated process, not the Shell/Core Node.js process.
- Every app owns a CSS prefix/namespace. A Shell or MicroVertical build must not scan, erase, or collide with another delivery unit's utility classes.
- A remote is healthy only when its manifest, remote entry, chunks, shared runtime, localized page, and Shell integration all load successfully.

## Release sequence

Use this sequence for a new or changed MicroVertical:

1. **Plan:** generate the impacted delivery-unit graph from topology and capture compatibility, migration, flag, smoke, and rollback declarations.
2. **Preflight:** validate configuration and record last-known-good artifacts.
3. **Build:** produce and verify immutable target-shaped artifacts.
4. **Migrate:** expand PostgreSQL, refresh grants, verify schemas, then compatibly update SpiceDB and complete any required operator-controlled relationship provisioning before deploying a fail-closed consumer.
5. **Deploy providers:** deploy affected MicroVerticals in dependency order, initially dark.
6. **Expose providers:** verify readiness, module manifest, BFF, remote assets, and public endpoint. Stage public subdomains are declared at service creation in `zerops-import.yaml`, never re-enabled per deploy.
7. **Promote composition:** validate and explicitly promote one immutable candidate revision. A compatible MicroVertical update or installation does not redeploy Shell.
8. **Smoke:** open a new browser document pinned to that revision and execute the authenticated distributed smoke suite.
9. **Canary:** activate the selected module—and its explicit implementation once supported—plus affected Storefront Clients for one approved tenant/cohort.
10. **Observe:** hold expansion until the canary window and required signals are healthy.
11. **Expand:** activate additional tenants gradually.
12. **Close:** record deployed digests, smoke evidence, and the new last-known-good set.

Do not report release success before all required smoke checks pass.

### Deploy target per environment

One workflow deploys every GitHub deployment environment. Each environment chooses where its
delivery units run with its `DEPLOY_TARGET` variable, and how its Outbox Workers run on Zerops with
its required `OUTBOX_WORKER_MODE` variable (`dedicated` or `host`, see
[Outbox Workers](./OUTBOX_WORKERS.md)). The two are independent:

| Environment  | `DEPLOY_TARGET`   | What deploys                                                                                                                                                                                                                          |
| ------------ | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stage`      | unset or `zerops` | The whole Zerops topology: migrator, SpiceDB, every vertical, its outbox worker and the Shell, each with its own `ZEROPS_*_SERVICE_ID`. Placed units also deploy as Workers when the edge deploy is configured (a shadow deployment). |
| `stage`      | `cloudflare`      | On Zerops only the migrator, SpiceDB and the outbox workers; every placed unit as a Cloudflare Worker (`deploy-cloudflare`).                                                                                                          |
| `production` | unset or `zerops` | The whole Zerops topology from `production`'s own variables and secrets. `cloudflare` is rejected: only stage has an edge deploy history (`stage-edge`) and a reviewed edge build environment.                                        |

The deployment planner always emits both plans from the same topology: the Zerops phases (`phases`,
`units.providers` with each vertical's outbox worker, `units.shell`, `units.workers`) and the edge
units (`units.cloudflare`). The workflow picks by target, so neither path depends on the other and
tests assert both for the same diffs. Nothing on the Zerops path is removed for the Cloudflare
target: `zerops.yaml`, `zerops-import.yaml`, the generators, the materializers and the push script
keep deploying every environment that targets Zerops.

| Environment  | `OUTBOX_WORKER_MODE` | Outbox Workers on Zerops                                                         |
| ------------ | -------------------- | -------------------------------------------------------------------------------- |
| `stage`      | `host`               | Every owner's worker in the one `outbox-worker-host` process, the cheap choice.  |
| `production` | `dedicated`          | One `<owner>-worker` service per owner, deployed and failing independently (HA). |

Before the Cloudflare cut-over stage runs `dedicated`, the workers it has today; `cloudflare-stage-cutover.mts
activate` switches it to `host` beside `DEPLOY_TARGET=cloudflare`. A preview or demo environment on
Zerops can equally run `host`.

`deploy-target` reads `DEPLOY_TARGET`, `OUTBOX_WORKER_MODE`, `ZEROPS_PROJECT_ID` and the `ZEROPS_TOKEN`
secret from the deploying environment without creating a deployment. An invalid target or mode fails
the run, and so does a configured environment without `OUTBOX_WORKER_MODE`: it has no default. An
environment without its Zerops project or token deploys nothing and records nothing. `deploy-plan`
then plans in that environment from the environment's last successful deployment and promotes
authorization for that environment (`--authorization-environment`), so production needs its own
enforced authorization evidence and context. `deploy-migrations` runs the planned migrations and
SpiceDB deploy, and `deploy-zerops`, the environment's one deployment record, deploys the rest. Pushes to `main` deploy `stage`. Production deploys
only on an explicit dispatch:

```sh
gh workflow run ultramodern-workspace-gates.yml --ref main -f environment=production -f full=true
```

Create `production` once, outside CI, before the first dispatch, with the operator script in
[Create production](#create-production). Leave `DEPLOY_TARGET` unset or `zerops`, and keep
`OUTBOX_WORKER_MODE=dedicated`, which the script records. The first production deploy has no base, so dispatch it with `full=true`.

`zerops.yaml` describes stage. Before any push, `deploy-migrations` and `deploy-zerops` write a copy that sets
`ULTRAMODERN_DEPLOYMENT_ENVIRONMENT` to the deploying environment in every build and runtime that
names it (`pnpm zerops:materialize-environment`), and every `zcli push` reads that copy. Production
therefore never runs stage-only behaviour. Every runtime reaches SpiceDB over TLS gRPC and pins
`SPICEDB_CA_CERT`, which `zerops.yaml` takes from the `spicedb` service's `SPICEDB_GRPC_TLS_CERT`
secret; there is no plaintext mode. Production's copy sets every `SPICEDB_ENDPOINT` to production's
`SPICEDB_ENDPOINT` variable, so production's SpiceDB gRPC certificate must name that host. A
production deploy without that variable fails before it pushes anything. The
scheduled composition refresh has a `refresh-production` lane beside `refresh-stage`, in production's
own environment and `zerops-production` concurrency group; it publishes nothing until production is
configured and has deployed once.

The composition publisher resolves each unit's public origin by target: the Zerops subdomain of its
service on `zerops`, and on `cloudflare` the Worker URL its edge build is given
(`ULTRAMODERN_PUBLIC_URL_<UNIT>` in the placement `buildEnvironment`). On `cloudflare` it restarts
only the consumers that remain on Zerops (the Outbox Workers of the environment's mode). `deploy-zerops` does not publish
on `cloudflare`, because a new or moved Worker is unobservable until `deploy-cloudflare` ships it;
`publish-edge-composition` publishes from the new Workers afterwards. A placed Worker that consumes
the snapshot (Commerce Customer Context) has no Zerops project variable, and the snapshot outgrows
a Worker secret's 5.1 kB limit. Every placed Worker binds the stage composition KV namespace as
`ONTOS_ACTIVE_APPLICATION_COMPOSITION` and reads key `active` on each request, failing closed when
the binding or key is missing. `sync-edge-composition`, and `refresh-stage-edge` after each
scheduled refresh, write every publication to that key from `stage-edge`
(`scripts/put-edge-composition-snapshot.sh`). Writing the key deploys nothing.

Switching stage between targets is one variable: set `DEPLOY_TARGET` on `stage` and dispatch
`full=true`. Its other variables and secrets never change. A stage on `cloudflare` whose edge deploy
is not configured fails in `edge-deploy-readiness`, before anything changes on Zerops.

### Edge units on Cloudflare Workers

`topology/cloudflare-placement.json` lists the delivery units CI also ships as Cloudflare Workers;
each needs a `cloudflare.workerName` in the reference topology, and its Worker configuration must be
deployable on its own. Every vertical (UI and headless API) and the Shell are placed, so every
Worker the Shell binds as a service is placed too. The deployment planner emits the placed,
impacted units as `units.cloudflare` in dependency order (providers before Shell).

The edge deploy runs only for `stage`, and only when it is configured (below). On the `zerops` target
it is additive; on the `cloudflare` target it is how the placed units reach stage.
In the `host` Outbox Worker mode, whatever the target, `deploy-zerops` deploys the one
`outbox-worker-host` service (`ZEROPS_OUTBOX_WORKER_HOST_SERVICE_ID`) instead of each owner's
dedicated worker service; see [Outbox Workers](./OUTBOX_WORKERS.md). The run that deploys one mode's
workers stops the other mode's. A switch changes no source, so each deploy first checks whether the
other mode's workers still run or this mode's do not (`active-composition:publish worker-mode-drift`);
when either holds, the plan deploys every worker of this mode, whatever the diff, and stops the others.

The `deploy-cloudflare` job runs once `deploy-migrations` has migrated the database and SpiceDB, beside
`deploy-zerops`, in its own `stage-edge` environment, one edge deploy at a time (`edge-stage` concurrency
group). It resolves the last successful `stage-edge` deployment, plans the diff from there, and ships
the planned units in three passes: build and verify every unit (each unit's `cloudflare:deploy` up to
its final `wrangler deploy`, three units side by side), deploy them with Wrangler one by one in plan
order, then run every unit's `cloudflare:proof` side by side. Only the Wrangler steps receive `CLOUDFLARE_API_TOKEN`; the
build, verification and proof run dependency code and never see it. Every Worker's active version
is recorded before the first deploy. A failed deploy or proof returns each Worker this run deployed
to that state: the recorded version, or no Worker at all when the run created it. A cancelled run
restores the same way, because its deploy may have stopped after some Workers changed. The restore
step verifies that state, and any Worker left on the candidate is reported and fails the job. A
change to the edge workflow or the install action replans every placed unit, and a change to the
planner itself replans every unit on Zerops and the edge. Because the history is separate, a failed
edge deploy is replanned by the next run even when Zerops succeeded for the same revision.

Build, deploy, proof and retirement-check steps each have a timeout that leaves the restore step
its own budget inside the job deadline, so a hung deploy still ends with every changed Worker
restored.

Removing a unit from placement, or renaming its Worker, must list the old Worker in
`retiredWorkers`. The planner compares placement with the last successful edge deployment, in full
plans too, and refuses a change that drops a deployed Worker without retiring it. Placed units must
also have distinct Worker names. Retirement has two phases, and CI never deletes a Worker. The
deploy that drops a Worker leaves it running, so a rollback of the Shell or another dependent still
finds its binding target. After the proofs pass, every successful edge deploy reports each retired
Worker that still exists as a warning, until an operator deletes it with
`wrangler delete --name <worker>`. `retiredWorkers` is a ledger: CI cannot see a deletion, so the
planner keeps every entry the last edge deployment retired, and a deleted Worker's entry costs one
read-only check per deploy.

The job runs only when the repository is configured for Cloudflare: the `CLOUDFLARE_ACCOUNT_ID`
variable, the `CLOUDFLARE_API_TOKEN` secret in the `stage-edge` environment, and a complete build
environment (below). The `edge-deploy-readiness` job checks all three from `stage-edge` without
creating a deployment. If any is missing, `deploy-cloudflare` is skipped, records nothing, a notice
names what is missing, and CI stays green. Reading `stage-edge` without a deployment uses
`environment.deployment: false`, which GitHub refuses for environments with custom deployment
protection rules, so `stage-edge` must not have any.

The non-secret configuration the Worker builds read is reviewed source, the `buildEnvironment` of
`topology/cloudflare-placement.json`. It must hold `ULTRAMODERN_MF_DEV_ORIGIN`, the stage Shell
origin (the placed units' API CORS allowlist), `ULTRAMODERN_PUBLIC_URL_<UNIT>` for every placed
unit (the output verifier requires them), and the private data plane every Worker binds:
`ULTRAMODERN_CLOUDFLARE_HYPERDRIVE_ID` (the `HYPERDRIVE` binding, from which Core's
`#database-runtime` takes the runtime `DATABASE_URL`) and
`ULTRAMODERN_CLOUDFLARE_SPICEDB_VPC_SERVICE_ID` (the `SPICEDB` Workers VPC binding Core's
`#spicedb-transport` calls), and `ULTRAMODERN_CLOUDFLARE_COMPOSITION_KV_ID` (the
`ONTOS_ACTIVE_APPLICATION_COMPOSITION` KV binding Core's `#active-application-composition-source`
reads). A Worker build without any of them fails. It may add `MODERN_ASSET_PREFIX`.
Only `MODERN_`, `ULTRAMODERN_` and `VERTICAL_` keys are accepted. `ULTRAMODERN_SOURCE_REVISION` and
`ULTRAMODERN_DEPLOYMENT_ENVIRONMENT` are reserved for the run. `VERTICAL_*_WORKER_NAME` and
`VERTICAL_*_WORKER_BINDING` are rejected: a Worker's name and service-binding name are its topology
`cloudflare.workerName` and `workerDispatch.serviceBinding`, the names CI deploys and every caller uses. Because it is a topology document,
changing a value replans every unit, so no Worker keeps a build of the old configuration. The job
never reads the Zerops `stage` environment.
Each Worker's runtime configuration is set once, outside CI, before its first deploy: secrets
(`wrangler secret put`, for example `SPICEDB_PRESHARED_KEY` and `BETTER_AUTH_SECRET`); the
Hyperdrive config and Workers VPC service the IDs above name are account objects.

Inside the account the Workers call each other through service bindings where the topology allows
it: a binding call goes straight to the target Worker, without a public round trip or a routable
hostname. The Shell discovers each UI vertical's module
contract through its `VERTICAL_<UNIT>_WORKER` binding (the reference topology's
`workerDispatch.serviceBinding`), and Commerce calls Price Group Catalog through
`VERTICAL_PRICE_GROUP_CATALOG_WORKER` (Core's `#unit-service-fetch`). On Node both keep their URLs.
Calls a binding cannot carry go by URL: gateway credentials come from the Shell, which binds every
vertical, so a vertical binding the Shell would be a deploy cycle no first seed can satisfy. Those
URLs must be the Shell's and verticals' routable custom domains. Every OntOS Worker sets
`global_fetch_strictly_public`, the flag under which Cloudflare lets a Worker fetch another Worker
on the same zone.

The `Cloudflare Workerd Artifact Proof` job runs the built Workers together before any deploy:
`scripts/prove-cloudflare-local-topology.sh` starts each Worker in `wrangler dev` against the job's
PostgreSQL (as the `HYPERDRIVE` local connection string) and SpiceDB (a local gateway Worker stands
in for the `SPICEDB` VPC service), then proves repeated database requests, a SpiceDB-authorized
Shell read, module discovery and a vertical API over service bindings, and SSR. Run it locally
after `pnpm cloudflare:build`, `pnpm db:migrate` and `pnpm local:initialize`. The per-unit
`cloudflare:proof` and the verified rollback catch a Worker whose configuration is incomplete.
The first edge deploy has no previous edge deployment, so seed it with a full run:
`gh workflow run ultramodern-workspace-gates.yml --ref main -f full=true`. Placement adds the Worker
delivery; it never removes a Zerops service or any GitHub environment variable or secret.

### Adding a vertical

Stage deploys to Cloudflare, so a vertical that merges without its edge placement never reaches
stage and fails the stage edge deploy. The `Repository Tooling Tests` check fails the pull request
first: it needs no secrets, so it also runs for forks. In the same pull request as the vertical:

1. Give the vertical a `cloudflare` block in `topology/reference-topology.json`, with its
   `workerName` and `publicUrlEnv` (`ULTRAMODERN_PUBLIC_URL_<UNIT>`).
2. Add its id to `units` in `topology/cloudflare-placement.json`, and add its service-binding
   targets to `unitServiceBindings` when it calls other placed units.
3. Set `buildEnvironment.ULTRAMODERN_PUBLIC_URL_<UNIT>` to its stage origin,
   `https://ontos-stage-<unit>.<STAGE_ZONE>`.
4. Pick its CPU tier in its `modern.config.ts`: the default is `CLOUDFLARE_WORKER_CPU_MS.vertical`.
   Pass `cloudflareCpuMs: CLOUDFLARE_WORKER_CPU_MS.largeApiVertical` only when Workers analytics
   shows its BFF hitting the default cap.

Before the merge, an operator runs `node scripts/ops/cloudflare-stage-cutover.mts worker-secrets`
from the pull request's checkout, so the new Worker holds its runtime secrets when the stage deploy
ships it, and runs `verify` after that deploy. A vertical needs no new GitHub variables or secrets.

## Stage cut-over and Zerops service retirement

Two operator scripts own the one-time account and service changes around the Cloudflare stage. Run
them from `app/` on a clean `main`. Both read before they write, so a re-run after a partial failure
converges, and `--dry-run` performs every read and prints each mutation instead of running it. Zerops
is reached through the locally authenticated `zcli` and GitHub through `gh`. Secret values stay in
memory: they reach Cloudflare in request bodies, Wrangler and `zcli` on standard input, and never
appear in a command line or in the output.

`node scripts/ops/cloudflare-stage-cutover.mts <step> [--dry-run] [--env-file <path>]` reads
`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `STAGE_ZONE` and `STAGE_SHELL_HOSTNAME` from the
environment, or else from the dotenv file `~/.cloudflare-ontos-stage-token`. The optional
`CLOUDFLARE_STAGE_EDGE_API_TOKEN` is the narrower token CI receives. Without it, CI receives
`CLOUDFLARE_API_TOKEN`. The SpiceDB TLS step also needs `ZEROPS_TOKEN`, because `zcli` cannot set
service secrets, and a `CLOUDFLARE_API_TOKEN` with the stage zone permission "SSL and
Certificates: Edit" for the Origin CA.
`provision` creates the composition KV namespace, and CI writes its `active` key with the
`stage-edge` token, so both tokens need the account permission "Workers KV Storage: Edit".

- `spicedb-tls` creates the SpiceDB TLS material as sensitive secrets on the Zerops `spicedb` service,
  and `provision` runs it first. The gRPC pair `SPICEDB_GRPC_TLS_CERT`/`SPICEDB_GRPC_TLS_KEY` is a
  self-signed certificate for `spicedb`, `localhost` and `127.0.0.1` that Node clients pin. The HTTP
  gateway pair `SPICEDB_HTTP_TLS_CERT`/`SPICEDB_HTTP_TLS_KEY` is a Cloudflare Origin CA certificate
  for `ontos-stage-spicedb.<STAGE_ZONE>`, the server name Workers VPC verifies; it needs no DNS record.
  A pair that exists and holds is kept. A partial pair, a wrong name, a mismatched key or a
  certificate expiring within 30 days fails with the pair to remove, instead of rotating silently.
- `provision` runs every step in dependency order. It creates or reuses the remotely managed Tunnel
  `ontos-stage`. It imports `cloudflared` from `zerops-import.yaml`, with the tunnel connector token
  as its `TUNNEL_TOKEN` secret, and imports `outboxworkerhost`. It records their `ZEROPS_*_SERVICE_ID`
  stage variables and deploys `cloudflared`, then waits until the tunnel is healthy. Next it creates
  the Workers VPC services `ontos-stage-db18` (tcp `db18.zerops:5432`, certificate verification
  `disabled`, because Zerops Postgres serves a self-signed certificate and the hop stays inside the
  Tunnel and the project network) and `ontos-stage-spicedb` (HTTPS `spicedb.zerops:8443`, certificate
  verification `verify_full`). cloudflared resolves fully qualified names, and Zerops answers only a
  service's `<hostname>.zerops` name that way. Then it creates Hyperdrive `ontos-stage-runtime`: role
  `ontos_runtime`, caching disabled, origin connection limit 40, and the password read from Zerops
  `db18_password`. Service values such as that password come from the service's data through the
  Zerops API, because `zcli project env` prints sensitive secrets and generated passwords as `REDACTED`.
  It creates the KV namespace `ontos-stage-active-application-composition`, empty until CI writes the
  first publication. It writes the IDs
  and stage origins into this placement's `buildEnvironment` for a reviewed PR. It sets the
  `stage-edge` variable `CLOUDFLARE_ACCOUNT_ID` and secret `CLOUDFLARE_API_TOKEN`. Last, it sets every
  placed Worker's secrets with `wrangler secret bulk`, from the Zerops values the Node services use
  today, plus `ULTRAMODERN_DEPLOYMENT_ENVIRONMENT=stage`, because the Worker build's environment never
  reaches the Worker's runtime. A Worker's `SPICEDB_ENDPOINT` is the gateway name
  `ontos-stage-spicedb.<STAGE_ZONE>`, which the VPC service verifies. An existing object that differs from the runbook fails the step instead of being reused.
- `cost-guards` repeats only the cost-guard step, which `provision` runs after the `stage-edge`
  settings (see [Stage cost guards](#stage-cost-guards)).
- `resume` turns the cost kill switch off again.
- `worker-secrets` repeats only the Worker secrets step.
- `verify` runs the cut-over checklist and changes nothing. The tunnel must be healthy, and both
  SpiceDB TLS pairs must exist and hold. Both VPC
  services and Hyperdrive must match the runbook, the composition KV namespace must exist, and the
  reviewed `buildEnvironment` must name them. Every placed Worker must exist and hold each runtime secret `provision` plans for it, and the latest `stage-edge` deployment, which includes
  `cloudflare:proof`, must have succeeded for the checked-out revision. Once `stage` targets
  Cloudflare, the composition KV namespace must also hold key `active`, which the stage deploy's
  composition sync writes. Before activation `verify` only reports that check as waiting, so run it again after
  `activate` and the full deploy, and move DNS only when it passes.
- `activate` runs `verify` and, only when every item holds, sets `OUTBOX_WORKER_MODE=host` and
  `DEPLOY_TARGET=cloudflare` on `stage`. `provision` created the host service it needs.

### Stage cost guards

Stage runs on Workers Paid ($5 a month, which includes 10M requests and 30M CPU ms). That allowance
covers the whole Cloudflare account, which also runs other projects' Workers, and the stage zone is
shared with them. So the guards measure account-wide usage but only ever change OntOS stage objects. The cut-over script also reads `STAGE_ACCESS_EMAILS` (required, a comma-separated
list of the people Access admits and the usage notification emails) and `STAGE_ACCESS_ENFORCE_SHELL`
(default `false`).

- Every Worker config sets `workers_dev: false` and `preview_urls: false`, so the only way in is the
  zone routes the guards cover, and caps CPU per request at 200 ms for the Shell, 100 ms for a
  vertical, and 3000 ms for Catalog and commerce-customer-context (`CLOUDFLARE_WORKER_CPU_MS` in
  `packages/shared-contracts/tooling/modern-config.ts`). Each BFF request builds the whole Effect
  HTTP API runtime, so CPU grows with the endpoint count, and those two verticals have far more
  endpoints than the rest. Raise a cap only when Workers analytics shows real requests hitting it.
- A WAF custom rule `ontos_stage_kill_switch` blocks exactly the placed OntOS stage hostnames. It is
  added next to any rules other projects keep in the zone, created disabled, and re-runs keep its
  current state. The WAF answers before a Worker runs, so blocked requests are never billed. There is
  no rate-limit rule: on the Free plan a rate-limit expression cannot match a hostname, so it would
  throttle every other project in the zone. `cost-guards` also records the zone as the `stage-edge` variable
  `CLOUDFLARE_STAGE_ZONE_ID`.
- The hourly `.github/workflows/stage-edge-cost-guard.yml` runs
  `node scripts/ops/cloudflare-stage-cost-guard.mts check` once that variable exists. It sums the
  whole account's Workers requests and CPU time since the billing cycle started, and logs each OntOS
  Worker's share and the other Workers' total (`STAGE_BILLING_CYCLE_DAY`,
  1-28, default 1). Past `STAGE_WORKERS_REQUEST_LIMIT` (default 8M) or `STAGE_WORKERS_CPU_MS_LIMIT`
  (default 24M), it enables the kill switch and fails the run. All three are optional `stage-edge`
  variables. The kill switch only stops OntOS stage traffic: if the breakdown shows other projects
  drive the usage, they need their own action.
- The Workers requests usage notification `ontos-stage-workers-requests` emails the Access people at
  5M requests. Cloudflare offers usage notifications to Pay-as-you-go accounts, which a Workers Paid
  account is. If the API still rejects the policy, `cost-guards` and `provision` stop there with the
  Cloudflare error; the notification is the last guard, so the kill switch and Access are already in
  place.
- Access: a reusable people policy `ontos-stage-people`, a service token `ontos-stage-ci` (one-year
  duration) and a policy `ontos-stage-ci-token` for it. `stage-edge` holds the token as the secrets
  `CLOUDFLARE_ACCESS_CLIENT_ID` and `CLOUDFLARE_ACCESS_CLIENT_SECRET`; when they are missing, a
  re-run rotates the token to recover the secret. Enable Zero Trust once in the dashboard (the Free
  plan covers 50 people) before the first run; until then Cloudflare answers
  `access.api.error.not_enabled`, `cost-guards` stops with that to-do, and `verify` reports it.

Only with `STAGE_ACCESS_ENFORCE_SHELL=true` does `cost-guards` put the Shell hostname behind the
Access application `ontos-stage-shell`, with `ontos-stage-shell-gateway` bypassing
`/shell-super-app-api/auth/api-key/gateway-context`, which verticals call with an API key. Keep it
off for now: `cloudflare:proof` probes the Shell with plain `fetch`, cannot send the service token
headers, and would fail every stage deploy. Vertical hostnames stay outside Access for good, since the
browser loads their federated remotes cross-origin without credentials; the CPU caps and the kill
switch cover them.

To resume after the kill switch trips, find out why, then run
`node scripts/ops/cloudflare-stage-cutover.mts resume` (the check trips it again within the hour if
usage is still over the limit, so raise the limit variables or wait for the next cycle). To undo the
guards, delete the kill switch rule and the notification in the dashboard and remove the Access
applications; deleting `CLOUDFLARE_STAGE_ZONE_ID` stops the hourly check.

The cut-over token needs these permissions. Account: Cloudflare Tunnel Edit, Workers Scripts Edit,
Hyperdrive Edit, Connectivity Directory Admin, Access: Apps and Policies Edit, Access: Service Tokens
Edit, Notifications Edit, Account Analytics Read and Account Settings Read. Zone: Zone Read, DNS
Edit, Workers Routes Edit and Zone WAF Edit. The narrower `stage-edge` token additionally needs
Account Analytics Read and Zone WAF Edit for the hourly check.

### Zerops service retirement

`node scripts/ops/stage-zerops-services.mts retire|restore [--dry-run]` handles the 9 stage
application services that Cloudflare mode no longer uses. The migrator, SpiceDB, `outboxworkerhost`
and the 3 per-vertical outbox workers stay: the workers remain stopped, and the deploy workflow reads
their status to reconcile Outbox Workers after an Outbox Worker mode switch. The script never changes
`zerops.yaml`, `zerops-import.yaml`, a deploy script, or a GitHub variable.

- `retire` records each service in the versioned file `scripts/ops/stage-zerops-retirement.json`:
  its ID, status, `zerops-import.yaml` entry and stage service-ID variable. It also records the KEYS
  of its variables, split three ways: keys the setup's `run.envVariables` declares, keys inherited
  from the project, and service-level secrets. Values are never recorded. Commit the file. With
  `--confirm`, `retire` then deletes each service with `zcli service delete`. It refuses to delete
  until `stage` deploys with `DEPLOY_TARGET=cloudflare` and `--dns-cut-over` confirms the stage
  hostnames already route to the Workers, which `cloudflare-stage-cutover.mts verify` checked first. `DEPLOY_TARGET`
  only chooses where CI deploys; moving the hostnames is a DNS step outside this repository.
  A re-run keeps the records of services that are already gone.
- `restore --secrets-file <vault export>` re-imports every recorded service that `zerops-import.yaml`
  still declares. It passes each service's secrets as import `envSecrets`, read from a dotenv export
  of the vault keyed `<hostname>_<KEY>`, the names `zcli project env` shows. The export is parsed with dotenv rules, so JSON values such as the private JWK belong in single quotes. Today those secrets are
  `ONTOS_GATEWAY_PUBLIC_JWKS` on each vertical, plus `BETTER_AUTH_SECRET`,
  `BETTER_AUTH_TRUSTED_ORIGINS`, `BETTER_AUTH_URL` and `ONTOS_GATEWAY_PRIVATE_JWK` on the Shell. If
  the file lacks any recorded secret, `restore` changes nothing. Otherwise it points every stage
  `ZEROPS_*_SERVICE_ID` at the new service (and fails, changing no variable, if Zerops does not list one), sets `DEPLOY_TARGET=zerops` and dispatches the full
  Zerops deploy. Moving the Shell hostname back to Zerops remains a DNS step.

## Stage cost profile

Stage on the Cloudflare target keeps only the data plane and its helpers on Zerops, each in one
container with a hard ceiling, so a runaway process cannot grow the bill:

| Service                         | Runs                 | CPU (shared) | RAM          | Disk    |
| ------------------------------- | -------------------- | ------------ | ------------ | ------- |
| `db18` (`postgresql:single@18`) | always               | 1-2 cores    | 1-2 GB       | 1-10 GB |
| `spicedb`                       | always               | 1 core       | 1 GB         | 5 GB    |
| `cloudflared`                   | always, 1 connector  | 1 core       | 0.125-0.5 GB | 1 GB    |
| `outboxworkerhost`              | always               | 1 core       | 0.125-1 GB   | 1-2 GB  |
| `migrator`                      | only during a deploy | 1-2 cores    | 0.5-2 GB     | 5 GB    |

`zerops-import.yaml` declares the ceilings of the stage-only services. The `db18`, `spicedb` and
`migrator` ceilings are set on the stage services only, so production's derived import keeps Zerops'
defaults. The dedicated per-vertical outbox workers do not exist on stage while
`OUTBOX_WORKER_MODE=host`; each deploy reads a deleted worker as stopped. To switch stage back to
`dedicated`, import their `zerops-import.yaml` entries again and point the
`ZEROPS_*_WORKER_SERVICE_ID` stage variables at the new services before the deploy.

High availability stays one command away: `production-environment.mts` (below) derives `:ha` managed
services and at least two containers per runtime service from the same import, and production runs the
dedicated outbox workers instead of the host.

## Create production

Stage stays cheap: `zerops-import.yaml` declares its services in single-container mode
(`postgresql:single@18`, one container per runtime). Production runs the same topology in high
availability. `node scripts/ops/production-environment.mts` derives production's import from
`zerops-import.yaml` instead of keeping a second copy:

- every managed service switches from `:single` to `:ha` (`db18` becomes `postgresql:ha@18`);
- every runtime service runs at least 2 containers, except the migrator, which runs once per deploy;
- `cloudflared` and `outboxworkerhost` are left out: they serve only stage's Cloudflare target, and
  production runs each owner's dedicated outbox worker.

`render-import` prints that import without secrets, for review. `provision` builds production. Run
it from `app/` on a clean `main`. Like the stage scripts, it reads before it writes, so a re-run after
a partial failure converges, and `--dry-run` performs every read and prints each mutation instead of
running it. It reaches Zerops through the locally authenticated `zcli` and GitHub through `gh`. It
never deletes a service, variable or secret, and never touches `stage` or `stage-edge`.

Before running it:

1. Log `zcli` in with an account that may create projects in the stage project's organization.
2. Create a Zerops access token for production CI.
3. Export the supplied service secrets from the vault as a dotenv file keyed `<hostname>_<KEY>`,
   with JSON values in single quotes: `shellsuperapp_BETTER_AUTH_URL`,
   `shellsuperapp_BETTER_AUTH_TRUSTED_ORIGINS`, `shellsuperapp_ONTOS_GATEWAY_PRIVATE_JWK`, and
   `<vertical>_ONTOS_GATEWAY_PUBLIC_JWKS` for each vertical with a public subdomain. Production needs
   its own gateway key pair and auth origin, not stage's.

```sh
cd app
printf %s "$PRODUCTION_ZEROPS_TOKEN" | node scripts/ops/production-environment.mts provision \
  --spicedb-endpoint <host:port> --secrets-file <vault export> --zerops-token-stdin --dry-run
# review the plan, then run the same command without --dry-run
```

`provision` does this, in order:

1. Creates the GitHub environment `production` when it is missing, deployable only from `main`, with
   no required reviewers.
2. Finds the production project: the one `ZEROPS_PROJECT_ID` names, else the one named
   `ontos-production`, else creates `ontos-production` in Serious core mode, in the stage project's
   organization (`--org-id` overrides). It refuses a `ZEROPS_PROJECT_ID` that names the stage project.
3. Imports the services the project lacks, with their secrets. Zerops generates
   `BETTER_AUTH_SECRET` on the Shell and `SPICEDB_DATABASE_PASSWORD` and
   `SPICEDB_GRPC_PRESHARED_KEY` on SpiceDB at import (`#yamlPreprocessor=on`); the rest come from the
   vault export. If the export lacks one, nothing is imported. A service-ID variable that already
   names a different service fails the run.
4. Sets only the `production` variables that differ, once Zerops lists every service:

   | Variable                                                  | Value                                                                           |
   | --------------------------------------------------------- | ------------------------------------------------------------------------------- |
   | `ZEROPS_PROJECT_ID`                                       | the production project                                                          |
   | `ZEROPS_MIGRATOR_SERVICE_ID`, `ZEROPS_SPICEDB_SERVICE_ID` | the migrator and SpiceDB                                                        |
   | `ZEROPS_SHELL_SERVICE_ID`                                 | the Shell                                                                       |
   | `ZEROPS_<SETUP>_SERVICE_ID`                               | each vertical and each outbox worker, named after its `zerops.yaml` setup       |
   | `SPICEDB_ENDPOINT`                                        | `--spicedb-endpoint`, the `host:port` of production's TLS SpiceDB gRPC endpoint |
   | `DEPLOY_TARGET`                                           | `zerops`                                                                        |
   | `OUTBOX_WORKER_MODE`                                      | `dedicated`, one worker service per owner                                       |

5. Sets the `ZEROPS_TOKEN` secret from standard input when `--zerops-token-stdin` is given. Until
   `production` holds that secret, the flag is required and the run fails before changing anything.

SpiceDB starts only with its gRPC and HTTP gateway TLS secrets. After `provision`, create them on
production's `spicedb` service with `spicedb-tls`, which reads `CLOUDFLARE_ACCOUNT_ID`,
`CLOUDFLARE_API_TOKEN` and `ZEROPS_TOKEN` from the environment or `--env-file`:

```sh
node scripts/ops/production-environment.mts spicedb-tls --gateway-hostname <name in a Cloudflare zone> --dry-run
```

`provision --dry-run` needs neither the token nor the secrets file; it lists what the real run needs.
[Stand up production in under an hour](PRODUCTION_RUNBOOK.md) walks the whole sequence.

`provision` does not set Zerops project variables. Before the first deploy, set on the production
project the values stage holds at project scope, with production's own origins:
`MODERN_PUBLIC_SITE_URL`, `ONTOS_GATEWAY_ISSUER` and `ULTRAMODERN_MF_DEV_ORIGIN`. Production also needs its own enforced authorization evidence and
context (see [Fail-closed authorization promotion](#fail-closed-authorization-promotion)). Then
dispatch the first production deploy:

```sh
gh workflow run ultramodern-workspace-gates.yml --ref main -f environment=production -f full=true
```

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
- contract/build-skew rejection and, once supported, explicit implementation-selection rejection;
- native Commerce Storefront API and declared Medusa compatibility-route checks when present;
- basic responsive layout/CSS geometry;
- absence of unexpected browser errors and HTTP 5xx responses.

Run affected unit, integration, database, contract, and browser tests in CI as well. A root `/` health probe cannot substitute for this suite.

## Observability

Observability is part of the deployable contract, not a response to a failed release.

Every deploy and smoke record includes:

- environment, source SHA, artifact digest, delivery-unit `appId`, and version;
- deployment phase, operation, correlation ID, start/end time, and duration;
- readiness/smoke result and stable failure code/stage;
- previous and candidate versions for rollback;
- bounded logs for the failing service and direct dependencies.

Automatically collect failed-service logs. Alert if the administrative migrator remains running after the migration phase.

Never log credentials, signing material, cookies, raw assertions, complete tenant/composition payloads, or unbounded schema diagnostics. Unexpected defects keep full internal Effect causes at the owning server boundary with correlation context; public errors remain typed and sanitized.

## Rollback

Rollback must be executable and tested before rollout:

1. deactivate the affected tenant module state/canary;
2. stop further promotion;
3. identify the failed unit and the last successful phase from structured evidence;
4. explicitly promote the previously validated composition revision;
5. restore affected delivery units using the deployment automation's immutable release records. Composition pins public contract and MF-manifest digests; its `buildMarker` alone is not an executable artifact identity. The publisher in #374 must bind the composition revision to those release records before supporting rollback;
6. leave additive PostgreSQL and compatible SpiceDB changes in place;
7. rerun the complete authenticated smoke suite;
8. record the rollback artifacts and outcome.

If cleanup or endpoint provisioning returns an error, accept only a recognized idempotent state and verify the final state. `continue-on-error` without final-state verification is not rollback or idempotence.

## Merge queue and the main deploy path

`main` accepts changes only through the GitHub merge queue (the `Protect main` ruleset). The queue
runs the gates once, on the exact commit that will land on `main`, and its required check is the
`Workspace gates` job, which needs every gate job. Add a new gate job to that job's `needs`, not to
the ruleset. The queue rebases, so `main` stays linear.

Merge a green pull request by adding it to the queue:

```sh
gh pr merge <number>   # or the "Merge when ready" button
```

No merge strategy flag is needed: the queue rebases. Before the pull request's own checks pass, the
command enables auto-merge, and the pull request joins the queue once they do. It leaves the queue if
its merge-group run fails. Nobody bypasses the queue, so do not pass `--admin`.

The push that lands the commit deploys straight away. `queue-proof` looks for a successful
`merge_group` run of the workflow on that commit; when one exists every gate job is skipped and
`Workspace gates` passes on that proof. A commit without one (a dispatch on a commit pushed before
the queue) runs the gates first. The deploy then runs:

```text
deploy-target ─┬─ deploy-plan ──────────┐
edge-readiness ┘                        ├─ deploy-migrations ─┬─ deploy-cloudflare ─┐
Workspace gates ────────────────────────┘   (migrator,        └─ deploy-zerops ─────┴─ publish-edge-composition ─ sync-edge-composition
                                             SpiceDB)
```

`deploy-plan` needs no gate, so the plan is ready when the gates pass or prove skipped. A plan with
no migration and no SpiceDB change finishes `deploy-migrations` in seconds, so a one-vertical change
reaches its Worker within minutes of the merge.

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

Separate review concerns when useful—normally deployment generator/infrastructure, compatible schema, application behavior, and activation—but assemble and prove one immutable release candidate before merge. Do not merge a release and then use stage to discover one failure per follow-up PR.

After any failed rehearsal or rollout:

1. stop the train;
2. preserve the exact artifact, deployment plan, and logs;
3. reproduce the failure in the parity environment;
4. fix the entire failure class and add a regression test;
5. rebuild once and rerun the ordered gates from the beginning.

Use the CI provider's rerun or manual dispatch for a genuine retry. Do not create empty commits to retrigger a pipeline.

## Historical release evidence

Git history and regression tests own the detailed rollout-failure record. When a failure class recurs or deployment behavior changes, add a permanent automated contract test instead of extending a prose commit list.

## Fail-closed authorization promotion

Authorization changes deploy schema and data expansion first: the Contacts assertion-redemption migration and SpiceDB policy precede every provider and the Shell. Run the inventory check, collect sanitized report-only evidence for one source revision and inventory hash, reduce it with `pnpm authorization:impact:report`, and validate fixed-context evidence with `pnpm authorization:readiness:check -- stage`. The command accepts only a fixed environment name; it loads `topology/authorization-contexts/<environment>.json` and the fixed inventory, impact, observation, and negative-smoke report names. The resulting artifact binds the environment, source revision, inventory and context hashes, schema/data versions, replay migration, impact report, smoke evidence, observation bounds, and approval reference.

Pass `--authorization-environment <environment>` to `pnpm deployment-impact:plan --` for a promotion plan. `report_only` is valid only before its declared expiry and never in production. `enforced` has no expiry; `expiresAt` bounds only a report-only window. In production, `enforced` requires matching zero-impact, readiness, and negative-smoke artifacts from the exact build. Development and stage may enforce without those artifacts only while the compatibility baseline is empty, because enforcing then withdraws no allowance; the plan records status `enforced` instead of `ready`. Any present artifact must still match, and a non-empty baseline needs the full evidence. Stage enforces since 2026-10-01. Abort on an expired window, mixed build evidence, unresolved impact, missing policy/module/worker/issuer/replay data, or a failed negative smoke.

Production remains blocked while no approved source-controlled production context exists; the development/stage provisioner must continue rejecting production and arbitrary tenant or Action arguments. Issue #173 owns technical implementation and readiness; issue #369 owns the separate production-promotion approval gate. Issue #169 is broader review context, not approval. Their current records—not this playbook—determine whether the gates are satisfied. An implementation override never records Petr/Jiří approval or permits production enforcement. The checked-in stage context remains `pending`; code-only override is not approval. Rollback restores the prior application mode only after preserving the exact evidence and must not remove the expanded schema or durable redemption rows while old/new consumers overlap.
