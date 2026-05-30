# Agent brief for `/grill-with-docs`

You are reviewing the TERP architecture before implementation. Treat this as an architecture grilling session, not a documentation summarization task.

## Goal of the grilling session

The goal is to identify conceptual inconsistencies, missing definitions, invalid boundaries, overengineering, underengineering, performance risks, permission-model risks, migration risks, and delivery risks before the PoC and before the production V0 build.

The project will likely start with a throwaway PoC. The documents in this pack should help decide what the PoC must prove, what should be removed, and what must be nailed down before the June–December 2026 implementation window.

## Important correction to preserve

Do not model TERP as a separate Web App container and BFF/API container where MicroVerticals live only in one of them. That is not the intended MicroVertical concept.

A MicroVertical is a unified vertical slice inside a jointly deployable UltraModern.js application. It includes frontend and backend concerns together: UI, routes, components, state, actions, command handlers, domain code, migrations, tests, and metadata. Core services are outside ordinary business MicroVerticals and provide the platform capabilities that all MicroVerticals use.

A separate worker runtime may exist for outbox processing, projections, imports, exports, and scheduled work. That does not make each MicroVertical a microservice. In V0 the system is a modular monolith/modulith.

## Constraints to respect

- Team capacity is roughly two FTE developers from June 2026, a partial product/UX/UI role, and heavy use of coding agents.
- Product AI is not part of V0 delivery. AI may be heavily used in development, but user-facing AI, autonomous agents, process autodiscovery, and vibemodule are later capabilities.
- The V0 must satisfy the 2026 ERP delivery obligation, including short-term rental, long-term rental, billing, accounting workflow/export, documents, roles/permissions, audit, reporting, and multi-company foundations.
- Internal dogfooding should begin early with clients, projects, tickets, documents, and invoice drafts.
- The current intended stack is UltraModern.js + MicroVerticals, existing design system, Postgres, Neo4j, SpiceDB, and BetterAuth.
- Neo4j should be challenged as a projection/read model, not assumed as the canonical transactional ERP store.
- SpiceDB should be challenged as the authorization graph, not the company ontology graph.
- Postgres should be challenged as canonical operational truth, but any alternative must explain billing, audit, exports, migrations, and committed delivery.

## What to grill first

1. Are MicroVertical boundaries defined precisely enough to implement and enforce?
2. Does the architecture correctly separate Core from MicroVerticals?
3. Is the action/command-driven state model sufficiently concrete?
4. Does the outbox/projection model avoid sync subscriber chaos?
5. Is the entity registry model a good compromise between explicit domain tables and global ontology?
6. Is the authorization model realistic for V0, especially SpiceDB consistency and search filtering?
7. Is Neo4j introduced at the right layer, or is it premature?
8. Does the V0 scope fit a two-developer team with coding agents?
9. Which parts should be cut from the PoC?
10. Which decisions must be converted into implementation tests or benchmarks?

## Expected output from the grilling agent

Produce a structured critique with: confirmed decisions, contested decisions, underdefined terms, risks, missing ADRs, proposed PoC experiments, and a revised implementation sequence. Avoid rewriting the architecture unless a decision is clearly invalid.
