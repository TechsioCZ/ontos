# OntOS Application Agent Instructions

OntOS is an ERP system built with [UltraModern.js](https://bleedingdev.github.io/ultramodern.js/guides/get-started/ultramodern) and [`@techsio/ui-kit`](https://github.com/TechsioCZ/new-engine).
Never read .env file

## Required Guidance

For work inside `app/`, this file and `app/docs/` are authoritative implementation guidance. Use the repository-level [`../docs/`](../docs/) as product and architectural context. If they conflict, follow the guidance under `app/` and raise the discrepancy to the developer.

### Non-Negotiable Architecture

- **MicroVerticals:** Preserve the strict, independently deployable vertical seams between MicroVerticals. Keep each MicroVertical's frontend/backend seam virtual and represented by its generated Effect-based Backend for Frontend (BFF) client. Follow [MicroVertical Architecture](./docs/architecture/MICROVERTICALS.md).
- **Actions:** Drive every state change through a typed Action and preserve its required lifecycle, transaction, event, and evidence rules. Follow [Action Execution](./docs/architecture/ACTIONS.md).
- **Effect errors:** Use Effect end to end for application behavior, BFF contracts and clients, and expected failures. Every backend error response must come from a declared typed Effect error with the correct HTTP status. Follow [Effect Error and HTTP Contracts](./docs/architecture/ERRORS.md).
- **Database access:** Keep PostgreSQL access typed through Drizzle schema references and query builders inside Effect services. Follow [Database Architecture](./docs/architecture/DATABASE.md).
- **Governed data access:** Every operation declares legal-entity scope independently of tenant/system entrypoint scope. Core validates immutable operation scope and supplies only owner-local scoped services; business handlers never receive or import a database executor. Follow [Governed Data Access and Operation Scope](./docs/architecture/DATA_ACCESS.md).
- **Outbox Workers:** Consume cross-MicroVertical facts only through published schema contracts and the Core-owned delivery runtime. Follow [Outbox Worker Architecture](./docs/architecture/OUTBOX_WORKERS.md).
- **Module Entrypoints:** Every Action, page, API, public component, search provider, report, and Worker must use an approved generated structured descriptor and Shell/Core gateway so tenant module state is checked before private code loads or runs. Follow [Module Entrypoints and Tenant State](./docs/architecture/MODULE_ENTRYPOINTS.md). If a category lacks an approved generator or gateway adapter, stop and extend/approve Codesmith before creating its business artifact.
- **Module manifests:** Keep deployment `appId` and business `moduleId` distinct, discover modules only through the deployment allowlist and serialized contract, and keep runtime registrations owner-local. Follow [OntOS Module Manifests](./docs/architecture/MODULE_MANIFESTS.md).
- **Commerce applications:** Keep Storefront Applications externally deployed, the Commerce Storefront API thin, Portal Account BetterAuth separate from staff Auth, Commerce Operations outside Shell/Core, and customer implementation alternatives explicit in the catalog. Follow [Commerce Application Boundaries](./docs/architecture/COMMERCE_APPLICATIONS.md).

### Task-Specific Rules

- All implementation work: [UltraModern.js Implementation Rules](./docs/architecture/ULTRAMODERN.md)
- Deployment, CI/CD, migrations, runtime packaging, release sequencing, rollback, or new
  MicroVertical delivery work: [Deployment Architecture and Release Playbook](./docs/architecture/DEPLOYMENT.md)
- User-facing frontend work: [Frontend Architecture Rules](./docs/frontend/FRONTEND.md)
- When using Figma, follow: [Figma Rules](./docs/frontend/FIGMA.md)

### Mandatory Codesmith Generators

Run supported business-artifact generators from `app/` with the repository-managed toolchain.
Actions support exactly one of these ownership forms:

```bash
mise exec -- pnpm scaffold:action -- --vertical <vertical> --action <action>
mise exec -- pnpm scaffold:action -- --scope core --module <core.module> --action <action>
mise exec -- pnpm scaffold:action-service -- --vertical <vertical> --service <service>
```

The Core form accepts only stable `core.*` module keys and writes only to the generated Core
Action owner slot. Do not combine Core and MicroVertical ownership flags.

Use `scaffold:action-service` before adding an owner-local persistence service consumed by one or
more generated MicroVertical Actions. Adapt the generated Effect service without exposing a
database executor to an Action handler.

Use `scaffold:external-http-adapter` before adding a private third-party HTTP adapter inside any
`verticals/*` package. The generated file remains an owner-local implementation detail and must not
patch or appear in a module manifest, runtime registration, package export, Module Federation
exposure, generated BFF client, or Shell surface. Substitute the generated Effect `HttpClient`
context service in deterministic tests. The owning adapter must define its provider-specific
input/result schemas, tagged error union, request construction, resilience policy, diagnostics,
and business mapping when adapting the fail-closed scaffold.

```bash
mise exec -- pnpm scaffold:external-http-adapter -- --vertical <vertical> --provider <provider> --operation <operation>
```

Before any business generator targets a newly created MicroVertical, generate its paired manifest
and private registration exactly once:

```bash
mise exec -- pnpm scaffold:module-contract -- --vertical <vertical> --module <dotted.module-id>
```

Shell/Core and ordinary MicroVertical source must never import another deployment's
`vertical.manifest.ts` or `vertical.registration.ts`.

## Toolchain

Run every pnpm command from the `app/` directory with the repository-managed toolchain:

```bash
mise exec -- pnpm <command>
```

The only exception is a command embedded in a deployment manifest for a minimal provider image
that intentionally does not contain mise. That command must use the exact Node and pnpm versions
pinned by the deployment contract and must follow
[Deployment Architecture and Release Playbook](./docs/architecture/DEPLOYMENT.md). Do not apply this
exception to agent, developer, local CI, or ordinary GitHub Actions commands.
