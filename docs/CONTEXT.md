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
A named, reusable, continuously delivered, dependency-closed directed acyclic graph of OntOS Foundational and Business Modules serving a coherent business purpose. It defines required modules, permitted optional modules and implementations, and dependency rules. Core validates and gates the graph without learning its business meaning. Commerce is one Application Composition shared by Akros, N1, and later commerce customers.
_Avoid_: Customer deployment, customer-pinned release line, module bundle without dependency rules

**Customer Configuration**:
A declarative customer-specific configuration of an Application Composition that may select permitted optional modules and explicit Module Implementation Identities and define business policy, settings, locales, Storefront Clients, Connectors, and Integration Routes. It cannot fork Core, change a shared contract in place, or hide customer code behind an existing implementation identity; Akros and N1 are Customer Configurations of Commerce.
_Avoid_: Customer fork, separate product, customer release line

**Environment**:
A topology-neutral lifecycle context in which a Customer Configuration operates, such as Production, Staging, or Development. Environment identity does not imply geography, data residency, isolated infrastructure, or shared multi-tenancy.
_Avoid_: Deployment, region, tenant

**Deployment Topology**:
The physical mapping of Customer Configurations, Environments, Tenants, Application Composition modules, data stores, workers, and channel adapters onto running infrastructure. It decides customer isolation, shared multi-tenancy, infrastructure placement, and regional or residency constraints without changing logical module ownership; Commerce Storefront Applications remain outside the standard Shell deployment.
_Avoid_: Application Composition, Customer Configuration, Environment

**Channel Application**:
A customer- or partner-facing application that composes public OntOS Business Module contracts for a channel. A Commerce Storefront Application is independently deployed outside the standard Shell deployment and owns presentation and journeys rather than canonical business facts.
_Avoid_: Business Module, System of Record, Shell route

**Commerce Storefront API**:
The thin OntOS channel edge that authenticates Storefront Client and customer/guest context, authorizes, translates contracts, aggregates bounded reads, and invokes public Commerce Actions. It owns no canonical facts or durable workflows.
_Avoid_: Commerce domain, canonical store, universal BFF

**Storefront Client**:
A tenant-bound service Principal and rotatable credential for one Storefront Application. It identifies the calling application, never the browsing customer.
_Avoid_: Portal Account, Tenant, shared API key

**Module Contract Identity**:
The stable identity of a module capability's public semantics and contract. Different public semantics require a distinct identity.
_Avoid_: Deployment identity, build revision, customer fork

**Module Implementation Identity**:
The explicit catalog identity of one executable implementation of a Module Contract Identity, such as `standard` or `akros`. Customer Configuration may select a permitted implementation; invisible same-identity forks are forbidden.
_Avoid_: Product version, hidden override, customer copy

**Build Revision**:
The immutable source/artifact identity recorded for compatibility, audit, canary, and rollback. It is not a customer-selectable product version.
_Avoid_: Customer release line, Module Contract Identity

**Integration Route**:
The configured exchange path for one External Business System and fact family: One-time Migration, Symmy Route, or Direct Provider Route. It does not confer System-of-Record authority.
_Avoid_: Global integration mode, universal gateway

**Organization Registry**:
The Foundational Module that models shared organizational business structure such as legal-entity groups, holdings, portfolios, acquisition batches, and similar views over managed Legal Entities. In V0 it is a group/view model, not a corporate ownership or control ledger; Core only owns the minimal Legal Entity boundary needed for context, audit, and isolation.
_Avoid_: Core organization model, company registry, legal-entity registry, holding registry, ownership ledger

**Party Registry**:
The Foundational Module that owns tenant-scoped stable Party identities and shared Counterparty relationships across Application Compositions, including official identifiers, identity matching, correction, and merge. Cross-tenant correlation may link independently governed Parties but never collapses them into one shared tenant-independent identity.
_Avoid_: CRM customer registry, global party directory, Organization Registry, integration-owned identity

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
A real-world person or organization OntOS deals with; its kind may remain Unresolved while evidence is incomplete. A Party may initially be sparsely known or unverified, so missing business details do not prevent its identity from being recorded and later corrected or merged.
_Avoid_: Account, user, legal entity

**Party Relationship**:
A provenance-backed, time-bounded association between two Parties, such as representative, employee, owner, billing contact, or advisor. Several relationships may coexist between the same Parties, and none grants authorization by itself.
_Avoid_: Embedded person, Principal permission, permanent affiliation

**Contact Point**:
An email address, telephone number, or postal address through which a Party may be contacted. A Contact Point may be associated with several Parties and does not by itself prove identity or authorization.
_Avoid_: Person identity, unique Party key, Principal credential

**Legal Entity**:
A managed accounting or operating company inside an OntOS tenant. Legal entities may own, operate, bill, report, or account for parts of the business, but external organizations are modeled as Parties unless the tenant manages them as part of its own operating structure.
_Avoid_: Every company, external manager, counterparty

**Counterparty**:
The commercial or contractual relationship between one Party and one managed Legal Entity. A Counterparty may carry several Counterparty Roles at the same time without duplicating the Party's identity.
_Avoid_: Party copy, legal entity, principal

**Counterparty Role**:
A time-bounded capacity in which a Counterparty relates to a managed Legal Entity, such as customer, supplier, external manager, corporate buyer, wholesaler, or accounting office. Roles may coexist and end independently.
_Avoid_: Party identity, permanent customer type, Principal permission

**System of Record**:
The system authorized to decide a specific business fact or lifecycle transition. Authority is assigned per fact or transition and need not belong to one system globally.
_Avoid_: Master system, source system

**External Business System**:
A live upstream or downstream system that exchanges business facts with a Customer Configuration, such as an ERP, accounting system, WMS, PIM, CRM, or bespoke service. Its product and system type must be observed rather than assumed.
_Avoid_: ERP, when the actual system or role has not been verified

**Connector Registry**:
The module-owned record that correlates an OntOS resource with identifiers issued by one External Business System, including the provenance and lifecycle needed for dependable exchange. Owning the mapping does not make OntOS the issuer of the external identifier.
_Avoid_: Master identifier, shared external ID field

**Integration Hub**:
An External Business System that coordinates business exchanges with multiple third-party systems. It may route or transform facts but is not automatically their System of Record.
_Avoid_: Connector, ERP, System of Record

**Symmy**:
The preferred, non-exclusive Integration Hub for external invoicing, accounting, ERP, WMS/PIM, and comparable business-system integrations that Symmy provides. Its coordinating role does not give it authority over exchanged facts, and it is not the route for every external provider.
_Avoid_: ERP, Connector, universal provider gateway, universal System of Record

**Symmy Connector**:
The OntOS-to-Symmy boundary through which owning Foundational and Business Modules exchange provider-neutral business facts with Symmy. It does not own those facts or provider-specific downstream behavior.
_Avoid_: Universal external-provider gateway, System of Record, Core capability

**Symmy–Provider Integration**:
A provider-specific route operated downstream through Symmy, such as Symmy–POHODA Integration or Symmy–HELIOS Integration.
_Avoid_: OntOS-owned provider adapter, unnamed ERP integration

**Direct Provider Adapter**:
An owner-local external adapter used for a provider family intentionally outside Symmy, or when Symmy does not supply the required integration. It implements an owning module's external contract without gaining authority over the exchanged facts.
_Avoid_: Direct legacy Connector, Core integration, System of Record

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

## Commerce Delivery Language

These terms describe the Commerce Application Composition first configured for Akros and then N1. Current deployments supply evidence; they do not dictate the replacement's implementation or integration topology.

### Delivery and customer configurations

**Akros**:
A Customer Configuration of the Commerce Application Composition and its first production delivery. The Akros organization may separately be a Party and customer-role Counterparty in another Customer Configuration, such as Techsio's.
_Avoid_: Separate product, Core fork, Akros module family, Party when referring to the configuration

**N1**:
The second confirmed Customer Configuration of the Commerce Application Composition and an existing bikeshop customer on the legacy WRShop engine. The N1 organization may separately be a Party and customer-role Counterparty elsewhere, while its direct POHODA integration remains legacy and migration evidence.
_Avoid_: Separate product, POHODA-specific OntOS fork, Party when referring to the configuration

**Commerce Application Composition**:
The reusable, continuously delivered OntOS Application Composition that supplies shared B2C/B2B commerce capability to Akros, N1, and later Customer Configurations. It contains no third-party commerce-engine runtime or derived source; a temporary protocol facade does not become its foundation.
_Avoid_: Akros product, customer-pinned version, customer-specific commerce foundation

**Production Deployment Snapshot**:
The Akros package captured approximately five days before the Wayfinder session and confirmed by the operator as live and in use. It proves which code, routes, customizations, and connector seams were deployed at capture time, but not their database-controlled enablement, traffic, schedules, or operator use.
_Avoid_: Historical archive, when referring specifically to the current Akros package

**Deployed Capability**:
Behavior or a connector seam present in the Production Deployment Snapshot whose activation or use has not yet been established from runtime state.
_Avoid_: Active feature, requirement

**Active Behavior**:
Behavior established by current public observation, runtime configuration or telemetry, or explicit operator confirmation. Active Behavior is evidence for the replacement cutline, not an automatic decision to preserve it unchanged.
_Avoid_: Supported feature

**ABRA**:
A named External Business System family represented by several connector generations in the Production Deployment Snapshot. Its actual production role and activity remain facts to verify; it is neither the assumed current ERP nor a predetermined target dependency.

**Production-complete Launch**:
The release at which the replacement can safely take over every accepted Akros launch channel and its required end-to-end business outcomes. It does not imply parity with every capability deployed or historically available in WRShop.
_Avoid_: Feature parity, complete platform

**Launch Capability**:
A capability required at Production-complete Launch because it is active, revenue-critical, operationally necessary, legally required, or explicitly confirmed as part of the product promise.

**Later Capability**:
A useful capability intentionally deferred beyond Production-complete Launch because no launch-critical outcome depends on it.

**Archived Capability**:
Historical behavior or data retained read-only for customer service, audit, accounting, or legal obligations, without preserving its original write workflow.

**Retired Capability**:
A capability deliberately absent from the replacement because it is unused, obsolete, unsafe, or generic legacy breadth with no accepted Akros value.

### Commerce customers and channels

**B2C Channel**:
The Akros retail selling channel. Visitors may browse and complete a purchase as a guest or as an authenticated Retail Portal Principal.

**Retail Customer**:
A Party buying or considering a purchase through the B2C Channel. A Retail Customer may purchase as a guest or use a Retail Portal Principal for durable portal access.
_Avoid_: Customer Account, consumer user

**Retail Portal Principal**:
A Principal authorized to access a Retail Customer's saved addresses, commerce history, aftercare, favorites, and notifications. It is optional for B2C checkout.
_Avoid_: Customer Account, user account

**Commerce Portal Account**:
A Commerce-owned BetterAuth account used by a retail or B2B person outside the staff Shell realm. It links to tenant-scoped Principals and Party/Counterparty references but is not itself the shared Party identity.
_Avoid_: Staff account, Party record, Storefront Client

**B2B Channel**:
The Akros trade selling channel. Public visitors may see neutral product information and request access, but Counterparty-specific assortment, prices, availability, and ordering require an approved Principal acting for that Counterparty.

**Counterparty Buyer**:
A Principal authorized to prepare and submit purchases for a Counterparty within its assigned limits and approval rules.
_Avoid_: Company Buyer, Company User

**Counterparty Approver**:
A Principal authorized to approve or return purchases that require Counterparty approval.
_Avoid_: Company Approver

**Counterparty Access Administrator**:
A Principal authorized to manage which Principals may act for a Counterparty and with which permissions.
_Avoid_: Company Account Administrator, account owner

**Repeat Order**:
A request to construct a new Cart from a historical Order's still-sellable items and configurations. Current commercial rules apply; historical price, tax, availability, shipping, and payment terms are not reinstated.
_Avoid_: Duplicate order, reorder at original price

**Assisted Support**:
An audited staff capability that exposes the customer's channel and commercial context without silently assuming the customer's identity. Any customer-affecting action remains explicit, attributed to the operator, and permission-checked.
_Avoid_: Impersonation, login as customer

**Customer Archive**:
The authorized read-only experience through which a customer or operator can access retained historical Orders, documents, and Claims. It is not itself the statutory accounting or tax archive.

### Commerce domains

**Product**:
A good or service with a stable commercial identity that can be described, classified, related, and made available through one or more Channels. Its current offer conditions are not part of its identity.
_Avoid_: Price, stock item, Order line

**Catalog**:
The commerce domain that owns Product identity, variants and configurations, classification, descriptive facts, media references, and Product relationships.
_Avoid_: Assortment, price list, content-management screen

**Assortment**:
The set of Products eligible for visibility or purchase in a specific Channel or for a specific Counterparty under current policy.
_Avoid_: Catalog, Inventory, price list

**Pricing**:
The commerce domain that determines applicable prices, discounts, fees, tax inputs, quantity tiers, and commercial quotations for an explicit commercial context.
_Avoid_: Product identity, invoice, accepted Order price

**Inventory**:
The commerce domain that records or represents stock and reservations when the owning Customer Configuration owns those lifecycles. Inventory is distinct from the customer-facing delivery promise.
_Avoid_: Availability, Assortment

**Availability**:
The current promise that a Product can be sold and delivered under an explicit commercial context. It may depend on Inventory or facts supplied by an External Business System without owning those facts.
_Avoid_: Inventory, Assortment, raw stock count

**Cart**:
A prospective set of Product selections and configurations assembled under an explicit commercial context. A Cart is mutable and does not preserve accepted commercial terms as an Order does.
_Avoid_: Order, basket when naming the canonical domain concept

**Checkout**:
The commerce process that coordinates final validation, required customer choices, and submission of a Cart. Checkout does not own source commercial facts or the resulting Order.
_Avoid_: Order creation domain, Payment domain

**Order**:
The durable record of an accepted purchase, including the accepted commercial snapshot and its governed lifecycle.
_Avoid_: Cart, invoice, Payment

**Payment**:
The commerce domain that represents collection, authorization, settlement, cancellation, refund, and reconciliation outcomes associated with an Order.
_Avoid_: Order status, invoice, payment-provider callback

**Fulfillment**:
The commerce domain that represents preparation, handoff, delivery, tracking, and delivery exceptions for accepted Order quantities.
_Avoid_: Order, shipping-provider adapter

**Aftercare**:
Customer- and operator-facing post-purchase work permitted by the Order, Payment, Fulfillment, and Claim lifecycles. It coordinates those lifecycles without replacing their ownership.
_Avoid_: Unrestricted Order editing, customer service database

**Claim**:
A governed request concerning one or more durable Order lines, with its own evidence, communication, status, deadlines, and resolution history.
_Avoid_: Order note, generic support ticket

**Akros Commerce Policy**:
The declarative Akros Customer Configuration of shared commerce policy for its B2C and B2B Channels, Counterparty purchasing, quantities and packages, markets, and legal obligations. Behavior belongs in a shared module or an explicit catalogued Module Implementation, never an invisible Akros fork.
_Avoid_: Core policy, provider-specific mapping, generic settings

**Storefront Application**:
An independently deployed customer-facing application outside the standard OntOS Shell deployment. It owns framework, presentation, routing, branding, assets, interaction, and SEO while consuming the Commerce Storefront API through its local BFF.
_Avoid_: Commerce domain, Shell module, System of Record

**Medusa Store Compatibility Facade**:
A temporary Commerce Storefront API translation surface for the Medusa Store API shapes required by existing `new-engine` storefront hooks. It is not a Medusa runtime, source derivative, canonical contract, or permanent channel architecture.
_Avoid_: Commerce foundation, native Commerce contract

**Commerce Operations**:
The purpose-built staff application for permissioned commerce workflows and Assisted Support. It uses the staff Shell authentication boundary and public module contracts without becoming Shell/Core, a fact owner, or an unrestricted mutation surface.
_Avoid_: Admin, Back Office, direct database editor

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
