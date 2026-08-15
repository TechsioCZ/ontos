# OntOS Module Manifests

An OntOS Module Manifest is a validated business-capability contract. It is data, not an executable
plugin and not an UltraModern deployment inventory. V0 supports exactly one `business_module` per
MicroVertical deployment.

## Identity

- `appId` is the hyphenated UltraModern topology identity of a deployment. It remains the Module
  Federation remote identity, deployment lookup key, and exact Shell gateway JWT audience.
- `moduleId` is the stable dotted OntOS capability identity. It owns Actions, Policies, resources,
  events, Outbox producers and consumers, and `core.tenant_module_states.module_key`.
- These identities may happen to contain equal text, but their roles never become interchangeable.

For example, deployment `property-registry` may publish module `property.registry`.

## Four layers

1. Generated topology and an environment overlay enumerate known deployments and authorize one
   module-contract URL per topology vertical. A reachable service cannot add or install itself.
2. The owner-authored `vertical.manifest.ts` contains an Effect Schema-validated value referencing
   real typed Actions, Effect API values, Module Federation component values, payload Schemas, and
   plain public descriptors.
3. The owning build emits a deterministic versioned JSON deployment contract, including only safe
   semantic Shell contribution bindings. Shell fetches only
   allowlisted contracts and builds an immutable catalog indexed independently by `appId` and
   `moduleId`.
4. `vertical.registration.ts` binds private executable Actions, pages, components, APIs, search,
   reports, and workers for the owning process. Only safe descriptors may be projected into the
   deployment contract.

Tenant activation is separate from installation. Deployment and allowlist configuration install a
known capability; tenant module state decides whether that installed module is active for a tenant.

## Network and artifact contract

Every MicroVertical deployment serves the immutable document at
`/.well-known/ontos-module-manifest.json`. The document uses schema version `2`, media type
`application/json`, `Cache-Control: no-cache`, a strong build-marker ETag, and is limited to 1 MiB.
Shell loads it with a five-second deadline, redirect following disabled, and exact topology `appId`
matching. Contract URLs must use HTTPS except loopback HTTP during development. Credentials,
fragments, unsafe schemes, and duplicate normalized URLs are forbidden.

The document may describe identity, activation, public Actions/API/components,
resources, public events, search, reports, and schema-free Outbox subscriptions. It must never
contain a function, Effect program, React component, handler, Policy, migration, executable route
definition, repository, database metadata, source path, import/export specifier, fixture, test,
secret, or arbitrary private runtime value. The sole routing exception is the normalized
root-relative `routePath` on a governed Shell page contribution. It identifies that contribution's
canonical authenticated Shell location; it is not an owner route definition or remote source.

Shell contributions bind stable navigation/page, public-component, API-backed resource detail and
timeline, search, report, and media targets to descriptors already owned by the same manifest.
They may contain semantic keys, ordering, grouping metadata, and the page contribution's canonical
root-relative `routePath`, but never absolute URLs, import specifiers, remote strings, functions,
schemas, executable routes, or source paths. The Installed Module Catalog rejects the entire
snapshot when one binding is missing, duplicated, cross-owned, or role/access incompatible.

## Import and execution boundaries

Shell/Core and ordinary MicroVertical consumers must not statically import another deployment's
`vertical.manifest.ts`, `vertical.registration.ts`, or private source. Synchronous calls use the
provider's generated Effect BFF client, public components use generated Module Federation wrappers,
and asynchronous communication uses published schema-only Outbox contracts. Executable Actions,
Policies, workers, migrations, routes, repositories, search implementations, and report
implementations stay owner-local.

The installed catalog rejects unsupported schema versions, deployment/manifest identity mismatch,
duplicate app or module IDs, mismatched Outbox consumer ownership or entrypoints, and duplicate
worker keys. A failed load never creates or caches a partial catalog. A subscription may name a
producer that is not installed; it remains dormant until matching messages can exist.

Core capabilities are implicit universal infrastructure, not per-module requirements. External
system readiness and module-owned setup remain private implementation concerns and are not V0
activation gates. Every installed business module has an independent tenant lifecycle: any state
declared in its own `supportedStates` may be requested regardless of other modules' installation or
tenant state. Typed API, public event, and Outbox communication preserves deployment boundaries but
never creates installation, activation, deactivation, setup, or transition coupling.

## Generator order

After UltraModern creates a topology-backed vertical, run the module-contract Codesmith generator
before any business generator:

```bash
mise exec -- pnpm scaffold:module-contract -- --vertical property-registry --module property.registry
```

All later business generators read the generated module-ID marker and patch only explicit
generator-owned slots. They fail without a consistent package, topology entry, manifest, and private
registration.

Use the category generator before authoring each supported public artifact:

```bash
mise exec -- pnpm scaffold:microvertical-page -- --vertical property-registry --page overview [--url /custom/path]
mise exec -- pnpm scaffold:public-component -- --vertical property-registry --component unit-card
mise exec -- pnpm scaffold:module-api -- --vertical property-registry --api resource-api
mise exec -- pnpm scaffold:search-provider -- --vertical property-registry --provider unit-search
mise exec -- pnpm scaffold:report -- --vertical property-registry --report unit-inventory
```

The page name is a stable lower-kebab identity, while `--url` is an optional complete
root-relative canonical-path override. When `--url` is omitted, Codesmith derives
`/<microvertical>/<page>` from the validated MicroVertical slug. For example,
`--vertical crm --page customers` produces canonical `/crm/customers`; the locale-aware Shell
router exposes it as `/cs/crm/customers` or `/en/crm/customers`. Never include a locale prefix in
`--url`. A generated page is private and non-indexable, contains only its localized title, and is
loaded only after the authenticated Shell/Core gateway resolves that exact governed page
entrypoint. Private metadata alone is not an authentication mechanism.

An explicit page URL may mix lowercase kebab-case static segments with unique named parameter
segments such as `/crm/customers/:id/edit`. A parameter name starts with a lowercase letter and
continues with letters or digits. Optional, repeated, wildcard, catch-all, encoded, query, fragment,
origin, empty, dot, trailing-slash, and locale-prefixed forms are invalid. The serialized `routePath`
retains the canonical `:id` spelling as bounded plain data; Codesmith maps it deterministically to
the `[id]` filesystem segment used by both owner and Shell routers. Templates that differ only by a
parameter name at one position, and static/dynamic siblings, are routing collisions.

Dynamic page contributions remain in `pages`, component ownership, private registration, Module
Federation exposure, and the generated Shell lazy-client allowlist. They do not create ordinary
`navigation` contributions because a route template is not a usable destination. The manifest never
contains route values, loader functions, imports, private source paths, or executable matching code.

## Repository documentation follow-up

The repository-level `../docs/03_ARCHITECTURE_OVERVIEW.md`, `../docs/04_C4_MODEL.md`,
`../docs/05_MICROVERTICALS.md`, `../docs/14_ONTOS_MODULE_MANIFEST.md`, `../docs/CONTEXT.md`, and
proposed ADRs still describe a jointly deployed process or static registration catalog. Their
documentation owners must reconcile that older model separately; this app-local contract is the
authoritative implementation rule for independently deployed MicroVerticals.
