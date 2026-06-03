# OntOS Module Manifest

The OntOS Module Manifest is an OntOS-specific public contract for a module. It is not part of the standard UltraModern.js MicroVertical concept.

UltraModern.js MicroVerticals describe how code is organized as a vertical slice inside one jointly deployable application. OntOS adds a manifest because the ERP runtime needs a typed, machine-readable contract for module activation, dependencies, public APIs, public components, public resource types, public events, search, and reports.

The manifest should be authored as a TypeScript value validated by Effect Schema. Build tooling can emit JSON for catalogs, docs, runtime inspection, or CI artifacts, but JSON should be an output artifact rather than the hand-authored source of truth.

## Naming

Use these terms precisely:

| Term | Meaning |
|---|---|
| UltraModern.js MicroVertical | Framework-level vertical slice concept. It does not define an OntOS manifest. |
| OntOS Business Module | Product/business capability in OntOS, usually implemented as an UltraModern.js MicroVertical in V0. |
| OntOS System Module | Core-owned capability such as `core.identity`, `core.authz`, `core.audit`, or `core.search`. |
| OntOS Module Manifest | Effect Schema-defined public contract for an OntOS Business Module, Foundational Module, or selected System Module. |

Avoid saying "MicroVertical Manifest" unless talking loosely. The precise term is "OntOS Module Manifest".

## Scope

The manifest exposes only the public surface that other modules, Core, tooling, activation logic, and generated clients may depend on.

It should include:

- module identity
- activation behavior
- module dependencies
- public API contracts
- public component exports
- public resource types
- public events
- public search descriptors
- public report descriptors

It should not include:

- database table names
- migrations
- command handler file paths
- private read models
- private validation internals
- outbox handler file paths
- projection implementation details
- fixtures
- tests
- arbitrary implementation imports
- TanStack Router route trees
- ordinary navigation wiring

Domain tables, routes, navigation, handlers, fixtures, tests, and projection jobs still matter. They are owned by the implementation of the module, but they are not part of the public module contract.

## Authoring Model

The source artifact should be a typed module manifest, not a loose JSON file.

The manifest should rely on inference wherever TypeScript, Effect Schema, React types, or Effect HttpApi can already provide the information. Do not hand-author static strings for things the compiler can know, such as import paths, export names, component prop types, API endpoint definitions, client shapes, or runtime value identities.

String keys are acceptable only when they are stable business/runtime identifiers, such as module ids, dependency ids, resource type keys, event keys, search descriptor keys, and report keys. They should not be used as a substitute for typed values.

```ts
import { defineOntosModuleManifest } from "@ontos/core/module-manifest"
import { PropertyUnitClient } from "./public-api"
import { PropertyUnitCard } from "./public-components"

export const PropertyRegistryManifest = defineOntosModuleManifest({
  module: {
    id: "property.registry",
    kind: "business_module",
    implementedAs: "ultramodern_microvertical",
    displayName: "Property Registry",
    description:
      "Stable physical and legal property structure for property and rental workflows."
  },
  activation: {
    scope: "tenant",
    defaultState: "inactive",
    supportedStates: [
      "active",
      "read_only",
      "suspended",
      "quarantined",
      "deprecated",
      "archived"
    ],
    preservesHistoryWhenInactive: true
  },
  dependencies: {
    core: [
      "core.identity",
      "core.authz",
      "core.modules",
      "core.actions",
      "core.audit",
      "core.events",
      "core.search"
    ],
    modules: [],
    externalSystems: []
  },
  publicSurface: {
    api: {
      PropertyUnitClient
    },
    components: {
      PropertyUnitCard
    },
    resourceTypes: [],
    events: [],
    search: [],
    reports: []
  }
})
```

`defineOntosModuleManifest` should validate the value with Effect Schema and preserve enough literal type information for build-time tooling.

Package version, Module Federation build metadata, package ownership, and code ownership should be derived from `package.json`, Module Federation metadata, workspace metadata, or CODEOWNERS. Do not duplicate them in the source manifest. If generated catalogs need that information later, tooling can merge it into generated output.

Generated outputs may include:

- JSON manifest catalog
- Markdown reference docs
- dependency graph
- import-boundary rules
- serializable metadata derived from public API client values
- serializable metadata derived from public component values

Generated outputs may contain import paths, export names, JSON keys, or documentation metadata if tooling needs them. Those are derived artifacts, not authored manifest fields.

## Activation And Dependencies

Dependencies belong in the manifest because they are part of module activation. The runtime can use them to prevent invalid activation and to offer safe activation bundles.

```ts
dependencies: {
  core: [
    "core.identity",
    "core.authz",
    "core.modules",
    "core.actions",
      "core.actions"
  ],
  modules: [
    {
      id: "documents.center",
      required: false,
      activation: "enable_together_when_available",
      reason:
        "Property resources can expose document-specific capabilities when documents.center is active."
    }
  ],
  externalSystems: []
}
```

Suggested module dependency activation modes:

| Mode | Meaning |
|---|---|
| `must_be_active_first` | The dependency must already be active before this module can activate. |
| `enable_together_when_available` | The runtime may suggest or perform bundled activation. |
| `optional_enhancement` | The module works without it, but exposes extra API/components when present. |
| `integration_required_for_api` | Only specific public API capabilities require the dependency. |

## Public API

The manifest should expose the module's public API surface. Other modules should use this API rather than importing private queries, tables, command handlers, or route loaders.

OntOS should use Effect HttpApi and Effect HttpClient for these contracts. The `HttpApi` definition is the source of endpoint truth; the manifest must not manually repeat endpoints, methods, paths, request schemas, or response schemas.

Effect's platform docs describe this as one API definition reused for serving, documentation, and deriving a fully typed client. OntOS should follow that pattern: the module creates an Effect `HttpApi` definition internally, derives a client from it, and puts the client value directly in the manifest.

```ts
api: {
  PropertyUnitClient
}
```

Rules:

- Public API client values in the manifest are part of the module's public surface.
- The module's `HttpApi` owns endpoint names, methods, paths, request schemas, response schemas, and errors.
- API schemas should be Effect Schema definitions inside the `HttpApi`, not ad hoc TypeScript types.
- Public clients should be derived from the module's `HttpApi`.
- Consumers should use the values exposed by the producer manifest, for example `PropertyRegistryManifest.publicSurface.api.PropertyUnitClient`.
- Authorization is enforced inside the API implementation through SpiceDB and the OntOS Policy Layer; the manifest does not publish a permission catalog for other modules.
- Other modules must not bypass the public API by importing module internals.

## Public Components

Components are public only when another module is expected to embed them. An invoice preview used while closing a contract is a good example.

As with public APIs, the authored manifest should reference real typed component values. It should not duplicate component names, import paths, prop types, or registry metadata by hand.

```ts
components: {
  InvoicePreview,
  InvoiceStatusBadge
}
```

Rules:

- Public components are real React component values referenced by the manifest.
- Props are inferred from the component type, for example `React.ComponentProps<typeof InvoicePreview>`.
- Add Effect Schema only when runtime validation or generated documentation truly needs it.
- Consumers should use the values exposed by the producer manifest, for example `BillingManifest.publicSurface.components.InvoicePreview`.
- Components must not depend on another module's private state or private imports.
- Internal UI components remain private and must not appear in the manifest.

Build-time enforcement should use the manifest as the allowlist. A consumer may use components exposed through the producer manifest; private component paths remain blocked.

## Routes And Navigation

Routes and navigation should not be public manifest surface by default.

The earlier reason to include them was application-shell discovery and activation visibility. With TanStack Router, that boundary is too noisy: route trees, loaders, layout nesting, and navigation composition are implementation details of the module and application shell.

Better rule:

- The module owns its routes internally.
- The app shell can discover high-level module activation state from the manifest.
- Cross-module reuse should happen through public APIs and public components, not by linking against internal routes.
- If a module needs a public deep link, expose a typed link builder or URL contract as part of `api` or `components`, not the whole route tree.

## Resource Types

Resource types are public because other modules can reference them by ResourceRef, search can expose them, authorization can protect them, and graph/timeline views can display them.

The manifest declares public resource semantics, not physical storage and not a central Core entity registry.

```ts
resourceTypes: [
  {
    key: "property.unit",
    label: "Unit / Space",
    kind: "business_resource",
    description:
      "Rentable, usable, bookable, or manageable physical object inside a property or building.",
    identity: {
      refShape: ["tenant_id", "module_key", "resource_type", "resource_id"]
    },
    capabilities: {
      searchable: true,
      linkable: true,
      timelineVisible: true,
      graphVisible: true,
      mediaAttachable: true
    }
  }
]
```

Storage strategy, table names, and column bindings are intentionally absent. They belong to implementation metadata, migrations, or generated internal catalogs, not to the public manifest.

Per-public-surface stability, such as `stable` or `experimental` API/component wrappers, may become useful later for build warnings and generated documentation. It is intentionally deferred from the V0 manifest until there is tooling that enforces it.

## Links And Relations

Relations are not part of the OntOS Module Manifest.

By design, OntOS links and relations are dynamic runtime/domain data. The system must be able to link resources as workflows evolve without forcing each module manifest to anticipate every possible relation in advance. Publishing relation types in module manifests would make the system too rigid and would leak domains into each other.

The manifest may expose resource types because other modules need stable addressable targets. It should not expose a static relation catalog.

Relation behavior belongs in:

- module-owned domain tables
- action/API implementations that create or interpret links
- ResourceRef-based projection/link tables where needed
- search/timeline/graph projection logic
- tests around workflows that rely on specific links

This keeps module public contracts focused on reusable surfaces while allowing relations to grow dynamically with the business.

## Authorization

SpiceDB owns authorization relationships and permission checks. The OntOS Policy Layer owns business conditions that are not pure relationship-based authorization.

The OntOS Module Manifest should not publish a permission catalog for other modules to depend on. Cross-module callers should depend on public APIs and public components; those surfaces enforce authorization internally.

The manifest may include lightweight `authz` notes for public APIs, components, resource types, search, or reports when useful for review and generated documentation, but these notes are descriptive. The source of truth for authorization remains the SpiceDB schema, tuple writes, policy implementation, and action/API enforcement tests.

## Events, Search, And Reports

Public events describe business facts that other modules or integrations may react to. Internal outbox messages and handler implementations are not public manifest surface.

```ts
events: [
  {
    key: "property.unit_created",
    tense: "past",
    description: "A unit resource was created.",
    payloadSchema: "PropertyUnitCreatedEvent",
    referencesResourceTypes: ["property.unit"],
    visibility: "public_module_event"
  }
],
search: [
  {
    key: "property.unit.search_result",
    resourceType: "property.unit",
    accessFiltering: "legal_entity_scope"
  }
],
reports: [
  {
    key: "property.unit.inventory",
    label: "Unit inventory",
    dimensions: ["legal_entity", "property", "lifecycle_state"],
    accessFiltering: "legal_entity_scope"
  }
]
```

Projection mechanics, indexing jobs, and report query implementation stay private.

## Enforcement

Manifest validation should check:

- Effect Schema validity
- stable module id format
- no manually-authored import/export path metadata for typed values
- dependency existence
- required Core dependencies
- referenced resource types exist
- public API client values exist
- public component values exist
- public events have payload schemas
- no private implementation fields are present

Build-time validation should additionally check import boundaries:

- Other modules may use only API/client/component values exposed through producer manifests.
- Private module paths are blocked.
- A consumer cannot import a public component unless it is exposed through the producer manifest.
- A consumer cannot call a public API unless the producing module declares it.
- Activation dependency checks can be generated from manifest dependencies.

## Open Questions

1. Should the manifest live beside each module as `manifest.ts`, with generated JSON under a central catalog?
2. Should Core system modules use the same Effect Schema shape or a smaller `system_module` variant?
3. Which dependency activation modes are enough for V0?
4. Should public deep links be modeled as API/link-builder exports, or should they stay entirely outside the manifest for V0?
