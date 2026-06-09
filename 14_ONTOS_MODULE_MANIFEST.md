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
| Vertical Runtime Registration | Private per-MicroVertical runtime registration that binds the public manifest to private installed-module hooks such as routes, navigation, handlers, migrations, workers, search, and reports. |
| Installed Vertical Registry | Shell/Core-owned internal registry of installed Vertical Runtime Registrations. |

Avoid saying "MicroVertical Manifest" unless talking loosely. The precise term is "OntOS Module Manifest".

Use dotted identifiers for domain/runtime keys and hyphenated names for filesystem folders. For example, the module id remains `property.registry`, action keys start with `property.registry.*`, and `CORE_TENANT_MODULE_STATES.module_key` stores `property.registry`; the MicroVertical folder should be `verticals/property-registry`.

## Scope

The manifest exposes only the public surface that other modules, Core, tooling, activation logic, and generated clients may depend on.

It should include:

- module identity
- activation behavior
- module dependencies
- public Action descriptors
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

## Runtime Registration

The Shell and Core discover runnable installed modules from the private Installed Vertical Registry, not from public manifests alone.

Each MicroVertical should keep two paired contract files at the vertical root:

```text
verticals/property-registry/
  vertical.manifest.ts
  vertical.registration.ts
```

`vertical.manifest.ts` contains the public OntOS Module Manifest. `vertical.registration.ts` contains the private Vertical Runtime Registration that binds the public manifest to private hooks needed by the installed application runtime. The MicroVertical owns its route subtree, pages, and components; Shell composes registered route and navigation contributions, applies shared layout, and filters visibility through activation/module-state rules.

```ts
export const propertyRegistryRegistration =
  defineVerticalRuntimeRegistration({
    manifest: propertyRegistryManifest,
    shell: {
      nav: {
        label: "Property Registry",
        path: "/property"
      },
      routes: [PropertyRegistryRoute]
    },
    actions: {
      [createUnitAction.key]: createUnitHandler
    },
    migrations: [],
    handlers: {},
    search: [],
    reports: []
  })
```

The public manifest remains the public contract. The runtime registration is an internal wiring surface for Shell/Core only. Other MicroVerticals should depend on public Action/API/client/component values exposed through manifests, not on another module's runtime registration.

For the MVP, the Installed Vertical Registry can be a statically imported list owned by the Shell/Core, named `installed.registry.ts`:

```text
apps/shell/src/verticals/installed.registry.ts
```

This is an explicit installed-module allowlist, not a runtime plugin marketplace.

Day 1/2 should represent tenant module state with a fixture that mirrors `CORE_TENANT_MODULE_STATES`. Both MVP MicroVerticals, `property.registry` and `accounting.core`, should be `active` for the demo tenant until persistent module state is implemented. Normal Shell navigation should include `active`, `read_only`, and `deprecated` modules and hide `inactive`, `suspended`, `quarantined`, and `archived` modules. Each MVP MicroVertical route should visibly show its module id, filesystem folder name, tenant module state, and that the route/page is rendered by the owning MicroVertical.

## Authoring Model

The source artifact should be a typed module manifest, not a loose JSON file.

The manifest should rely on inference wherever TypeScript, Effect Schema, React types, or Effect HttpApi can already provide the information. Do not hand-author static strings for things the compiler can know, such as import paths, export names, component prop types, API endpoint definitions, client shapes, or runtime value identities.

String keys are acceptable only when they are stable business/runtime identifiers, such as module ids, dependency ids, resource type keys, event keys, search descriptor keys, and report keys. They should not be used as a substitute for typed values.

```ts
import { defineOntosModuleManifest } from "@ontos/core/module-manifest"
import { createUnitAction } from "./src/actions/create-unit.action"
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
    actions: [
      createUnitAction
    ],
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
- serializable metadata derived from public Action descriptors
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

## Actions

Actions are first-class public descriptors in the manifest, but they should not be authored inline inside `vertical.manifest.ts`.

Each action should live in its own public descriptor file and use Effect Schema-backed runtime values:

```text
verticals/property-registry/
  vertical.manifest.ts
  vertical.registration.ts
  src/actions/
    create-unit.action.ts
    create-unit.handler.ts
```

```ts
import { Schema } from "effect"
import { defineVerticalAction } from "@ontos/core/actions"

export const CreateUnitRequest = Schema.Struct({
  legalEntityId: Schema.UUID,
  displayName: Schema.NonEmptyString
})

export const CreateUnitResponse = Schema.Struct({
  unitRef: ResourceRefSchema
})

export const createUnitAction = defineVerticalAction({
  key: "property.registry.createUnit",
  request: CreateUnitRequest,
  response: CreateUnitResponse,
  idempotency: "required",
  authz: {
    permission: "property.registry.unit.create"
  },
  audit: {
    profile: "standard"
  },
  moduleState: {
    writesRequire: "active"
  }
})
```

Rules:

- Action descriptors are public runtime values, not type-only TypeScript interfaces.
- Request and response contracts should be Effect Schema values so Core can validate at runtime and infer TypeScript types.
- Action keys are stable runtime identifiers and should include the module key, for example `property.registry.createUnit`.
- Action descriptors belong in `src/actions/*.action.ts` and are imported into `vertical.manifest.ts`.
- Action handlers belong in private `src/actions/*.handler.ts` files and are wired only through `vertical.registration.ts`.
- Handlers should return `Effect.Effect<Success, DomainError, Requirements>` rather than raw promises where practical, so required services and typed errors remain visible.
- Handler dependencies should be provided through Effect `Context`/`Layer` services such as repositories, clocks, transaction context, authorization adapters, or policy services.
- If an Action is also exposed over HTTP, Effect `HttpApi` can reuse the same schemas/descriptors, but HTTP transport is not the source of truth for the Action.

Day 1/2 should include placeholder Action descriptors so the manifest and registration shape is proven before the Core action runtime exists. `property.registry` should declare `property.registry.createUnit` because Day 3 will run that Action through Core. `accounting.core` should declare a placeholder such as `accounting.core.createDraftEntry` to prove a second module can expose an Action descriptor. These descriptors should be wired to stub handlers or explicit not-implemented handlers in `vertical.registration.ts`; no real ERP behavior should be implemented on Day 1/2.

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

For Day 1/2, each MVP MicroVertical should expose one placeholder public component descriptor so the manifest can verify component allowlisting:

- `property.registry`: `PropertyUnitCard`.
- `accounting.core`: `AccountingDraftEntryCard`.

These components should be inert boundary-verification components, not production product UI.

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

For Day 1/2, expose enough placeholder public resource descriptors to verify the manifest thesis for both MVP MicroVerticals:

- `property.registry` should expose `property.unit`.
- `accounting.core` should expose `accounting.draft_entry`.

These are descriptor placeholders only. They prove ResourceRef/search/report descriptor shape; they do not imply real property or accounting workflow implementation.

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

For Day 1/2, each MVP MicroVertical should also expose placeholder search and report descriptors so the public manifest can be validated across more than one surface:

- `property.registry`: `property.unit.search_result` and `property.unit.inventory`.
- `accounting.core`: `accounting.draft_entry.search_result` and `accounting.draft_entry.summary`.

These descriptors should have no production query implementation beyond stubs in `vertical.registration.ts`.

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

Package exports and import rules should separate public and private vertical surfaces:

- Other MicroVerticals may import public manifest values, Action descriptors, public API clients, public component values, and public resource/event/search/report descriptors.
- Shell/Core may import `vertical.registration.ts` for the Installed Vertical Registry.
- Ordinary MicroVertical consumers must not import `vertical.registration.ts`.
- No consumer should import private handlers, private routes, private tables, private migrations, fixtures, or tests from another MicroVertical.
- Generated package exports should expose public surfaces such as `./vertical.manifest` and selected public descriptors, while keeping `./vertical.registration` unavailable except through the Shell/Core allowlist.

The MVP should expose one stable command for these checks: `pnpm check:boundaries`. If UltraModern generates a boundary checker, `check:boundaries` should call that generated checker and add any OntOS-specific rules that are not covered. If the generated scaffold has no suitable checker, `check:boundaries` can be a small import-scanning script. In either case, `pnpm check` should run `check:boundaries`.

Build-time validation should additionally check import boundaries:

- Other modules may use only Action/API/client/component/resource values exposed through producer manifests.
- Private module paths are blocked.
- A consumer cannot import a public component unless it is exposed through the producer manifest.
- A consumer cannot call a public API unless the producing module declares it.
- A consumer cannot invoke an Action unless the producing module declares it.
- Only Shell/Core may import vertical runtime registrations.
- Activation dependency checks can be generated from manifest dependencies.

## Open Questions

1. Should Core system modules use the same Effect Schema shape or a smaller `system_module` variant?
2. Which dependency activation modes are enough for V0?
3. Should public deep links be modeled as API/link-builder exports, or should they stay entirely outside the manifest for V0?
