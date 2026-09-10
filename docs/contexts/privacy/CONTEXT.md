# Consent + Privacy language

Consent + Privacy is the shared OntOS privacy capability for processing purposes, legal-basis evidence,
privacy notices, Consent, Processing Eligibility, Data Subject Requests, retention/disposition, and
cross-owner privacy work. This context owns canonical privacy product semantics and vocabulary, not
storage, file layout, transport, provider implementation, or legal advice. It extends
`../ontos/CONTEXT.md`; when the two contexts conflict, the OntOS context and accepted ADRs govern.

## Product boundary

**Consent + Privacy** — One OntOS Foundational Module with Module Contract Identity `privacy`. It owns
privacy-specific facts, decisions, cases, policies, and coordination shared by Commerce,
Communications, Measurement, Content/Channel Applications, integrations, and other consuming
capabilities. The planning branches under issue #509 are capability areas of this one module contract;
they are not separate deployable modules unless a later accepted decision creates a real independent
public semantic boundary.

Consent + Privacy is not OntOS Core. Core continues to own generic authorization, Action execution,
audit, events/outbox, ResourceRef, Evidence Registry, and other business-neutral runtime guarantees.
Consent + Privacy uses those guarantees for privacy behavior.

Consent + Privacy is not a central personal-data store. Every owning capability remains the System of
Record for the Resources and business facts it owns. Privacy coordination uses public contracts and
stable ResourceRefs and never gains ownership merely by reading, referencing, exporting, restricting,
anonymizing, or deleting owner data.

## Language guardrails

**Privacy role versus identity** — Data Subject, Requester, Representative, Controller, Processor,
Recipient, DSR Resolver, Retention Rule Authority, and Legal Hold Authority are privacy or business
roles/responsibilities. They are not new Party, Principal, Legal Entity, account, or Permission types.
When a system operation is performed, the actual Actor remains a Principal under the OntOS context.

**Privacy responsibility versus authorization** — A privacy role or responsibility never grants a
Permission. Protected Actions and governed Reads still require the exact authorization required by
the owning module. A privacy Business Policy result never replaces authentication or authorization.

**Privacy responsibility versus fact ownership** — Controller/Processor/Recipient roles do not imply
System-of-Record ownership of the data. Conversely, an owning capability that is System of Record for
a Resource does not automatically become Controller, Processor, or Recipient for every processing of
that Resource.

**Current** — Always uses the canonical OntOS meaning: authoritative facts and Effective Periods at
the trusted operation time. A cached Consent, stored eligibility result, queued message, export, or
previous policy decision is not Current merely because it still exists.

**Historical truth** — Later privacy changes do not rewrite Accepted Facts, historical Snapshots,
previous Consent Decisions, previous Privacy Notice Provision facts, or previously proven execution
outcomes. Historical retention still requires its own applicable reason; historical status is not a
blanket retention exception.

**Customer** — Do not use unqualified `customer` when the privacy meaning is Data Subject, Party,
Requester, Principal, Controller, Retail Customer, Counterparty, or Commerce Customer Profile. Use the
exact role or Resource defined by its owning context.

**User** — Avoid `user` in canonical privacy rules where the actual meaning can be Data Subject,
Requester, Representative, Principal, visitor, or recipient. Resolve the concrete role.

**Subject** — Avoid bare `subject` when it could mean Data Subject, Purchasing Subject, Party,
Principal, or an anonymous context. Use `Privacy Subject` for the privacy-specific tagged meaning
below, or the exact underlying concept when known.

**Owner** — Avoid bare `owner` when it could mean Controller, data subject, account owner, or System
of Record. Say `owning capability` / `System of Record`, `Controller`, or the exact responsibility.

**Channel** — A channel is not universally part of every Consent scope. It is included only when the
channel changes the business meaning of the Consent or the governed processing, such as independent
EMAIL versus SMS marketing choices.

**Jurisdiction** — Jurisdiction/country/region facts can be inputs to a Privacy Applicability Policy,
but geography alone does not determine Controller, Consent scope, Legal Basis, DSR obligations, or
retention. Commerce Market may carry jurisdiction references, but is not itself a privacy regime.

**No legal inference from technical topology** — Tenant, Legal Entity, Selling Legal Entity,
Commerce Market, Storefront, hostname, Deployment Topology, provider, Integration Route, IP address,
locale, or client-supplied identifier must never silently determine privacy responsibility or legal
obligations. They may be trusted inputs only where an explicit Privacy Applicability Policy declares
their meaning.

## Privacy subjects and responsibility

**Data Subject** — The natural person whose personal data or privacy rights are being considered. Data
Subject is a privacy role, not a new OntOS identity type. The role does not require creation of a Party,
Principal, or account. When an existing Party safely represents the person, Consent + Privacy may hold
a stable ResourceRef to that Party without taking Party identity ownership.

**Anonymous Privacy Context** — Bounded context that allows a privacy choice or evidence to exist
without creating a Party, Principal, or account, for example a browser-scoped technology choice. It
is not the Commerce Guest Purchase Context and it is not automatically a legally anonymous dataset.
The term describes the lack of an asserted canonical person identity in this privacy flow. Later
login, Party matching, device reuse, or technical continuity does not silently convert it into a
Data Subject identity or personal Consent.

**Privacy Subject** — Explicit tagged privacy subject of a fact or decision: either a Data Subject
reference where sufficiently resolved, or an Anonymous Privacy Context where that capability supports
anonymous handling. A Privacy Subject is not a new identity registry and cannot hide uncertainty by
coercing one variant into the other.

**Requester** — Person or supported requester context that submits a Data Subject Request. Requester
is not automatically the Data Subject and does not gain authority merely by knowing or sharing a
Contact Point.

**Representative** — Requester acting for a Data Subject under evidence sufficient for the exact
requested scope. Representation is scope-bound and does not create general account, profile, Party,
or Counterparty authority.

**Controller** — Explicit privacy responsibility role holder for a declared Processing Scope. The
role may be held by a managed Legal Entity or another real organization represented by its canonical
owner; it is never inferred merely because that identity hosts a Storefront, sells an Order, stores a
record, or appears in a technical route.

**Processor** — Explicit privacy role holder processing personal data for a declared Processing Scope
under the relevant Controller responsibility. Processor is a role in the processing model, not an
Integration Route, provider category, or automatic System of Record designation.

**Recipient** — Explicit party or organization category that receives personal data in a declared
Processing Scope. A downstream system or provider is not automatically a Recipient merely because a
transport exists; the business disclosure/processing relationship must be explicit.

**Privacy Responsibility Assignment** — Effective, historically explainable assignment of one or
more Controller, Processor, or Recipient roles to a Processing Activity or narrower Processing Scope.
The assignment references existing identities and does not create another company/person registry.
Multiple Controllers are allowed when explicitly required; no implicit `primary controller` exists.

## Applicability and processing model

**Privacy Applicability Policy** — Explicit, versioned Controller/governance policy that determines
which privacy rules and obligations apply to an exact privacy operation or Processing Scope from
trusted business facts. It may use declared jurisdiction, Data Subject relationship/location where
legitimately relevant, Controller, Purpose Version, Commerce Market, Storefront, or other facts, but
must define their meaning explicitly. It is not an automatic legal-advice engine and has no silent
fallback to another legal regime.

**Privacy Applicability Decision** — Current, explainable decision produced from a specific Privacy
Applicability Policy version and trusted context. It records the exact scope and policy references
used by downstream Notice, Legal Basis, Consent, DSR, Processing Eligibility, and Retention behavior.
Missing, conflicting, or insufficient authoritative inputs remain explicit and fail closed where a
protected processing operation requires a reliable result.

**Personal Data Category** — Governed description of a category of personal data used to declare
Processing Activities, owner coverage, retention, export, and disposition scope. It classifies data;
it is not a copied payload or a central privacy-owned record.

**Processing Purpose** — Stable business meaning explaining why a declared processing exists. A
Processing Purpose is not Consent, Legal Basis, Permission, a provider, or a technical workflow.

**Purpose Version** — Historically distinct version of a Processing Purpose. A material change that
changes what the purpose means creates a new Purpose Version or new purpose identity; wording-only
changes that do not alter business meaning do not reinterpret historical processing.

**Processing Scope** — Exact business scope to which a privacy fact or decision applies. It includes
at least the relevant Controller, Purpose Version, Processing Activity or declared use, Privacy
Subject where applicable, Personal Data Categories, and any further dimensions whose difference
changes business meaning. Dimensions such as Channel, Storefront, Commerce Market, technology
category, recipient, or jurisdiction are included only when relevant to that exact rule.

**Processing Activity** — Privacy-owned description of a real processing activity and its approved
scope: Controllers, Processing Purpose/Purpose Version, Personal Data Categories, owning
capabilities, Recipients, downstream systems, applicable Privacy Applicability Policy references,
Legal Basis Assignment, and Retention Rule references as applicable. It is a map of processing and
responsibility, not a copy of personal data or an integration orchestrator.

**Legal Basis** — Typed legal basis used by a Controller for a declared Processing Scope under the
applicable policy. Consent is one possible Legal Basis where appropriate; it is never a universal
fallback for every Processing Activity.

**Legal Basis Assignment** — Explicit, Effective and historically explainable decision linking one
Legal Basis to an exact `Controller × Purpose Version × Processing Scope`. For the exact same scope
and time there is one unambiguous Current Legal Basis decision. Different legitimate Legal Bases
require distinguishable Processing Scopes; missing/conflicting basis is never repaired by a silent
technical fallback chain.

## Privacy notices and information

**Privacy Notice** — Privacy information intended for provision to a Privacy Subject in a declared
scope. Content/Channel Applications may own authoring or presentation, but Consent + Privacy owns the
privacy applicability and historical meaning of the information step.

**Privacy Notice Version** — Stable historical identity of exact notice wording in one language and
its declared applicability. It is distinct from Purpose Version and from Evidence Artifact. A later
Current text must never change what a historical Privacy Notice Version meant or contained.

**Privacy Notice Provision** — Historical privacy fact that a particular Privacy Notice Version was
actually provided for a specific Privacy Subject/context and business interaction at a stated time.
Publication, render attempt, queued delivery, or page availability alone is not proven provision.
The evidence references the exact version and actual language used without storing unnecessary
credentials, tokens, or request payloads.

**Material Privacy Change** — Change that alters the business meaning or material Processing Scope
relevant to a Privacy Subject. It is determined by semantic impact, not by textual diff size. A
material change can require new information and, where the new scope depends on Consent, a new Consent
Decision; publication of new text alone satisfies neither.

## Consent

**Consent** — Privacy business fact formed from an explicit, provable decision for one exact Consent
Scope. Consent is not a global boolean, Permission, account state, subscription, communication
preference, Contact Point verification, Terms acceptance, or proof of identity.

**Consent Scope** — Minimum stable business scope is `Privacy Subject × Controller × Processing
Purpose/Purpose Version`. Add Channel, Storefront, technology category/provider set, jurisdiction, or
another dimension only when that dimension changes what the person is deciding about. Two values of
a material dimension are independent Consent Scopes. A technical property is not added merely because
it is convenient as a database key.

**Consent Decision** — One historical decision in the Consent lifecycle: grant, refusal, withdrawal,
or a new grant after withdrawal. Absence of a decision is none of those states. Each decision preserves
its effective time, recorded time, provenance, relevant Privacy Notice Version/Purpose Version, and
Actor/flow evidence where applicable. Later decisions do not overwrite earlier decisions.

**Current Consent** — Current result derived for one exact Consent Scope from authoritative Consent
Decisions at the trusted operation time. It is not a mutable boolean field whose latest technical
arrival wins. Delayed older grants or retries must not resurrect a later withdrawn Consent.

**Marketing Consent** — Consent specialization for marketing Processing Purposes. Channel normally
is material here when EMAIL, SMS, PHONE, push, or another communication channel is independently
selectable. Marketing Consent remains distinct from subscription and communication preferences owned
by Communications.

**Technology Consent** — Consent specialization for cookies and comparable client technologies. It
may be scoped by Anonymous Privacy Context, Storefront/site, browser/device context, technology
category, Purpose, and provider set where those dimensions change the meaning of the choice. It uses
the common Consent lifecycle; it does not create a second consent registry or analytics identity.

## Processing Eligibility

**Processing Eligibility** — Consent + Privacy-owned Current Business Policy decision answering
whether personal data may be used for one exact intended Processing Scope according to relevant
Current privacy facts and Privacy Applicability Decision. It evaluates the applicable Legal Basis,
Consent, withdrawal, objection, restriction, and other privacy blockers without performing the
consumer operation.

A completed Processing Eligibility evaluation returns exactly one of:

- `ALLOWED` — relevant Current privacy facts allow the exact intended processing;
- `NOT_ALLOWED` — an authoritative Current privacy fact provides a definite blocking reason;
- `INDETERMINATE` — the required Current privacy facts or applicability cannot be resolved reliably.

`NOT_ALLOWED` and `INDETERMINATE` both fail closed for the protected processing. `ALLOWED` is not a
Permission and does not bypass authentication, authorization, module state, or a consuming module's
own Business Policy.

**Eligibility Evidence** — Minimal explainability of one Processing Eligibility result: exact
Processing Scope, trusted decision time, outcome/reason, Privacy Applicability Policy version, and
references to the authoritative facts/versions used. It must not become a copied personal-data
archive.

## Data Subject Requests

**Data Subject Request (DSR)** — One durable privacy Case for a Requester/Data Subject interaction.
One DSR can contain several requested rights and several Controller-specific obligations while
preserving a single intake and communication case. It is not six separate request systems and is not
a universal mutation/export engine.

**DSR Right** — Requested privacy right within a DSR, such as Access, Portability, Rectification,
Erasure, Restriction, or Objection. Each right preserves its own substantive scope and outcome even
when several rights share one DSR Case.

**DSR Controller Obligation** — Explicit sub-scope of one DSR for one Controller and one applicable
Privacy Applicability Policy result. It owns the Controller-specific requested rights, deadlines,
substantive decisions, owner tasks, and completion evidence needed to prevent obligations of several
Controllers or legal regimes from being silently collapsed into one rule. A single DSR Case can have
one or more Controller Obligations.

**DSR Resolver** — Narrative business responsibility of the Principal coordinating a DSR Case. It is
not a Principal type, role that grants Permission, or System of Record for owner data. Assignment and
reassignment preserve responsibility history and do not silently reset deadlines.

**DSR Verification** — Evidence that the Requester and any Representation are sufficiently verified
for the exact requested operation/risk. A shared Contact Point, active account, login, or Commerce
profile is not by itself sufficient proof for every DSR right.

**DSR Substantive Decision** — Controller-specific decision to grant, partially grant, or deny an
exact requested right/scope with an explainable reason. It is distinct from technical execution.
Owner outage or transport failure is not a substantive denial.

**DSR Owner Task** — Durable task sent to an owning capability through a Privacy Owner Contract for a
specific approved lookup, export contribution, correction, restriction, anonymization, or deletion
scope. Dispatch/acceptance is not execution success.

**Final DSR Response** — Response to the verified recipient that truthfully separates substantive
decisions, measures actually completed, justified exceptions/denials, and unresolved or technically
blocked work. Successful Case closure requires the response/delivery outcome required by the
applicable DSR contract; sending tasks alone is insufficient.

## Retention and disposition

**Retention Rule** — Versioned privacy rule scoped to a Personal Data Category or other exact
Record/content scope, relevant Controller, Processing Purpose, applicable policy, business start
event, duration/end semantics, and disposition behavior. Retention is never one global period for a
Data Subject.

**Retention Rule Authority** — Narrative business responsibility for governing Retention Rules. It
is not a Principal type or Permission grant.

**Retention Evaluation** — Current decision applying the relevant Retention Rule, exceptions, Legal
Holds, and owner facts to one exact Record/content scope. Periodic retention and DSR Erasure use the
same shared rule model.

**Retention Exception** — Explicit, evidenced, time/review-bounded exception for a precise
Record/content scope. An exception for one Resource does not retain every item of the same Data
Subject and does not itself authorize other processing.

**Legal Hold** — Explicit business/legal blocker of destructive disposition for a precise scope. It
has reason, authority, effective lifecycle, review, and release semantics. Legal Hold is not a blanket
Data Subject marker, Permission, Processing Purpose, Retention Rule, or storage feature.

**Legal Hold Reason Type** — Governed typed reason for a Legal Hold. Free-text justification may add
detail but cannot replace the governed reason type.

**Legal Hold Authority** — Narrative business responsibility authorized under the relevant governance
to activate, review, and release Legal Holds. The label itself grants no Permission.

**Storage-level WORM / Object Lock** — Uses the OntOS canonical meaning. It can technically prevent a
DELETE after a business Legal Hold has been released; this leaves execution blocked/pending but does
not make the Legal Hold active again and does not create a new retention reason.

**Disposition Decision** — Result of Retention Evaluation for an exact content scope. Supported
business outcomes are `RETAIN`, `RESTRICT`, `ANONYMIZE`, and `DELETE`. The decision is distinct from
confirmed owner execution. Hiding/archiving is not DELETE, and pseudonymization is not ANONYMIZE when
owner semantics still permit person identification.

## Privacy owner contracts and cross-module work

**Privacy Owner Contract** — Public business contract by which an owning capability contributes to
DSR, retention, or another approved privacy measure while retaining ownership of its Resources and
facts. Consent + Privacy never reaches through the contract into private owner tables/repositories.

**Owner Coverage Result** — Owner-declared result describing how completely the requested owner scope
was searched/evaluated. `NO_DATA` is valid only when the owning capability proves complete coverage of
the requested scope. An empty Core Search result, missing projection, or customer-facing history view
is not coverage proof. Partial and indeterminate coverage stay explicit.

**Owner Contribution** — Owner-produced contribution to an approved DSR output with explicit owner
scope, business/data instant, content classification, and completion state. Combining available
contributions does not make an incomplete result complete, and incompatible data instants must not be
silently presented as one coherent snapshot.

**Privacy Measure** — Approved owner-local action request such as correction, restriction,
anonymization, or deletion with exact Privacy Subject/Resource/content scope, decision reference,
expected outcome, and evidence expectation. The owning capability executes it through its own public
Actions/contracts and authorization boundary.

**Owner Execution Outcome** — Proven owner result for a Privacy Measure, distinguished from message
or transport success. It must support at least successful, partial, rejected/exception, and
indeterminate meanings as required by the exact contract. Retry after indeterminate outcome first
uses owner state/idempotency/Reconciliation rather than assuming failure or success.

**Cross-owner privacy workflow** — Coordination over independently owned modules using public
contracts, durable messages/outbox work, idempotency, and Reconciliation. It never opens a shared
business transaction, performs synchronous dual write, or fabricates rollback of an already committed
fact in another module.

**Anti-Resurrection Protection** — Minimal durable, scope-bound evidence required to prevent a proven
DELETE, ANONYMIZE, or current RESTRICT outcome from being silently reversed by stale import, event
replay, projection rebuild, or backup recovery. It does not retain the deleted payload, create a
global Data Subject blacklist, or block legitimately new processing based on new Current inputs.

## Evidence, access, and external systems

Privacy evidence uses the canonical OntOS `Evidence Artifact` and `Evidence Registry` concepts where
content proof is required. Evidence Registry does not become the System of Record for Processing
Purpose, Consent, DSR, Retention, or owner business facts and must not be used as a permanent payload
archive.

External Business Systems, External Evidence Providers, Processors, and Recipients keep their exact
business roles. Provider/product category and Integration Route never determine fact ownership or
privacy responsibility by themselves. External privacy measures use the owning capability's existing
Integration Route or adapter boundary; changing the route does not erase the business obligation or
historical provenance.

## Required cross-context invariants

1. `Party`, `Principal`, `Legal Entity`, `Counterparty`, `Commerce Customer Profile`, `Privacy Subject`,
   `Data Subject`, and `Anonymous Privacy Context` remain distinct concepts.
2. Consent never creates identity, authentication, Permission, subscription, profile binding, or
   Counterparty authority.
3. Party correction, Party Alias, Resource Alias, Party Merge, login, shared Contact Point, device
   continuity, or profile reconciliation never silently union or transfer Consent.
4. Commerce Market, Storefront, Selling Legal Entity, Tenant, provider, or Deployment Topology never
   silently determine Controller or Privacy Applicability.
5. Privacy Notice Provision, Terms acceptance, and Consent are separate facts.
6. Privacy Applicability, Legal Basis Assignment, Consent, Processing Eligibility, DSR substantive
   decision, owner execution, and retention/disposition are separate decisions/facts with independent
   ownership and evidence.
7. Processing Eligibility `ALLOWED` never creates Permission. `NOT_ALLOWED` and `INDETERMINATE` both
   fail closed for the intended privacy-protected processing.
8. DSR coordinates owner work but never writes canonical owner data directly.
9. One DSR Case may contain several Controller Obligations; Controller-specific applicable policies,
   deadlines, decisions, and outcomes must remain distinguishable.
10. Retention is evaluated per exact Record/content scope, not per whole person. Legal Hold blocks only
    its explicit scope and does not authorize other processing.
11. Historical Accepted Facts, Snapshots, Evidence Artifacts, and proven outcomes remain explainable
    without becoming blanket reasons to retain unrelated Current personal data.
12. No privacy workflow creates shared cross-module business transactions or synchronous dual writes.
13. Anti-Resurrection Protection preserves only the minimal scope/outcome evidence needed for
    enforcement and Reconciliation; it is never a hidden archive of deleted data.
