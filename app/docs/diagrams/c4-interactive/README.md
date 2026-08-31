# OntOS C4 architecture diagrams

These diagrams explain OntOS from the outside in. Start with Level 1 for the business view, then follow the levels for progressively more technical detail.

| Level | Audience and question | Interactive diagram | Archify source |
| --- | --- | --- | --- |
| C4 Level 1 — System context | Everyone: who uses OntOS, and which external systems surround it? | [Open diagram](./ontos-c4-l1-system-context.html) | [JSON](./ontos-c4-l1-system-context.architecture.json) |
| C4 Level 2 — Accepted target containers | Product and engineering: which applications, MicroVerticals, identity realms, stores, and integration boundaries form the accepted logical target? | [Open diagram](./ontos-c4-l2-containers.html) | [JSON](./ontos-c4-l2-containers.architecture.json) |
| C4 Level 3 — Core runtime components | Engineers and architects: how does the governed runtime enforce context, permissions, transactions, ownership, and delivery? | [Open diagram](./ontos-c4-l3-core-runtime.html) | [JSON](./ontos-c4-l3-core-runtime.architecture.json) |
| C4 Level 4 — Current Projects exemplar | Implementers: how does the develop-branch Projects MicroVertical connect UI, generated Effect clients, BFF endpoints, Actions/Reads, persistence, and ARES? | [Open diagram](./ontos-c4-l4-projects-code.html) | [JSON](./ontos-c4-l4-projects-code.architecture.json) |
| C4 Deployment — Current Zerops Stage | Engineering and operations: which Zerops services exist today, who owns them, and how do migration, authorization, and persistence connect? | [Open diagram](./ontos-c4-zerops-stage-deployment.html) | [JSON](./ontos-c4-zerops-stage-deployment.architecture.json) |

## Akros delivery module map

The [interactive Akros full module map](./akros-full-module-map.html) is an evidence-backed delivery DAG for ideation and sequencing. It expands foundational and business capabilities into individual modules and shows the dependency paths that can proceed in parallel toward a working B2C and B2B shop. It is intentionally more detailed than the C4 views and must not be read as a committed delivery plan or as evidence that every module is already implemented.

Portable exports are available as [light high-resolution PNG](./akros-full-module-map.light.high-res.png), [dark high-resolution PNG](./akros-full-module-map.dark.high-res.png), and [editable SVG](./akros-full-module-map.vector.svg). The maintainable Archify source is the matching [architecture JSON](./akros-full-module-map.architecture.json).

The map is grounded in the accepted Akros product and commerce boundaries in Wayrepo at revision `bfa07e91cb4ebc22a72f8a58525c562e4fab3d23`. Its interactive source links pin the evidence to that revision. Mobile readers can zoom the diagram to 200%, pan horizontally inside the map, and continue scrolling the page vertically.

## How to read them

- Solid relationships describe implemented or directly evidenced paths.
- Purple dashed relationships describe target or partial architecture. Their labels state the intended contract or integration.
- Orange dashed boundaries group an architectural responsibility or independently deployable unit; they are not evidence that everything inside is already implemented.
- The notes beneath each diagram separate plain-language meaning, implementation rules, and current-versus-target evidence.
- Use the diagram toolbar to switch theme, change visual mode, zoom, present, or export.

## Decision status

The C4 set is a truthful diagram of the **accepted logical target**, not a claim that every production placement decision is complete. Product boundaries, Application Compositions, independently deployable MicroVerticals, Core ownership, commerce channel boundaries, identity realms, Party Registry, data authority, and integration routing are accepted. Final physical production topology—tenant/service placement, regions, recovery, observability, cost, and the Akros launch shape—remains open in [Wayrepo #17](https://github.com/TSNheathen/wayrepo/issues/17).

The separate Zerops diagram is the current Stage evidence from `app/zerops.yaml`; it must not be read as the final production topology. The Level 4 Projects diagram is an implementation-pattern exemplar, not the final Commerce module design.

## Evidence and maintenance

The set was derived from the OntOS `develop` branch at commit `b07ec16fe7657f947f15724191caf3f09d13dfd7`. It reflects the repository state at that commit, including the documented target architecture where the implementation is not yet complete.

The cross-repository verification is recorded in [Architecture evidence audit](./architecture-evidence-audit-2026-08-30.md). It covers the complete issue inventories in `TechsioCZ/ontos` and `TSNheathen/wayrepo`, the accepted decision documents, and the Zerops Stage manifest.

The `*.architecture.json` files are the maintainable Archify specifications. The matching `*.html` files are self-contained interactive deliverables. When architecture changes, update the JSON source, validate it with Archify, regenerate the HTML, and review both light and dark renders before merging.
