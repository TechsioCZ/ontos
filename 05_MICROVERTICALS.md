# MicroVerticals

This document defines MicroVerticals as they are intended for OntOS. It supersedes any wording that implied a MicroVertical is only a frontend module or that the architecture is naturally split into web and BFF containers.

## Definition

An OntOS MicroVertical is a unified vertical business slice inside one jointly deployable application. It owns both user-facing and server-side behavior for a bounded business capability. It is designed to be understood, generated, tested, activated, and evolved as one unit.

A MicroVertical should normally contain:

| Area | Owned by MicroVertical |
|---|---|
| UI | pages, routes, panels, forms, tables, entity detail sections, dashboard sections |
| State | local state, server-state hooks, view state, filters, query descriptors |
| Actions | declared business actions callable from UI/API/import/integration |
| Command handlers | backend implementation of actions |
| Domain data | domain tables, constraints, migrations, seed data |
| Ontology | entity types, relation types, entity display rules, timeline contributions |
| Authorization | module permissions, resource mappings, action permission requirements |
| Policy | module-specific business rules, state transitions, validation rules |
| Events/outbox | domain events, outbox descriptors, projection handlers |
| Reports/search | search descriptors, report descriptors, metrics definitions |
| Tests | unit, integration, action pipeline, permission, migration, fixture tests |

## What MicroVerticals are not

They are not separate microservices in V0. They are not only UI modules. They are not only backend bounded contexts. They are not arbitrary plugins loaded from untrusted code at runtime. They are not a way to bypass Core.

## Why this model matters

Traditional layered architecture often splits a feature across frontend, backend, database, permissions, jobs, and reporting folders. That makes it easy for a feature to become cross-layer scattered. OntOS needs the opposite: each business capability should have a cohesive home so that humans and coding agents can reason about the whole feature.

A MicroVertical therefore packages the things that change together. The short-term rental slice owns reservation UI and reservation command handling together. The long-term rental slice owns lease contract UI and lease command handling together. The billing slice owns invoice actions and invoice UI together.

## Relationship to Core

Core provides shared capabilities; MicroVerticals consume them. Core should not know business-specific details except through module manifests and declared extension points. MicroVerticals must not reimplement Core concerns.

Examples of Core concerns: authentication integration, authorization adapter, principal context, module runtime, entity registry, relation registry, audit, events, outbox, document metadata, projection dispatch, common search interfaces.

Examples of MicroVertical concerns: what a reservation means, how a lease contract is created, what an invoice draft contains, how an internal delivery ticket links to a project, which reports a property module exposes.

## Runtime activation

In V0, MicroVertical code is part of the application deployment. A module can be activated, suspended, read-only, quarantined, deprecated, or archived per tenant/legal entity without restarting the server. That means runtime activation controls whether UI contributions appear, whether actions are invokable, whether entity types are enabled, and how historical data is displayed.

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

The key rule is that module deactivation must not destroy company memory. Historical entities, documents, relation edges, audit, and invoices remain addressable subject to permissions.

## Manifest discipline

Every MicroVertical must declare its contract through a manifest. The manifest is not optional documentation; it is the runtime and tooling boundary.

The manifest should include module identity, version, dependencies, owned entity types, relation types, actions, permissions, state machines, UI contributions, route contributions, migrations, search descriptors, report descriptors, outbox handlers, projection handlers, feature flags, and test fixture metadata.

In V0 this can start lightweight. The important part is that the concept exists from the beginning and that new modules cannot grow as unregistered folders of ad hoc code.

## Dependency rules

MicroVerticals may depend on Core and on explicit public contracts of other MicroVerticals. They should not import another module’s internal tables, command handlers, UI internals, or private utilities. Cross-module writes should go through actions or explicit Core-mediated mechanisms. Cross-module reads should use declared read models, entity references, or public query surfaces.

This matters because the long-term product depends on being able to add, replace, suspend, or generate modules without making the entire codebase a single implicit dependency graph.

## MicroVertical Forge

Forge is an internal development tool that should help generate MicroVertical skeletons. It is not the vibemodule product. Its near-term value is to make coding-agent output consistent: manifests, entity declarations, relation declarations, permissions, actions, command handler stubs, migrations, UI stubs, and tests.

Forge should be used to create uniformity, not magic. It should make it harder for a developer or agent to create a module that bypasses Core.
