# OntOS application

This directory is the application root. It contains the Shell, independently deployable
MicroVerticals, shared runtime packages, Codesmith generators, topology, and validation.

## Start here

1. Read [`../AGENTS.md`](../AGENTS.md) and [`AGENTS.md`](AGENTS.md).
2. Read [`DEVELOPMENT.md`](DEVELOPMENT.md) for branch, Locki sandbox, and local startup work.
3. Select one task-specific document from the table below.
4. Use [`../CONTEXT-MAP.md`](../CONTEXT-MAP.md) only when domain semantics or vocabulary are needed.
5. Read a specification only when the task or GitHub issue names it. `done`, `complete`, and
   `superseded` specifications are historical evidence, not current guidance.

## Current implementation authority

| Concern                                               | Read                                                                                                                |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| MicroVertical seams and BFF communication             | [MicroVertical Architecture](docs/architecture/MICROVERTICALS.md)                                                   |
| State-changing operations and identity lifecycles     | [Action Execution](docs/architecture/ACTIONS.md)                                                                    |
| Typed failures and HTTP responses                     | [Effect Error and HTTP Contracts](docs/architecture/ERRORS.md)                                                      |
| PostgreSQL ownership and access                       | [Database Architecture](docs/architecture/DATABASE.md) and [Governed Data Access](docs/architecture/DATA_ACCESS.md) |
| Asynchronous consumers                                | [Outbox Worker Architecture](docs/architecture/OUTBOX_WORKERS.md)                                                   |
| Pages, APIs, components, search, reports, and workers | [Module Entrypoints](docs/architecture/MODULE_ENTRYPOINTS.md)                                                       |
| Deployment and business module identity               | [Module Manifests](docs/architecture/MODULE_MANIFESTS.md)                                                           |
| Commerce surfaces                                     | [Commerce Application Boundaries](docs/architecture/COMMERCE_APPLICATIONS.md)                                       |
| Entities versus value objects                         | [Value Objects](docs/architecture/VALUE_OBJECTS.md)                                                                 |
| Release, CI, migrations, authorization rollout        | [Deployment Playbook](docs/architecture/DEPLOYMENT.md)                                                              |
| Frontend, routing, public surfaces, and Figma          | [Frontend Architecture](docs/frontend/FRONTEND.md)                                                                  |
| ARES integration                                      | [ARES reference](docs/integrations/ares.md)                                                                         |

## Workspace

- `apps/shell-super-app` owns staff authentication, trusted context, Shell composition, and Shell
  routes.
- `verticals/*` contains independently deployable business MicroVerticals.
- `packages/*` contains genuinely shared contracts and business-neutral runtime support.
- `scripts/*` contains generators and executable repository checks.
- `topology/*` owns current app inventory, deployment IDs, and delivery topology. Do not create a
  parallel deployment registry.

The topology `appId` identifies a deployment, Module Federation remote, and gateway audience. The
dotted `moduleId` identifies a business contract and tenant module state. Do not conflate them.

## Toolchain and local startup

`.mise.toml`, `package.json`, and the lockfile are the executable sources for tool versions,
workspace scripts, and dependencies. `.modernjs/ultramodern.json` owns generated package-source
provenance; `.codex/skills-lock.json` owns pinned agent-skill sources. Do not copy mutable values into
guidance.

```bash
mise install
mise exec -- pnpm install
mise exec -- pnpm env:local:ensure
mise exec -- pnpm dev
```

Use the [Locki workflow](DEVELOPMENT.md) for feature work. Read configuration names from
`.env.example`; never inspect `.env` contents. Optional source references and agent skills are
managed by the `agents:refs:*` and `skills:*` scripts in `package.json`.

## Codesmith

[`package.json`](package.json) is the complete command catalog. Discover generators there instead of
using a copied list:

```bash
mise exec -- pnpm run
mise exec -- pnpm scaffold:<artifact> -- --help
```

A supported business artifact must start from its generator, then be adapted. If the category has
no approved generator or governed gateway, stop before creating it manually.

Create a new full-stack vertical with the current Modern.js creator workflow, then generate its
module contract before any business artifact:

```bash
mise exec -- pnpm dlx @bleedingdev/modern-js-create <vertical> --vertical
mise exec -- pnpm scaffold:module-contract -- --help
```

The page generator owns stable component/entrypoint identity, canonical URL grammar, localized route
wiring, route parameters, safe Shell contribution metadata, and private runtime registration. Use
its `--help`; do not recreate that wiring by hand.

## Non-negotiable boundaries

- Use Effect for application behavior, I/O, resource management, concurrency, dependencies, BFF
  contracts and clients, schemas, and expected failures. Keep pure synchronous transformations and
  reusable presentation components plain TypeScript or React when Effect adds no behavior.
- Model expected failures as tagged Effect errors. Do not throw, reject, or cross a public boundary
  with untyped errors.
- Every business state change uses a declared Action. Every public read uses the governed read
  lifecycle defined by the owning architecture document.
- Frontends call their generated Effect BFF clients; they do not call private handlers, databases,
  or third-party providers directly.
- Data, migrations, handlers, routes, and executable runtime registrations remain owner-local.
  Cross-deployment communication uses public typed contracts.
- Every module-owned Action, page, API, public component, search provider, report, and Worker is a
  structured entrypoint governed before private code loads or runs.
- Reuse an existing concept before adding an abstraction. Infrastructure files may be authored
  directly only when no business generator applies.
- Keep third-party adapters private to their owner and use the generated Effect `HttpClient` service
  as the deterministic test seam.

The strict Effect API topology is `shared/api.ts`, `api/index.ts`, and `src/api/*-client.ts`.
`mise exec -- pnpm api:check` rejects legacy API trees, raw handlers, manual JSON/Response
construction, and generic public schemas.

## Routes and public surfaces

Routes are private and non-indexable by default. Route owners declare metadata in colocated
`src/routes/**/route.meta.ts`; generators maintain the compatibility manifest. Only explicit
`public && indexable` routes may emit discovery artifacts or structured data. Add `jsonLd`
explicitly—never infer it from a route.

Public artifacts are generated build outputs, not hand-authored files under `config/public`.
Dynamic public routes may provide a Node-safe colocated `route.sitemap.mjs`. Follow
[Frontend Architecture](docs/frontend/FRONTEND.md) and run the i18n and contract checks after route
changes.

## Deployment URL roles

- `MODERN_PUBLIC_SITE_URL` is the canonical origin for public SEO output.
- `MODERN_ASSET_PREFIX`, then `ULTRAMODERN_ASSET_PREFIX`, controls emitted asset URLs; otherwise use
  origin-relative `/`.
- `ULTRAMODERN_PUBLIC_URL_<APP_ID>` identifies each deployed app for proof and Module Federation
  discovery.

Do not use the SEO origin as an asset-prefix fallback. `.env.example` owns configuration names;
[Deployment](docs/architecture/DEPLOYMENT.md) owns build, proof, promotion, and rollback.

## Validation

Choose focused scripts from `package.json`. Run commands through the managed toolchain:

```bash
mise exec -- pnpm <script>
```

Before completion, run:

```bash
mise exec -- pnpm check
git diff --check
```

Also run `mise exec -- pnpm build` when changing routing, public surfaces, Module Federation,
deployment artifacts, or runtime bundling. Service-backed integration and browser tests remain
package-owned and must run when the change requires them.
