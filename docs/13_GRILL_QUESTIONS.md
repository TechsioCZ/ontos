# Grill questions

This document is intentionally adversarial. Use it to challenge the architecture before implementation.

## MicroVertical semantics

1. Is the definition of MicroVertical precise enough to implement consistently?
2. Which files/artifacts must every MicroVertical have before it is considered valid?
3. How do we prevent a MicroVertical from importing another MicroVertical’s internals?
4. How does a MicroVertical contribute UI without becoming a runtime plugin system too early?
5. How does a MicroVertical contribute backend actions while preserving centralized authz, audit, and outbox rules?
6. Is “one deployable app with unified vertical slices” compatible with the UltraModern.js implementation model?
7. What does module activation mean if the code is already deployed?
8. What exactly happens when a module is suspended or quarantined?

## OntOS Module Manifest

1. Which manifest fields are required for the PoC, and which can wait until production V0?
2. Is Effect Schema the right authoring and validation format, with JSON emitted only as a generated catalog artifact?
3. Is the manifest still too broad, or does it now correctly include only public contract: activation, dependencies, APIs, components, public resource types, public events, search, and reports?
4. Which manifest sections should be runtime-enforced versus documentation-only?
5. How do we prevent manifest declarations from drifting away from implementation code?
6. Should Core system modules use the same manifest shape as business modules or a narrower variant?
7. How should manifest validation enforce dependency rules and prevent private imports across MicroVertical boundaries?
8. How should public component imports and Effect HttpApi clients be enforced at build time?
9. Where are string identifiers genuinely part of the business contract, and where should typed inference replace them?
10. What is the minimum Forge-generated manifest skeleton that makes coding-agent output safer?

## Core boundaries

1. Which capabilities are truly Core and cannot be moved into a MicroVertical?
2. Where is the boundary between Core media assets/links and the `documents.center` business module?
3. Is billing base Core or a business module?
4. Where should shared CRM/contact primitives live?
5. How do we keep Core from becoming a dumping ground?

## Consistency and events

1. Are there any state changes that currently bypass registered Actions?
2. Which side effects must be outbox-driven from day one?
3. Which projections are allowed to lag?
4. Which operations require immediate consistency?
5. What is the minimal outbox implementation that is safe enough for V0?
6. What metrics prove that event/outbox processing is not becoming a bottleneck?

## ResourceRef model

1. What exact criteria make something a public resource?
2. Which V0 objects are public resources vs child rows?
3. Does every public resource require a detail page, or only addressability?
4. How are `module_key`, `resource_type`, and `resource_id` stabilized?
5. Which cross-module references need validation by the owning module?
6. Which relationships deserve module-owned tables instead of generic ResourceRef links?
7. How do we prevent generic `relates_to` links from destroying semantic value?

## Authorization

1. Is SpiceDB appropriate for V0 or too heavy for the team?
2. What is the minimum SpiceDB schema that proves value without modeling every business relation?
3. Which permissions are handled by SpiceDB vs OntOS Policy Layer?
4. How is search permission filtering implemented without one SpiceDB call per result?
5. What is the fail-closed behavior when SpiceDB is unavailable?
6. How are role changes audited?

## Data stores

1. Is Neo4j necessary in the PoC, or should it be introduced after ResourceRef/domain link semantics stabilize?
2. What will be the first graph query that justifies Neo4j?
3. How do we rebuild Neo4j from Postgres?
4. What data must never be projected into Neo4j?
5. Is Postgres full-text enough for V0 search?

## Delivery realism

1. Does the June–December roadmap fit two FTE developers plus agents?
2. Which V0 feature is most likely to break the schedule?
3. What can be cut while still satisfying committed delivery?
4. What is the minimum useful accounting workflow/export?
5. What is the minimum useful short-term reservation module?
6. What is the minimum useful long-term rental module?
7. How early can internal dogfooding start without distracting from customer scope?

## PoC acceptance

1. What must the May PoC prove before we accept the stack?
2. What PoC result would cause us to drop Neo4j from V0?
3. What PoC result would cause us to drop SpiceDB from V0?
4. What PoC result would show that MicroVertical cohesion is not working?
5. What PoC result would show that coding agents need stricter scaffolding?
