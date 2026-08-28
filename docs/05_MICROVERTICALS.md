# MicroVerticals and OntOS modules

This document distinguishes the UltraModern.js MicroVertical implementation concept from the OntOS module contract. It follows [ADR-0016](adr/0016-independently-deployable-microverticals.md) and supersedes wording that implied a frontend-only module, a mandatory web/BFF split, or one jointly deployed modular monolith.

## Definition

An UltraModern.js MicroVertical is a full-stack vertical slice behind a strict independently deployable seam. It owns both user-facing and server-side behavior for a bounded capability. It is designed to keep code that changes together in one understandable slice while allowing placement to change through configuration or Adapter selection only.

An OntOS Business Module is the ERP/product concept built on top of that implementation shape. In V0, ordinary business modules should normally be implemented as UltraModern.js MicroVerticals, but OntOS adds a public Effect Schema-defined Module Manifest that UltraModern.js itself does not define.

An OntOS Business Module implemented as a MicroVertical should normally contain:

| Area | Owned by MicroVertical |
|---|---|
| UI | pages, routes, panels, forms, tables, resource detail sections, dashboard sections |
| State | local state, server-state hooks, view state, filters, query descriptors |
| Actions | declared business actions callable from UI/API/import/integration |
| Command handlers | backend implementation of actions |
| Domain data | domain tables, constraints, migrations, seed data |
| Resource model | public resource types, domain links, display rules, timeline contributions |
| Authorization | module permissions, resource mappings, action permission requirements |
| Policy | module-specific business rules, state transitions, validation rules |
| Events/outbox | domain events, outbox descriptors, projection handlers |
| Reports/search | search descriptors, report descriptors, metrics definitions |
| Tests | unit, integration, action pipeline, permission, migration, fixture tests |

## What MicroVerticals are not

They are not separate products, frontend-only modules, backend-only bounded contexts, or arbitrary plugins loaded from untrusted code. Independent deployability does not require every module to run on a separate host, and co-location does not permit private imports, shared repositories, or shared business transactions. They are not a way to bypass Core. The UltraModern.js MicroVertical concept also does not imply the OntOS Module Manifest; the manifest is an OntOS runtime contract.

## Why this model matters

Traditional layered architecture often splits a feature across frontend, backend, database, permissions, jobs, and reporting folders. That makes it easy for a feature to become cross-layer scattered. OntOS needs the opposite: each business capability should have a cohesive home so that humans and coding agents can reason about the whole feature.

A MicroVertical therefore packages the things that change together. The short-term rental slice owns reservation UI and reservation command handling together. The long-term rental slice owns lease contract UI and lease command handling together. The billing slice owns invoice actions and invoice UI together.

## Relationship to Core

Core provides shared capabilities; business modules consume them. Core should not know business-specific details except through OntOS Module Manifests and declared extension points. MicroVertical implementations must not reimplement Core concerns.

Examples of Core concerns: BetterAuth binding, authorization adapter, principal context, tenant-level module state, action invocation recording, audit, events, outbox, media asset/link infrastructure, projection dispatch, common search interfaces.

Examples of MicroVertical concerns: what a reservation means, how a lease contract is created, how invoice lines are sourced, how an internal delivery ticket links to a project, which reports a property module exposes.

Each MicroVertical that owns persistent domain data must own a dedicated Postgres schema. Module-owned tables live in that schema, not in `public` and not in another vertical's schema. Cross-module data access must go through public module contracts, ResourceRefs, Actions, or explicit Core-mediated read/query surfaces rather than direct table coupling.

## Runtime activation and composition

Each MicroVertical is installed through an allowlisted deployment contract. A module can be inactive, active, read-only, suspended, quarantined, deprecated, or archived per Tenant. Legal-entity-specific setup belongs in the owning module's settings tables. Runtime activation controls whether UI contributions appear, whether Actions are invokable, whether public resources are enabled, and how historical data is displayed.

Adding a new MicroVertical requires building and deploying its delivery unit. Later versions may support generated/schema-defined or sandboxed modules, but that is not a launch requirement.

An Application Composition owns a continuously delivered, dependency-closed DAG of Foundational and Business Modules. Core validates installation, compatibility, implementation selection, and activation closure. A module activates only when its required dependencies are installed, compatible, and active. A dependency outage degrades affected entrypoints explicitly without rewriting or cascading stored module states; unrelated modules continue operating.

A Module Contract Identity names stable public capability semantics; a Module Implementation Identity names one catalogued executable implementation. Customer Configuration may select a permitted implementation declaratively. Compatible alternatives may share a contract identity only while public semantics remain the same; different semantics require a distinct module identity. The Installed Module Catalog records implementation identity, immutable build revision, contract hash/version, migrations, owner, and health. Invisible same-identity forks are forbidden.

This is accepted target architecture. The current app manifest/catalog supports one implicit `standard` implementation per module and must be extended through its generators and validation before a second implementation is added.

All module entrypoints must be invoked through Shell/Core gateways. Direct entrypoint loading is forbidden: modules should not bypass Shell/Core by directly loading Module Federation remotes, private routes, public components, Action handlers, or worker handlers. This keeps tenant module state enforcement at the boundary before module code is loaded or dispatched.

Commerce channel applications are an explicit boundary exception to Shell UI composition, not to module governance. Independently deployed Storefront Applications call a thin Commerce Storefront API over published module contracts; Commerce Operations is a purpose-built staff application over the same governed entrypoints. Neither imports module-private code or becomes a canonical owner. See [ADR-0017](adr/0017-commerce-application-boundaries.md).

## Activation states

| State | Meaning |
|---|---|
| Inactive | Module is installed in the application but not enabled for the tenant. Historical data, if any exists, remains preserved subject to permissions. |
| Active | Module is available for normal read and write usage. |
| Read-only | Data remains visible but write actions are disabled. |
| Suspended | Module is not available in the customer’s current package or payment state; historical data remains preserved. |
| Quarantined | Module is temporarily disabled because of a defect, migration issue, or data safety concern. |
| Deprecated | Module is being replaced but still exists for compatibility. |
| Archived | Module is no longer operational but its historical data remains available for audit/reporting as permitted. |

Normal Shell navigation should show `active`, `read_only`, and `deprecated` modules, with visible state indicators for non-active visible states. It should hide `inactive`, `suspended`, `quarantined`, and `archived` modules from ordinary navigation while preserving historical data access through explicit permitted paths when needed.

The key rule is that module deactivation must not destroy company memory. Historical resources, media links, audit, events, invoices, and module-owned links remain addressable subject to permissions.

## OntOS Module Manifest discipline

Every OntOS Business Module must declare its public contract through an OntOS Module Manifest. The manifest is not optional documentation; it is the public runtime and tooling boundary for activation, dependencies, and cross-module contracts.

The manifest should include public module identity, activation, dependencies, Action descriptors, APIs, component exports, public resource types, public events, search descriptors, and report descriptors.

It should not include private implementation details such as database tables, migrations, command handler paths, outbox handler paths, route trees, navigation wiring, fixtures, tests, relation catalogs, or private read models. Those can be validated by internal tooling, but they are not public module contract.

The current app implements this contract through generated owner-authored manifests, deterministic serialized deployment contracts, a topology allowlist, and an atomically validated Installed Module Catalog. New modules cannot grow as unregistered folders of ad hoc code.

The product-level contract is summarized in `14_ONTOS_MODULE_MANIFEST.md`; current executable details live under `app/docs/architecture/`.

## Dependency rules

OntOS modules may depend on Core and on explicit published contracts of other modules. They consume generated typed clients, schema-only Outbox contracts, and Shell/Core-governed public component or entrypoint descriptors. They must not import another deployment's manifest source, runtime registration, internal tables, handlers, private routes, UI internals, migrations, fixtures, tests, or utilities. Cross-module writes go through published Actions or durable messages; cross-module reads use declared APIs/read models and ResourceRefs. No interaction creates a shared business transaction.

This matters because the long-term product depends on being able to add, replace, suspend, or generate modules while keeping the explicit Application Composition DAG distinct from hidden implementation coupling.

Public component reuse across modules still goes through the Shell/Core component gateway. A module may depend on another module's public component contract, but it must not directly call Module Federation or hard-code remote specifier strings. Shell/Core should represent module component loads as structured entrypoints, not ad hoc import paths.

## Implemented safeguards and remaining proof

The current app enforces the seam with Codesmith-generated contracts and private registrations, deterministic serialized deployment contracts, topology allowlisting, an all-or-nothing Installed Module Catalog, static private-import and database-boundary checks, structured entrypoint gateways, module-state enforcement, audience-scoped Shell assertions, contract-derived Effect clients, owner-local schemas/migrations, and module-owned Outbox workers.

These are implemented mechanisms, not complete production evidence. Production acceptance must still prove equivalent local and network behavior; independent compatible build, migration, rollout, rollback, and recovery; timeout, partition, crash, and backpressure handling; typed degradation limited to affected dependency closures; unrelated-module continuity; version-skew rejection; health/readiness and observability; and backup/restore and incident procedures. Foundational Module catalog support and complete contract-compatible Application Composition closure enforcement remain implementation work.

## MicroVertical Forge

Forge is an internal development tool that should help generate OntOS Business Module skeletons implemented as MicroVerticals. It is not the vibemodule product. Its near-term value is to make coding-agent output consistent: OntOS Module Manifests, resource descriptors, permissions, actions, command handler stubs, migrations, UI stubs, and tests.

Forge should be used to create uniformity, not magic. It should make it harder for a developer or agent to create a module that bypasses Core.
