# OntOS language

Use these terms consistently across product, architecture, and implementation discussions. This
context defines language only; it does not override accepted ADRs or current application guidance.

## Language guardrails

**Customer** — Never a standalone canonical identity type or generic aggregate. Always qualify the
meaning, for example Customer Configuration, Retail Customer, Counterparty Role `CUSTOMER`,
Engagement Profile, Commerce Retail Customer Profile, Commerce Counterparty Purchasing Profile, or
Customer Archive. Avoid `customer`, `customer record`, `customer ID`, and `B2B Customer` when the
intended subject is actually a Party, Counterparty, Principal, account, role, or contextual profile.

**Actor** — Narrative name for the Principal performing or attempting one concrete operation. Actor
is not a separate identity object and must not be used as a synonym for Party, person, account, or
permission holder without resolving the Principal.

**Permission** — Explicit authorization allowing one Principal to perform one declared Action or
governed read against a Resource and scope. A Party Relationship, Counterparty Role, selected
context, profile membership, account session, or Business Policy result is not a Permission.

**Business Policy** — Module-owned condition or decision evaluated from trusted context and business
facts after authentication and authorization boundaries. It may allow, deny, require approval, or
select a typed business outcome; it never creates identity, authentication, or Permission.

**Current** — Valid from authoritative facts, Permissions, Business Policies, and Effective Periods
at the trusted operation time. A value retained by a client, cache, Cart, or previous evaluation is
not Current merely because it still exists.

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

**OntOS Business Module** — A product capability normally implemented as a MicroVertical and
published through an OntOS Module Manifest.

**Foundational Module** — A Business Module that owns shared business reality used by several
domains. It remains outside Core because its concepts evolve through domain discovery.

**Organization Registry** — Foundational Module for shared organizational groupings and views over
managed Legal Entities. It is not a Core company registry or a corporate ownership ledger.

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

**OntOS Module Manifest** — Effect Schema-defined public module contract. It declares identity,
dependencies, Actions, APIs, components, Resource types, events, search, and reports, but excludes
private tables, migrations, handlers, registrations, routes, fixtures, and tests.

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

**Legal Entity** — Managed accounting or operating company inside a Tenant. External organizations
remain Parties unless the Tenant manages them as part of its own structure.

**Principal** — Canonical Actor used for authentication resolution, authorization, invocation, and
audit. It may represent a person, integration, service, agent, or system job.

**Principal Auth Binding** — Core-owned non-secret mapping from a stable external authentication
subject to one Tenant-scoped Principal. The authentication provider continues to own credentials
and sessions.

**Authenticated Principal Session** — Staff session context that activates exactly one valid
Tenant-scoped Principal and Tenant. Selecting context grants no authority and is revalidated.

**Party Registry** — Foundational Module and System of Record for Tenant-scoped shared person and
organization identity, Official Identifiers, matching, correction, merge, Contact Points, Party
Relationships, and Counterparties.

**Party** — Real-world person or organization OntOS deals with. Its identity may be sparse or
Unresolved while evidence is incomplete.

**Unresolved Party** — Party with a stable Resource identity but insufficient evidence to assert a
complete or uniquely matched real-world identity. It may participate only where the owning Business
Policy permits. Later matching, correction, or merge preserves provenance and addressability; it does
not grant Permission or rewrite Accepted Facts.

**Official Identifier** — Identifier issued or recognized by an authoritative registry or public
body for a Party or Legal Entity, such as a company-registration or VAT identifier. Its value,
jurisdiction, type, validity, and provenance are Party Registry facts. An Official Identifier is not
a Principal, account, Party Relationship, Counterparty Role, or authorization proof.

**Party Relationship** — Provenance-backed, time-bounded association between Parties. It does not
grant authorization.

**Contact Point** — Email address, telephone number, or postal address through which a Party may be
contacted. It does not by itself prove identity or authority.

**Counterparty** — Commercial or contractual relationship between one Party and one managed Legal
Entity.

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

**Neo4j Projection** — Optional rebuildable read model for selected business relationships. It is
never canonical operational storage or an authorization dependency.

**Evidence Artifact** — Durable content retained as proof for audit, compliance, or investigation.
Its content identity is based on exact bytes, not a display filename.

**Evidence Registry** — Core references connecting Evidence Artifacts to the facts they substantiate,
their hashes, retention, classification, legal hold, and verified storage immutability. It is not a
payload archive, trace store, or financial ledger.

**Storage-level WORM / Object Lock** — Provider-enforced immutability of stored artifact bytes.
Database rules may protect application behavior but cannot claim provider-enforced WORM.

## External systems

**External Business System** — Live upstream or downstream system exchanging business facts with
OntOS. Its observed role must not be inferred from its product category.

**Connector Registry** — Module-owned correlation between an OntOS Resource and identifiers issued
by one External Business System. The mapping does not transfer fact ownership.

**Integration Route** — Configured exchange path for one External Business System and fact family,
such as one-time migration, integration-hub route, or direct provider route.

**Integration Hub** — External system coordinating exchanges with several providers. Routing does
not automatically make it the System of Record.

**Symmy** — Preferred, non-exclusive Integration Hub for provider families it supports.

**Symmy Connector** — OntOS-to-Symmy boundary through which owning modules exchange
provider-neutral facts. It owns neither the facts nor downstream provider behavior.

**Direct Provider Adapter** — Owner-local adapter for a provider family intentionally outside
Symmy, or unsupported by it. It remains a private implementation detail.
