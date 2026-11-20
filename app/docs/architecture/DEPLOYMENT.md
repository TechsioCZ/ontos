# Deployment Architecture and Release Playbook

This playbook is the authoritative release guidance for OntOS application delivery. It covers deployment configuration, CI/CD, PostgreSQL and SpiceDB changes, runtime packaging, Shell changes, and every new or changed MicroVertical.

> [!IMPORTANT] Explicit `implementationId`, dependency-closure selection, public-contract hashes, migration-set identity, and full artifact metadata are accepted target architecture, not fields in the current manifest/catalog schema. Requirements below that name them become mandatory with that contract. Until then, releases use one implicit `standard` implementation per `moduleId` and the current generated `buildMarker`; do not simulate missing fields with ad hoc configuration.

Application Composition validation and stage publication are implemented; live Shell loading is not. Stage publication is described in [Stage on Zerops](#stage-on-zerops). Until #374–#377 wire those paths in, remote URL and generated lazy-registry changes still require Shell regeneration and redeployment. The composition promotion sequence below is the target flow.

The rules exist because the first Zerops stage rollout was merged after source-level validation and then required 43 linear repair commits. Stage had become the first production-shaped integration test. Future releases must prove the target artifact and the distributed user journey before promotion.

## Stage on Zerops

Stage runs on Zerops only. Cloudflare serves only its DNS, outgoing email and the SpiceDB gateway's Origin CA certificate. The layout below comes from `app/zerops.yaml`, `app/scripts/zerops/` and `.github/workflows/zerops-stage.yml`.

### Services

Stage is the Zerops project `t1ljmn3DRDafgi8AuPvhdQ` (LIGHT core).

- `app`: one Node container. It serves the Shell, every owner in `topology/application-release-intent.json`, and the Outbox Worker host.
- `storefront`: the real customer's Next.js standalone server, on port 3070. It calls the Shell at `http://app:3000` with its own tenant key.
- `shop`: ŠroubShop, the demo tenant's pseudonymous storefront, built from the same artifact. It runs as the storefront application `sroubshop-storefront` with its own managed key: the deploy workflow syncs `ONTOS_STOREFRONT_APP_ID` and `ONTOS_AKROS_STOREFRONT_API_KEY` (stage-edge secret `SHOP_STOREFRONT_API_KEY`) to the shop service before it pushes shop; `STOREFRONT_BRAND=sroubshop` is a service variable. The data cutover itself is the reviewed operator in `scripts/demo/pseudonymize-akros-demo.md`; deployment never runs it.
- `db18`: PostgreSQL.
- `spicedb`: SpiceDB.
- `migrator`: keeps only its secrets, the database identity passwords that the app references as `${migrator_…}`. The app container runs the migrations itself.

Each service runs one container, with no HA and no autoscaling. The app host keeps no local state, so it can scale out later.

### Inside the app container

`scripts/zerops/app-host.mts` is the supervisor. It listens on port 3000.

- It routes `/_m/<appId>/…` to that owner's loopback server. Every other request goes to the Shell on loopback port 3020.
- It starts three processes:
  - the Shell: `serve-units.mts shell-super-app`;
  - all owners in one process: `serve-units.mts <appId> …`, so shared dependencies load once;
  - the Outbox Worker host, with its health endpoint on port 4100.
- If any process exits, the container stops, and Zerops restarts it from a clean state.
- Browser owners keep their topology port. Server-only owners (api-only, or without a Module Federation remote) start at 4200. Every unit listens on `127.0.0.1` only.

Each owner's composition backend is its loopback `node-http` origin. The browser loads each remote's manifest and assets from `https://<origin>/_m/<appId>/`.

### Composition and authority

On every start, the host does the following.

1. Runs the migrations with `scripts/run-zerops-migrator.mjs` (`MIGRATOR_ONCE=true`) while it waits for every unit to serve its contract. Each unit has five minutes.
2. Observes the running artifacts over loopback, and derives the snapshot using the public artifact URLs.
3. Proves the release against the live engine, read-only (`scripts/zerops/release-access-verification.mts`): the live SpiceDB schema must equal the canonical v2 schema, and every active Tenant must carry its scopes, its owner membership and a SpiceDB projection equal to PostgreSQL intent. The proof never writes, revokes or re-grants, and a Tenant or engine it cannot prove stops the release here with the exact Tenant and the remediation instead of publishing a release that locks its people out.
4. Publishes the snapshot with `publishApplicationCompositionAuthoritySnapshot`. The result is one active revision in the PostgreSQL table `core.application_composition_authority`.
5. Serves the snapshot bytes at `/_host/composition`, a loopback-only path. Every hosted process reads it through `ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL`. The host serves a revision only while the database still names it.

The release writes no authorization relationship and installs no schema. Authorization v2 (ADR-0030) projects every tuple from PostgreSQL intent through the one Core writer, so the retired `scoped_role`/`action`/`context_permission` reconciliation has no place in a release. The deployment's SpiceDB bootstrap file is read **only when the datastore is empty** (`scripts/run-zerops-spicedb.sh` gates it on `namespace_config`), so a live engine keeps whatever schema it was given: bringing a live engine to the canonical v2 schema, and retiring its old relationships, are each a separately approved operation that must complete **before** the read-only release verification. A live Tenant's people, Roles and workloads are seeded by the operator-gated stage bootstrap (`apps/shell-super-app/scripts/bootstrap-stage-accounts.mts`).

The host renews the lease itself every 6 hours. Validity is 24 hours. A failed renewal is logged, and if renewals keep failing the lease expires. There is no KV namespace, no workers.dev route and no scheduled refresh workflow.

Probes:

- `/_host/live` answers as soon as the host listens.
- `/_host/ready` returns 200 after publication. Zerops switches traffic only after it answers.
- `ONTOS_APP_HOST_PUBLISH=false` starts and observes every unit without migrating or publishing. In that mode `/_host/ready` returns 200 after observation. Use it only to try a build next to a live stage.

### Secrets

- `ONTOS_OWNER_SECRETS_JSON` is a sensitive `app` service variable. Each deploy writes it from the GitHub secret `DEMO_IMMUTABLE_RELEASE_SECRETS` through `scripts/zerops/sync-service-secret.sh`. It maps each appId to that owner's secrets.
- Each process gets only the entries of the owners it serves. Host-derived settings win over stored values: the issuer, auth URL, composition URL, gateway base URL, SpiceDB settings and `DATABASE_URL`.
- `DATABASE_ADMIN_URL` and the identity passwords never reach an owner process. Each process gets only its own identity URL: Party Registry in the owners process, `PARTY_REGISTRY_WORKER_DATABASE_URL` in the Outbox Worker host, and `SHELL_GATEWAY_ISSUER_DATABASE_URL` in the Shell.
- Known isolation trade-off: owners in the shared owners process share one environment, so any owner there can read every owner's entries. Two owners that store different values under one key stop the host at startup. Per-service hosting kept these apart.

### Email

- `EMAIL_PROVIDER=cloudflare-api`: mail is sent through the Cloudflare Email Service REST API for account `CLOUDFLARE_EMAIL_ACCOUNT_ID`. Outbound SMTP on port 465 is blocked from Zerops, so the SMTP adapter is not used on stage.
- The API token is a Cloudflare API token with Email Sending. It is stored as the `app` service secret `SMTP_PASSWORD` and referenced as `CLOUDFLARE_EMAIL_API_TOKEN: ${SMTP_PASSWORD}`.
- Sender: `noreply@ontos-stage.web-revolution.cz`.

### Build

- Node builds and runtimes use Zerops' `alpine/nodejs@26` image and its `node` executable. Builds install the workspace's pinned pnpm version; no Node archive is downloaded or included in the deployment. The local and CI Node patch pin remains in `.mise.toml`, while Zerops manages its image's Node 26 patch version.
- GitHub Actions builds the units, in eight parallel shards (`zerops-stage.yml`, job **Build units**). Each shard runs `scripts/zerops/build-app.sh` for its units, two at a time, and the shards are dealt so the slowest of those two-wide lanes is as short as the measured unit costs allow.
- Units build in the gates' mode (`build-app.sh` sets `ONTOS_CI_TYPECHECK_SEPARATE=1`): no bundler or server typecheck, which the gates run, and no JavaScript source maps, which nothing on stage reads.
- Each unit's build script still ends with `modern deploy`, but only to write `.output/index.js`. `scripts/zerops/owner-entry.mts` turns that file into `dist/zerops-entry.mjs`, which exports `start(port)`.
- A unit whose committed inputs are unchanged keeps its previous `dist/`. The digest is in `dist/.zerops-build-digest`. Each shard keeps its builds in the Actions cache, outside the checkout: any untracked file in the tree turns every release identity into `workspace`.
- The deploy job packs every shard's `dist/` (no source maps, type bundles or precompressed copies) into `app/.zerops-prebuilt.tar.zst` and pushes it with the checkout.
- The Zerops `app` build (`zerops.yaml`) unpacks that archive, installs the workspace, keeps every unit whose digest matches, builds the Outbox Worker host bundle under the hosted owners' revisions, and ships `app/`. It can still build any unit itself, two at a time, in its 5 vCPU / 8 GB build container.
- `.deployignore` keeps `.output`, source maps, caches and tests out of the deployed package.

### Deploy

`.github/workflows/zerops-stage.yml` runs on each push to `demo/sales-crm`, except pushes that touch only `docs/**` or Markdown files. It also runs on manual dispatch. Runs are serialized in the `zerops-stage` concurrency group.

1. **Build units**: eight shards, as above.
2. **Deploy** (environment `stage-edge`): syncs the owner secret bundle to the `app` service, then pushes the `app` and `storefront` setups in parallel with `scripts/zerops/push-service.sh`, using the commit SHA as the version name. That script uploads over HTTP/1.1 with curl, because Zerops silently drops an upload that runs longer than about 30 seconds. On failure the job prints the app log.
3. **Verify**: runs the timing probe (`/cs` and OAuth metadata) and checks that every storefront home lists products and the MCP OAuth proof, both blocking. The declared-read warm-up is blocking as well: it fails when its budget expires before every declared persona and destination has been read.

Environment `stage-edge` needs the variables `ZEROPS_PROJECT_ID`, `ZEROPS_APP_SERVICE_ID` and `ZEROPS_STOREFRONT_SERVICE_ID`, and the secrets `ZEROPS_TOKEN` and `DEMO_IMMUTABLE_RELEASE_SECRETS`.

### Edge

- Cloudflare is DNS only. DNS-only (not proxied) A and AAAA records point at the shared Zerops IPv4 and the project IPv6. Zerops terminates TLS with a Let's Encrypt certificate.
- WAF and Access are not in front of stage. Proxying would need SSL `full` for these hostnames (the zone default is `flexible`), and the stage token cannot create page or configuration rules.
- `scripts/zerops/route-stage-domains.sh` creates a Zerops public HTTP routing for each hostname. It detaches any Worker custom domain on that hostname (the Worker itself stays), replaces other A, AAAA and CNAME records, and writes the DNS-only A and AAAA.

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

Stage deploys from `demo/sales-crm` through `.github/workflows/zerops-stage.yml`, which builds and pushes the `app` and `storefront` services on Zerops. It has no deploy plan and no release ledger. A unit whose committed inputs are unchanged keeps its cached build (see [Stage on Zerops](#stage-on-zerops)), and there is no force-full input. Run it manually with `gh workflow run zerops-stage.yml --ref demo/sales-crm`.

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

### Database identities

Party Registry and the Shell gateway-grant registrar use dedicated PostgreSQL logins instead of `ontos_runtime`. The design, rotation costs and the full rollback recipe are in [Database trust boundaries](./DATABASE_TRUST_BOUNDARIES.md#operations).

The three passwords are sensitive `migrator` service secrets: `PARTY_REGISTRY_DB_PASSWORD`, `PARTY_REGISTRY_WORKER_DB_PASSWORD` and `SHELL_GATEWAY_ISSUER_DB_PASSWORD`. A human operator, never an agent, creates them once on the `migrator` service before the first deploy that references them. `zerops.yaml` hands them to the `app` service as `${migrator_<KEY>}`, never as project variables: every service inherits project variables, which would hand every credential to every process. `scripts/tests/zerops-deployment-contract.test.mts` enforces this.

On every start the app host runs the migrator (`scripts/run-zerops-migrator.mjs`), whose role bootstrap (`scripts/postgres/bootstrap-runtime-role.mts`) creates the login roles with `LOGIN` and `CONNECT` only, re-sets the three passwords, resets role settings, re-applies the grant manifest and fails if a URL user differs from its manifest role or targets another database.

`scripts/zerops/app-host.mts` keeps the administrative URL and the identity passwords to itself. Each hosted process receives only its own identity URL:

| Process            | Database URLs                                        |
| ------------------ | ---------------------------------------------------- |
| Shell              | `DATABASE_URL`, `SHELL_GATEWAY_ISSUER_DATABASE_URL`  |
| owners             | `DATABASE_URL`, `PARTY_REGISTRY_DATABASE_URL`        |
| Outbox Worker host | `DATABASE_URL`, `PARTY_REGISTRY_WORKER_DATABASE_URL` |
| app host (startup) | all of them, plus `DATABASE_ADMIN_URL`               |

Rotation (human operator, during stage maintenance):

1. Change the relevant sensitive `migrator` service secret.
2. Restart the `app` service. Its migrator pass runs `ALTER ROLE ... PASSWORD` before any hosted process starts, and every process then opens fresh connections with the new credential.

`zerops.yaml` is shared with any future production project, which stays blocked until the same `migrator` secrets exist there.

### Order-flow owner credentials

Commerce Order, Customer Context, Commerce Cart and Pricing call each other through the Shell's delegated issuance. A calling module presents its own module credential, which the platform hands its process on a private channel (never an environment variable); the Shell binds each credential to exactly one module, build and release (see [Module credentials and bindings](#module-credentials-and-bindings)) and signs that module as the actor of the call, with the original person as its subject. The receiving owner admits the actor by module (for example, only `commerce-order` may consume an order approval, and only for the approval's buyer). No owner admits another by Principal ID, grant list or API-key namespace. `scripts/ops/owner-runtime-configuration.mts` names the other values each owner reads, and the app host derives each owner's API bases from it:

| Owner                       | Credentials (sensitive)                                                   | Per-environment values (not secret)                        |
| --------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `commerce-customer-context` | `COMMERCE_TENANT_CREDENTIALS` (per-Tenant Core identity and gateway keys) |                                                            |
| `pricing`                   | `ONTOS_PRICING_CONFIRMATION_SIGNING_SECRET`                               | `ONTOS_PRICING_CONFIRMATION_KEY_{REF,VERSION,LINEAGE_REF}` |

Add these to the owner's entry, keyed by its `appId`, in the GitHub secret `DEMO_IMMUTABLE_RELEASE_SECRETS` of the `stage-edge` environment. Each deploy writes that JSON to the `app` service as `ONTOS_OWNER_SECRETS_JSON` (see [Secrets](#secrets)), and the app host hands each process only the entries of the owners it serves; the Outbox Worker host receives every owner's entries, because it runs their workers. Every owner base is the owner's loopback API origin `<origin>/<unit>-api`, derived, never stored. At runtime each owner reads its values lazily, so an unusable one fails only the work that needs it, never the other owners in the shared process.

### Payment gateway relay

Providers deliver notifications to the Shell's typed relay at `/api/payment/v1/notifications/{gopay,stripe,comgate}/<tenantId>/<routeKey>`, and the Payment reconciliation driver requests recoveries at `/api/payment/v1/reconciliation/<routeKey>/recoveries`. The Shell mounts `/api/payment/v1` as its own always-on prefix beside `/shell-super-app-api`, and the app host routes every path outside `/_m/<appId>/` to the Shell, so the relay is served at the public origin.

| Owner             | Credentials (sensitive, in `DEMO_IMMUTABLE_RELEASE_SECRETS`)                     |
| ----------------- | -------------------------------------------------------------------------------- |
| `payment`         | `ONTOS_PAYMENT_PROVIDER_CREDENTIALS`, `ONTOS_PAYMENT_RECONCILIATION_CREDENTIALS` |
| `shell-super-app` | `ONTOS_PAYMENT_NOTIFICATION_RELAY_CREDENTIALS`                                   |

- `ONTOS_PAYMENT_NOTIFICATION_BASE_URL` is derived by the app host from the public origin (`scripts/zerops/app-host.mts`), never stored. Payment composes each binding's notification URL from it, the provider family, the tenant and the binding's generated route key. Outside an `https` origin (the local demo), configuring a provider binding fails with 503 `payment_notification_route_unavailable` and the rest of Payment keeps working.
- `ONTOS_PAYMENT_PROVIDER_CREDENTIALS` is a JSON object keyed by the credential secret ref of a provider account binding. Each entry is `{ "family": "GOPAY", "clientId", "clientSecret" }`, `{ "family": "STRIPE", "secretKey", "webhookSigningSecret" }` or `{ "family": "COMGATE", "secret" }`; an entry with any other field is refused. While it is absent every payment gateway operation is unavailable and the other Payment features keep working. Payment reads it on each cache miss, so a rotation is picked up within 60 seconds.
- `ONTOS_PAYMENT_NOTIFICATION_RELAY_CREDENTIALS` (Shell) and `ONTOS_PAYMENT_RECONCILIATION_CREDENTIALS` (Payment; read by the Payment Outbox Worker in the Outbox Worker host) are each a JSON array `[{ "tenantId": "<tenant uuid>", "apiKey": "<managed API key>" }]`, one entry per tenant. Each entry is decoded on its own and only when its tenant is needed, so a malformed entry fails only that tenant and an absent value makes the relay or the driver unavailable while the rest keeps working. Two entries for one tenant mean no key. A provider notification for a tenant with no relay entry gets the same 404 as an unknown route.
- The driver calls the Shell at the origin of `ONTOS_SHELL_GATEWAY_BASE_URL` (the host-derived loopback Shell base) and drops the `/shell-super-app-api` path. Without a valid tenant entry, that tenant is skipped and logged at most once per hour.

Before a tenant uses a payment gateway, a human operator, never an agent, provisions two integration principals in that tenant and records their keys:

1. Run `core.identity.create-non-human-principal` with `kind: integration` and the display name `Payment notification relay`. Register its workloads `payment.provider-notification-ingress` and `payment.source-ingress` (on stage through the accounts file `workloads`).
2. Run `core.identity.create-non-human-principal` with `kind: integration` and the display name `Payment reconciliation driver`. Register its workloads `payment.provider-reconciliation` and `payment.source-ingress`.
3. For each principal, issue a managed API key through Shell's API key service and run `core.identity.bind-managed-api-key` with the principal ID and provider key ID.
4. Add the relay key to the Shell's `ONTOS_PAYMENT_NOTIFICATION_RELAY_CREDENTIALS` and the driver key to Payment's `ONTOS_PAYMENT_RECONCILIATION_CREDENTIALS`, each under the tenant's ID.

Rotating a relay or driver key changes only that secret; notification URLs stay the same. Revoking a key or a workload registration makes that tenant's relay or driver fail closed, and the providers retry within their own limits.

Payment's notification and recovery Outbox Workers submit provider evidence through Payment's own `accept-payment-observation` Action with a registered-workload assertion. Payment calls through the Shell's delegated issuance with its own module credential (`MODULE_CREDENTIAL_CALLERS`), and the Shell derives the registered-workload rules of the Payment binding from the installed contracts; nobody records them. Each tenant needs exactly one active system principal registered for `payment.source-ingress`; it is the executor.

### Module credentials and bindings

The platform provisions module credentials itself, on every environment and with no human step. Nobody issues, copies or rotates a module key by hand, and no module key or binding is stored in GitHub, Zerops or an env file. Every module key ends 24 hours after it was issued (`MODULE_CREDENTIAL_LIFETIME`), so a key nobody retired still dies on its own.

- **Who holds them.** Every module that calls another module through the Shell's delegated issuance gets one module credential. The list is not kept by hand: every module a carrier admits as its delegated caller (`accessActor.callers`) is one, generated with the catalog artifact into `scripts/zerops/module-credential-callers.generated.mts` (`pnpm authorization:catalog:artifact`; `--check` fails when it is stale), and a test fails when a module calls another without a carrier that admits it. Each credential is a managed API key bound to that module's own service principal, `module:<appId>`, in the platform tenant. The platform creates that tenant and nobody administers it: it has no person, membership, Role or company, so no Action, grant or tenant-managed key reaches it, and release access verification skips it. Principals, keys and bindings go through the same writers `core.identity.create-non-human-principal`, `core.identity.bind-managed-api-key` and the API-key binding lifecycle use. The key belongs to a platform provider user with no account and no password, through a server-only issuance no HTTP endpoint reaches. The database keeps only what it keeps for every managed key: hashes and bindings.
- **When.** `scripts/zerops/provision-module-credentials.mts issue` runs with the Shell's settings and issues every hosted caller a fresh key. The app host starts its owners holding no key, runs the migrator (migrations, the runtime role bootstrap and schema verification), observes the owners, and only then runs the pass for the observed release, before it verifies release access, publishes and opens its public port. An observe-only host (`ONTOS_APP_HOST_PUBLISH=false`) runs the same pass after observing. The local demo (`scripts/demo/up.sh`) runs `issue-installed` once its local composition is published, and the native test fixtures call the same service.
- **Database role.** The pass runs as the shared runtime role `ontos_runtime` (`DATABASE_URL`), with the grants the role manifest already gives it and no migration of its own: `insert`/`select` on `core.tenants` and `core.principals`, `insert`/`select`/`update` on `core.principal_auth_bindings`, `insert` on `core.audit_events`, `select` on `core.application_composition_authority`, and `insert`/`select`/`update` on Better Auth's `user` and `apikey` tables. It never receives `DATABASE_ADMIN_URL`. The integration test `apps/shell-super-app/tests/integration/module-credential-provisioning.test.ts` runs the real program as that role (no superuser, no `BYPASSRLS`).
- **Bound to a build and a release.** At issue, the key's provider metadata records what the issuing host attested: the module, that module's build marker, the composition revision of the release it serves, and the issuing host (its container's host name) and boot (a fresh id each time the host process starts) (`apps/shell-super-app/api/auth/module-credential-attestation.ts`, `attested_v2`). A key that is bound but not attested binds nothing.
- **How a key reaches its owner.** Only through process memory and a private channel: a pipe on file descriptor 3, beside standard output and standard error, which stay logs. The provisioning child writes its pass to its file descriptor 3, closes its database pools and exits; the app host reads it (one attempt with a two-minute budget, `PROVISIONING_BUDGET`, never retried before publishing, so module credentials add at most two minutes to a start that Zerops allows 15) and writes each process's handover as one line to that process's file descriptor 3: the owners process and the Outbox Worker host. The store is module-private (`packages/core-runtime/src/auth/hosted-module-credential-store.ts`): no package export and no global handle reaches it. Every built owner API bundle inlines its own copy of it (the API bundler inlines workspace sources), so a process holds one copy per bundle it loaded, and only a copy the host claimed can ever hold a key. Each unit's build therefore exposes exactly its API bundle's own one-time claim, and nothing else of the store, as one export that the unit's generated entry re-exports (`scripts/zerops/hosted-credential-claim.mts`, run by `owner-entry.mts`; the build fails if anything the unit serves carries a copy no host can claim). The host program claims each unit's copy for that unit's module right after loading the unit and before it serves (`serve-units.mts`; `scripts/demo/serve-module.mts` locally; the Outbox Worker host's `worker.mjs` is one bundle with one copy, which it claims itself), and refuses to serve a unit whose bundle carries a copy its entry does not let it claim. Every handover line then reaches every claimed copy, each of which takes only its own module's slot and refuses any other; the latest keys stay with the host, so a unit loaded after a line arrived gets them at once. A second claim of a copy is refused. Each owner's slot is written only by that receiver, fed by the host's channel: the first key at boot or later, then a replacement whenever the host renews or rotates keys. The channel stays open for the life of the process, so no key change needs a restart (`scripts/tests/hosted-credential-claim.test.mts` checks a real bundle and every built unit; the packaged relay and CRM tests run owners exactly this way). The delegated gateway client (`acquireDelegatedGatewayContext`) is the only reader of a module credential and the only importer of the reader, `@app/core-runtime/auth/owner-module-credential`: every call names its calling module, and it reads that module's slot, whichever runtime, worker or background fiber it runs in. Every module names itself by its own topology app id (`scripts/tests/module-credential-reader-boundary.test.mts` holds the importers and the names). An owner without a key has none: its delegated calls fail closed (`No module credential of <module> in this process`); there is no environment variable to read one from. If a process can no longer read its channel (a malformed line is only refused, and a channel the launcher closed after one handover, as the local demo does, is not a failure), it logs `HANDOVER CHANNEL LOST` and stops: the owners process ends its command, the Outbox Worker host stops through its `watch`. The app host treats either exit as fatal, so the container restarts with fresh keys on fresh channels. That costs a container restart (the owners and the Outbox are unavailable until the new boot publishes), in exchange for never running a process whose keys are retired under it; an acknowledgement from each process before its old key is retired would avoid the restart and is the follow-up. Both processes keep that descriptor open for later handovers, and a subprocess would inherit it, so neither starts one: their command line runs with a spawner that refuses every command (`scripts/zerops/no-subprocess-services.mts`), and a source test walks everything they load and finds no code that spawns (`scripts/tests/module-credential-channel-subprocesses.test.mts`, following imports, re-exports, `require` and `createRequire` calls; third-party code bundled into an owner and the built owner bundles `owner-entry.mts` loads are outside that walk). File descriptor 3 is not close-on-exec: Node cannot set that flag on an inherited descriptor, so any subprocess these processes did start would inherit the open channel and could read every later handover line (each owner's current key) from it. A worker thread shares the process and its descriptors: it could open descriptor 3 itself, and it can already reach every owner's slot through the shared store, like any code in the process (the cooperative isolation below). The Shell process receives no key, and its bundle carries no store copy. A copy nobody claimed holds no key.
- **In-process isolation is cooperative.** Owners that share one process share one heap: the store keeps each owner to its own slot by code, not by an operating-system boundary, and code running in that process could ask for another owner's slot. Running each calling owner in its own process (one channel each) is the stronger option for later.
- **Bindings are derived.** The Shell reads the platform's enrolment (which provider key belongs to which module) with each key's attestation and joins it with the release it has installed: a key binds only while the installed release runs exactly the attested build of that module at exactly the attested revision. During a deploy overlap the keys of the release that holds the authority bind, and the other host's keys bind nothing; after a rollback, the keys issued for the restored release bind again. A credential of a module the release does not install binds nothing. Any enrolled module key is refused as an ordinary key on every other API-key entry point: the API-key gateway context, the agent-platform key caller and the external-identity workload endpoints (403; an unreadable enrolment answers 503).
- **The Shell verifies with its own key.** A live delegated call carries the subject's assertion that the Shell itself signed for the calling module. The Shell verifies it with the public half of its own signing key (`ONTOS_GATEWAY_PRIVATE_JWK`) and its own issuer (`ONTOS_GATEWAY_ISSUER`), never with a separate public key set: the Shell process does not receive `ONTOS_GATEWAY_PUBLIC_JWKS`, which only the owners and the Outbox Worker host use.
- **Background work is bound to its message's company.** An `Originator` delegation (asynchronous work acting for a recorded invocation) carries the company of the Outbox message being handled whenever the Outbox runtime provides one (`OutboxMessageCompany`, from the message's domain event). The Shell accepts it only if Core recorded a domain event of that invocation in that company, then issues the context for exactly that company; another company named beside it (`originator_company_mismatch`) or a company Core never recorded for the invocation (`originator_company_not_recorded`) is refused. Without one, admission is unchanged.
- **Every refusal names its step.** The delegated endpoint writes one warning per refusal, `gateway delegation refused`, with a stable `reason` code (`GatewayRefusalReasonSchema` in `packages/shared-contracts/src/gateway-context.ts`), the calling module (`callerAppId`), the subject's tenant (`subjectTenant`) and the audience, and returns the same `reason` in the problem body. The caller logs `gateway context not issued` with that reason, or its own (`No module credential of <module>…`, `No credential of <workload>…`). Neither line carries a key, a token or a subject.
- **Rotation and retirement.** Every boot issues new keys. Eight hours before its keys end (`MODULE_CREDENTIAL_ROTATION_LEAD`, so at about 16 hours) the host issues every caller a fresh key, hands the fresh keys to the owners process and the Outbox Worker host on their channels, and after two minutes for in-flight delegated calls retires the keys they replaced. A host retires its own keys itself with `retire-own`, and "own" is proven by boot, never by host name alone: after a renewal it names exactly the provider key ids it replaced (keys only its current boot ever held), and at boot it names the ended boots its container recorded, whose keys are attested for its host name and one of those boots. It never retires a key of its current boot it still holds, or any key of another boot, so two containers that share a host name never retire each other's keys. Each host process records its boot id in the container (`.zerops/state/module-credential-boots.json`) before it issues any key; a container runs one host process at a time, so every other boot recorded there has ended. A new container (every deploy) starts with no record and retires none of the keys of the container it replaces, which keeps serving until the switch even if both carry the same host name. `retire-own` runs once the grace period passed after boot (after it published, for a host that takes the authority) and after each renewal. A key of an ended boot this host cannot prove is its own (a container replaced without a record) still ends within a day. Once the host published and two minutes passed for in-flight delegated calls, it also runs `retire`, keeping the keys it holds at that moment (and running even when its boot pass issued none), which acts only while the host's release holds the authority (`core.application_composition_authority`, phase `active`, revision equal to its own). Its cutoff is the moment that revision took the authority, `revision_activated_at`, which a renewal of the same revision keeps and a different revision (a newer release or a rollback) moves. Credentials bound before the cutoff are disabled and then their bindings revoked; credentials bound after it (another container of the same release, an observe-only host, a newer host still booting) and the host's own are never touched by `retire`. The authority is re-read with each revocation. Only the release holding the authority retires another host's keys; an observe-only host runs `retire-own` only.
- **Audit.** Every issue and retire pass writes one system-actor row to `core.audit_events` in the platform tenant (`platform.module_credentials.issued` / `.retired` / `.retired_own`): operation id, host name and boot id, composition revision, module ids and provider key ids, the cutoff and what failed. Never a key.
- **Healing and failure.** A pass that fails or overruns never stops the host or holds its publication: it logs `MODULE CREDENTIAL PROVISIONING FAILED` (or `MODULE CREDENTIALS UNAVAILABLE for <modules>`), the affected owners' delegated calls fail closed, and a background loop retries every minute, backing off to a quarter hour while it keeps failing; a key it obtains is handed to the empty slots without a restart. If the host finds its own keys revoked (a binding no longer active, or a key disabled or ended in the key store, checked every minute), it logs `MODULE CREDENTIALS OF THIS HOST WERE REVOKED`, issues every caller a fresh key and hands it over on the open channels, without a restart. A renewal or rotation that issues nothing changes nothing: the keys held stay in use until they end, and the loop retries with backoff; a module the pass missed keeps its old key. Healing stops once a newer release holds the authority. A retirement that fails is logged and repeated by the next boot.
- **Local demo.** `scripts/demo/up.sh` keeps the pass's output in its own memory (never exported) and gives each calling module's server (`scripts/demo/serve-module.mts`, which runs `modern serve` in-process) a private FIFO on its file descriptor 3, writing that module's line once the keys exist; the Outbox Worker host gets its line on a pipe. The demo does not rotate or run `retire-own`: its keys simply end after 24 hours, so a demo left running longer than a day needs `up.sh` again.
- **Internal workload credentials.** A calling module whose own server acts as one of its own internal workloads (O73) gets that workload's keys the same way: `MODULE_INTERNAL_WORKLOADS` in `scripts/zerops/module-credentials.mts` (today only CRM's Party intake, `demo.crm.party-intake`; a test derives the module list from source and checks that the module's own access declarations name each workload).
  - **Registration is the platform's (ADR-0028).** At release `scripts/demo/release-internal-workloads.mts` (core: `packages/core-runtime/src/install/release-internal-workloads.ts`) registers each such workload that the reviewed catalogue also declares. It does so in every tenant that serves people where the module is installed, once per active company: one service principal, one workload binding, one company binding. One active workload binding acts for one company, so each company has its own registration and key.
    - It writes through Core's own writers as the tenant's release actor, under the tenant's workload fence, with one audit row per tenant it changed.
    - The principal's id is derived from tenant, workload and company. It holds no role, grant or relationship, is never a person, and never appears in People.
    - It retires what is no longer wanted: module not installed, workload no longer declared, company not active. Company binding and workload binding are revoked and the principal is disabled; nothing is deleted. Re-running changes nothing.
    - Only the platform changes a registration's status: the principal-status Action refuses any principal with a platform role and any principal of the platform tenant. A registration found disabled or archived anyway is made active again by the next release and reported as healed. The database refuses any change to `platform_role` (`core.keep_system_principals`), but all writers share one runtime role, so it cannot tell the release step's status writer from an Action's: that guard is in code.
    - A registration someone made by hand is never adopted and never keyed.
    - A principal that holds a derived id without the platform's marker is never adopted. One of another tenant is reported as `id taken by another principal (tenant …)`. One of the same tenant (an earlier build registered it before the marker existed) is reported as `derived id held by an unmarked principal of the same tenant created by an earlier build`; that company's registration stays unmade until an operator removes the old principal. Local fix (wipes the local demo database and builds it again): `docker --context orbstack compose -f docker-compose.yml -f scripts/demo/compose.demo.yml down -v && scripts/demo/up.sh`. On stage, count such principals with `select count(*) from core.principals where display_name like 'internal-workload:%'`.
  - **Keys.**
    - Each provisioning pass reads the active platform registrations tenant by tenant (one short transaction per tenant, the platform tenant skipped). For each it issues one key owned by the platform key owner, binds it to that principal in that tenant (a managed `api_key` binding) and attests it (`workload_attested_v2`: module, workload, tenant, company, principal, build, release, host, boot).
    - The key travels beside its module's key, keyed `<app id>/<workload>/<tenant id>/<company id>`. The module reads exactly the entry of the request's tenant and company (`ownWorkloadCredential`), never another company's and never the environment; without one it fails closed and logs the tenant and company ids.
    - It is rotated with its module's key, retired with the host's own and the superseded keys, audited in the same pass rows, and dropped (and retired) at the next renewal once its registration ends.
  - **Order.** The publishing boot registers first and then provisions, so a first deploy keys every registration in the same pass. After publishing, the release fiber runs the registration again, after the release-time module install where that step exists. When the registrations then differ from the keys held, the next healing step renews them within a minute. The local demo (`up.sh`) registers right after the permissions and then provisions.
  - **Admission does not change.** It is an ordinary key of the registered principal, admitted at `/auth/api-key/gateway-context` and only for what that registration admits; it is no module credential, so the delegated endpoint refuses it.

What happens to the owners process or the Outbox Worker host on its key channel:

| Channel state                                                                                                                              | What the process does                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `ONTOS_MODULE_CREDENTIAL_HANDOVER` unset                                                                                                   | Opens no socket; no owner holds a key, and none can come from the environment  |
| End of the channel, local demo (`fd3`: the launcher may close its side after a hand-over)                                                  | Keeps running with the keys it holds                                           |
| End of the channel, app host (`fd3-lifetime`: the host keeps it open while it lives; the kernel closes it when the host dies, even killed) | Stops, so it never serves as an orphan with keys nobody rotates                |
| Malformed or partial line                                                                                                                  | Refuses that line, keeps reading                                               |
| Socket error or a premature close while reading                                                                                            | Stops (`HANDOVER CHANNEL LOST`); the app host stops and the container restarts |
| File descriptor 3 is not a pipe                                                                                                            | Stops, as for a socket error                                                   |

How long delegated calls can be without a key around a deploy:

- **Normally: 0 minutes.** The new host issues its keys and hands them over before it verifies release access and publishes, so its owners hold keys before they serve; the old host keeps its keys until 2 minutes after the new release took the authority, when it no longer serves governed requests.
- **When the boot pass fails: about 1 to 1.5 minutes.** The host publishes without keys (one attempt, at most `PROVISIONING_BUDGET`, two minutes), and the healing loop issues the keys on its first step about a minute later.
- **Liveness unreadable:** revocations are not noticed until the read works again, but keys are still rotated before they end; the failed read is logged once per streak.
- **Keys reported revoked again and again:** renewals back off to 2, 4, 8 and then 15 minutes, and the log names how many came in a row.

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
3. provision the stage Action grants from the canonical access catalog (`pnpm authorization:catalog:artifact` / `pnpm authorization:catalog:report`) in the stage-gated artifact. It publishes the compatible schema and membership-set executor grants for every `tenant_membership_default` Action across the fixed stage Tenants. For every `explicit` Action it writes direct executor grants for the accounts whose `grants.explicitActions` in the operator stage accounts file name it ([ADR-0028](../../../docs/adr/0028-stage-accounts-from-operator-data.md)); set `ONTOS_STAGE_ACCOUNTS_FILE` for the run;
4. verify every default Action for the fixed stage Principals and the non-member denial. Verify every explicit Action as allowed for its grantees and denied for every other fixed account and the non-member. Verify that no fixed Principal can access the other fixed Tenant;
5. only then deploy the runtime that treats missing `action#execute` permission as denial;
6. smoke one provisioned Action and one deliberately unconfigured Action denial.

The command is operator-invoked, idempotent, accepts no scope arguments, and must not be attached to PostgreSQL migrations, SpiceDB startup, application startup, or automatic deployment. A failure or catalog mismatch blocks promotion. Rollback restores the previous application artifact while leaving the additive schema and relationships in place.

Provisioning is additive, not stale-grant reconciliation. Before narrowing an Action from `tenant_membership_default` to `explicit`, the operator must prepare its intended narrow grants, remove the obsolete `action:<encoded-key>#executor@tenant:<fixed-tenant>#member` relation for each affected fixed Tenant, and verify both the intended allowed Principal and a Tenant member who must now be denied. Removed Actions and revoked role/workload assignments likewise require an explicit, reviewed removal of their obsolete executor relations. Derive Action object IDs with `toSpiceDbActionObjectId`; never delete unrelated tuples or rely on rerunning `TOUCH` to revoke access. Record and verify this policy-data transition before promotion. An application rollback must not silently restore a revoked grant; any policy restoration needs its own reviewed decision. The fixed environment's provisioning input records at least one allowed and one denied Principal assertion for every `explicit` Action. On stage those assertions and grants are derived from the operator stage accounts file, the same data the bootstrap writes; grant data may name only accounts in the file and current `explicit` Actions, and a direct grant may name only a fixed Principal with an allowed assertion. Development has no explicit policy, so it still fails while the catalog has `explicit` Actions. Promotion verifies every fixed context plus the representative non-member for each `tenant_membership_default` Action; it verifies only those recorded per-Action assertions for an `explicit` Action. Missing, duplicate, unknown, allow-only, or deny-only explicit assertion sets fail before schema or relationship writes.

### Stage accounts bootstrap

Stage bootstrap is an operator action, not a migration, startup hook, or automatic deploy step. It must remain:

- driven only by the operator stage accounts file; source control holds no stage Tenant, account, or grant ([ADR-0028](../../../docs/adr/0028-stage-accounts-from-operator-data.md));
- explicitly gated to stage;
- idempotent and conflict detecting;
- interactive or otherwise secret-safe;
- outside normal application startup;
- responsible only for the documented initial installation exception.

The operator supplies every stage Tenant, account, and grant in a JSON file outside the repository and names it with `ONTOS_STAGE_ACCOUNTS_FILE`. `mise exec -- pnpm --filter shell-super-app stage:bootstrap-accounts` fails when the variable is unset, the file cannot be read, the file is readable by group or others, or it does not match this shape. Errors never echo file values, and output names accounts but never passwords. A failed run prints `Stage accounts bootstrap failed (<code>): <reason>`; a refusal of the run keeps the code Core decided it under (`stage_last_administrator`, `stage_connected_app_not_administered`, `stage_context_bootstrap_failed`), so it is never reported as a persistence failure.

```json
{
  "schemaVersion": 2,
  "tenants": [
    {
      "tenantId": "<uuid>",
      "slug": "<lowercase-slug>",
      "displayName": "<name>",
      "defaultLocale": "<locale>",
      "moduleKey": "<base module key declared by the composition>",
      "moduleStateId": "<uuid>",
      "legalEntity": {
        "legalEntityId": "<uuid>",
        "legalName": "<name>",
        "registrationCountry": "<ISO 3166-1 alpha-2>",
        "registrationNumber": "<number>"
      },
      "accounts": [
        {
          "principalId": "<uuid>",
          "authBindingId": "<uuid>",
          "email": "<email>",
          "password": "<at least 8 characters>",
          "displayName": "<name>",
          "grants": {
            "owner": true,
            "roles": ["full_access"]
          }
        }
      ],
      "workloads": [{ "principalId": "<uuid of an account of this Tenant>", "workloadKey": "<declared workload key>" }]
    }
  ],
  "attachedLogins": [
    {
      "tenantId": "<uuid>",
      "principalId": "<uuid>",
      "authBindingId": "<uuid>",
      "email": "<email>",
      "displayName": "<name>"
    }
  ],
  "retiredPrincipals": [{ "tenantId": "<uuid>", "principalId": "<uuid>", "email": "<email>" }],
  "retiredTenants": [{ "tenantId": "<uuid>", "legalEntityId": "<uuid>", "principalIds": ["<uuid>"] }],
  "retiredAccountEmails": ["<email>"]
}
```

- Every Tenant, slug, legal entity, module state, Principal, binding, and email must be unique; unknown keys are rejected. Every UUID is read in lowercase, so two spellings of one id are the same id. `tenants` may be empty when the file only attaches or retires logins; every Tenant it lists is reconciled in full, including its owner's password.
- `grants.owner` names the one account that owns the Tenant: `bootstrapTenantAccess` creates the Tenant's scopes, its owner's memberships and the "Plný přístup" role assigned to it in every scope. `grants.roles` lists what a further account holds beside its membership; `full_access` is the only role the file may name today. Nothing assigns rights by account kind, and no account receives a blanket grant: a capability a module ships later arrives through Novinky and an explicit adoption, never by rebuilding the release a role is pinned to.
- `workloads` (optional) registers the trusted machine workloads of one Tenant (O73): each entry names a Principal of that Tenant and one `<module>.<workload-name>` key a carrier declares with `accessWorkload`. A workload that is not registered is refused, so a service principal never acts on the strength of its kind.
- `attachedLogins` (optional) gives an existing login a Principal of its own in an existing, active Tenant that the file does not list: a human Principal and a `better_auth` staff binding to the login's Better Auth user, found by email (exactly one, not banned). Only a Principal and a binding that both do not exist yet are created; a rerun accepts exactly the pair it created and refuses any other existing Principal or binding, so no login is ever added to somebody else's Principal. The login, its password and the Tenant's release stay unchanged, and the Principal holds no access until the Tenant's administrator grants it through People.
- `retiredPrincipals` (optional) ends one person's sign-in to a Tenant that stays active. `email` names the login that signs in as that Principal (exactly one Better Auth user): the Principal must hold a live (`active`) staff binding of that login and, beside its connected apps, no binding of any other login or credential, or the entry is refused; a historical binding of the login is not enough. Only a rerun finds the Principal without one, archived with every binding revoked and one of them the login's. A Tenant owner, a co-owner included, is refused: ownership moves only through People. The departure is the one the People "person leaves" command plans, run as the Tenant's one live owner acting for the stage operator (ADR-0028), so every membership it ends records that owner as `ended_by` and the reason "Ended by the tenant owner through the stage accounts bootstrap…"; a Tenant without exactly one such owner is refused: an active person whose ownership row and tenant membership path have both started and not run out at the decision time. Under the Tenant's People lock the tenant membership ends with every membership, assignment (delegated ones included), managed delegation and administration that stood on it, and the last administrator of the Tenant or of a company is refused because the file names no successor; an administrator counts as one who stays only when, at the decision time, their administration row has started and not run out, their membership path is live and they are an active person. The decision time is taken after the run holds every lock it waits for, so nothing that runs out while the run waits counts. Before anything is written, every scope (the Tenant or a company) where a leaver holds administration must keep somebody who effectively administers it at the decision time, decided by Core's live rule (`administersScope`) with every leaver of the file excluded: an active person with a started, unexpired administration (their own `access_admin` row there, or Tenant ownership), a live membership path and no suspension in that company; otherwise the file is refused with `stage_last_administrator` naming the scope. A Tenant owner suspended in a company does not administer it, so the acting owner does not stand in for a company administrator there, and two leavers never count each other. The membership rows of the administrators who stay are share-locked with their Principal rows, so no suspension or end of their administration commits before the run does. The person's company directory memberships end as `departed`, exactly the bindings the run read are revoked (each by compare-and-set on its revision) and the Principal is archived. Connected apps (the OAuth connections the person approved, `core.oauth_connection_grants` acting as them) do not refuse the departure. Every `oauth_grant` binding whose grant acts as the person and names that binding back is revoked with the login's binding, a `disabled` one too: Odpojit in the product only disables the binding, and Core's binding writers may enable a disabled binding again while its Principal is active. A connected app that is still live (an `active` grant, or a `draft` consent the person has not finished) is ended in the same transaction through Core's grant transition, as a company administrator's Odpojit ends somebody else's connection, and so only in a company the acting owner effectively administers at the decision time, by the rule of the last-administrator check (`administersScope`): a live app in a company the owner does not administer (a Tenant owner suspended there) refuses the file with `stage_connected_app_not_administered`, naming the app's client and the company, and the move transaction writes nothing. An active grant becomes `revoked` with reason `admin`, a draft `denied`, both attributed to the acting owner. For exactly the grants the run moves from `active` to `revoked`, the same transaction records the product's `oauth.connection.revoked` event as an administrator's revocation records it (the product's row builder, the acting owner as actor in the app's company, reason `admin` and a note naming the stage accounts bootstrap), so the event commits with the revocation or not at all; the administrators' connection notes show it. A draft the run denies, a grant that had already ended (an older administrator revocation included, whatever it recorded) and a rerun, which ends nothing, record nothing. The run prints every app it ended: client name and id, the status it found and when it was last used. After the commit the Shell finishes each ending as the product's revocation does after its own commit: it deletes the Better Auth tokens and consent of every connected app of the people it retired, by grant id, so no refresh token of an ended grant keeps minting access tokens (another grant of the same login, such as one it connected as its new Principal, keeps its own). Until that clean-up has run, a refresh of an ended app still succeeds and yields a token that every data endpoint (MCP) refuses: the OAuth server's refresh and UserInfo endpoints do not check that the grant is still active, as after the product's own disconnect. The connected app of a retired person stops at its next request and must be reconnected in the new Tenant; a rerun after a crash finishes the token deletion. An `oauth_grant` binding that no grant of the person names still refuses the entry as "another login or credential". A Principal that still granted or manages a live delegation, holds a team place or operates a live agent connection is refused until that is ended through People; so are a non-human Principal, an active account, an attached login and a Principal of a retired Tenant.
- All attached logins and retired Principals of one file commit in one move transaction, after every refusal has been decided, so a refused entry makes that transaction write nothing for any of them. That is all a refusal promises: before the move transaction the Shell has already reconciled the Better Auth accounts the file lists (created users, reset passwords, verified emails) and run the read-only pre-step below, whose token and consent deletion a refused file does not undo. The run locks each leaver's connected apps first, as Core's revocation and a first approval lock the grant before the person's rows, then the Principal row before it reads anything else about it: a personal key, a staff binding or an agent connection written for that Principal meanwhile waits for the run to commit and is then written on the archived Principal. A reconnect does not follow that order: approving a draft locks the draft, then the person's rows, then the older active grant of the same client it supersedes, while the run may hold that older grant and wait for the draft or the person's row. The two can deadlock; PostgreSQL then aborts one of them, and when it is the run, its move transaction writes nothing and the same file is run again. An approval during the run ends in one of four ways: a draft the run locked is denied by the run, and its approval finds no draft left; a draft the run read while a first approval held its lock makes the run wait on that lock, and once the approval commits the run reads the grant as `active` with its binding and ends it as an administrator revocation, with its event; the approval of a draft created after the run's locking read of the grants waits for the person's row and then finds the person archived; and only a draft created after that locking read and approved before the run locks the Principal leaves a binding that no grant the run read names, so the run refuses the file as another credential, its move transaction writes nothing, and the same file is run again. A consent the person starts during the run stays a draft that can never be approved (approval needs an active Principal) and expires after 30 minutes. Such a row is inert (sign-in, key verification, the request context and agent requests all refuse an archived Principal), and the run never revokes it, because it never read it. The credential writers belong to Core auth, so the run does not stop them. **Run it in a quiet window:** drain the identity and access writers (no personal key, binding or agent connection being created or changed in the affected Tenants) and make sure nobody is using the affected logins.
- A late row matters only to a rerun. An active late row makes a rerun of the same file refuse the entry: a binding as "another login or credential", a connection as "a live agent connection". A rerun is needed only when the first run stopped between its commit and the reconcile or the clean-up of connected apps. To recover, end the late row through its governed command as a Tenant administrator, then rerun the file. For a personal key or another binding, use `core.identity.change-principal-binding-status` (access `core.identity.principal-binding.change-status`) with `requestedStatus: "revoked"`, the binding id and its current revision. For an agent connection, use the company administrator's Odpojit in connected applications (`revokeConnection`, access `core.identity.oauth-connection.administer`), with a reason. It ends the OAuth grant and its connection. A late agent connection whose OAuth grant is still in draft cannot be ended by the company administrator's Odpojit and blocks a rerun until it expires, another reason to run in a quiet window. Before the run, list each leaver's unrevoked bindings and connected apps read-only. Every unrevoked binding must be the login's own or an `oauth_grant` binding whose grant in `core.oauth_connection_grants` acts as the leaver (`acting_principal_id`) and names that binding (`auth_binding_id`); anything else (a personal key, another login) is refused and must be ended first as described above. The grants still `active` or `draft` are the connected apps the run will end; check that the acting owner administers the company of each (`legal_entity_id`), and tell the person beforehand, since the client stops working at its next request. Never edit these rows by hand. The Tenants people left are then reconciled; when a run stops between that commit and the reconcile, running the same file again finds every move already made, writes nothing, and completes the reconcile. When it stops before the clean-up of connected apps, the same file finishes it through a read-only pre-step that runs before the move transaction: it selects the people the file names who are archived, with every binding revoked, one of them the login's, and nothing live, and deletes only the Better Auth tokens and consent of their grants, by grant id. A retirement is one transaction that also archives the Principal, so an archived Principal of the file whose bindings are all revoked has completed it; and deleting the tokens of grants that have all ended is idempotent, and harmless even for a Principal archived by other means. No receipt table records a departure. The pre-step runs whatever the run then decides about the rest of the file, so even an attached login whose new Principal has since connected an app, which the attachment's exact replay refuses, does not keep it from finishing. Attach the login's new Principal and retire its old one in the same file to move a login between Tenants.
- The reconcile of a Tenant a person left is the single Core writer's, and it projects the Tenant whole: any access change of anybody else in that Tenant that a People command committed and never projected is published by the same run. Before the run, make sure no People change in that Tenant is waiting for its projection (a People command that reported a projection failure after its commit); the run would publish it together with the departure.
- `retiredTenants` (may be empty) lists former stage Tenants. The bootstrap revokes their bindings, archives their rows, and reconciles the intent that carried their authority, so the projection of it goes with it.
- `retiredAccountEmails` (may be empty) lists former stage accounts. The bootstrap bans each one, ends its sessions and removes its password credential. Retired data must not overlap an active Tenant, Principal, or email.
- Keep the file mode `600`. Rerunning with a changed password resets that account's password and ends its sessions. The bootstrap is insert-only: it never revives a membership, an assignment or a role an administrator ended, and removing a grant from the file does not revoke it.

The bootstrap's Core work connects with the runtime identity (`DATABASE_URL`), not the administrative one: every scope it installs is a session-setting scope its enrollment must name, and the identity rows and revocation events it writes are the shared runtime's own. Its Better Auth store connects with `DATABASE_ADMIN_URL`. The two URLs must be distinct logins (the runtime login is never `postgres`) of the same server, port and database; anything else is refused with `stage_accounts_configuration_invalid` before either pool opens. Each client confirms on its first statement only that its session is the login its own URL names, so that check cannot notice the two URLs swapped between the clients. Three things keep them apart: the one composition in the script (`makeStageAccountsRuntime`), which builds Core from `DATABASE_URL` and Better Auth from `DATABASE_ADMIN_URL`, the engine transport and the access writers, and which no caller wires differently; the integration test, which builds its run through that function and asserts that Better Auth's `session_user` is the administrative login and Core's the runtime login; and Core's role check whenever it installs a scope (`scoped-transaction.ts`), which fails closed for any role but the session-setting one its enrollment names, so Core handed the administrative URL refuses before it reads or writes a tenant row.

Every pool the command opens is its own, whatever `ONTOS_DATABASE_POOL_SHARED` says. The `app` container sets it to `true` for the app host, which alone installs the registry shared pools draw from and turns sharing off for every finite child it starts (`finiteProcessEnvironment` in `scripts/zerops/app-host.mts`). The operator command runs beside that host, not as its child, so `makeStageAccountsRuntime` applies the same rule itself; without it every client fails with "Shared database pools require a scoped process host registry" before its first statement. The integration test runs the composition with the variable set to `true`.

#### Running it on stage: dry run, run, rerun

The command runs by hand in the `app` container, from the Shell's directory, with the container's `node`. The container already provides `DATABASE_URL`, `DATABASE_ADMIN_URL`, `ULTRAMODERN_DEPLOYMENT_ENVIRONMENT=stage`, `SPICEDB_ENDPOINT=spicedb:50051`, `SPICEDB_CA_CERT`, `SPICEDB_PRESHARED_KEY` and the pool settings `ONTOS_DATABASE_POOL_MAX_CONNECTIONS`, `ONTOS_DATABASE_POOL_IDLE_TIMEOUT_MILLIS` and `ONTOS_DATABASE_POOL_MIN_CONNECTIONS`; its `ONTOS_DATABASE_POOL_SHARED=true` is overridden by the command, so the operator sets nothing for the pools. With the three below, these are every variable the command's configuration reads. The operator sets:

- `ONTOS_STAGE_ACCOUNTS_FILE`: the operator file, mode `600`, outside the release tree.
- `BETTER_AUTH_URL`: the origin the app host hands the Shell, which it derives from `ONTOS_PUBLIC_ORIGIN` and lets no stored value override, so `$ONTOS_PUBLIC_ORIGIN`.
- `BETTER_AUTH_SECRET`: the Shell's own entry of `ONTOS_OWNER_SECRETS_JSON` (key `shell-super-app`), which the host hands only to the Shell process. Read it into the variable without printing it; the line below prints nothing, and on any failure the variable stays empty and the command refuses with `BETTER_AUTH_SECRET is required`.

```sh
cd /var/www/app/apps/shell-super-app
umask 077  # the operator file is written with mode 600
# write the operator file to /tmp/stage-accounts.json
export ONTOS_STAGE_ACCOUNTS_FILE=/tmp/stage-accounts.json
export BETTER_AUTH_URL="$ONTOS_PUBLIC_ORIGIN"
export BETTER_AUTH_SECRET="$(node -e 'try { process.stdout.write(JSON.parse(process.env.ONTOS_OWNER_SECRETS_JSON)["shell-super-app"].BETTER_AUTH_SECRET) } catch { process.exit(1) }')"
node scripts/bootstrap-stage-accounts.mts --dry-run   # 1. the dry run
node scripts/bootstrap-stage-accounts.mts             # 2. the real run, only after reading the dry run
rm /tmp/stage-accounts.json
```

Node first prints a `MODULE_TYPELESS_PACKAGE_JSON` warning; it is harmless. Without a flag the command is the real run, and `--dry-run` is its dry run. Its command line is parsed before it reads the file or opens a connection: a mistyped flag, a repeated one or a stray argument is refused with the usage and exit 1, so it never starts the real run; `--help` prints the usage.

1. **Dry run first.** `--dry-run` makes every read and refusal of the real run, in its order, then runs the real move transaction (the same People locks, row locks, reads, decision and writes) and rolls it back instead of committing it. It prints, per person the file retires, the bindings it would revoke counted by provider, subject and the status it read, the memberships, assignments, delegations, team places and directory rows it would end and the audit events it would record, and each connected app it would end with its client name and id, the status it found and its last use; per attached login, the Principal and binding it would create (or that it finds them created already); the total of audit events; then one `Dry run skipped …` line for every write of the real run outside that transaction, each of which it does not make: the pre-step's deletion of Better Auth tokens and consent (its read runs), the reconciliation of the file's Better Auth accounts (their reads and refusals run; the line says whether the run would create the user, replace its password and end its sessions, or mark its email verified), the deletion of tokens and consent after the commit, the authorization reconcile of each tenant somebody leaves, every tenant and retired tenant of the file, and every ban of a retired account. A refusal is printed exactly as the real run prints it, and exits 1. Nothing persists: the move transaction's rows roll back with it (a rolled-back insert can at most consume a sequence value), it writes nothing to SpiceDB, and no write outside it runs. A refusal the real run can only meet after its move transaction (reconciling a tenant the file lists, retiring a tenant, an engine failure during a reconcile) is not shown. Because the dry run is the real transaction, its lock footprint is the real one, held for as long as that transaction runs (usually well under a second): each affected tenant's People lock, the leavers' grants, Principal rows, bindings and agent connections, and share locks on the administrators who stay. Run it in the same quiet window as the real run; a reconnect during it can deadlock with it exactly as with the real run, and it is then simply run again.
2. **Then the real run**, only when the dry run printed exactly the intended moves and no refusal. The real run decides again under its own locks, so it may still refuse what changed since the dry run. It prints each attached login, each retired Principal and each connected app it ended.
3. **Rerun rule.** The real run is run once. When it fails or is interrupted, run the dry run again with the same, unchanged file. When it prints every Principal as retired already and every login as attached already, the move transaction committed, and the real run of the same file writes nothing more of the moves and finishes what is left: the reconcile of the tenants people left and the token clean-up. When it prints the moves again, nothing of them was written: resolve what the failure named (through People or the governed commands above), then dry-run and run again. Never edit the file between a run that may have committed and its rerun.

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
- Shell/Core SSR renders stable framing and typed placeholders. Any future MicroVertical SSR runs in a MicroVertical-owned isolated process, not the Shell/Core Node.js process. On Zerops stage the owners run in one owners process beside the Shell process in the same container, reached over loopback. Module code still never runs inside the Shell process (see [Stage on Zerops](#stage-on-zerops)).
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

Stage is the only deployed environment. `.github/workflows/zerops-stage.yml` deploys it from `demo/sales-crm` into the GitHub environment `stage-edge` (see [Stage on Zerops](#stage-on-zerops)). `main` deploys nothing: `ultramodern-workspace-gates.yml` only runs the gates. There is no production deploy path; a production project needs its own deploy workflow, its own `migrator` identity secrets, gateway key pair, auth origin and SpiceDB TLS pairs, and its own enforced authorization evidence and context (see [Fail-closed authorization promotion](#fail-closed-authorization-promotion)) before anything deploys to it.

`zerops.yaml` describes stage: SpiceDB, the storefront and the one application container (`app`), which runs the owner migrations, every owner and the Outbox Worker host. `zerops-import.yaml` lists the services those setups deploy, plus the `migrator` service that holds the identity secrets. Every service runs a single container.

Outbox Workers run in the app container's one Outbox Worker host process, which runs only the workers of the units the deployment serves (`ONTOS_OUTBOX_HOST_SERVED_UNITS`). `scripts/zerops/build-app.sh` bundles it under the release identity each hosted owner's build names, and the workspace gates prove that bundle against a freshly migrated database before any deploy (`scripts/prove-outbox-worker-host-artifact.sh`).

### SpiceDB TLS

Every runtime reaches SpiceDB over TLS gRPC and pins `SPICEDB_CA_CERT`, which `zerops.yaml` takes from the `spicedb` service's `SPICEDB_GRPC_TLS_CERT` secret; there is no plaintext mode. `scripts/run-zerops-spicedb.sh` starts SpiceDB only when its four TLS secrets exist on the `spicedb` service: the gRPC pair (`SPICEDB_GRPC_TLS_CERT`, `SPICEDB_GRPC_TLS_KEY`), a self-signed certificate for `spicedb`, `localhost` and `127.0.0.1`, and the HTTP gateway pair (`SPICEDB_HTTP_TLS_CERT`, `SPICEDB_HTTP_TLS_KEY`). A human operator creates missing pairs as sensitive service secrets; no script provisions them. `generateGrpcMaterial` in `scripts/ops/spicedb-tls.mts` produces a gRPC pair of the required shape (named-curve P-256, never a CA), which `pnpm spicedb:tls:local` also uses for the local development pair.

### Adding a vertical

The app host serves the Shell plus every module of `topology/application-release-intent.json`, and `zerops-stage.yml` builds exactly those units, so adding the vertical's module to the release intent is what puts it on stage. In the same pull request:

1. Add the vertical's module to `topology/application-release-intent.json`.
2. Add its unit to one shard of the `node-artifact-build` job in `ultramodern-workspace-gates.yml`; `Repository Tooling Tests` fails until it does.
3. Add its owner secrets, if it has any, to its `appId` entry in `DEMO_IMMUTABLE_RELEASE_SECRETS` before the deploy (see [Order-flow owner credentials](#order-flow-owner-credentials)).

A vertical needs no new GitHub variables, no Zerops service and no Cloudflare configuration.

Payment is not in the release intent, so stage builds and serves no Payment owner; the migrator still applies its schema. Main's release intent leaves it out too, and its cross-owner evidence ports and `payment.source-ingress` workload have no stage provider yet. No other owner calls Payment, so only Payment's own features are unavailable.

Promotion is left out of the release intent on the same terms: main's release intent omits it, and the migrator applies its `promotion` schema. Pricing treats an uninstalled Promotion module through its existing not-installed fence, so promotion contributions are unavailable and nothing else changes.

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
   Exception: the dedicated database identities cannot be rolled back by redeploying the previous release, because its verifiers reject the `trust` schema. Ship the forward rollback release described in [Database trust boundaries](./DATABASE_TRUST_BOUNDARIES.md#rollback) instead.
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

The push that lands the commit deploys nothing. `queue-proof` looks for a successful `merge_group`
run of the workflow on that commit; when one exists every gate job is skipped and `Workspace gates`
passes on that proof. A commit without one (a dispatch on a commit pushed before the queue) runs the
gates.

`demo/sales-crm` has no merge queue. A push to it skips its gates on the same `queue-proof` job when a
successful `candidate/*` dispatch of the workflow ran on that exact commit with `base-ref` `demo/sales-crm`
and compared with the commit the push starts from, and that commit's own push run is green. The
candidate's plan records what it compared with in its `ci-comparison` artifact;
`scripts/ci/commit-proof.sh` reads it, and its log and step summary name the proving run.

Stage deploys from `demo/sales-crm` (`zerops-stage.yml`), never from `main`.

## Demo branch divergence from main

When `main` merges into `demo/sales-crm`, main's design wins except for these recorded exceptions:

1. Owner-action approvals and agent proposals, including the AI staleness comparators.
2. The optional `mcp` key in module manifests.
3. Staged prepare/load/finish reads (helpers with the `Staged` suffix).
4. Owner-declared Search presentation.
5. Build-time public components.
6. The module-declared external identity provider (Customer Context portal auth).
7. Demo capability issuers.
8. Manifest-declared registered-workload calls.
9. Declared in-transaction evidence calls. The demo's transaction I/O guard refuses remote I/O inside every governed read and Action transaction, but main's source-evidence design makes its owner proof reads (current Privacy, Party, Customer Profile and source facts) from inside the owner write or read transaction. Its request can only be derived there, from sealed invocation facts (the current invocation and its idempotency key, the admitted workload) and from correlation and replay lookups. Those proof calls are declared at their call sites with `declaredEvidenceCallInsideTransaction`, from one registry per owner (`src/declared-evidence-calls.ts`). Inside a declared call the remote refusals are lifted and a second pool connection is still refused. `scripts/tests/declared-evidence-calls-ratchet.test.mts` pins the 23 declarations by value and every file that uses one (and how often), so the number can only go down:
   - Assortment (1): `assortment.symmy-rule-fixture-owner-currentness` (its owner authorization overlay for the enrolled Symmy rule fixture import reads current Catalog, Customer Context, Market Catalog and Storefront Registry facts).
   - Party Registry (3): `party.client-source-privacy`, `party.client-source-organization-privacy`, `party.legacy-ico-privacy`.
   - Privacy (9): `privacy.organization-ico-owner-facts`, `privacy.organization-profile-ico-owner-facts`, `privacy.organization-business-owner-context`, `privacy.organization-business-owner-facts`, `privacy.organization-source-owner-facts`, `privacy.organization-profile-owner-facts`, `privacy.organization-party-record-facts`, `privacy.customer-intake-owner-context`, `privacy.source-person-party-owner`.
   - Symmy (2): `symmy.customer-intake-privacy`, `symmy.retention-privacy-current` (both retention checks, before and after the source fence cancellation wait).
   - Customer Context (8): `commerce.organization-business-eligibility`, `commerce.source-processing-eligibility`, `commerce.source-counterparty-admission`, `commerce.source-person-admission`, `commerce.organization-profile-ico-eligibility`, `commerce.counterparty-organization-ico-facts`, `commerce.counterparty-migration-correlation`, `commerce.legacy-ico-inventory`.

   Known follow-ups:
   - Three Privacy declarations wrap an injected owner-provider seam that no production layer provides (`OrganizationBusinessFactsOwner`, `OrganizationIcoFactsOwner`, `OrganizationProfileIcoFactsOwner` in `organization-business-applicability.service.ts`, `organization-ico-applicability.service.ts` and `organization-profile-ico-applicability.service.ts`). They exist so main's integration tests, whose injected providers fetch, pass under the guard; they go once those test fakes stop doing remote I/O inside the read.
   - A fiber forked as a daemon, or a finalizer registered on an outer scope, from inside a declared call would inherit the lifted state. No wrapped code does this today; the follow-up is a guard test for it and clearing the lifted state by identity when the declared effect exits, a guard change that needs its digest re-pinned and a re-review.

   What removes each: staging that proof in the operation's prepare step (or a read's finish step) and revalidating it against transaction-local owner state, once Core exposes the sealed invocation facts to preparation. Privacy's read-only proofs can move first: their requests need no sealed facts (branch `fix/merge4-a2-restaging-20261114` holds a first attempt).

10. Lint suppression counts. Main still fails the Quality Audit workflow on an increase; the demo reports changes, totals, and GitHub Actions warnings without enforcing a count limit. Removed when main adopts report-only monitoring.

Zerops-only deployment and its own gates: the demo keeps none of main's deploy jobs or Cloudflare/edge workflows and deploys through `zerops-stage.yml`. Its `ultramodern-workspace-gates.yml` is its own design, not main's: six build shards with a per-unit output cache whose kept units carry their proven identity, a seed database the integration rows restore, a separate seed proof, browser job and Node proof (the ten gate ids in `scripts/check-ci-gates.sh`), scheduler `needs:` instead of in-runner build waits, and changed-owner narrowing on demo pushes. Merges from main port its CI ideas into that shape instead of taking main's workflow. The deploy chain behind `MAIN_DEPLOY_ENABLED` in `ultramodern-workspace-gates.yml` and the workflows `active-application-composition-refresh.yml`, `initial-composition-cutover.yml` and `stage-edge-cost-guard.yml` are absent on purpose.

The owner generator no longer scaffolds a Cloudflare build script.

Upstream risk when the demo merges back into `main`: Tax keeps the demo's migrations `20261023223119_gateway-assertion-redemptions` and `20261030121613_gateway-assertion-redemption-main-shape` instead of main's `20261109213238_tax_gateway_assertion_redemptions`. A database that already ran main's migration would replay the demo's two by name. Reconcile the Tax migration history before that merge lands.

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

Authorization changes deploy schema and data expansion first: the Contacts assertion-redemption migration and SpiceDB policy precede every provider and the Shell. Run the source-owned inventory check (`pnpm authorization:inventory:check`) and the catalog report (`pnpm authorization:catalog:report`) over one source revision. The catalog report is review evidence, not runtime policy: it lists every declaration, field group and review finding the installed modules carry, and a missing or invalid declaration fails the check. The canonical catalog artifact under `topology/` is the promotion record; keep it regenerated from the installed modules before any promotion.

`report_only` is valid only before its declared expiry and never in production. `enforced` has no expiry; `expiresAt` bounds only a report-only window. In production, `enforced` requires matching zero-impact, readiness, and negative-smoke evidence from the exact build. Development and stage may enforce without that evidence only while the compatibility baseline is empty, because enforcing then withdraws no allowance. Any present evidence must still match, and a non-empty baseline needs the full set. Stage enforces since 2026-10-01. Abort on an expired window, mixed build evidence, unresolved impact, missing policy/module/worker/issuer/replay data, or a failed negative smoke.

Production remains blocked while no approved source-controlled production context exists; the development/stage provisioner must continue rejecting production and arbitrary tenant or Action arguments. Issue #173 owns technical implementation and readiness; issue #369 owns the separate production-promotion approval gate. Issue #169 is broader review context, not approval. Their current records—not this playbook—determine whether the gates are satisfied. An implementation override never records Petr/Jiří approval or permits production enforcement. The checked-in stage context remains `pending`; code-only override is not approval. Rollback restores the prior application mode only after preserving the exact evidence and must not remove the expanded schema or durable redemption rows while old/new consumers overlap.

## Operator-only legacy completion gate

Before first authority publication, the first active-to-draining fence, a recovered migration, and a replacement pointer publication, the administrative publisher rechecks the configured retired-provider inventory and requires the published owner legacy-completion verifier. Missing verifier, incomplete observation, unknown owner database, unresolved legacy work, or failed evidence retention refuses publication. Closing new durable admission does not itself establish legacy absence.

The operator sets `ONTOS_LEGACY_COMPLETION_EVIDENCE_DIRECTORY` to an absolute private directory. Deployment and refresh jobs create that mode-0700 directory under `runner.temp` and upload its sanitized evidence with `always()` retention for 30 days, including failed attempts. The publisher retains each sanitized native identity/result observation as an exclusive mode-0600 JSON artifact there. A retained observation cannot authorize a later attempt: its live callback, exact database/system/runtime identity, native transaction and revision must match the current transition. Provider credentials and database URLs remain the existing distinct operator/runtime configuration; evidence contains no handoff payload or credentials.

Privacy observes all tenants through its deployment-only administrative verifier, with native full-visibility and READ COMMITTED checks. It holds its own dispatch/outcome table locks while Core verifies its immutable message evidence and commits the fence in a separate transaction. No raw executor crosses the published interface. Unmarked legacy obligations remain unresolved; the gateway never invents an original release, adopts work, marks delivery done, or treats a fresh environment as evidence about another environment. Current marked completion requires the exact owner handoff and immutable successful outcome.

An existing base-schema authority first receives the additive opt-in Core completion and dead-delivery resolution migrations through the normal Drizzle journal. Only that compatible expansion runs before drain verification; the full owner migrator remains deferred until the old authority is verified and sealed. Repeated migration skips the already journaled expansion.

Core acquires its exclusive authority fence before requesting owner leases, matching the authority-before-owner order of public Actions. The owner lock remains held through the actual Core commit. A later owner connection/finalizer failure does not undo an already committed Core transition: retain the exact failure and independently inspect native authority before recovery, as for provider settlement failures.

## Dead Outbox deliveries during a composition drain

A dead delivery never finishes by itself. While publication drains the old release, a dead delivery that carries completion debt blocks the durable-work phase, and any dead delivery blocks the final Outbox phase. The publisher keeps waiting so an operator can act. It logs a warning that names each blocking delivery as the exact command arguments, for example `--tenant-id <uuid> --message-id <uuid> --worker-key commerce.order.finalize-order-work (attempts 60)`. If the drain does not finish within its freshness lease (at most 20 minutes), the publisher fails, and the timeout error names the same deliveries. Before it exits it returns the authority to `active` with durable admission open (see [Returning a stuck authority to `active`](#returning-a-stuck-authority-to-active)), so the old release keeps serving. A dead delivery is now usually refused before the drain starts at all.

Resolve each named delivery with the administrative database identity the publisher uses (`DATABASE_ADMIN_URL` and `DATABASE_URL`). A waiting drain then continues by itself; after a timeout, rerun the same publication:

```sh
mise exec -- pnpm outbox:dead-delivery list [--tracked-revision <old revision>] [--tenant-id <uuid>]
mise exec -- pnpm outbox:dead-delivery redrive --tenant-id <uuid> --message-id <uuid> --worker-key <key> \
  --operator <who> --reason <why>
mise exec -- pnpm outbox:dead-delivery release --tenant-id <uuid> --message-id <uuid> --worker-key <key> \
  --operator <who> --reason <why>
```

- `list` shows each dead delivery with its attempt count and last sanitized error.
- `redrive` is the default once the owner is healthy again. It returns the delivery to `pending` with a fresh attempt budget, and the normal Worker runs it. Its real acknowledgement then clears the debt.
- `release` resolves the delivery without delivery and clears its completion debt. Use it only when no automatic outcome is safe and the owner's business effect has been settled by hand.
- Only a `dead` delivery is eligible. A `released` delivery is terminal and cannot be redriven or released again.
- Every redrive and release appends a row to `core.outbox_delivery_resolutions`. The row holds the operator, the reason, the database session user and the time. No runtime role can write it, so a release is always distinguishable from a Worker acknowledgement.

Order finalization retries for about 24.5 hours, so a dead finalization delivery means a lasting owner refusal. When Customer Context refused PROOF revalidation while the approval request was still valid, redrive the delivery once the owner is available. When CONSUME died after commit because the approval was cancelled or revised, the Order already exists and no automatic terminal outcome is safe. First reconcile the buyer-facing Order by hand, then release the delivery with a reason that records that reconciliation.

Privacy still verifies its own successful measure outcome before publication, so a released Privacy delivery does not satisfy the Privacy legacy-completion gate. Redrive Privacy work instead.

## Outbox work that cannot drain, and Core's own work that crosses the boundary

Before a publication closes durable admission it asks what the drain would wait for and refuses to start when some of that work can never finish: a dead delivery; a pending delivery whose consumer module is not background-eligible in its tenant or whose tenant is not active; a delivery whose next attempt falls after the drain budget; and, as a catch-all, work nothing has picked up for longer than a whole drain budget — a due, never-attempted, unclaimed delivery, or a `processing` one whose claim lease expired that long ago. Age is measured from `available_at`, not `created_at`, so a deploy straight after a redrive is not refused for a row that has been claimable for seconds. It also refuses when an Outbox message has waited longer than a whole drain budget without being matched: the matcher keeps running while a release drains, so a freshly written message is in-flight work, but one that old means no matcher is running and the drain could never finish. Restore the running release's Outbox Worker host (it runs the matcher) and the refusal clears by itself. The refusal names every such row with its reason (`no-eligible-consumer: --tenant-id … --message-id … --worker-key … (consumer …, pending, attempts 0, available at …)`). Durable admission is unchanged and the authority stays `active`, so the running release keeps serving reads and writes. (Earlier boot steps — the migrator, workload registration, credential provisioning and the expand-only completion-schema expansion — have already run and stay applied; they are safe under the old release.)

The consumer and tenant terms are the Outbox claim's own predicates, so the drain cannot wait for work the claim would refuse for those reasons. Two of the claim's terms cannot be asked without a running host — whether each worker's intrinsic provider modules are active for the tenant, and whether any live host registers the worker key at all — and those are what the age catch-all covers: nothing has picked the row up for a whole budget, whatever the cause. Work that is genuinely in flight — claimed, or retrying inside the budget with a live consumer — is not reported and still drains.

The pre-flight fails closed: if it cannot read the outstanding Outbox work, the drain is not started (`its pre-flight could not read the outstanding Outbox work`) and the authority stays `active` with admission unchanged. A core-system delivery counts as having a live consumer only where it carries over: nothing in the authority row says whether the retiring release can claim core-system work (releases before the claim-eligibility fix never do), so a pending core-system row whose worker key's descriptor CHANGED between the releases is refused as `no-eligible-consumer` rather than waited for. A key whose descriptor is identical keeps its consumer: its attempted or redriven rows do not carry over, but they are drained like any other in-flight work. On a retiring release that does claim core-system work, the refusal for a changed descriptor is transient: its host finishes the row and the next deploy proceeds.

The pre-flight is a point in time, so the check runs again at the enter-draining fence, under the exclusive authority lock where the matcher cannot move it. The publisher first waits up to 10 seconds for the running matcher to take freshly written messages; a message still unmatched at the fence, or any delivery that arrived since the pre-flight and could never drain, refuses the drain there. Durable admission, already closed by then, is reopened for the same revision, so the authority is exactly as it was before the publication began.

Once drained, a promote or a seal re-drains if a live host of the retiring release claimed a carried-over row in the meantime. All of those re-drains share one deadline — at most one drain budget, and never past the retiring lease less 75 seconds — and after the last refused attempt the publisher gives up with a message naming the phase the authority is left in.

An `unclaimed-longer-than-budget` refusal means no process is taking that worker key: check which host should serve it. For a core-system key (`core.authorization.*`, `core.identity.*`) that is the app container's Outbox Worker host, which always serves the Shell's core entry; for a tenant module's key it is that owner's worker in the same host. Compare the key against `ONTOS_OUTBOX_HOST_SERVED_UNITS` at build time and the authority's `subscriptions_json`, and check whether the worker's intrinsic provider modules are active in that tenant (an inactive provider holds its work back without ever attempting it). The refusal clears by itself as soon as something claims the row — re-run `composition:drain-preflight` to confirm — and there is no override: the budget cannot be argued with, only the missing consumer fixed.

A `no-eligible-consumer` refusal blocks every deploy until it is resolved, and no command resolves it today. Resolve it by making the consumer claimable again: reactivate or install the consumer module in that tenant (`core.modules.change-tenant-module-state`, or the release module installation), or reactivate the tenant if that is the reason. There is no supported way to discard such a delivery — the dead-delivery commands only accept a `dead` row, and a pending delivery with no consumer never reaches `dead` because nothing ever attempts it. No command discards a delivery whose module is intentionally gone; that needs its own reviewed change.

Core's own system work crosses the release boundary instead of blocking the drain. A delivery carries over only when all of this holds: its worker key is one of `CORE_SYSTEM_OUTBOX_SUBSCRIPTIONS`, the descriptor the retiring authority approved under that key is identical to the one this release ships, the delivery is `pending` with zero attempts and no claim, its message is matched and carries no completion debt of the retiring revision, and no `core.outbox_delivery_resolutions` row names it (a redriven delivery looks untouched, but an operator chose to run it on _this_ release, so this release drains it). The drain, the pre-flight and `composition:drain-preflight` all ask that one predicate, so what the pre-flight exempts is exactly what the drain carries over.

The descriptor equivalence proves the topic and the entrypoint — not the payload schema and not the handler body. The rest rests on the handler being a whole-tenant reconcile that ignores its message payload and is idempotent, and on one rule: **a core-system payload schema change requires a new topic version.** `scripts/tests/core-system-carry-over.test.mts` pins each core-system worker key to its versioned topic so reusing a topic for a changed shape has to be a reviewed edit. Such work is not old-release work in flight: the handler is a whole-tenant reconcile owned by Core and identical in both releases, so the next release's own Outbox host finishes it under the new authority. A core-system descriptor that changed between releases does not carry over and is drained by the release that approved it.

### First deploy with the fail-closed pre-flight

The first deploy of a release with this pre-flight refuses to start its drain, leaving the running release serving,
on any of: a `dead` delivery; a `pending` delivery with no eligible consumer (consumer module not background-eligible
in its tenant, or tenant not active); a `pending` core-system delivery whose worker key's descriptor changed between the releases (a key with an
identical descriptor stays eligible, even for an attempted or redriven row) — this refusal can be transient, since a
retiring release that claims core-system work finishes the row and the next deploy proceeds; a delivery due after the drain's deadline, including one its owner
deferred (the refusal says `deferred by its owner until …`); a delivery nothing has picked up for longer than a whole
drain budget; and an Outbox message unmatched for longer than a whole drain budget. Before pushing, run the read-only
check below, `pnpm composition:drain-preflight`, against the target environment.

### Checking before a deploy

Run this from a checkout of the release you are about to deploy, whenever anything looks stuck, before the deploy rather than during it. It writes nothing, takes no advisory lock, and so cannot stall a running publisher or release; its verdict is advisory for that reason, and the publisher re-asks under its own publication lock before it acts. It prints identifiers, worker keys, statuses and times only, never a payload.

```sh
mise exec -- pnpm composition:drain-preflight [--budget-ms <ms>] [--limit <rows>]
```

It needs the same database identities as the dead-delivery command — `DATABASE_ADMIN_URL` and `DATABASE_URL` — and reports the authority's phase, revision and durable admission; non-terminal Outbox work counted by worker key and status; for each outstanding delivery whether the next drain would `DRAIN` it (a live consumer can claim it), `CARRY OVER` it (Core's own untouched work, with `identity=identical`) or `BLOCK` on it (with the reason), where `identity` is how that worker key compares with the retiring authority's `subscriptions_json` (`identical`, `differs`, `not-core-system`, `absent`); and the verdict `a publication of this release would start its drain: yes/no`. It exits non-zero on `no`. A `BLOCK` with `identity=absent` is a delivery for a worker key the running composition no longer approves at all.

## Returning a stuck authority to `active`

A publication that ends early in or after its drain returns the authority itself before it exits: the same revision
goes from `draining` back to `active` with durable admission open, in one transaction under the exclusive authority
lock. That covers an ordinary failure — the drain budget or the old release's freshness lease expires, the
enter-draining fence refuses, a quiescence check after draining fails, a promote or seal exhausts its re-drains — and
also an interruption (the platform's SIGTERM after its readiness timeout, an outer deadline) or a defect. A failure
message ends with `The authority was returned to active with durable admission open (drain abandonment …)`; an
interruption is recorded in the ledger as one. The restore is bounded by the database (`lock_timeout` 5 s,
`statement_timeout` 10 s) and commits whole or not at all. When it fails only because a lock was not available in time
(SQLSTATE `55P03`), it tries the whole transaction again, up to four more times with a doubling backoff from 250 ms.
One attempt can wait on two locks in turn — the exclusive authority advisory lock
(`ontos.application-composition-authority`), then the authority row — each for just under 5 s, so all five attempts
take about 55 s at most; a rolled-back attempt leaves no ledger row, so a restore that succeeds is recorded once, and
one that never succeeds reports that the authority could not be returned. Every drain and re-drain therefore ends at
least 75 seconds before the retiring lease expires (and a drain does not start on a lease with less than that left):
an expired lease is never returned to `active`, so a restore that outlived it would leave the authority `draining`.

A drain also ends early on its own when it meets Outbox work it could never finish. Each poll of the Outbox wait that
finds work outstanding asks what of it can never finish before the drain's deadline: a delivery that died during the
drain, one deferred or backed off past the deadline, or one with no consumer at all stops the wait at once (`The
Application Composition drain was stopped: …`, naming the rows), and the restore above runs then rather than when the
budget expires. The poll asks less than the pre-flight, so a healthy drain is never stopped: it counts every
core-system key the retiring authority approved as consumed (a changed-descriptor row the retiring host claimed and
then retries is still in flight), and it never stops on age alone (a row that has waited long may still be claimed
before the deadline; if it is not, the deadline ends the drain as before). If that extra check cannot be read, the
poll keeps waiting and logs it once per kind of failure. The pre-flight, the fence and every poll measure the deadline
from the same moment, when the drain's budget clock started; stalled work is always aged by one whole standard drain
budget (300 s), never by what is left of a migration's budget.

What it cannot cover is a process that never runs its exit hook: a `SIGKILL`, an out-of-memory kill, a lost
container, or a database the publisher can no longer reach. Then the authority stays `draining` and an operator
returns it with the command below. A container that vanished without closing its connection can leave its database
session holding the publication lock for a while; see
[A publisher that is gone still holds the lock](#a-publisher-that-is-gone-still-holds-the-lock).

The rule, enforced by the database rather than by the caller: a revision returns from `draining` to `active` only
through a row in `core.application_composition_drain_abandonments`, and only while the authority row is exactly that
revision, `draining` and unexpired. Phases only move forward and a seal precedes every publisher-run schema
migration, so `draining` also proves that nothing was sealed and that migration never started; a `sealed` or
`migrated` revision is never returned. `draining` admits only workers — a strict subset of `active` — so the release
that held `active` retakes exactly the reads and writes it had before its drain began. A hand-written `UPDATE` of the
authority row from `draining` to `active` is refused. Owner migrations of the failed release stay applied: they ran
before the publication, are expand-only, and the old release is rehearsed against the migrated database.

The ledger is append-only and written only by the migration administrator. Each row records the revision, who
initiated it (`publisher` or `operator`), the operator name and reason, the session user, the transaction, the time
and the lease it found.

If the publisher could not return the authority (its message then names this command), or it died before it could,
use the operator command with the administrative identity (`DATABASE_ADMIN_URL` and `DATABASE_URL`):

```sh
mise exec -- pnpm composition:abandon-drain --revision <the revision the old release serves> \
  --operator <who> --reason <why>
```

- It proves no publisher is alive: on the session it holds for the whole run it takes the publication lock without
  waiting, and refuses at once (`A publisher is alive`) when another session holds it. A live publisher restores the
  authority itself when it fails. If you are sure the publisher is gone and it still refuses, see
  [A publisher that is gone still holds the lock](#a-publisher-that-is-gone-still-holds-the-lock).
- It refuses unless the authority row is exactly `--revision`, `draining` and unexpired, writes exactly one ledger
  row, and prints the abandonment's id, who recorded it, when, and the lease — never a payload.

### Plain-SQL fallback

Use this only when no publisher is alive and the command is unavailable (an image or checkout that predates it). It is
the same transition, through the same audited ledger insert: the database refuses a direct `UPDATE` of the authority
row, so there is no shorter route. Run the whole block in ONE `psql` session with the administrative identity
(`psql "$DATABASE_ADMIN_URL"`); the publication lock it takes is held by that session and released at the end.

Preconditions, all checked by the block before it writes, and all of which must hold:

- **No publisher is alive**: the session takes the environment-wide publication lock without waiting. `false` means a
  publisher holds it; it restores the authority itself when it fails, so stop and let it finish.
- **The running revision**: the authority row names the revision the OLD release serves — the one the last successful
  deploy published, still running in the old app container — never the revision of the image that just failed.
- **Phase `draining`**: an `active` row needs nothing; a `sealed` or `migrated` row is never returned (its seal precedes
  the schema migration), so stop and read the deploy log instead.
- **A valid lease**: `unexpired` must be `true`. If it is `false`, renew first (below), then run the block again.
- **The stuck delivery is known**: step 2 lists the Outbox work that kept the drain from finishing — usually one
  delivery no consumer can claim. Put its ids in the reason, and resolve it (see
  [Outbox work that cannot drain](#outbox-work-that-cannot-drain-and-cores-own-work-that-crosses-the-boundary)) before
  the next deploy, whose pre-flight would otherwise refuse on the same row.

```sql
\set ON_ERROR_STOP on
-- Never wait on a lock for long: a statement that cannot get one in 5 s fails and the block stops.
set lock_timeout = '5s';
-- 0. Prove no publisher is alive; this session holds the lock until step 4.
select pg_try_advisory_lock(hashtextextended('ontos.application-composition-publication', 0)) as no_publisher \gset
\if :no_publisher
-- 1. The authority: must be the old release's revision, 'draining', unexpired = true.
select revision, phase, durable_work_admission, valid_until, valid_until > clock_timestamp() as unexpired
  from core.application_composition_authority where authority_key = 'active';
-- 2. The work the drain was waiting for; name the stuck delivery in the reason below.
select d.outbox_delivery_id, m.tenant_id, d.outbox_message_id, d.worker_key, d.consumer_module_key, d.status,
       d.attempts_count, d.available_at, d.claim_expires_at
  from core.outbox_deliveries d join core.outbox_messages m on m.outbox_message_id = d.outbox_message_id
  where d.status not in ('done', 'released') order by d.available_at limit 20;
-- 3. The guarded transition: one ledger row only while every precondition still holds, otherwise none.
insert into core.application_composition_drain_abandonments
  (revision, initiated_by, operator_name, reason, lease_valid_until)
select a.revision, 'operator', '<who>', '<why, naming the stuck delivery id>', a.valid_until
  from core.application_composition_authority a
  where a.authority_key = 'active'
    and a.revision = '<the revision the old release serves>'
    and a.phase = 'draining'
    and a.valid_until > clock_timestamp()
returning drain_abandonment_id, revision, recorded_by, recorded_at, lease_valid_until;
-- 4. Confirm phase = 'active' and durable_work_admission = 'open', then release the lock.
select revision, phase, durable_work_admission from core.application_composition_authority where authority_key = 'active';
select pg_advisory_unlock(hashtextextended('ontos.application-composition-publication', 0));
\else
\echo 'A publisher is alive: stop and let it finish.'
\endif
```

Step 3 must return exactly one row. No row means a precondition no longer held when it ran: nothing was written, so
read the authority row again before doing anything else. The insert's triggers re-check the same rules under the
exclusive authority lock, stamp the session user, transaction, time and the real lease (the `lease_valid_until` given
is replaced), and return the revision to `active` with durable admission open in the same statement; any refusal
there aborts the block with nothing written.

Cancelling the block (Ctrl-C), or a statement stopped by its `lock_timeout`, is always safe: each statement is its own
transaction, the insert writes its ledger row and moves the authority together or not at all, and closing the session
releases the publication lock. Read the authority row and run the block again. If you ran it interactively (`\i` or
pasted into `psql`) and it stopped on an error, the session is still open and still holds the publication lock, so
every publisher and this command now see `A publisher is alive`: quit `psql` (`\q`), or release it in that session
with `select pg_advisory_unlock_all();`, before anything else.

If it refuses because the lease has expired, **renew first, then run the command again**:

1. Restart the OLD app container — the one serving the revision in the row — and nothing else. Its host boots, finds
   the row naming its own revision, and takes the renewal path: the lease becomes fresh again and the phase stays
   `draining` (renewal never changes the phase, so the release still refuses reads until step 2). A running old host
   renews by itself, so an expired lease means its host had stopped; the restart is what brings the renewal back.
2. Confirm the row is `draining` for that revision and now unexpired
   (`select revision, phase, valid_until > clock_timestamp() as unexpired from core.application_composition_authority`),
   then run the command again. Reads return.

Do not try to recover an expired lease by deploying again: a replacement publication refuses an expired authority, and
a fresh deploy waits on the same `draining` row. A refusal for another revision or phase means the situation is not
the one this command is for; read the row before doing anything else.

### A publisher that is gone still holds the lock

A container that vanished without closing its connection — a lost host, a network cut — can leave its PostgreSQL
session alive until TCP keepalive notices, holding the publication lock. Then both the command and the plain-SQL
block answer `A publisher is alive` while the release still refuses reads. Nothing ends that session automatically;
an operator does, and only under this precondition: **the container that holds the lock is verifiably gone.**

1. Find the session holding the publication lock, with the administrative identity:

   ```sql
   with k as (select hashtextextended('ontos.application-composition-publication', 0) as key)
   select a.pid, a.usename, a.application_name, a.client_addr, a.backend_start, a.state, a.state_change
     from k, pg_locks l join pg_stat_activity a on a.pid = l.pid
     where l.locktype = 'advisory' and l.granted and l.objsubid = 1
       and l.classid = ((k.key >> 32) & 4294967295)::oid
       and l.objid = (k.key & 4294967295)::oid;
   ```

2. Confirm its container is gone. `client_addr` alone is not proof — a connection pooler, NAT or the VPN can show the
   same address for a live container — so require all of these:
   - no running container of the project has that `client_addr` (check the service's containers in Zerops), and no
     deploy or publication is in progress;
   - the session is `idle` with an old `state_change` (minutes, not seconds), AND no other session from the same
     `client_addr` and `application_name` changed state recently. The holder alone proves little: a live publisher
     holds the lock on a reserved session that stays idle while it works on its other connections, and those
     change state every few seconds as it polls (`select pid, state, state_change from pg_stat_activity where
client_addr = '<addr>'`);
   - its `application_name` and `backend_start` match the vanished container: it connected when that container's
     publication started, and no running container started then.

   If any of these fails, treat it as a live publisher: stop, and let it finish and restore the authority itself.

3. End that one session: `select pg_terminate_backend(<pid>);`. Its open transaction, if any, rolls back, and the
   lock is released. Terminating a LIVE publisher by mistake is recoverable: it fails that deploy, its own restore
   or the next step here returns the authority, and the database-enforced abandonment rules keep the authority
   consistent whichever runs first.
4. Run `composition:abandon-drain` (or the plain-SQL block) again.

Without server keepalive settings (`tcp_keepalives_idle` and friends at their defaults), PostgreSQL may not notice a
vanished client for about two hours, so a stale session can hold the lock that long if no one ends it.
