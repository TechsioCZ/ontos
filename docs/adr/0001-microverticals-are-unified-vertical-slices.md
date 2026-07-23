# ADR-0001: MicroVerticals are unified vertical slices

Status: Proposed

## Context

Earlier architecture wording separated “web app” and “BFF/API” as if frontend and backend were separate containers and MicroVerticals lived across that split. That does not match the intended UltraModern.js MicroVertical concept.

The project needs feature cohesion, fast development with coding agents, and one jointly deployable application for V0. Splitting every feature across separate frontend and backend architectural containers obscures the desired vertical ownership.

## Decision

An UltraModern.js MicroVertical is a unified vertical slice containing both frontend and backend concerns for a bounded capability. OntOS Business Modules normally use that implementation shape in V0, so a business module can own its UI, routes, components, state, actions, command handlers, domain code, migrations, tests, public resource descriptors, module-owned links, permissions, search/report descriptors, and projection descriptors.

MicroVerticals are deployed together in V0 as part of one OntOS Application Runtime. They are not independently deployed microservices.

## Consequences

The architecture should model one OntOS Application Runtime container rather than separate Web App and BFF containers at the conceptual C4 container level. Framework-specific internal routes or handlers may exist, but they are implementation details inside the unified runtime.

OntOS Module Manifests become central as the public contract layered on top of the MicroVertical implementation. Coding agents should generate MicroVerticals as cohesive slices, not as disconnected frontend/backend fragments.

## Risks

Vertical cohesion can become an excuse for duplicating shared logic. Core must provide system capabilities, and MicroVerticals must consume them rather than reimplement them.
