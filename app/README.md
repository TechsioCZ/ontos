# OntOS application

> [!IMPORTANT]
> Read [Development](./DEVELOPMENT.md) before feature work. Use an isolated Locki sandbox and
> treat `app/` as the application root.

## Read by trigger

Read this guide, then only the rows that govern the task.

| Concern                                               | Current authority                                                                                                   |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| MicroVertical seams, BFFs, and staff identity         | [MicroVertical Architecture](docs/architecture/MICROVERTICALS.md)                                                   |
| State-changing operations                             | [Action Execution](docs/architecture/ACTIONS.md)                                                                    |
| Typed failures and HTTP responses                     | [Effect Error and HTTP Contracts](docs/architecture/ERRORS.md)                                                      |
| PostgreSQL ownership and governed access              | [Database Architecture](docs/architecture/DATABASE.md) and [Governed Data Access](docs/architecture/DATA_ACCESS.md) |
| Asynchronous consumers                                | [Outbox Worker Architecture](docs/architecture/OUTBOX_WORKERS.md)                                                   |
| Pages, APIs, components, search, reports, and workers | [Module Entrypoints](docs/architecture/MODULE_ENTRYPOINTS.md)                                                       |
| Deployment contracts and module identity              | [Module Manifests](docs/architecture/MODULE_MANIFESTS.md)                                                           |
| Commerce surfaces                                     | [Commerce Application Boundaries](docs/architecture/COMMERCE_APPLICATIONS.md)                                       |
| Entities versus value objects                         | [Value Objects](docs/architecture/VALUE_OBJECTS.md)                                                                 |
| Deployment and release work                           | [Deployment Playbook](docs/architecture/DEPLOYMENT.md)                                                              |
| Frontend work, including Figma                        | [Frontend Architecture](docs/frontend/FRONTEND.md)                                                                  |
| ARES integration                                      | [ARES reference](docs/integrations/ares.md)                                                                         |

Read a specification only when the task or GitHub issue names it. A specification with
`status: done`, `status: complete`, or `status: superseded` is historical implementation evidence,
not current guidance. Do not browse `specs/` for background.

## Non-negotiable rules

- Use Effect for application behavior, I/O, resource management, concurrency, dependencies, BFF
  contracts and clients, schemas, and expected failures. Pure synchronous transformations and
  reusable presentation may stay plain TypeScript or React.
- Model expected failures as tagged Effect errors. Do not throw, reject a Promise, return an
  untyped error object, or collapse an expected failure into a string.
- Preserve strict independently deployable MicroVertical seams. Never import another deployment's
  private manifest, registration, table, handler, repository, route, migration, fixture, or test.
- Frontends call only the owning MicroVertical's generated Effect BFF client. Run an Effect at the
  framework edge without erasing its typed failure channel.
- All public writes and governed reads pass through Core-owned operation lifecycles. Tenant/system
  entrypoint scope and legal-entity scope are independent; invalid or indeterminate context fails
  closed before private code resolves.
- Prefer direct values and typed references over stringly typed metadata. Reuse existing concepts
  and files; add an abstraction only for a concrete reuse case.
- Business handlers receive owner-local transaction-scoped services, never a raw database
  executor.
- Start supported business artifacts with Codesmith. If a category has no approved generator or
  gateway, extend or approve that boundary before creating the artifact.
- Infrastructure and architecture files may be created directly when no generator applies.
- Keep third-party HTTP adapters private to their owner. Define provider schemas, typed failures,
  request construction, resilience, diagnostics, and business mapping; use the generated Effect
  `HttpClient` service as the test seam.
- Run pnpm commands from `app/` through `mise exec -- pnpm`.

## Codesmith

`package.json#scripts` is the command source of truth. Inspect supported flags with
`mise exec -- pnpm <script> -- --help` before planning or generating.

```sh
mise exec -- pnpm run
mise exec -- pnpm <scaffold-script> -- --help
```

Create a new full-stack MicroVertical with the workspace-pinned `@modern-js/create` binary:

```sh
mise exec -- pnpm exec modern-js-create <vertical> --vertical
```

Then generate its MicroVertical module contract before its business artifacts. Generated files and
registration slots are the required starting point and may then be adapted. The same rule applies
to delegated work. Do not replace the pinned binary with an unversioned `pnpm dlx` invocation.

## Sources of truth

| Fact                                      | Source                                                                 |
| ----------------------------------------- | ---------------------------------------------------------------------- |
| Workspace packages and scripts            | `package.json`, `pnpm-workspace.yaml`                                  |
| Node and pnpm versions                    | `.mise.toml`, `package.json#packageManager`                             |
| Package-source and generated profile data | `.modernjs/ultramodern.json`                                           |
| Deployments, remotes, ports, and owners   | `topology/` and generated ownership metadata                           |
| Agent skill sources and install target    | `.agents/skills-lock.json` and its bootstrap script                    |
| CI and stage delivery                     | `../.github/workflows/ultramodern-workspace-gates.yml`                 |
| Local database defaults                   | `.env.example`, Compose configuration, and database scripts            |

Do not cache current versions, vertical inventory, generated fields, or package-source strategy in
prose. Where source files describe the same contract, they must agree; a mismatch is a generator or
validation defect, not a choice for documentation to resolve. Use the mise-managed toolchain; do
not reintroduce Corepack or alternate pnpm aliases. The repository typecheck script owns the
TS-Go/TS7 invocation; do not replace it with an ad hoc compiler command.

## Private-first routes and public output

Generated routes are private and non-indexable by default. Colocated
`src/routes/**/route.meta.ts` files own route metadata; the scaffold derives
`src/routes/ultramodern-route-metadata.ts` and public output from them. A route emits discovery
output only when metadata explicitly marks it `public && indexable`. JSON-LD is explicit, never
inferred, and uses the generated helpers for supported schema types. Dynamic public routes may
provide a Node-safe `route.sitemap.mjs`. Generated public files belong in `dist/public` and
`.output/public`, not hand-authored source directories.

Use [Frontend Architecture](docs/frontend/FRONTEND.md) for user-facing behavior and
[Module Entrypoints](docs/architecture/MODULE_ENTRYPOINTS.md) for governed page resolution,
dynamic parameters, and lazy remote loading.

## Local database

`.env.example`, Compose, Drizzle journals, and database scripts own local role and connection
details. Never read `.env`. For an existing volume, set the required URLs outside source control,
then run:

```sh
mise exec -- pnpm db:bootstrap-runtime-role
mise exec -- pnpm db:migrate
mise exec -- pnpm db:verify
```

Each owner keeps its own schema, migration journal, and verifier. See
[Database Architecture](docs/architecture/DATABASE.md).

## Public URLs and Cloudflare proof

| Variable                          | Role                                             |
| --------------------------------- | ------------------------------------------------ |
| `MODERN_PUBLIC_SITE_URL`          | Canonical origin for public SEO output           |
| `MODERN_ASSET_PREFIX`             | Preferred JS, CSS, and static-asset prefix       |
| `ULTRAMODERN_ASSET_PREFIX`        | Compatibility asset prefix                       |
| `ULTRAMODERN_PUBLIC_URL_<APP_ID>` | Per-app deployment, proof, and remote origin     |

Do not bake absolute localhost URLs into production asset configuration. Shell assets resolve
`MODERN_ASSET_PREFIX`, then `ULTRAMODERN_ASSET_PREFIX`, then origin-relative `/`. Module
Federation remotes use the same prefix precedence, then their configured per-app origin.
`MODERN_PUBLIC_SITE_URL` is SEO-only and never an asset-prefix fallback. When it is unset, local
and preview output remains non-public. App-specific public URL keys are generated from topology;
hyphens become underscores and letters become uppercase.

```sh
mise exec -- pnpm cloudflare:build
mise exec -- pnpm cloudflare:deploy
ULTRAMODERN_PUBLIC_URL_SHELL_SUPER_APP=https://shell-super-app.example.workers.dev \
  mise exec -- pnpm cloudflare:proof --require-public-urls
```

The live proof checks route discovery consistency, preview noindex behavior, unknown-route
status, asset headers, byte budgets, and public sourcemap exposure. Local checks do not prove live
Worker access. See [Deployment](docs/architecture/DEPLOYMENT.md) for release and rollback gates.

## Strict Effect API

Generated HTTP APIs use one direct topology:

- contract: `shared/api.ts`;
- runtime entry: `api/index.ts`;
- browser clients: `src/api/*-client.ts`;
- Modern configuration: Effect runtime with `strictEffectApproach: true`.

Do not add legacy nested API paths, Hono server imports, raw handlers, manual body parsing, manual
`Response` construction, or generic JSON schemas in API modules. `api:check`, type checking, and
linting enforce the boundary. Staff authentication and service identity remain Shell/Core
capabilities; use [MicroVertical Architecture](docs/architecture/MICROVERTICALS.md) rather than
duplicating those contracts here.

Prepare an existing MicroVertical once before its BFF accepts Shell-user Action calls:

```sh
mise exec -- pnpm scaffold:microvertical-action-boundary -- --vertical <vertical>
```

For an older generated workspace, inspect and run the repository-owned migration wrapper, then
validate the API and workspace contracts:

```sh
mise exec -- pnpm migrate:strict-effect -- --help
mise exec -- pnpm migrate:strict-effect -- <supported-arguments>
mise exec -- pnpm api:check
mise exec -- pnpm contract:check
```

Do not copy a generator release into prose or add compatibility shims around source that still
needs migration.

## Protected-entrypoint authorization rollout

Codesmith-generated entrypoint descriptors carry explicit authorization classification for
Actions, reads, pages, public components, APIs, search providers, reports, and Workers.
Repository checks reject missing or invalid classification. Each protected surface retains its
owning runtime gate; do not infer one universal runtime policy from shared metadata or add an
unconfigured allow path. The focused contracts live in
[Actions](docs/architecture/ACTIONS.md), [Module Entrypoints](docs/architecture/MODULE_ENTRYPOINTS.md),
and [Deployment](docs/architecture/DEPLOYMENT.md).

Use the source-owned operator evidence commands:

```sh
mise exec -- pnpm authorization:inventory:check
mise exec -- pnpm authorization:impact:report -- .codex/reports/authorization/would-deny.json
mise exec -- pnpm authorization:readiness:check -- stage
mise exec -- pnpm deployment-impact:plan -- --authorization-environment stage
mise exec -- pnpm test:scripts
```

Readiness accepts a fixed environment name and loads source-controlled contexts from
`topology/authorization-contexts/` plus fixed report paths. Those files are reproducible rollout
evidence, not runtime policy. Production remains blocked until its source-controlled context,
required evidence, and governance approval exist; do not weaken that gate in documentation.

## Validation

Run focused tests first. Before completion, run the required task commands and the repository gate:

```sh
mise install
mise exec -- pnpm install
mise exec -- pnpm check
```

Run `mise exec -- pnpm build` when build output, routes, public surfaces, Module Federation,
deployment artifacts, or runtime bundling changed.

## Troubleshooting

| Symptom                     | First source or check                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------- |
| Toolchain mismatch          | `.mise.toml`, `package.json#packageManager`, then `mise install`                       |
| Package cohort mismatch     | `.modernjs/ultramodern.json`, workspace policy, then a frozen install                  |
| Old API path                | `mise exec -- pnpm api:check`                                                         |
| Type, lint, or contract fail| Run the matching primitive script from `package.json` before the aggregate gate       |
| Missing public URL          | The app key generated in `.modernjs/ultramodern.json`                                 |
| Asset or CSS 404            | Rebuild and inspect emitted asset paths; do not hardcode URLs                         |
| Federation failure          | Build host and remote, then verify each configured `mf-manifest.json`                 |
| Deployment or rollback issue| [Deployment Playbook](docs/architecture/DEPLOYMENT.md)                                |
