---
status: proposed
---

# ADR-0032: One CoreSDK for Platform and Tenant Modules

Proposed. It records the decisions the Product Owner has made so far in the CoreSDK design interview
and the outcome of a four-model design council. The interview is still open; this ADR gains decisions
as they are made and is accepted only when the Product Owner confirms the complete design.

## Context

OntOS modules are written in several styles. A neutral kernel exists
(`@app/core-runtime/sdk`: `call` and `transaction`), but only governed reads use it; Actions and
Outbox Workers use earlier forms. A module states one fact in several generated files, and a module
has no way to declare an inbound endpoint, a schedule, or an external connector, so those live in the
Shell or as private loops.

Two requirements now shape the boundary. Modules will be delivered through Module Federation for both
browser and server code. Tenants will later author their own modules, mostly through the Vibe Module,
and those modules must be created, versioned, reverted, and deleted without a product release.

## Decision

1. **One CoreSDK.** Platform Modules and Tenant Modules are authored against the same CoreSDK, the
   same kernel (`call`, `transaction`), and the same Module Definition. Actions and Outbox Workers
   move onto the kernel, and the earlier authoring forms are removed as their callers migrate. A
   Tenant Module differs from a Platform Module in what it is granted, never in how it is written.
2. **Simplicity comes from Module Blueprints, not from a second SDK.** Codesmith stays. A blueprint
   generates ordinary CoreSDK code once, deterministically, and proposes structure and semantics. The
   manifest, registration, public contracts, and Module Federation exposes are derived from the Module
   Definition; they are not separately maintained sources.
3. **A closed vocabulary.** A Module declares only what the CoreSDK vocabulary names: what it
   publishes (Resources, Actions, reads, events, interface contributions, search) and what it needs.
   Any Module may call another Module's public operations and embed its public interface
   contributions through the same contracts. Adding a vocabulary item is a Core change.
4. **Modules are not confined to Core for I/O.** A Module may own a datastore other than the shared
   PostgreSQL service and may call external services directly, so Core is not the path for all load.
   The CoreSDK and its enforcement make every such dependency declared; none is ambient.
5. **Enforce on types, with Effect.** The CoreSDK reuses Effect Schema, Layer, requirements, and typed
   errors so that a Module that violates its own declarations does not compile.
6. **Platform Modules are closed to per-Tenant modification.** A Tenant builds a Tenant Module on a
   Platform Module's public contract or uses a Module Replacement. Both paths are supported.
7. **Tenant Module code runs in its own isolated runtime per Module**, separate from Core, Shell, and
   other Modules. That runtime is the unit a Tenant is charged for.
8. **Module code is runtime-neutral.** The CoreSDK does not assume Node.js. Node.js, Bun, and
   Cloudflare Workers are intended targets, with Module Federation for browser and server code.
9. **One Business Module remains one MicroVertical** ([ADR-0016](0016-independently-deployable-microverticals.md)),
   and every Module publishes its Resources under the one ResourceRef
   ([ADR-0006](0006-explicit-domain-tables-plus-resource-ref.md)).
10. **The staff Shell is the first interface host.** Channel Applications are out of scope for the
    first CoreSDK version.

## Considered options

The council (GPT-6.2 Astra, GPT-6.1 Sol, Claude Opus 5.5, Claude Fable 5.2) chose the accepted option
unanimously.

1. **One SDK whose customer tier is only a smaller grant.** Rejected as the whole answer: it
   standardizes primitives but leaves every pattern choice to each author, which is where
   AI-authored modules diverge.
2. **A separate, restricted customer SDK.** Rejected: two contracts drift, a Tenant Module cannot
   graduate into a Platform Module without a rewrite, and composition stops being symmetric.
3. **Declarative-first modules interpreted by Core.** Rejected: the interpreter becomes the limit of
   what a module can do, and it puts module behavior inside Core, against the isolated-runtime
   decision.
4. **One kernel with layered authoring through Module Blueprints.** Accepted.

## Consequences

- What crosses a runtime boundary is a serialized contract (operation schemas, typed outcomes,
  ResourceRefs, events, interface contribution contracts). Live Effect values, Layers, and
  transactions never cross it, so the Effect version is not part of the module contract.
- Types prove that a Module's wiring matches its declarations. They do not confine code that ignores
  the CoreSDK. Confinement of a Tenant Module is the job of its isolated runtime.
- [ADR-0020](0020-governed-application-composition.md) treats every module as first-party code in one
  browser realm, adds no further trust tier, and rejects Tenant-pinned versions. Tenant Modules need
  a superseding decision on each of those points before they ship.
- [ADR-0007](0007-no-product-ai-in-v0.md) keeps the Vibe Module out of V0. This ADR does not change
  that; it makes the CoreSDK ready for it.
