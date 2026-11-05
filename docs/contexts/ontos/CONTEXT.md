# OntOS language

Use these terms consistently across product, architecture, and implementation discussions. This
context owns canonical product semantics and vocabulary, not storage, file layout, transport, or
other implementation mechanics. It does not override accepted ADRs or current application guidance.

## Language guardrails

**Customer** — Never a standalone canonical identity type or generic aggregate. Always qualify the
meaning, for example Customer Configuration, Retail Customer, Counterparty Role `CUSTOMER`, Contacts
Engagement Profile, Commerce Retail Customer Profile, Commerce Counterparty Purchasing Profile, or
Customer Archive. Avoid `customer`, `customer record`, `customer ID`, and `B2B Customer` when the
intended subject is actually a Party, Counterparty, Principal, account, role, or contextual profile.

**Actor** — Narrative name for the Principal performing or attempting one concrete operation. Actor
is not a separate identity object and must not be used as a synonym for Party, person, account, or
permission holder without resolving the Principal.

**Permission** — Explicit authorization allowing one Principal to perform one declared Action or
governed read against a Resource and scope. A Party Relationship, Counterparty Role, selected
context, profile membership, account session, or Business Policy result is not a Permission.

**Business Permission Definition** — Owner-published meaning of a business Permission and its
permitted authorization targets and scopes. Publishing a definition grants no Principal a Permission.
One publishing Module may host definitions for several canonical business capabilities; its runtime
or deployment identity does not reassign their business ownership or activate a dormant capability.

**Authorization Target** — The exact object or scope against which an operation requires Current
Permission, including an ordered conjunction when several targets are independently required.
Deployment and build identity do not replace this target.

**Business Policy** — Module-owned condition or decision evaluated from trusted context and business
facts after authentication and authorization boundaries. It may allow, deny, require approval, or
select a typed business outcome; it never creates identity, authentication, or Permission.

**Current** — Valid from authoritative facts, Permissions, Business Policies, and Effective Periods
at the trusted operation time. A value retained by a client, cache, Cart, or previous evaluation is
not Current merely because it still exists.

**Owner-Verifiable Set Completeness Evidence** — Owner-verifiable evidence that, for one exact
decision-relevant predicate or safely broader declared scope, an observed set contains every Current
owner fact whose presence or absence can change the exact decision. A broader proof is valid only
when its owner contract guarantees invalidation for every material insert, removal, lifecycle or
matching change capable of altering that predicate.
_Avoid_: returned rows assumed complete, final page or row count as business completeness, cache or
event silence as completeness proof, winner revision standing in for complete candidate state,
consumer-inferred completeness without owner authority.

**Effective Period** — Explicit interval during which a fact or assignment is valid. Unless an owning
capability states otherwise, `effective_from` is inclusive and `effective_to` is exclusive.

**Accepted Fact** — Business value definitively used by a successful committed transition. Later
changes to Current source facts do not rewrite an Accepted Fact; the owning historical Resource
retains the evidence required to explain it.

## Product and composition

**OntOS** — The encompassing modular business product. Core and Shell provide shared runtime
guarantees; Foundational and Business Modules provide reusable capabilities assembled into
Application Compositions.

**OntOS Core** — Business-neutral system capabilities required by ordinary modules: trusted
identity and scope, module state, governed operations, authorization and policy boundaries, audit,
events, outbox, evidence foundations, and runtime composition. Core does not own module-specific
business behavior.

**Shell** — The staff application boundary that authenticates staff, resolves trusted context, and
composes governed module entrypoints. It is not a business fact owner.

**CoreSDK** — The server-side boundary through which public writes and governed reads pass so Core
can apply shared scope, authorization, policy, evidence, transaction, event, and outbox semantics.
It is not a BFF business layer or a direct database path.

**UltraModern.js MicroVertical** — A cohesive full-stack capability behind a strict independently
deployable seam. It owns its UI and server behavior; co-location does not permit private imports,
shared repositories, or shared business transactions.

**OntOS Module** — Umbrella for a capability described by an OntOS Module Manifest. The current
module kinds are Business Module, Foundational Module, and System Module.

**OntOS Business Module** — Module kind that owns one cohesive business capability, normally behind
an independently deployable MicroVertical seam.

**Foundational Module** — Separate module kind that owns shared business reality used by several
domains. It remains outside Core because its concepts evolve through domain discovery.

**Organization Registry** — Foundational Module for shared organizational groupings and views over
Core-owned managed Legal Entities. It does not own trusted Legal Entity scope identity or lifecycle,
and it is not a Core company registry or a corporate ownership ledger.

**System Module** — A Core-owned capability described through a module contract, or a smaller
system variant, for consistent discovery and governance. It is not tenant-optional business logic.

**Application Composition** — A named dependency-closed graph of compatible Foundational and
Business Modules serving a coherent purpose.

**Customer Configuration** — Declarative selection of permitted modules, implementations,
policies, settings, locales, clients, connectors, and Integration Routes for one customer. It cannot
fork Core or hide customer code behind an existing implementation identity.

**Environment** — A topology-neutral lifecycle context such as Production, Staging, or Development.
It does not imply geography, residency, or isolation.

**Deployment Topology** — The physical placement and isolation of environments, customers, modules,
stores, workers, and channel adapters. It does not change logical ownership.

**Channel Application** — Customer- or partner-facing application that composes public module
contracts for one channel. It owns presentation and journeys, not canonical business facts.

## Module contracts and execution

**Module Contract Identity** — Stable identity of one module capability's public semantics.
Different semantics require a different identity.

**Module Implementation Identity** — Explicit catalog identity of one executable implementation of
a Module Contract Identity. Compatible alternatives have distinct implementation identities;
invisible forks are forbidden.

**Build Revision** — Immutable source and artifact identity used for compatibility, canary, audit,
and rollback. It is not a customer-selectable product version.

**Public Operation Contract** — One owner's declared public operation identity and supported
version. Its compatibility claim is distinct from the serialized deployment-contract format,
artifact digest and Build Revision. Equal document formats do not establish operation compatibility;
a different build alone does not create a new business owner or Permission target.

**Intrinsic Module Requirement** — Required compatible capability that belongs to installation,
activation and the module's governed execution closure. These requirements form the dependency DAG;
reciprocal calls made by separate business operations do not themselves form an intrinsic cycle.

**Operation Fact Requirement** — An owner-authored obligation to establish a fact when a particular
operation or its real business branch needs it. The owner defines the condition, supported public
contract or accepted owner-issued proof, and required evidence. A condition that does not apply is
different from an applicable condition whose facts cannot be proved. Neither a caller flag nor a
provider outage can waive the latter.

**Composition Membership** — Presence in one authoritative Application Composition revision. It is
separate from source implementation, Tenant module state, entrypoint availability and Permission.
Absence from that composition alone proves neither absence of code nor extinction of historical
business obligations.

**OntOS Module Manifest** — Effect Schema-defined public module contract that exposes safe module
semantics while excluding private tables, migrations, handlers, registrations, routes, fixtures,
and tests. The exact current and target fields are owned by app-local manifest guidance.

**Vertical Runtime Registration** — Owner-local private binding from a module's public contract to
its executable Actions, APIs, pages, policies, migrations, workers, search, and reports. It never
crosses a deployment seam.

**Installed Module Catalog** — Atomically validated catalog built from allowlisted serialized
deployment contracts. It indexes deployment and module identities without importing remote
executables.

**Module Entrypoint** — A governed crossing into module behavior, such as an Action, page, API,
public component, search provider, report, or worker.

**Structured Entrypoint** — A Shell/Core-owned entrypoint description using stable identities
rather than private paths or raw remote specifiers.

**Module State Gate** — Core-owned check of a Tenant's module state before private code loads or
runs. It is separate from authentication, SpiceDB authorization, and Business Policy.

**Core Modules Capability** — Always-available Core capability for viewing and changing Tenant
module states. Its availability prevents administrative lockout; authorization and policy still
govern who may use it.

**Action** — A declared business operation and the only public path for changing canonical business
state.

**Action Descriptor** — Public Effect Schema-backed runtime value describing an Action's identity,
request, result, idempotency, authorization, audit, scope, and module-state requirements. The
handler remains private.

**Outbox Worker** — Module-owned asynchronous consumer of committed facts. It is governed as an
entrypoint of the consuming module and never extends the producing Action's transaction.

## Identity and shared business reality

**Tenant** — Top-level customer or operating isolation boundary. Cross-Tenant access is forbidden
by default.

**Legal Entity** — Core-owned trusted scope Resource for one managed accounting or operating
company inside a Tenant. Core owns only the minimum identity and lifecycle required to establish and
validate that scope. External organizations remain Parties unless the Tenant manages them as part
of its own structure; accounting, tax, banking, and organizational business profiles retain their
own System of Record.

**Principal** — Canonical Actor used for authentication resolution, authorization, invocation, and
audit. It may represent a person, integration, service, agent, or system job.

**Authentication Namespace** — Trusted provider-plus-realm or issuer identity qualifying an external
authentication subject. Equal provider-local subject identifiers in different Authentication
Namespaces are distinct and must never resolve through each other's Principal Auth Bindings.
_Avoid_: treating a provider technology name such as `better_auth` as the realm identity when more
than one trusted realm uses that provider.

**External Authentication Subject** — Stable provider-issued subject qualified by its exact
Authentication Namespace and subject type: `(Authentication Namespace, subjectType,
providerSubjectId)`. `providerSubjectId` is the stable opaque identifier inside that namespace and
subject type. Tenant is deliberately not part of this external-subject identity; Tenant is a
separate scope dimension of Principal Auth Binding. Mutable login identifiers such as email or
telephone, sessions, provider technology names and Party identity are not External Authentication
Subject identity.
_Avoid_: provider-local ID without namespace, `(Tenant, providerSubjectId)` as external subject,
email/telephone as subject identity, provider technology name as realm identity, omitting subjectType
when the provider can distinguish subject kinds.

**Principal Auth Binding** — Core-owned non-secret mapping from one exact External Authentication
Subject and one Tenant to one Tenant-scoped Principal. Its canonical key meaning is
`(Tenant, Authentication Namespace, subjectType, providerSubjectId)`. The authentication provider
continues to own credentials and sessions; mutable login identifiers such as email or telephone are
not the binding identity.

**Authenticated Principal Session** — Staff session context that activates exactly one valid
Tenant-scoped Principal and Tenant. Selecting context grants no authority and is revalidated.

**Party Registry** — Foundational Module and System of Record for tenant-scoped shared Party
identity, matching, correction, merge, Official Identifiers, Contact Points, Party Relationships,
and Counterparties. It does not own or mirror managed Legal Entities.

**Party** — Real-world person or organization OntOS deals with outside the Tenant's managed Legal
Entity structure. Its identity may be sparse or unresolved while evidence is incomplete.

**Unresolved Party** — Party with a stable Resource identity and evidence for one concrete subject,
but insufficient evidence to assert PERSON versus ORGANIZATION. It may participate only where the
owning Business Policy permits; later enrichment, correction, or merge preserves provenance and
addressability and grants no permission.

**Party Candidate** — Immutable evidence about a potential real-world subject before Party Matching
chooses an existing Party or Party Create establishes a new one. It is not a Party and has no Party
identity.

**Official Identifier** — Typed identifier assigned or recognized in a defined issuer, namespace,
or jurisdiction for a real-world Party. It is distinct from an OntOS Resource identity, a Source
Record Reference, and a provider-issued Connector Registry correlation.

**Identifier Type** — Governed definition of one Official Identifier's business meaning,
normalization, validation, applicability, namespace, multiplicity, collision, verification, and
matching semantics. A generic free-text OTHER value is not an Identifier Type.

**Party Fact Assertion** — Provenance-backed statement about a Party-owned fact with recorded time,
real-world validity where applicable, lifecycle state, and verification context. Current state is
derived from accepted assertions; correction does not silently overwrite history.

**Party Matching** — Tenant-scoped decision that compares a Party Candidate with existing Parties
and returns MATCHED, NO_MATCH, or AMBIGUOUS under explicit Match Rules. It does not merge Parties or
use a search result as identity authority.

**Match Rule** — Versioned and explainable Party Matching policy that defines which normalized facts,
provenance, verification, and conflicts permit a matching outcome. An opaque score is not a Match
Rule.

**Duplicate Candidate Case** — Durable Party Registry review case created when available evidence
cannot safely choose an existing Party or permit a new Party. It is not the UNRESOLVED Party Type or
a Party Merge.

**Identity Reviewer** — Principal explicitly authorized to resolve a Duplicate Candidate Case,
approve a Party Correction, or confirm a Party Merge according to the relevant policy. The role
name does not itself grant authority; SpiceDB and policy still decide each operation.

**Source Record Reference** — Stable reference to one record in an External Business System or
migration dataset. It preserves source context and provenance but is not an Official Identifier,
Party identity, or proof that the record represents a new real-world subject.

**Party Alias** — Preserved identity reference from an absorbed Party to its canonical survivor
after Party Merge. It is not an alternate business name, remains tenant-scoped, and accepts no new
canonical writes.

**Party Relationship** — Provenance-backed, time-bounded association between Parties. It does not
grant authorization.

**Contact Point** — Email address, telephone number, or postal address through which a Party may be
contacted. It does not by itself prove identity or authority.

**Counterparty** — Durable commercial or contractual context between one Party and one managed
Legal Entity. The Party and Legal Entity remain distinct Resources.

**Counterparty Role** — Time-bounded capacity such as customer, supplier, or accounting office.
Several roles may coexist and end independently.

**External Operator** — Party outside the managed Legal Entity structure that receives explicitly
scoped operational access. Being an operator does not itself grant Tenant membership or Permission.

## Resources, stores, and evidence

**Resource** — Module-owned business or system object with durable identity. Not every database row
is a Resource.

**ResourceRef** — Value reference to a module-owned Resource containing Tenant scope, module
identity, Resource type, and Resource identity. It preserves addressability without transferring
ownership to Core or the consumer.

**Resource Alias** — Owner-maintained durable mapping from a superseded Resource identity to a
surviving Resource identity after correction, merge, or reconciliation. It preserves lookup and
historical explanation. It does not merge business facts, broaden Permission, or authorize a caller.

**System of Record** — System authorized to decide a particular business fact or lifecycle
transition. Authority is assigned per fact, not globally.

**Reconciliation** — Owner-governed process that determines and converges the real state after
conflict, partial failure, duplicate correlation, or indeterminate external outcome. Reconciliation
uses durable identity, idempotency, provenance, and explicit owner contracts; it never guesses,
silently broadens authority, or rewrites a proven committed fact.

**SpiceDB Authorization Graph** — Relationship-based authorization system used for Permission
decisions. It is distinct from business relationships and Business Policy conditions.

**OntOS Core Search** — Core-owned rebuildable search projection and query capability. Owning
modules publish safe searchable descriptors and lifecycle facts; Core Search does not own business
facts, decide Party Matching, or bypass the standard authorization gate.

**Neo4j Projection** — Optional rebuildable read model for selected business relationships. It is
never canonical operational storage or an authorization dependency.

**Evidence Artifact** — Durable content retained as proof for audit, compliance, or investigation.
Its content identity is based on exact bytes, not a display filename.

**Evidence Registry** — Core references connecting Evidence Artifacts to the facts they substantiate,
their hashes, retention, classification, legal hold, and verified storage immutability. It is not a
payload archive, trace store, or financial ledger.

**Storage-level WORM / Object Lock** — Provider-enforced immutability of stored artifact bytes.
Database rules may protect application behavior but cannot claim provider-enforced WORM.

## Granular authorization

These terms belong to the accepted granular authorization model
([ADR-0030](../../adr/0030-granular-authorization.md)). In product language "company" is a Legal
Entity.

**Capability** — One declared permission made available in one scope (a company or the Tenant
context) where its module is installed. Scope admins can always configure it, installed or not; a
delegate only within its live delegation envelope. Nobody can use it without an adopted grant in an
assigned Role. Uninstalling the module stops every use while keeping its configuration.
_Avoid_: confusing it with capability issuance (credentials) or a module capability; the engine type
is `access_capability`, and a Capability is never a grant and never a module boundary.

**Access declaration** — A module's in-code statement of one protected entrypoint's permission:
stable key, kind (action, read, field read, field write, export, admin), Risk tier, suggested
placement, supported record scopes and modes. It never grants anything; it only creates a catalog
entry.

**Risk tier** — Routine, sensitive or critical classification of a declared permission. Sensitive
covers personal data, financial visibility, exports, bulk changes and external communication;
critical covers money movement, irreversible or legal effects, destructive operations and authority
changes. Risk drives warnings, Adoption, approvals and agent limits, never an automatic grant.

**Role** — A Tenant-defined job description, such as Účetní or Obchodník, defined once and
assigned per company. A role's levels, switches and limits compile to exact permissions pinned to
the catalog at save time; something new never slips into a level silently.
_Avoid_: treating an admin or owner title as a Role; it is management power, not data access.

**Role revision** — One immutable saved state of a Role, with provenance (template,
customer-changed or manual). Editing a Role creates a new revision.

**Assignment** — One holder (person or agent) × one Role revision × one scope × one period. Each
Assignment is a distinct incarnation that is never reused: removing and re-adding a Role creates a
new Assignment, so approvals and history tied to the old one never come back.

**Delegation** — A bounded management envelope letting a person assign approved Roles within exact
permissions, people, company and duration. A delegate can never escalate, self-assign, delegate
further or gain the module's future permissions automatically.

**Access change** — An item in Novinky v oprávněních describing what a module release added,
changed, renamed or split, with suggested Roles and affected people. It makes the change
configurable and visible, never usable.

**Adoption** — An explicit decision that adds a new or changed permission to a Role. Routine items
may be adopted in one batch per release; sensitive and critical items are adopted one by one with a
named effect. Only Adoption plus an Assignment makes a permission usable.

**Principal and agent** — In the authorization graph a Principal is a verified person: only
Principals of kind human become v2 `principal` subjects. AI agents are the separate `agent` subject
type, and service, integration and system Principals never appear in v2 relationships; they keep
their workload classification, which is not an agent.
_Avoid_: reading the general Principal entry (a person, integration, service, agent or system job)
as authorization vocabulary, or treating an agent as a kind of Principal that can approve or
administer.

**Mandate** — A person's single-use approval of one exact proposed command. In the graph it is bound
to the approver's exact execution and approval Assignments and their grants; the requester's exact
Assignment is bound in Core and re-checked at execution. It expires, and lapses permanently when the
bound authority is lost. Agents never hold or grant a Mandate.

**Agent connection** — A person's revocable, time-bounded consent for one agent to act for them in
one scope, with a ceiling on what the agent may reach. An agent's effective access is the
intersection of the person's access, the agent's own access and the connection.

**Scope fence** — The per-scope guard that lets only one access-changing operation alter a
company's or Tenant context's access at a time. While a change is in progress, readers see the access
state before the operation or after it, never a mix of old and new.

## External systems

**External Business System** — Live upstream or downstream system exchanging business facts with
OntOS. Its observed role must not be inferred from its product category.

**External Evidence Provider** — External registry or service that supplies observations used to
verify or enrich a business fact. It is not automatically the System of Record for the resulting
OntOS state.

**Connector Registry** — Module-owned correlation between an OntOS Resource and identifiers issued
by one External Business System or External Evidence Provider. The mapping does not transfer fact
ownership.

**Integration Route** — Configured exchange path for one External Business System and fact family,
such as one-time migration, Integration Hub route, or Direct Provider Adapter route.

**Integration Hub** — External system coordinating exchanges with several providers. Routing does
not automatically make it the System of Record.

**Symmy** — Preferred, non-exclusive Integration Hub for provider families it supports.

**Symmy Connector** — OntOS-to-Symmy boundary through which owning modules exchange
provider-neutral facts. It owns neither the facts nor downstream provider behavior.

**Direct Provider Adapter** — Owner-local adapter for a provider family intentionally outside
Symmy, or unsupported by it. It remains a private implementation detail.
