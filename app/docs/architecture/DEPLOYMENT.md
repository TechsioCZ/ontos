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
- `storefront`: the AKROS Next.js standalone server, on port 3070. It calls the Shell at `http://app:3000`.
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
3. Publishes the snapshot with `publishApplicationCompositionAuthoritySnapshot`. The result is one active revision in the PostgreSQL table `core.application_composition_authority`.
4. Runs `scripts/demo/reconcile-stage-service-grants.mts --apply` for the SpiceDB schema and the stage service grants. A failure is logged and does not stop the release.
5. Serves the snapshot bytes at `/_host/composition`, a loopback-only path. Every hosted process reads it through `ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL`. The host serves a revision only while the database still names it.

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

- SMTP goes through the Cloudflare SMTP bridge at `smtp.mx.cloudflare.net:465`, with implicit TLS (`SMTP_SECURE=true`).
- User `api_token`. The password is a Cloudflare API token with Email Sending, stored as the `app` service secret `SMTP_PASSWORD`.
- Sender: `noreply@ontos-stage.web-revolution.cz`.

### Build

- GitHub Actions builds the units, in seven parallel shards (`zerops-stage.yml`, job **Build units**). Each shard runs `scripts/zerops/build-app.sh` for its units, two at a time.
- Each unit's build script still ends with `modern deploy`, but only to write `.output/index.js`. `scripts/zerops/owner-entry.mts` turns that file into `dist/zerops-entry.mjs`, which exports `start(port)`.
- A unit whose committed inputs are unchanged keeps its previous `dist/`. The digest is in `dist/.zerops-build-digest`. Each shard keeps its builds in the Actions cache, outside the checkout: any untracked file in the tree turns every release identity into `workspace`.
- The deploy job packs every shard's `dist/` (no source maps, type bundles or precompressed copies) into `app/.zerops-prebuilt.tar.zst` and pushes it with the checkout.
- The Zerops `app` build (`zerops.yaml`) unpacks that archive, installs the workspace, keeps every unit whose digest matches, builds the Outbox Worker host bundle under the hosted owners' revisions, and ships `app/`. It can still build any unit itself, two at a time, in its 5 vCPU / 8 GB build container.
- `.deployignore` keeps `.output`, source maps, caches and tests out of the deployed package.

### Deploy

`.github/workflows/zerops-stage.yml` runs on each push to `demo/sales-crm`, except pushes that touch only `docs/**` or Markdown files. It also runs on manual dispatch. Runs are serialized in the `zerops-stage` concurrency group.

1. **Build units**: seven shards, as above.
2. **Deploy** (environment `stage-edge`): syncs the owner secret bundle to the `app` service, then pushes the `app` and `storefront` setups in parallel with `scripts/zerops/push-service.sh`, using the commit SHA as the version name. That script uploads over HTTP/1.1 with curl, because Zerops silently drops an upload that runs longer than about 30 seconds. On failure the job prints the app log.
3. **Verify**: runs the timing probe (`/cs`, OAuth metadata and the storefront home) and the MCP OAuth proof, both blocking. The newsletter grant and withdrawal proof only warns.

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

Commerce Order, Customer Context, Commerce Cart and Pricing call each other and the Shell gateway with Shell-issued API keys, and admit each other's API-key Principals by ID or by grant list. `scripts/ops/owner-runtime-configuration.mts` names every value each owner reads, and the app host derives each owner's API bases and caller namespace from it. Before the first deploy that carries them, a human operator, never an agent, issues the keys in Shell and records the per-environment values:

| Owner                       | Credentials (sensitive)                                                                                                       | Per-environment values (not secret)                                                                                                                                                                                                                                                                        |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `commerce-order`            | `ONTOS_ORDER_FINALIZATION_GATEWAY_API_KEY`, `ONTOS_ORDER_APPROVAL_GATEWAY_API_KEY`                                            | `ONTOS_ORDER_FINALIZATION_WORKER_PRINCIPAL_ID` (the finalization key's Principal), `ONTOS_ORDER_CCC_VERIFIER_PRINCIPAL_ID` (Customer Context's `ONTOS_CCC_ORDER_GATEWAY_API_KEY` Principal), `ONTOS_ORDER_PRICING_VERIFIER_PRINCIPAL_ID` (Pricing's key Principal)                                         |
| `commerce-customer-context` | `ONTOS_COMMERCE_CUSTOMER_CONTEXT_GATEWAY_API_KEY`, `ONTOS_CCC_ORDER_GATEWAY_API_KEY`, `ONTOS_CCC_PREPROPOSAL_GATEWAY_API_KEY` | `ONTOS_CCC_ORDER_CONSUMER_{PRINCIPAL,LEGAL_ENTITY,TENANT}_ID` (Order's approval key), `ONTOS_CCC_PREPROPOSAL_PRICING_ISSUER_PRINCIPAL_ID`, and the JSON grant lists `ONTOS_CCC_ORDER_FINALIZATION_SERVICE_GRANTS`, `ONTOS_CCC_PRICING_FINALIZATION_SERVICE_GRANTS`, `ONTOS_CCC_PREPROPOSAL_SERVICE_GRANTS` |
| `commerce-cart`             | `ONTOS_CART_FINALIZATION_SERVICE_API_KEY`                                                                                     | the JSON grant lists `ONTOS_CART_FINAL_CANDIDATE_SERVICE_GRANTS`, `ONTOS_CART_PREAPPROVAL_SERVICE_GRANTS`                                                                                                                                                                                                  |
| `pricing`                   | `ONTOS_PRICING_GATEWAY_API_KEY`, `ONTOS_PRICING_CONFIRMATION_SIGNING_SECRET`                                                  | `ONTOS_PRICING_ORDER_PRINCIPAL_ID`, `ONTOS_PRICING_PREPROPOSAL_PRINCIPAL_ID`, `ONTOS_PRICING_CONFIRMATION_KEY_{REF,VERSION,LINEAGE_REF}`                                                                                                                                                                   |

Add the credentials and the per-environment values to the owner's entry, keyed by its `appId`, in the GitHub secret `DEMO_IMMUTABLE_RELEASE_SECRETS` of the `stage-edge` environment. Each deploy writes that JSON to the `app` service as `ONTOS_OWNER_SECRETS_JSON` (see [Secrets](#secrets)), and the app host hands each process only the entries of the owners it serves; the Outbox Worker host receives every owner's entries, because it runs their workers. Caller namespaces (`*_NAMESPACE_ID`) are the Shell's staff namespace `ontos.staff.better-auth.v1`, the code constant every Shell-issued API key is bound in, and every owner base is the owner's loopback API origin `<origin>/<unit>-api`; both are derived, never stored. Create the values before the deploy that first references them. At runtime each owner reads its values lazily, so an unusable one fails only the work that needs it, never the other owners in the shared process.

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
3. run `mise exec -- pnpm authorization:provision-current-actions` in the stage-gated artifact. It publishes the compatible schema and membership-set executor grants for every `tenant_membership_default` Action across the fixed stage Tenants. For every `explicit` Action it writes direct executor grants for the accounts whose `grants.explicitActions` in the operator stage accounts file name it ([ADR-0028](../../../docs/adr/0028-stage-accounts-from-operator-data.md)); set `ONTOS_STAGE_ACCOUNTS_FILE` for the run;
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

The operator supplies every stage Tenant, account, and grant in a JSON file outside the repository and names it with `ONTOS_STAGE_ACCOUNTS_FILE`. `mise exec -- pnpm --filter shell-super-app stage:bootstrap-accounts` fails when the variable is unset, the file cannot be read, the file is readable by group or others, or it does not match this shape. Errors never echo file values, and output names accounts but never passwords.

```json
{
  "schemaVersion": 2,
  "tenants": [
    {
      "tenantId": "<uuid>",
      "slug": "<lowercase-slug>",
      "displayName": "<name>",
      "defaultLocale": "<locale>",
      "moduleKey": "<module the Tenant activates, e.g. party.registry>",
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
            "tenantRelations": ["<tenant relation from the SpiceDB schema>"],
            "explicitActions": ["<explicit Action key>"]
          }
        }
      ]
    }
  ],
  "retiredTenants": [
    { "tenantId": "<uuid>", "legalEntityId": "<uuid>", "moduleKey": "<module>", "principalIds": ["<uuid>"] }
  ],
  "retiredAccountEmails": ["<email>"]
}
```

- Every Tenant, slug, legal entity, module state, Principal, binding, and email must be unique; unknown keys are rejected.
- `tenantRelations` may name any Principal relation on `tenant` in the SpiceDB schema except `member`, which every account gets. `explicitActions` is a list of `explicit` Action keys or `"all"`. `authorization:provision-current-actions` reads the same file, so grants and their assertions cannot drift apart.
- `retiredTenants` (may be empty) lists former stage Tenants. The bootstrap revokes their bindings, archives their rows, and deletes every SpiceDB relationship it can have written for them.
- `retiredAccountEmails` (may be empty) lists former stage accounts. The bootstrap bans each one, ends its sessions and removes its password credential. Retired data must not overlap an active Tenant, Principal, or email.
- Keep the file mode `600`. Rerunning with a changed password resets that account's password and ends its sessions. Both tools only add relationships; removing a grant from the file does not revoke it.

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

Every runtime reaches SpiceDB over TLS gRPC and pins `SPICEDB_CA_CERT`, which `zerops.yaml` takes from the `spicedb` service's `SPICEDB_GRPC_TLS_CERT` secret; there is no plaintext mode. `scripts/run-zerops-spicedb.sh` starts SpiceDB only when its four TLS secrets exist on the `spicedb` service: the gRPC pair (`SPICEDB_GRPC_TLS_CERT`, `SPICEDB_GRPC_TLS_KEY`), a self-signed certificate for `spicedb`, `localhost` and `127.0.0.1`, and the HTTP gateway pair (`SPICEDB_HTTP_TLS_CERT`, `SPICEDB_HTTP_TLS_KEY`). `ensureSpicedbTls` in `scripts/ops/spicedb-tls.mts` creates a missing pair as sensitive service secrets through the Zerops REST API; the gateway certificate comes from the Cloudflare Origin CA, the one Cloudflare API call the repository still makes (`scripts/ops/cloudflare-api.mts`). A pair that exists and holds is kept; a partial or invalid pair fails with guidance instead of being rotated silently.

### Adding a vertical

The app host serves the Shell plus every module of `topology/application-release-intent.json`, and `zerops-stage.yml` builds exactly those units, so adding the vertical's module to the release intent is what puts it on stage. In the same pull request:

1. Add the vertical's module to `topology/application-release-intent.json`.
2. Add its unit to one shard of the `node-artifact-build` job in `ultramodern-workspace-gates.yml`; `Repository Tooling Tests` fails until it does.
3. Add its owner secrets, if it has any, to its `appId` entry in `DEMO_IMMUTABLE_RELEASE_SECRETS` before the deploy (see [Order-flow owner credentials](#order-flow-owner-credentials)).

A vertical needs no new GitHub variables, no Zerops service and no Cloudflare configuration.

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

Stage deploys from `demo/sales-crm` (`zerops-stage.yml`), never from `main`.

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

## Operator-only legacy completion gate

Before first authority publication, the first active-to-draining fence, a recovered migration, and a replacement pointer publication, the administrative publisher rechecks the configured retired-provider inventory and requires the published owner legacy-completion verifier. Missing verifier, incomplete observation, unknown owner database, unresolved legacy work, or failed evidence retention refuses publication. Closing new durable admission does not itself establish legacy absence.

The operator sets `ONTOS_LEGACY_COMPLETION_EVIDENCE_DIRECTORY` to an absolute private directory. Deployment and refresh jobs create that mode-0700 directory under `runner.temp` and upload its sanitized evidence with `always()` retention for 30 days, including failed attempts. The publisher retains each sanitized native identity/result observation as an exclusive mode-0600 JSON artifact there. A retained observation cannot authorize a later attempt: its live callback, exact database/system/runtime identity, native transaction and revision must match the current transition. Provider credentials and database URLs remain the existing distinct operator/runtime configuration; evidence contains no handoff payload or credentials.

Privacy observes all tenants through its deployment-only administrative verifier, with native full-visibility and READ COMMITTED checks. It holds its own dispatch/outcome table locks while Core verifies its immutable message evidence and commits the fence in a separate transaction. No raw executor crosses the published interface. Unmarked legacy obligations remain unresolved; the gateway never invents an original release, adopts work, marks delivery done, or treats a fresh environment as evidence about another environment. Current marked completion requires the exact owner handoff and immutable successful outcome.

An existing base-schema authority first receives the additive opt-in Core completion and dead-delivery resolution migrations through the normal Drizzle journal. Only that compatible expansion runs before drain verification; the full owner migrator remains deferred until the old authority is verified and sealed. Repeated migration skips the already journaled expansion.

Core acquires its exclusive authority fence before requesting owner leases, matching the authority-before-owner order of public Actions. The owner lock remains held through the actual Core commit. A later owner connection/finalizer failure does not undo an already committed Core transition: retain the exact failure and independently inspect native authority before recovery, as for provider settlement failures.

## Dead Outbox deliveries during a composition drain

A dead delivery never finishes by itself. While publication drains the old release, a dead delivery that carries completion debt blocks the durable-work phase, and any dead delivery blocks the final Outbox phase. The publisher keeps waiting so an operator can act. It logs a warning that names each blocking delivery as the exact command arguments, for example `--tenant-id <uuid> --message-id <uuid> --worker-key commerce.order.finalize-order-work (attempts 60)`. If the drain does not finish within its freshness lease (at most 20 minutes), the publisher fails, and the timeout error names the same deliveries. Durable admission stays closed, and the old release keeps running.

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
