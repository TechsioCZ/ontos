# MicroVerticals and OntOS modules

This document distinguishes the UltraModern.js MicroVertical implementation concept from the OntOS module contract. It supersedes any wording that implied a MicroVertical is only a frontend module or that the architecture is naturally split into web and BFF containers.

## Definition

An UltraModern.js MicroVertical is a unified vertical slice inside one jointly deployable application. It owns both user-facing and server-side behavior for a bounded capability. It is designed to keep code that changes together in one understandable slice.

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

They are not separate microservices in V0. They are not only UI modules. They are not only backend bounded contexts. They are not arbitrary plugins loaded from untrusted code at runtime. They are not a way to bypass Core. The UltraModern.js MicroVertical concept also does not imply the OntOS Module Manifest; the manifest is an OntOS ERP runtime contract.

## Why this model matters

Traditional layered architecture often splits a feature across frontend, backend, database, permissions, jobs, and reporting folders. That makes it easy for a feature to become cross-layer scattered. OntOS needs the opposite: each business capability should have a cohesive home so that humans and coding agents can reason about the whole feature.

A MicroVertical therefore packages the things that change together. The short-term rental slice owns reservation UI and reservation command handling together. The long-term rental slice owns lease contract UI and lease command handling together. The billing slice owns invoice actions and invoice UI together.

## Relationship to Core

Core provides shared capabilities; business modules consume them. Core should not know business-specific details except through OntOS Module Manifests and declared extension points. MicroVertical implementations must not reimplement Core concerns.

Examples of Core concerns: BetterAuth binding, authorization adapter, principal context, tenant-level module state, action invocation recording, audit, events, outbox, media asset/link infrastructure, projection dispatch, common search interfaces.

Examples of MicroVertical concerns: what a reservation means, how a lease contract is created, how invoice lines are sourced, how an internal delivery ticket links to a project, which reports a property module exposes.

## Runtime activation

In V0, MicroVertical code is part of the application deployment. A module can be activated, suspended, read-only, quarantined, deprecated, or archived per tenant without restarting the server. Legal-entity-specific setup belongs in the owning module's settings tables. Runtime activation controls whether UI contributions appear, whether actions are invokable, whether public resources are enabled, and how historical data is displayed.

Adding a brand-new MicroVertical with new code requires deployment in V0. Later versions may support generated/schema-defined modules or sandboxed modules, but that is explicitly not a V0 requirement.

## Activation states

| State | Meaning |
|---|---|
| Active | Module is available for normal read and write usage. |
| Read-only | Data remains visible but write actions are disabled. |
| Suspended | Module is not available in the customer’s current package or payment state; historical data remains preserved. |
| Quarantined | Module is temporarily disabled because of a defect, migration issue, or data safety concern. |
| Deprecated | Module is being replaced but still exists for compatibility. |
| Archived | Module is no longer operational but its historical data remains available for audit/reporting as permitted. |

The key rule is that module deactivation must not destroy company memory. Historical resources, media links, audit, events, invoices, and module-owned links remain addressable subject to permissions.

## OntOS Module Manifest discipline

Every OntOS Business Module must declare its public contract through an OntOS Module Manifest. The manifest is not optional documentation; it is the public runtime and tooling boundary for activation, dependencies, and cross-module contracts.

The manifest should include public module identity, activation, dependencies, APIs, component exports, public resource types, public events, search descriptors, and report descriptors.

It should not include private implementation details such as database tables, migrations, command handler paths, outbox handler paths, route trees, navigation wiring, fixtures, tests, relation catalogs, or private read models. Those can be validated by internal tooling, but they are not public module contract.

In V0 this can start lightweight. The important part is that the concept exists from the beginning and that new modules cannot grow as unregistered folders of ad hoc code.

The first draft Effect Schema-defined manifest shape is described in `14_ONTOS_MODULE_MANIFEST.md`. That document should be treated as the contract design surface for grilling and PoC validation, not as a finalized schema.

## Dependency rules

OntOS Business Modules may depend on Core and on explicit public contracts of other business modules. They should not import another module's internal tables, command handlers, UI internals, or private utilities. Cross-module writes should go through actions or explicit Core-mediated mechanisms. Cross-module reads should use declared read models, ResourceRefs, or public query surfaces.

This matters because the long-term product depends on being able to add, replace, suspend, or generate modules without making the entire codebase a single implicit dependency graph.

## MicroVertical Forge

Forge is an internal development tool that should help generate OntOS Business Module skeletons implemented as MicroVerticals. It is not the vibemodule product. Its near-term value is to make coding-agent output consistent: OntOS Module Manifests, resource descriptors, permissions, actions, command handler stubs, migrations, UI stubs, and tests.

Forge should be used to create uniformity, not magic. It should make it harder for a developer or agent to create a module that bypasses Core.
