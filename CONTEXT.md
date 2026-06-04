# OntOS

OntOS is a delivery-bound property/rental ERP with strong platform foundations. This file is shared vocabulary, not an implementation specification; terms are working language until validated with product leads and customer discovery.

## Language

**OntOS**:
The system being built. In V0 it is a property/rental ERP with platform-shaped foundations; in the long-term vision it can grow into a temporal company ontology system.
_Avoid_: TERP

**OntOS V0**:
The first production delivery of OntOS. It prioritizes concrete ERP workflows for multi-company property/rental operations, billing, accounting handoff, documents, permissions, audit, and reporting.
_Avoid_: Platform-first release, ontology-first release

**Strong Foundations**:
The small set of architectural invariants that prevent expensive rework: registered Actions for writes, tenant/legal-entity isolation, separated authentication/authorization/business policy, ResourceRef-based cross-module references, audit and outbox in the write path, and manifest-declared public module boundaries.
_Avoid_: Polished Forge, vibemodule primitives, exhaustive ontology metadata, rich graph UX, generic workflow engine, generalized plugin loading, full future AI readiness

**UltraModern.js MicroVertical**:
The framework-level vertical slice concept in the UltraModern.js fork. It organizes frontend and backend behavior together inside the jointly deployable application. By itself, it does not define an OntOS manifest.
_Avoid_: OntOS-specific manifest, standalone microservice, frontend-only module

**OntOS Business Module**:
A product/business capability in OntOS, usually implemented as an UltraModern.js MicroVertical in V0. It exposes a public OntOS Module Manifest so Core, activation logic, tooling, and other modules can reason about its public contract.
_Avoid_: Generic plugin, deployment unit, raw framework module

**Foundational Module**:
An OntOS Business Module that models shared business reality used by multiple other modules, but is not part of the Core Kernel. A Foundational Module may be active for most tenants and required by other modules, but it remains outside Core because it owns domain concepts that can evolve with customer discovery.
_Avoid_: Core module, System Module, platform service, ordinary vertical, always-on kernel

**Organization Registry**:
The Foundational Module that models shared organizational business structure such as legal-entity groups, holdings, portfolios, acquisition batches, and similar views over managed Legal Entities. In V0 it is a group/view model, not a corporate ownership or control ledger; Core only owns the minimal Legal Entity boundary needed for context, audit, and isolation.
_Avoid_: Core organization model, company registry, legal-entity registry, holding registry, ownership ledger

**OntOS Module Manifest**:
The OntOS-specific Effect Schema-defined public contract for an OntOS Business Module, Foundational Module, or selected System Module. It declares public identity, activation, dependencies, APIs, components, public resource types, public events, search, and reports. It should rely on TypeScript/Effect/React inference wherever possible, using real typed values instead of manually-authored import/export strings. It does not publish a permission model or a static relation catalog; authorization is owned by SpiceDB, the OntOS Policy Layer, and API/action enforcement, while relations are dynamic runtime/domain data. It must not declare private implementation details such as database tables, migrations, command handler paths, outbox handler paths, route trees, navigation wiring, fixtures, or tests.
_Avoid_: MicroVertical Manifest, database schema, implementation manifest, stringly typed import/export metadata

**Principal**:
An actor that can authenticate, invoke actions, or appear in audit and authorization. A Principal may represent internal staff, external manager staff, accountants, guests with portal access, integrations, service accounts, agents, or the system itself.
_Avoid_: User, employee, contact

**Principal Auth Binding**:
The Core-owned mapping from a stable externally authenticated subject to an OntOS Principal. BetterAuth owns users, sessions, API keys, key verification, and impersonation sessions; Core only stores the non-secret binding needed to resolve the effective Principal for actions, audit, and SpiceDB subjects. System jobs use system/service Principals without pretending to be external auth bindings.
_Avoid_: Credential store, API key table, session table, runtime credential reference, user profile

**Evidence Artifact**:
A durable file, export, generated document, import source, signed document, or compliance bundle retained as proof for audit, compliance, or later investigation. An Evidence Artifact is the content being retained, not the index entry that makes it discoverable.
_Avoid_: Raw payload, trace, log line, media attachment by default

**Evidence Registry**:
The Core vocabulary for durable audit and compliance evidence references. It records that an Evidence Artifact exists, what business subject or runtime event it substantiates, and which retention, classification, and legal-hold rules apply; it is not a financial ledger, payload archive, or observability trace store.
_Avoid_: PG ledger, Postgres ledger, double-entry ledger, payload store, artifact storage

**Party**:
A real-world person or organization OntOS deals with. A Party may be a guest, tenant, supplier, accountant office, external management company, owned company, contact person, or commercial counterparty.
_Avoid_: Account, user, legal entity

**Legal Entity**:
A managed accounting or operating company inside an OntOS tenant. Legal entities may own, operate, bill, report, or account for parts of the business, but external organizations are modeled as Parties unless the tenant manages them as part of its own operating structure.
_Avoid_: Every company, external manager, counterparty

**Counterparty**:
A Party in a commercial or contractual relationship with a managed Legal Entity. Counterparties can include tenants, guests, suppliers, external managers, corporate buyers, wholesalers, or accounting offices.
_Avoid_: Legal entity, principal

**External Operator**:
A Party outside the tenant's managed legal-entity structure that receives scoped operational access, such as an external property manager or external accountant.
_Avoid_: Owned legal entity, tenant member by default

**SpiceDB Authorization Graph**:
The external relationship-based authorization system OntOS uses for permission decisions. It is a strong foundation because custom authorization logic spread through application code creates too many failure points.
_Avoid_: Hand-rolled authorization graph, business ontology graph

**V0 SpiceDB Model**:
The working minimum authorization model for OntOS V0. It likely covers tenant membership, legal-entity roles, module access, admin/support powers, accounting/export powers, and explicit grants to sensitive resources; it should not mirror every business relation.
_Avoid_: Full business ontology mirror, per-record tuple for every ordinary entity

**Neo4j Projection**:
An optional graph projection of module-owned resources, selected ResourceRefs, and domain-specific relationships. It may become necessary for graph traversal, impact analysis, visual exploration, or future semantic context, but OntOS V0 must not depend on Neo4j for canonical ERP operations or permission decisions.
_Avoid_: Canonical graph store, mandatory V0 dependency, authorization graph

**Property Registry**:
The candidate first customer-domain MicroVertical. It describes the property structure that later rental, billing, facility, document, search, and reporting workflows depend on.
_Avoid_: Generic asset database, dogfood-first slice

**Property Registry Boundary**:
The working scope line around `property.registry`. It likely describes stable physical/legal property structure, including properties or property complexes, buildings, units/spaces, legal-entity association, management assignments, unit/space state, basic technical metadata, equipment/labels, and links to documents or service tickets; rental, billing, facility, accounting, pricing, and reporting workflows probably belong elsewhere.
_Avoid_: Property super-module, lease owner, reservation owner, invoice owner

**Property Complex**:
A candidate term for a property structure that may contain multiple buildings and dynamic units or spaces, such as a shopping center, hotel campus, or mixed-use asset.
_Avoid_: Fake single building, vague property bucket

**Unit/Space**:
A candidate term for the rentable, usable, bookable, or manageable physical object inside a property or building. A Unit/Space may be stable, split, merged, suspended, or archived over time.
_Avoid_: Room only, apartment only

**Capacity Allocation Contract**:
A candidate future commercial-rights term where a Counterparty receives rights to a portion of capacity for a period, such as reserving part of a hotel for later resale to real guests. This is vocabulary for discussion, not V0 scope.
_Avoid_: V0 default reservation model, physical property structure

**Physical, Commercial, And Access Separation**:
The working distinction that physical structure, commercial rights, and access rights are different relationships. This language helps discuss edge cases without deciding the final module split.
_Avoid_: Ownership as access, management as ownership, reservation as physical structure

**Ownership Assignment**:
A candidate term for the relation stating which Legal Entity owns a property, property complex, building, or unit/space for a period.
_Avoid_: Permanent owner field, access grant

**Management Assignment**:
A candidate term for the relation stating which Party or External Operator manages a property, property complex, building, or unit/space for a period.
_Avoid_: Ownership, tenant membership, access grant by itself

## Flagged Ambiguities

**Example provenance**:
Examples used during architecture discussion are hypothetical unless explicitly tied to customer discovery notes. Do not treat stress-test examples as client-owned assets, committed scope, or delivery evidence.

**Property structure vocabulary**:
`Property`, `Property Complex`, `Building`, and `Unit/Space` are working terms. They need validation against real customer examples before they become implementation concepts.

**External actor vocabulary**:
`Party`, `Counterparty`, `External Operator`, and `Principal` are working terms for separating real-world people/organizations from authenticated actors. The customer access model must validate whether these names match business language.

**Commercial rights vocabulary**:
`Capacity Allocation Contract` is a discussion term for B2B inventory/capacity rights. It is intentionally not a V0 workflow decision.

## Example Dialogue

Developer: "Should we delay billing to finish the ontology layer?"
Domain expert: "No. OntOS V0 must deliver the ERP workflow first. The foundation should be strong enough that billing, documents, permissions, audit, and future modules do not fight the architecture later."

Developer: "Does strong foundation mean we need a full module generator before the first rental workflow?"
Domain expert: "No. Strong foundations mean the invariants are enforced early. A polished generator can wait."

Developer: "Can we skip SpiceDB and write permission checks ourselves?"
Domain expert: "No. Authorization is too easy to get wrong across tenants, legal entities, modules, and sensitive records. SpiceDB is a foundation-level dependency."

Developer: "Should every reservation, invoice, document, and relation edge become a SpiceDB tuple?"
Domain expert: "No. SpiceDB owns coarse security-critical access. Ordinary record access should mostly come from tenant, legal entity, module scope, and explicit sensitive-resource grants."

Developer: "Does every V0 relation need to be projected into Neo4j?"
Domain expert: "No. Module-owned resources and selected ResourceRef/domain links remain canonical in Postgres. Neo4j can be added when graph queries justify it."

Developer: "Should the first real MicroVertical be internal dogfooding?"
Domain expert: "No. Start with Property Registry because it is the customer-domain dependency root. Add internal dogfooding once the rails are proven."

Developer: "A unit has a lease, reservation, service ticket, media attachment, and invoice. Which module owns the unit?"
Domain expert: "Property Registry owns the unit. The lease, reservation, service ticket, media attachment, and invoice are separate resources linked to it through ResourceRefs or module-owned link tables."

Developer: "Can an external property manager use OntOS without being one of our legal entities?"
Domain expert: "Yes. The manager is a Party or External Operator. Their staff are Principals with SpiceDB access scoped to the properties, buildings, units, documents, and workflows they manage."

Developer: "Do we need hotel capacity allocation contracts in V0?"
Domain expert: "No, unless the customer has that workflow. V0 should support external managers and guests now, but capacity allocation contracts stay a future commercial-rights pattern."

Developer: "A property changed managers in July. Should old tickets still show the old manager?"
Domain expert: "Yes. Ownership and management assignments are temporal from day one, with simple validity intervals and audit metadata."

Developer: "Is the Evidence Registry a PostgreSQL ledger or a double-entry accounting ledger?"
Domain expert: "No. Evidence Registry is the vocabulary for audit and compliance evidence references. Financial ledgers belong to billing/accounting; observability traces belong to observability tooling; raw artifacts belong to storage."
