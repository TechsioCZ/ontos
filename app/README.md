# app

> [!IMPORTANT]
> Read the [development workflow](./DEVELOPMENT.md) before starting feature work. It explains how
> to create, run, and remove isolated Locki development sandboxes.

Generated UltraModern SuperApp workspace.

## Coding guide

Read this file before application work. Then read only the implementation document relevant to the
task:

| Concern                                               | Current authority                                                                                                   |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| MicroVertical seams and BFF communication             | [MicroVertical Architecture](docs/architecture/MICROVERTICALS.md)                                                   |
| State-changing operations                             | [Action Execution](docs/architecture/ACTIONS.md)                                                                    |
| Typed failures and HTTP responses                     | [Effect Error and HTTP Contracts](docs/architecture/ERRORS.md)                                                      |
| PostgreSQL ownership and access                       | [Database Architecture](docs/architecture/DATABASE.md) and [Governed Data Access](docs/architecture/DATA_ACCESS.md) |
| Asynchronous consumers                                | [Outbox Worker Architecture](docs/architecture/OUTBOX_WORKERS.md)                                                   |
| Pages, APIs, components, search, reports, and workers | [Module Entrypoints](docs/architecture/MODULE_ENTRYPOINTS.md)                                                       |
| Deployment and business module identity               | [Module Manifests](docs/architecture/MODULE_MANIFESTS.md)                                                           |
| Commerce surfaces                                     | [Commerce Application Boundaries](docs/architecture/COMMERCE_APPLICATIONS.md)                                       |
| Entities versus value objects                         | [Value Objects](docs/architecture/VALUE_OBJECTS.md)                                                                 |
| Deployment and release work                           | [Deployment Playbook](docs/architecture/DEPLOYMENT.md)                                                              |
| Frontend work, including Figma                        | [Frontend Architecture](docs/frontend/FRONTEND.md)                                                                  |
| ARES integration                                      | [ARES reference](docs/integrations/ares.md)                                                                         |

Read a specification only when the task or GitHub issue explicitly names it. A specification with
`status: done`, `status: complete`, or `status: superseded` is implementation evidence, not
current guidance: stop unless the task explicitly asks for historical provenance. Do not browse
`specs/` for general background.

### Coding rules

- Use Effect for application behavior, I/O, resource management, concurrency, dependencies, BFF
  contracts and clients, schemas, and expected failures. Keep pure synchronous transformations and
  reusable presentation components as plain TypeScript or React when Effect adds no behavior.
- Model expected failures as tagged Effect errors. Do not throw, reject a Promise, return an
  untyped error object, or collapse an expected failure into a string.
- Prefer direct values and references over stringly typed metadata.
- Reuse an existing concept or file before adding one. Add an abstraction only for a concrete use
  case.
- Preserve owner-local data and executable registration. Never import another deployment's private
  manifest, registration, table, handler, repository, route, migration, fixture, or test.
- Create supported business artifacts through Codesmith first. Generated output is the required
  starting point and may then be adapted. If a business artifact has no approved generator or
  governed gateway, stop and extend or approve Codesmith before adding it.
- Infrastructure and architecture files may be created directly when no generator applies.
- Keep third-party HTTP adapters private to their owning MicroVertical. Define provider-specific
  schemas, typed errors, request construction, resilience, diagnostics, and business mapping; use
  the generated Effect `HttpClient` service as the deterministic test seam.

### Mandatory generators

Run generators from this directory through the repository-managed toolchain:

```bash
mise exec -- pnpm scaffold:module-contract -- --vertical <vertical> --module <dotted.module-id>
mise exec -- pnpm scaffold:action -- --vertical <vertical> --action <action> --legal-entity-scope <required|optional|forbidden> --authorization action_execution --provisioning <tenant_membership_default|explicit>
mise exec -- pnpm scaffold:action -- --scope core --module <core.module> --action <action> --legal-entity-scope <required|optional|forbidden> --authorization action_execution --provisioning <tenant_membership_default|explicit>
mise exec -- pnpm scaffold:action-service -- --vertical <vertical> --service <service>
mise exec -- pnpm scaffold:microvertical-page -- --vertical <vertical> --page <page> --authorization <public|authenticated_principal|context_permission> [--permission <permission>]
mise exec -- pnpm scaffold:outbox-message -- --vertical <vertical> --action <action> --topic <topic>
mise exec -- pnpm scaffold:outbox-worker -- --vertical <vertical> --worker <worker> --producer <producer> --topic <topic> --authorization owner_local_background
mise exec -- pnpm scaffold:policy -- --scope <global|microvertical> --policy <policy>
mise exec -- pnpm scaffold:external-http-adapter -- --vertical <vertical> --provider <provider> --operation <operation>
```

Use each command's `--help` for supported flags. Additional Shell-visible generators are described
beside the relevant architecture sections below. A MicroVertical-scoped Policy also requires
`--vertical <vertical>`. The generator requirement applies to delegated work as well as the
primary coding agent.

All public writes and reads run through Core-owned governed operation lifecycles. Tenant/system
entrypoint scope and required/optional/forbidden legal-entity scope are independent declarations;
invalid or indeterminate trusted context fails closed before private code resolves. Business
handlers receive owner-local transaction-scoped services, never a database executor. See
[Governed Data Access](docs/architecture/DATA_ACCESS.md).

This workspace keeps `presetUltramodern(...)` as the single public
UltraModern.js 3.0 SuperApp surface and starts with an explicit shell:

- `apps/shell-super-app` owns shell route assembly, Module Federation host
  wiring, shared SSR/i18n runtime setup, and the boundary debugger.
- `packages/shared-*` provide placeholders for cross-workspace contracts and
  design tokens.
- `verticals/*` is intentionally empty until a real business domain is added.

Add a full-stack MicroVertical when the product needs one:

```bash
pnpm dlx @bleedingdev/modern-js-create transportation --vertical
pnpm dlx @bleedingdev/modern-js-create payments --vertical
```

Each added vertical owns its UI/routes, browser-safe Module Federation exposes,
private-first route metadata, localized URLs, public-route opt-ins, CSS prefix,
Effect BFF handlers, local API contract, and typed client surface. Server
handlers and Effect client/contract modules stay out of browser exposes.

Every module-owned Action, page, API, public component, search provider, report, and Worker is a
structured entrypoint governed by Core before private code loads or runs. See
`docs/architecture/MODULE_ENTRYPOINTS.md`. The `module-entrypoints:check` repository command rejects
missing descriptors, owner/access mismatches, private cross-vertical imports, and raw remote loads.

Each OntOS business vertical also owns one deployment-safe module contract. After creating the
UltraModern vertical, run `pnpm scaffold:module-contract -- --vertical <vertical> --module
<dotted.module-id>` before generating Actions, Policies, pages, or Outbox artifacts. The topology
`appId` remains the deployment, Module Federation, and gateway-audience identity; the dotted
`moduleId` owns business contracts and tenant state. See
[`docs/architecture/MODULE_MANIFESTS.md`](./docs/architecture/MODULE_MANIFESTS.md).

The owning build emits `/.well-known/ontos-module-manifest.json`. Shell discovers only explicit
environment-overlay allowlist entries and never imports a remote vertical's manifest or private
registration. Deployment installation and per-tenant activation remain separate operations.

Codesmith governs every Shell-visible artifact and patches safe descriptors plus owner-private
runtime registration atomically:

```bash
mise exec -- pnpm scaffold:microvertical-page -- --vertical <vertical> --page <page> --authorization <public|authenticated_principal|context_permission> [--permission <permission>] [--url <url>]
mise exec -- pnpm scaffold:public-component -- --vertical <vertical> --name <component> --authorization <public|authenticated_principal|context_permission> [--permission <permission>]
mise exec -- pnpm scaffold:module-api -- --vertical <vertical> --name <api> --authorization <public|authenticated_principal|context_permission> [--permission <permission>]
mise exec -- pnpm scaffold:search-provider -- --vertical <vertical> --name <provider> --resource <resource> --authorization <authenticated_principal|context_permission> [--permission <permission>]
mise exec -- pnpm scaffold:report -- --vertical <vertical> --name <report> --resource <resource> --authorization <authenticated_principal|context_permission> [--permission <permission>]
mise exec -- pnpm check:module-contracts
mise exec -- pnpm module-entrypoints:check
```

`scaffold:microvertical-page` keeps the lower-kebab `--page` value as the stable component,
entrypoint, locale, and Module Federation identity. Its optional `--url` is a complete
root-relative canonical-path override. Without it, Codesmith uses
`/<microvertical>/<page>`: `--vertical contacts --page customers` produces canonical
`/contacts/customers`, which the localized Shell router exposes as `/cs/contacts/customers` and
`/en/contacts/customers`. Do not include a locale in `--url`; the router owns that prefix. The generated
private, non-indexable starter contains only a localized title, and the authenticated Shell/Core
gateway must resolve its exact page entrypoint before the private remote loads.

An explicit `--url` may contain unique named parameters using `:parameter` segments whose names
start with a lowercase letter and continue with letters or digits. Codesmith maps those segments to
TanStack filesystem directories such as `[parameter]`, while the manifest and route metadata retain
the canonical `:parameter` spelling:

```bash
mise exec -- pnpm scaffold:microvertical-page -- --vertical contacts --page customer-edit --url /contacts/customers/:id/edit
```

Dynamic page templates are exact, private page contributions, but are omitted from ordinary module
navigation because a template is not a usable href. After the authenticated Shell/Core gateway has
resolved and approved the exact page and loaded its allowlisted remote, the remote receives only the
declared route parameters as a bounded plain string record. Route parameters remain untrusted
business input and never alter tenant, principal, legal-entity, permission, module-state, or target
identity context.

## Private-First Public Surfaces

Generated app routes are private and non-indexable by default. Author route
metadata in colocated `src/routes/**/route.meta.ts` files; the scaffold
regenerates `src/routes/ultramodern-route-metadata.ts` as a compatibility
manifest for config, i18n, public head, and public surface contracts. Private
app, auth, tenant, dashboard, and internal routes publish no discovery output
unless route metadata explicitly marks them `public && indexable`. The default
scaffold therefore emits only a disallowing `robots.txt`; sitemap, web
manifest, `llms.txt`, API catalog, security.txt, and JSON-LD output stay
omitted until a safe public route or public docs/help/product surface exists.
Structured data is never inferred automatically. Add `jsonLd` explicitly in
route metadata for `public && indexable` routes and use
`src/routes/ultramodern-jsonld.ts` when the route fits the generated `WebPage`,
`WebApplication`, `SoftwareApplication`, `BreadcrumbList`, `FAQPage`, or
`Organization` helpers. Private or non-indexable routes emit no JSON-LD even
when they have localized paths, titles, descriptions, BFF APIs, or Module
Federation boundaries.

Public web artifacts are build/deploy outputs generated into `dist/public` and
`.output/public`, not hand-authored source files under `config/public`. Dynamic
public routes can expand sitemap entries through route-owned, Node-safe
`route.sitemap.mjs` providers beside route metadata. The public-surface
generator discovers those providers for dynamic public routes and still honors
explicit `routes.publicSurface.contentSources` entries in the generated
compatibility manifest.

Run the scaffold validator before adding business code and after every
`--vertical` mutation:

```bash
mise install
pnpm install
pnpm check
pnpm build
```

Local PostgreSQL uses the Compose-created `ontos_admin` identity for migrations and the
non-superuser `ontos_runtime` identity for application pools. Fresh volumes provision the runtime
login automatically, and `pnpm db:migrate` refreshes its schema/table/sequence grants after the
Core, Auth, and Contacts migration owners finish. Contacts owns its `contacts` schema and independent
`drizzle.__drizzle_migrations_contacts` history, preserving the rule that every MicroVertical owns a
separate schema and migration history. For an existing persistent volume, set both database URLs and run
`mise exec -- pnpm db:bootstrap-runtime-role` before migrations.

The generated toolchain baseline is Node `>=26` with pnpm `11.10.0`.
`packageManager`, `.mise.toml`, generated validation, and CI should all agree
on that baseline; do not reintroduce Corepack or older pnpm aliases.

Generated CI does not call the local aggregate. It runs format, lint,
typecheck, skills, i18n boundary validation, contract validation, and build as
separate matrix jobs so failures are isolated and parallelizable.

Type checking is TS7-first. `pnpm typecheck` runs
`scripts/ultramodern-typecheck.mts` in TS-Go build mode over
`tsconfig.json` project references, with `--checkers` and `--builders`
enabled by default. The stable `typescript` package is pinned to TS7 so
Modern/Rspack type checking uses TS-Go by default.

Read-only agent reference repositories under `repos/` (Effect and
UltraModern.js source lookup using squashed git subtrees) are an explicit
opt-in step: run `pnpm agents:refs:install` when you want them. `pnpm install`
never clones repositories.

Codex skill bodies are lockfile-pinned in `.codex/skills-lock.json` and
repo-owned under `.codex/skills`. `pnpm install` runs the bootstrap by default:
vendored pinned skills are copied locally, clone-backed public skills are
fetched when network access is available, and offline clone failures remain
advisory. Existing unrelated `.codex/skills/*` directories are preserved. Set
`ULTRAMODERN_SKIP_CODEX_SKILLS=1` or `ULTRAMODERN_CODEX_SKILLS=0` to opt out.
`pnpm skills:check` is advisory when local skill bodies are missing so offline
CI can still run the normal gate.

The topology and ownership metadata are generated under `topology/`. GitHub only discovers Actions
from the repository-root `.github/workflows/`, so this workspace's gate and stage-deploy workflow is
maintained at `../.github/workflows/ultramodern-workspace-gates.yml`; this is the explicit exception
to the otherwise `app/`-only ownership boundary. The workspace also ships `.github/renovate.json`
with read-only workflow permissions, commit-pinned actions, frozen installs, StepSecurity audit-mode
runner hardening, dependency dashboard review, one-day release age, grouped updates, and manual
approval for major upgrades.

Package source provenance is recorded in `.modernjs/ultramodern.json`. The
default strategy keeps UltraModern.js runtime and tooling packages on
`workspace:*` for monorepo development. To create a workspace that can install
those packages outside the monorepo, generate with
`--ultramodern-package-source install`; generated shared packages still use
`workspace:*` because they are part of this workspace.

## Public URL Environment Variables

This workspace's apps must not bake absolute `http://localhost:<port>` URLs
into asset configuration. Public URL and asset prefix environment variables
have distinct roles, and stale aliases should not be carried forward when
regenerating or updating the workspace.

| Variable                          | Role                                             | Feeds                                                                |
| --------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------- |
| `MODERN_PUBLIC_SITE_URL`          | Canonical site origin for public SEO output only | Canonical, hreflang, sitemap `<loc>`, robots `Sitemap:`              |
| `MODERN_ASSET_PREFIX`             | Preferred JS/CSS/static asset prefix             | Modern/Rspack-emitted asset URLs                                     |
| `ULTRAMODERN_ASSET_PREFIX`        | UltraModern compatibility asset prefix           | Modern/Rspack-emitted asset URLs when `MODERN_ASSET_PREFIX` is unset |
| `ULTRAMODERN_PUBLIC_URL_<APP_ID>` | Per-app deployment/proof URL                     | Cloudflare proof inputs and Module Federation remote URLs            |

Shell asset URLs use this precedence: `MODERN_ASSET_PREFIX` →
`ULTRAMODERN_ASSET_PREFIX` → origin-relative `/`. Module Federation remotes use
the same env precedence, then fall back to their per-app public origin:
configured public URL, inferred workers.dev URL, or local dev port.
`MODERN_PUBLIC_SITE_URL` is canonical/SEO-only and must not be used as an
asset-prefix fallback.
SEO output uses `MODERN_PUBLIC_SITE_URL`; if it is unset, generated local and
preview outputs remain non-public until deployment proof provides explicit
public URLs.

Without public URLs configured, shell asset paths are origin-relative (`/`).
Remote dev manifests publish their own local origin so host shells load
`remoteEntry.js` and exposed chunks from the remote dev server. Shell-only
workspaces can set `MODERN_PUBLIC_SITE_URL` for SEO output without changing
where assets load from.

## Cloudflare Proof

Deploy the generated apps, then pass each deployed app's generated public URL
env key into the proof step. The proof script reads the generated contract and
checks the live Worker surface, including public-route sitemap/robots
consistency, preview noindex behavior, unknown-route status, asset headers,
byte budgets, and public sourcemap exposure. A shell-only workspace only needs
the shell URL; added verticals use the same `ULTRAMODERN_PUBLIC_URL_<APP_ID>`
pattern with hyphens converted to underscores and uppercased.

```bash
pnpm cloudflare:deploy
ULTRAMODERN_PUBLIC_URL_SHELL_SUPER_APP=https://shell-super-app.example.workers.dev \
pnpm cloudflare:proof --require-public-urls
```

## Strict Effect API

Generated HTTP APIs use the direct strict Effect topology only:

- API contracts live at `shared/api.ts`.
- Runtime entries live at `api/index.ts`.
- Browser clients live under `src/api/*-client.ts`.
- `modern.config.ts` uses `bff.runtimeFramework: 'effect'`,
  `bff.effect.entry: './api/index'`, and
  `bff.effect.strictEffectApproach: true`.

Do not add `api/effect`, `api/lambda`, `shared/effect`, `src/effect`, Hono
server imports, raw request handlers, manual `request.json()` parsing, or
manual `new Response(...)` construction inside generated API modules.
`pnpm api:check` and Oxlint enforce this. Model requests, responses, and typed
errors with concrete Effect `Schema` values; generic JSON shortcuts such as
`Schema.UnknownFromJsonString`, `Schema.Unknown`, and `Schema.Any` are rejected
in API modules.

The Shell authentication API is the deliberate Shell-owned instance of this topology.
Authentication and session mechanics remain a Shell/Core capability and must not be
represented by an Auth MicroVertical.

The Shell is also the only raw-credential boundary for API keys. Better Auth owns key creation,
hashes, counters, expiry, enabled state, and mechanical support sessions in the private `auth`
schema. Core stores only stable provider-subject bindings and enforces one Better Auth key ID per
OntOS tenant/principal binding. External callers exchange `X-API-Key` for the existing five-minute,
single-audience assertion; MicroVerticals receive the assertion, never the raw key. Human remains
the V0 kind for internal, external, and guest users; SpiceDB roles and future Party relationships
express access differences.

Tenant administrators provision `service`, `integration`, and `system` principals through the
generated `core.identity.*` Actions. API-key issuance binds the provider key before returning its
secret; binding failure disables it. Disable/revoke closes Core first, re-enable activates Core
last, and administration lists report `cleanupPending` whenever Core usability and provider enabled
state disagree so cleanup can be retried without repeating a committed Core transition. Rotation
either closes the old binding, revokes the replacement before failing, or returns the replacement
secret with cleanup debt so an active one-time credential is never stranded. Issuance retries first
reconcile Auth's private binding-pending marker so a failed bind cannot leave an undiscoverable
active provider key. Markers are leased for five minutes and scoped by trusted tenant and issuer,
so a concurrent retry cannot disable a key that is still being bound. Cleanup lookup is indexed and
bounded; another batch defers issuance to a retry. Rotation re-reads Core state after uncertain
provider cleanup and never withholds the only definitely active replacement. Trusted background jobs use
a constructor-produced workload registration plus configured tenant/principal
UUIDs and a bounded non-secret run reference—never HTTP input or a fake Better Auth account.

Support IDs are configured mechanically through `BETTER_AUTH_SUPPORT_USER_IDS` as a comma-separated
list outside source control. Start and stop still require tenant-local SpiceDB permission and active
Core user bindings. Impersonation records target/original OntOS principal IDs and safe session
references; it never exposes provider user IDs, reasons, cookies, or session tokens to clients.
Before the started checkpoint completes, Auth durably records a non-secret recovery row and retains
it through provider stop or session expiry. The restored cookie is forwarded on every post-stop
outcome, and repeated stop completes the
idempotent stopped checkpoint and removes recovery state. That recovery checkpoint retains the
restricted Action's normal SpiceDB permission check; session termination succeeds independently and
evidence remains pending when authorization or storage is unavailable.

Every Action requires explicit SpiceDB executor provisioning; missing configuration is a definite
denial. The default environment rule is
`action:<object-id>#executor@tenant:<fixed-tenant-uuid>#member`, provisioned for the complete current
catalog with the parameterless, idempotent operator command
`mise exec -- pnpm authorization:provision-current-actions`. This grants authenticated active
members of that one trusted Tenant, not anonymous users or Principals from another Tenant. Direct
Principal relations remain valid for narrower authorization and use the exact object ID returned by
Core's `toSpiceDbActionObjectId(actionKey)`:
`action:<object-id>#executor@principal:<principal-uuid>`. Eligible interactive users receive the
`bind-self-api-key` and `set-self-api-key-binding-status` executors; tenant identity administrators
receive the create/change and managed-key executors in addition to the separate tenant
`identity_admin`/`manage_identity` relationship; support administrators receive
`record-support-impersonation` in addition to tenant `support`/`impersonate`. A configured system
Principal receives only the executor relations required by its registered jobs. Remove executor
relations when the corresponding role or workload authorization is removed. The placeholder
`allowed-principal` bootstrap tuples are test fixtures and are never production provisioning.

When an existing MicroVertical BFF begins accepting Shell-user Action calls, prepare its standard
identity boundary exactly once:

```bash
mise exec -- pnpm scaffold:microvertical-action-boundary -- --vertical <vertical>
```

The command generates a public-JWKS server verifier and a client adapter that obtains a fresh,
audience-scoped Shell assertion for each invocation attempt. It does not generate an Action,
permission, Policy, endpoint, Outbox Message, UI, or vertical. Continue to use
`scaffold:action` independently; no Action may add a per-Action Shell identity endpoint or store an
assertion in a route loader.

Generated pnpm overrides pin the framework-compatible Effect cohort. Keep
`effect` and `@effect/vitest` aligned with `pnpm-workspace.yaml`; do not add
new direct package-level Effect versions unless the whole UltraModern cohort is
upgraded. The generated pnpm policy intentionally excludes the matching
`effect` and `@effect/opentelemetry` cohort versions from the
minimum-release-age and no-downgrade checks while Effect's beta publishes move
from trusted-publisher metadata to provenance attestations.

For older generated workspaces, run the framework migration command first:

```bash
pnpm dlx @bleedingdev/modern-js-create@3.8.2-ultramodern.12 ultramodern \
  migrate-strict-effect --version 3.8.2-ultramodern.12
pnpm api:check
pnpm contract:check
```

The command updates generated package-source metadata, Modern package aliases,
framework-owned toolchain pins, direct API topology metadata, strict Effect pnpm
overrides/trust policy, and the lockfile. Remaining failures are source
migration work; fix the owning API files instead of adding compatibility shims.

## Troubleshooting

| Symptom                        | Current check                                                                                                                                                     | Owner                                       |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Package cohort mismatch        | Regenerate with one package source strategy, run `mise install`, then rerun `pnpm install` from the activated shell.                                              | Generated workspace package source metadata |
| Effect runtime cohort mismatch | Keep `effect` and `@effect/vitest` on the generated pnpm override versions, then rerun `pnpm install`.                                                            | Generated workspace dependency policy       |
| Old nested API path            | Run `pnpm api:check`, move code to `api/index.ts`, `shared/api.ts`, and `src/api/*`, then delete `api/effect`, `api/lambda`, `shared/effect`, and `src/effect`.   | API owner                                   |
| Install failure                | Check the active Node/pnpm from `mise install`; rerun `pnpm install` after the shell sees the pinned versions.                                                    | Toolchain setup                             |
| Build failure                  | Run the matching primitive gate (`pnpm lint`, `pnpm typecheck`, `pnpm i18n:boundaries`, `pnpm contract:check`) before `pnpm build`; fix the owning failure first. | Owning package or generated contract        |
| Missing public URL             | Set the app public URL env key recorded in `.modernjs/ultramodern.json`, for example `ULTRAMODERN_PUBLIC_URL_SHELL_SUPER_APP`.                                    | Deployment operator                         |
| Cloudflare credentials         | Confirm Wrangler credentials before `pnpm cloudflare:deploy`; local checks do not prove live Worker access.                                                       | Deployment operator                         |
| Asset or CSS 404               | Rebuild with `pnpm build` or `pnpm cloudflare:deploy` and inspect emitted Modern/Rspack asset paths instead of hardcoding CSS URLs.                               | Framework/runtime asset pipeline            |
| Federation manifest failure    | Run the shell and vertical build scripts, then check each deployed `/mf-manifest.json` URL used by the shell.                                                     | Module Federation owner                     |

## Authorization rollout evidence

Use these operator commands for the protected-entrypoint rollout:

```bash
pnpm authorization:inventory:check
pnpm authorization:impact:report -- .codex/reports/authorization/would-deny.json
pnpm authorization:readiness:check -- stage
pnpm deployment-impact:plan -- --authorization-environment stage
pnpm test:scripts
```

The readiness command accepts a fixed environment name, never an arbitrary context path. It loads
the source-controlled context from `topology/authorization-contexts/` and the fixed inventory,
impact, observation, and negative-smoke filenames under `.codex/reports/authorization/`. These are
reproducible, non-secret operator evidence bound to one source revision and inventory hash; they
are not runtime policy. Production promotion remains
blocked until the fixed production context and governance approval tracked by issues #169 and #173
exist. The current implementation continues PR #315 without treating that approval as complete.
