# OntOS

OntOS is the product that contains Core, its Shell and operational runtimes, and reusable Foundational and Business Modules. Property/rental ERP and commerce are Application Compositions of those capabilities. This file is shared vocabulary, not an implementation specification; terms are working language until validated with product leads and customer discovery.

## Language

**OntOS**:
The encompassing modular business product being built. Core is its internal kernel; business capabilities live in OntOS Foundational and Business Modules and are assembled into Application Compositions. Property/rental ERP is an OntOS composition, and Commerce is the reusable composition first configured for Akros and then N1.
_Avoid_: TERP, Core product, separate Akros product

**OntOS V0**:
The preparation phase for OntOS: Core implementation, architecture, ADRs, documentation, PoC work, module contracts, schema contracts, and delivery controls.
_Avoid_: First production ERP delivery, customer ERP release, platform-only product release

**OntOS V1**:
The first mandatory production ERP delivery of OntOS, targeted for the end of 2026. It prioritizes concrete ERP workflows for multi-company property/rental operations, billing, accounting handoff, documents, permissions, audit, and reporting.
_Avoid_: V0, architecture-only release, ontology-first release

**Strong Foundations**:
The small set of architectural invariants that prevent expensive rework: registered Actions for writes, tenant/legal-entity isolation, separated authentication/authorization/business policy, ResourceRef-based cross-module references, audit and outbox in the write path, and manifest-declared public module boundaries.
_Avoid_: Polished Forge, vibemodule primitives, exhaustive ontology metadata, rich graph UX, generic workflow engine, generalized plugin loading, full future AI readiness

**CoreSDK**:
The server-side OntOS boundary through which public writes and governed reads pass so Core can apply shared context, authorization, policy, evidence, transaction, event, and outbox semantics.
_Avoid_: Direct handler path, BFF business layer, MicroVertical-owned runtime boundary

**Module State Gate**:
The Core-owned runtime gate that evaluates a tenant's OntOS Business Module state before SpiceDB authorization and the OntOS Policy Layer. It is not relationship authorization and not business policy; it decides whether a module is currently loadable, readable, or writable for that tenant.
_Avoid_: Module permission, SpiceDB module permission, feature flag, package check by itself

**Module Entrypoint**:
A governed crossing from Shell/Core into an OntOS Business Module, such as page loading, public component loading, Action execution, or worker dispatch. All module entrypoints must be invoked through Shell/Core gateways. Direct entrypoint loading is forbidden.
_Avoid_: Direct module load, private handler import, bypassed route/component/action/worker

**Structured Entrypoint**:
A Shell/Core-owned description of a Module Entrypoint using module identity and entrypoint role rather than an ad hoc import path, raw remote specifier, or private handler reference.
_Avoid_: Raw remote specifier, stringly typed entrypoint, direct import path

**Core Modules Capability**:
The Core-owned capability for listing and changing tenant module states. It is always available to the Module State Gate so administrators cannot lock themselves out of module-state recovery, but SpiceDB authorization and policy still decide who can view or change module states.
_Avoid_: Ordinary business module, customer vertical, unguarded admin bypass

**UltraModern.js MicroVertical**:
The framework-level full-stack vertical slice concept in the UltraModern.js fork. It keeps one capability's frontend and backend behavior together behind a strict independently deployable seam. Co-location is permitted, but changing placement must not change consuming business logic. By itself, a MicroVertical does not define an OntOS manifest or become a separate product.
_Avoid_: OntOS-specific manifest, product, frontend-only module, modular monolith, jointly deployable application, mandatory co-location

**OntOS Business Module**:
A product/business capability in OntOS, usually implemented as an UltraModern.js MicroVertical in V0. It exposes a public OntOS Module Manifest so Core, activation logic, tooling, and other modules can reason about its public contract.
_Avoid_: Generic plugin, deployment unit, raw framework module

**Foundational Module**:
An OntOS Business Module that models shared business reality used by multiple other modules, but is not part of the Core Kernel. A Foundational Module may be active for most tenants and required by other modules, but it remains outside Core because it owns domain concepts that can evolve with customer discovery.
_Avoid_: Core module, System Module, platform service, ordinary vertical, always-on kernel

**Application Composition**:
A named, reusable, versioned, dependency-closed directed acyclic graph of OntOS Foundational and Business Modules serving a coherent business purpose. It defines required modules, permitted optional modules, and dependency rules. Core validates and gates the graph without learning its business meaning. Commerce is one Application Composition shared by Akros, N1, and later commerce customers.
_Avoid_: Customer deployment, product fork, module bundle without dependency rules

**Customer Configuration**:
A declarative customer-specific configuration of an Application Composition. It may select permitted optional modules and define policies, settings, branding, locales, Connectors, and integration participation, but it cannot fork Core, change shared module contracts, or create customer-specific module implementations. Akros and N1 are Customer Configurations of the Commerce Application Composition.
_Avoid_: Customer fork, separate product, customer-named module family

**Environment**:
A topology-neutral lifecycle context in which a Customer Configuration operates, such as Production, Staging, or Development. Environment identity does not imply geography, data residency, isolated infrastructure, or shared multi-tenancy.
_Avoid_: Deployment, region, tenant

**Deployment Topology**:
The physical mapping of Customer Configurations, Environments, Tenants, Application Composition modules, data stores, workers, and Channel Applications onto running infrastructure. It decides customer isolation, shared multi-tenancy, infrastructure placement, and regional or residency constraints without changing logical module ownership.
_Avoid_: Application Composition, Customer Configuration, Environment

**Channel Application**:
A customer- or partner-facing application that composes public OntOS Business Module contracts for a channel, such as a commerce Storefront. It may live in the OntOS monorepo and deploy separately, but owns presentation and journey concerns rather than canonical business facts.
_Avoid_: Business Module, System of Record, mandatory Shell route

**Organization Registry**:
The Foundational Module that models shared organizational business structure such as legal-entity groups, holdings, portfolios, acquisition batches, and similar views over managed Legal Entities. In V0 it is a group/view model, not a corporate ownership or control ledger; Core only owns the minimal Legal Entity boundary needed for context, audit, and isolation.
_Avoid_: Core organization model, company registry, legal-entity registry, holding registry, ownership ledger

**OntOS Module Manifest**:
The OntOS-specific Effect Schema-defined public contract for an OntOS Business Module, Foundational Module, or selected System Module. It declares public identity, activation, dependencies, Action descriptors, APIs, components, public resource types, public events, search, and reports. It should rely on TypeScript/Effect/React inference wherever possible, using real typed values instead of manually-authored import/export strings. It does not publish a permission model or a static relation catalog; authorization is owned by SpiceDB, the OntOS Policy Layer, and API/action enforcement, while relations are dynamic runtime/domain data. It must not declare private implementation details such as database tables, migrations, command handler paths, outbox handler paths, route trees, navigation wiring, fixtures, or tests.
_Avoid_: MicroVertical Manifest, database schema, implementation manifest, stringly typed import/export metadata

**Action Descriptor**:
An Effect Schema-backed public runtime value that describes an Action's stable key, request schema, response schema, idempotency rule, authorization requirement, audit profile, and module-state requirements. The descriptor is imported into the manifest from an action file, while its handler remains private.
_Avoid_: Type-only interface, command handler, HTTP endpoint by itself, inline manifest blob

**Outbox Worker**:
A module-owned asynchronous consumer of Outbox Messages for declared event topics. It reacts to committed facts after the originating Action succeeds; as a Module Entrypoint, it is governed by the consuming module's tenant module state, not the producer module's state.
_Avoid_: Picker, deployment unit, Worker Runtime, synchronous subscriber

**Vertical Runtime Registration**:
The private owner-local runtime registration that binds one MicroVertical's public contract to its executable Actions, routes, Policies, migrations, workers, search implementations, and report implementations. It never crosses the deployment seam or becomes a Shell/Core or cross-module import surface.
_Avoid_: Public manifest, plugin marketplace, Installed Module Catalog entry, cross-module import surface

**Installed Module Catalog**:
The immutable Shell/Core catalog built atomically from allowlisted serialized deployment contracts. It indexes deployment and business-module identities independently and never contains another deployment's executable runtime registration.
_Avoid_: Installed Vertical Registry, executable plugin registry, module marketplace, self-registration

**Principal**:
An actor that can authenticate, invoke actions, or appear in audit and authorization. A Principal may represent internal staff, external manager staff, accountants, guests with portal access, integrations, service accounts, agents, or the system itself.
_Avoid_: User, employee, contact

**Principal Auth Binding**:
The Core-owned mapping from a stable externally authenticated subject to an OntOS Principal. BetterAuth owns users, sessions, API keys, key verification, and impersonation sessions; Core only stores the non-secret binding needed to resolve the effective Principal for actions, audit, and SpiceDB subjects. System jobs use system/service Principals without pretending to be external auth bindings.
_Avoid_: Credential store, API key table, session table, runtime credential reference, user profile

**Authenticated Principal Session**:
An authenticated working context that activates exactly one tenant-scoped Principal and its Tenant. The same authenticated person may have Principal identities in other Tenants, but choosing the active context grants no authority.
_Avoid_: Tenant-Selected BetterAuth Session, unscoped global Principal, selected Tenant as permission

**Evidence Artifact**:
A durable file, export, generated document, import source, signed document, or compliance bundle retained as proof for audit, compliance, or later investigation. An Evidence Artifact is the content being retained, not the index entry that makes it discoverable. Its stable content identity is the hash of the exact stored bytes, not the display filename or surrounding metadata.
_Avoid_: Raw payload, trace, log line, media attachment by default

**Evidence Registry**:
The Core vocabulary for durable audit and compliance evidence references. It records that an Evidence Artifact exists, what business subject or runtime event it substantiates, which content hash was registered, whether provider-side storage immutability was verified, and which retention, classification, and legal-hold rules apply; it is not a financial ledger, payload archive, observability trace store, or replacement for storage-level WORM.
_Avoid_: PG ledger, Postgres ledger, double-entry ledger, payload store, artifact storage

**Storage-Level WORM / Object Lock**:
Provider-enforced immutability for stored artifact bytes, usually through retention periods, legal holds, object versions/generations, bucket/prefix rules, or container policies. OntOS records the requested and verified lock state for evidence, but Postgres does not itself make object storage immutable. If a backend lacks WORM/Object Lock, the evidence can only be considered application-level immutable.
_Avoid_: DB trigger as legal WORM, immutable URL, filename convention, ordinary no-delete permission

**Party**:
A real-world person or organization OntOS deals with. A Party may be a guest, tenant, supplier, accountant office, external management company, owned company, contact person, or commercial counterparty.
_Avoid_: Account, user, legal entity

**Legal Entity**:
A managed accounting or operating company inside an OntOS tenant. Legal entities may own, operate, bill, report, or account for parts of the business, but external organizations are modeled as Parties unless the tenant manages them as part of its own operating structure.
_Avoid_: Every company, external manager, counterparty

**Counterparty**:
A Party in a commercial or contractual relationship with a managed Legal Entity. Counterparties can include tenants, guests, suppliers, external managers, corporate buyers, wholesalers, or accounting offices.
_Avoid_: Legal entity, principal

**Symmy Connector**:
The single OntOS-to-Symmy integration seam. OntOS Business Modules publish provider-neutral business handoff contracts; the Symmy Connector adapts them to Symmy without owning business facts or lifecycle authority. OntOS does not maintain target direct Connectors to POHODA, ABRA, HELIOS, or similar provider systems.
_Avoid_: Direct provider Connector, System of Record, Core capability

**Symmy–Provider Integration**:
A provider-specific integration operated downstream through Symmy, named for the concrete external system, such as Symmy–POHODA Integration or Symmy–ABRA Integration. N1's current direct POHODA integration is legacy and migration evidence, not the target architecture.
_Avoid_: OntOS Connector, Core adapter, unnamed ERP integration

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

**Task**:
A work item in the ticketing app. A Task belongs to exactly one Task Collection and is created empty with only the Title Task Property present; additional Task Properties come from its Task Collection schema.
_Avoid_: Ticket, issue, card

**Task Collection**:
A visible project-like set of Tasks that owns one shared Task Property schema. Views present Tasks from a Task Collection; they do not own the schema.
_Avoid_: Hidden schema, board view, database table

**Task View**:
A presentation of Tasks from one Task Collection. A new Task Collection starts with one default Task View showing all Task Properties in Task Property Order; later view configuration may hide or reorder user-created Task Properties.
_Avoid_: Task Collection, schema owner

**Task Property**:
A field on Tasks within a Task Collection. Its definition is shared by the collection, while each Task has its own Task Property Value; multiple Task Properties of the same type may exist in one Task Collection.
_Avoid_: Column, field, Property Registry property

**Task Property Name**:
The user-facing name of a Task Property within one Task Collection. Task Property Names are trimmed and unique across all Task Properties in their Task Collection without regard to case, including locked Task Properties.
_Avoid_: Column header, field label

**Mandatory Task Property**:
A Task Property that must have a non-empty value when a new or edited Task form is saved. User-created Task Properties may be made mandatory or optional later; existing empty values are not automatically changed until that Task is edited and saved.
_Avoid_: Required field

**Locked Task Property**:
A system-created Task Property whose core configuration cannot be removed, changed, or duplicated by users.
_Avoid_: Normal mandatory property, user-required property

**User-created Task Property**:
A Task Property created by a user in a Task Collection. User-created Task Properties support the normal create, read, update, and delete lifecycle even when marked mandatory, but their Task Property Type does not change after creation.
_Avoid_: Locked property, system property

**Task Property Deletion**:
The removal of a user-created Task Property from a Task Collection. It always requires user confirmation, shows the count of Tasks where the property is Is not empty, and removes the property definition, its configuration, and its Task Property Values from all Tasks in the collection.
_Avoid_: Removing a value, hiding a property

**Hidden Task Property**:
A Task Property that exists in a Task Collection schema but is not shown in a specific view. Hiding a property does not remove its definition, configuration, or values.
_Avoid_: Deleted property, archived property

**Task Property Order**:
The default display order of Task Properties in a Task Collection schema and Task detail form. The Title Task Property is fixed first; user-created Task Properties can be manually ordered after it, while individual views may keep their own property order.
_Avoid_: View-only order, database column order

**Duplicated Task Property**:
A new user-created Task Property copied from an existing Task Property, including its configuration and mandatory state. Duplication always asks whether values should be copied, receives a unique copy name, is placed immediately after the source property in the Task Collection's property order, and becomes independent after duplication.
_Avoid_: Alias, synced copy, clone linked to original

**Title Task Property**:
The automatically created locked and mandatory Text Task Property in every Task Collection. It is edited as a single-line input, uniquely identifies a Task for users, and users cannot rename it, remove it, hide it from views, duplicate it, make it optional, or change it to another type.
_Avoid_: Core title attribute, removable title field

**Task Property Value**:
The value held by one Task for one Task Property. Empty is a valid value state unless a property is explicitly mandatory.
_Avoid_: Cell, column value, field value

**Task Property Search**:
Finding Tasks by matching Task Property Values. All Task Property Types are searchable, with matching semantics defined by each type.
_Avoid_: Text-only search

**Task Property Sort**:
Ordering rows in a Task table view by a Task Property Value. Task Property Types are sortable unless a type explicitly opts out; Multi-select, Person, and Files & Media are not sortable for now, and Empty values sort after non-empty values in both directions.
_Avoid_: Text-only sorting

**Task Property Type**:
The kind of value a Task Property accepts, such as Text, Number, Select, or Multi-select.
_Avoid_: Column type, field type

**Select Option**:
A configured choice in a Select Task Property. A Task may choose at most one Select Option for that property; table sorting by Select follows the property's option order.
_Avoid_: Tag, label, status

**Multi-select Option**:
A configured choice in a Multi-select Task Property. A Task may choose zero or more Multi-select Options for that property.
_Avoid_: Tag, label, status

**Status Task Property**:
A Task Property Type for a Task's workflow state. Status is its own type, not a Select property alias; its options belong to fixed groups such as Not started, In progress, and Done, and a new Status Task Property starts with default statuses for those groups.
_Avoid_: Select property with a different label

**Derived Task Property**:
An optional Task Property whose value is automatically produced by the system rather than manually edited or marked mandatory by users, such as Created time, Created by, Last edited time, Last edited by, or ID. Derived Task Properties may be renamed, duplicated, or removed from the Task Collection schema, but a duplicate keeps the same system value source and removal does not delete the underlying system fact.
_Avoid_: Editable user property, locked Title property

**Task ID**:
A system-produced globally unique identifier for a Task that can be exposed through the ID Derived Task Property.
_Avoid_: Collection-local task number

**Task Audit Principal**:
The Principal recorded by system-derived Task Properties such as Created by and Last edited by.
_Avoid_: Person property value, assignee

**Person Task Property**:
A Task Property Type whose editable value can reference zero, one, or more Principals. Search matches visible Principal display names and visible email or login identifiers.
_Avoid_: External contact, Party, free-text person

**Files & Media Task Property**:
A Task Property Type whose value can reference zero, one, or more Core-managed media or artifact records rather than storing file bytes inside ticketing. Search matches file names only, not metadata or file contents.
_Avoid_: Ticketing-owned file storage, inline binary value

**Date Task Property**:
A Task Property Type whose value is a single date. Search uses exact date selection, such as through a date picker, rather than formatted text matching.
_Avoid_: Free-text date

**Date Range Task Property**:
A Task Property Type whose non-empty value contains both a start date and an end date. The end date cannot be before the start date; same-day ranges are valid, search uses exact date selection rather than formatted text matching, and table sorting uses the start date before the end date.
_Avoid_: Half-open date value, single date

**Checkbox Task Property**:
A Task Property Type with checked and unchecked values. A new Checkbox Task Property starts as Empty for Tasks; once set, unchecked is a real value, not Empty, and Checkbox cannot be marked mandatory.
_Avoid_: Tri-state checkbox, empty unchecked value

**Task Access Level**:
The level of access a Principal has to Tasks and Task Properties. Full access can edit, suggest, comment, and share; editor can edit, suggest, and comment; user can edit Task Property Values, suggest, and comment but cannot change Task Property schema or configuration; viewer is read-only.
_Avoid_: Unscoped role, property ownership

**Task Change Version**:
A timestamped version record for a Task Property schema change, Task Property configuration change, or Task Property Value change.
_Avoid_: Unversioned edit, audit-free mutation

**URL Task Property**:
A Task Property Type for web addresses. Non-empty URL values must be valid enough to save as URLs.
_Avoid_: Free-text link label

**Email Task Property**:
A Task Property Type for email addresses. Non-empty Email values must be valid enough to save as email addresses.
_Avoid_: Free-text contact text

**Phone Task Property**:
A Task Property Type for phone numbers. Non-empty Phone values use light normalization and validation because phone formats vary internationally.
_Avoid_: Country-specific phone-only field

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
