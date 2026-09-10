# Consent + Privacy language

Consent + Privacy is the shared OntOS privacy capability for processing purposes, legal-basis evidence,
privacy notices, Consent, Processing Eligibility, Data Subject Requests, retention/disposition, and
cross-owner privacy work. This context owns canonical product semantics and vocabulary, not storage,
transport, provider implementation, or legal advice. It extends [OntOS language](../ontos/CONTEXT.md);
OntOS context and accepted ADRs govern shared concepts. Commerce-specific concepts retain their owner
in [Commerce language](../commerce/CONTEXT.md).

These are product and target-contract semantics, not evidence that a runtime module, owner adapter,
legal configuration, or production workflow is implemented. GitHub issues own delivery scope and
readiness; code, contracts, configuration, and tests establish implementation reality.

## Product boundary

**Consent + Privacy** — One OntOS Foundational Module with Module Contract Identity `privacy`. It owns
privacy-specific facts, decisions, cases, policies, and coordination shared by Commerce,
Communications, Measurement, Content/Channel Applications, integrations, and other capabilities.
The eight planning branches under #509 are internal capability areas, not eight independently
deployable modules. Splitting public module semantics requires a subsequent explicit accepted decision.

Consent + Privacy is outside OntOS Core. Core retains business-neutral authorization, Action
execution, audit, events/outbox, ResourceRef, Evidence Registry, and runtime composition guarantees.
Privacy uses those guarantees; it does not introduce a parallel authorization, audit, or identity stack.

Consent + Privacy is not a central personal-data store. Each owning capability remains System of
Record for its Resources and facts. Reading, referencing, exporting, coordinating, restricting,
anonymizing, or deleting through public owner contracts does not transfer their ownership to privacy.
Privacy is itself the System of Record for its own privacy facts and applies retention to its own data.

## Language guardrails

**Privacy role versus identity** — Data Subject, Requester, Representative, Controller, Processor,
Recipient, DSR Resolver, Retention Rule Authority, Exception Authority, and Legal Hold Authority are
roles or business responsibilities, not new Party, Principal, account, or Permission types. An actual
protected system operation remains attributable to a Principal; Actor is its narrative name.

**Privacy responsibility versus authorization** — A role, Representation, identity verification,
Consent, applicability result, or Business Policy result does not create a Permission. Protected
Actions and governed Reads still use the owning contract's exact authorization and Module State Gate.

**Privacy responsibility versus fact ownership** — Controller/Processor/Recipient describes a role
in processing, not ownership of an OntOS fact. System-of-Record ownership likewise does not establish
one of those roles. A technical provider, Integration Route, or host does not become a legal role holder
merely because bytes pass through it.

**Current** — Uses OntOS meaning: authoritative facts and Effective Periods at trusted operation time.
A cached Consent, stored decision, queued task, export, or old policy result is not Current merely
because it exists. Effective Period starts are inclusive and ends exclusive unless the owning
capability explicitly defines otherwise. Effective time and recorded time are distinguishable facts.

**Historical truth** — Current changes do not recalculate Accepted Facts, retained Snapshots,
Consent Decisions, Privacy Notice Provisions, or proven execution outcomes. Immutability of retained
values is not unlimited retention of the Resource. Historical content needs its own applicable reason.

**Customer / User / Subject / Owner** — Qualify ambiguous wording. Use Data Subject, Requester,
Representative, Principal, Retail Customer, Counterparty, Commerce Customer Profile, Privacy Subject,
Controller, or owning capability/System of Record as appropriate. A broad role or label must not hide
a different identity, permission, or ownership model.

**Communication Channel** — Means of communication such as EMAIL, SMS, PHONE, or push when that
meaning is material to Consent or processing. It is not Commerce B2C/B2B Channel, a Channel Application,
or necessarily the channel where a choice was collected. A choice submitted on a website may govern
EMAIL marketing. Plans using `Channel` for EMAIL/SMS refer to Communication Channel, not Commerce Channel.
No channel dimension is mandatory for every Consent merely for persistence convenience.

**Jurisdiction** — Explicit legal/country/region context where relevant to approved applicability.
Geography alone does not determine Controller, Consent, Legal Basis, DSR, or retention. Commerce Market
may carry jurisdiction references but is not itself a privacy regime.

**No legal inference from topology** — Tenant, Legal Entity, Selling Legal Entity, Commerce Market,
Storefront, hostname, Deployment Topology, provider, Integration Route, IP address, locale, and
client-supplied identifiers cannot silently determine privacy responsibility or obligations. Approved
policies may use trusted business facts with an explicitly defined meaning; configuration is not
permission to waive an applicable legal requirement.

## Privacy subjects and responsibility

**Data Subject** — Natural person whose personal data or rights are being considered. This privacy
role does not require creation of a Party, Principal, or account. Where a Party safely represents that
person, privacy uses its stable ResourceRef without taking identity ownership. A supplied name,
Contact Point, or account identifier is not automatically verified Data Subject identity.

**Anonymous Privacy Context** — Bounded privacy context without an asserted canonical person identity,
for example a browser-scoped technology choice. It is not Party, Principal, Commerce Portal Account,
or Commerce Guest Purchase Context. `Anonymous` here does not claim that the associated data is
legally anonymized. Later login, device reuse, matching, or technical continuity does not convert
historical choices into personal Consent. Explicit linking preserves original provenance and does
not itself create a new Consent Decision.

**Privacy Subject** — Explicit tagged subject of a privacy fact: a sufficiently resolved Data Subject
reference or, only where supported, an Anonymous Privacy Context. It is not a new identity registry.
Unresolved intake may be recorded without coercing uncertainty into a supposedly verified subject;
sensitive reads and measures wait for their required assurance.

**Requester** — Person or supported request context submitting a privacy request or choice, including
a DSR. It is not automatically the Data Subject, Representative, or Principal executing the protected
system Action. Knowledge of a Contact Point does not establish authority.

**Representative** — Requester acting for a Data Subject with sufficient evidence for the requested
scope. It is a role, not itself a Party Relationship or a universal access grant.

**Representation** — Evidenced, scope-bound authority of a Representative for a particular Data
Subject and operation/right, with relevant validity and provenance. It does not create a general
Party Relationship, account binding, Counterparty access, or Permission. Verification and system
authorization remain separate gates.

**Controller** — Privacy role that determines why and how personal data is processed, alone or
jointly, in the declared Processing Scope. It can be a natural person, legal person, public authority,
or other qualifying body; it is not restricted to managed companies. In OntOS the assignment references
the existing canonical role-holder identity. Legal Entity and Party references remain distinctly typed;
no implicit mirror Party or conversion is created for a managed Legal Entity.

**Processor** — Privacy role processing personal data on behalf of the Controller in the declared
scope. Its real role holder is referenced through the relevant identity owner; it is not the
External Business System, Integration Route, or adapter used to perform the processing.

**Recipient** — Concrete real role holder to whom data is disclosed in a declared scope, subject to
applicable legal distinctions. A Recipient Category is not that concrete identity. One role holder
may also be a Processor in the same or another scope, but the roles are not inferred from topology.

**Recipient Category** — Governed grouping used where descriptions of recipients by category are
appropriate. It is not proof that every specific recipient is known or that downstream obligations
are complete. Actual known relevant recipients retain their concrete responsibility and outcomes.

**Privacy Responsibility Assignment** — Effective, historically explainable assignment of Controller,
Processor, or Recipient roles to a Processing Activity or narrower scope. Multiple Controllers remain
explicit; there is no implicit primary Controller. Changing arrangements preserves prior assignments.
Role-holder identity, role assignment, and the technical External Business System are distinct.

## Applicability and processing model

**Privacy Applicability Policy** — Explicit versioned Controller/governance policy resolving which
rules and obligations apply from trusted business facts. It can use declared jurisdiction, relevant
Data Subject context, Controller, purpose, market, or site where their meaning is approved. It is not
an executable general legal-advice engine or a silent fallback chain between legal regimes. Multiple
applicable layers require an explicit composition rule; unresolved conflicts remain unresolved.

**Privacy Applicability Decision** — Explainable result for one exact privacy operation/scope and
trusted time, preserving policy identities/versions and the facts used. Notice, Legal Basis, Consent,
DSR, Eligibility, and Retention use this shared model rather than incompatible local jurisdiction
resolvers. Missing mandatory applicability prevents dependent use, but does not prevent supported
DSR intake from recording an unresolved request. Applicability can evaluate a declared prospective
activity; an already-eligible activity is not a circular prerequisite for assessing its applicability.

**Personal Data Category** — Governed classification used for Processing Activities, coverage,
right-specific outputs, retention, and disposition. It is not a payload, a new Resource instance, or
a central copy. A category may span several owners only with distinguishable fact/Resource scopes.

**Processing Purpose** — Stable business reason why processing exists. It is not Consent, Legal
Basis, Permission, a provider, or a technical workflow identifier.

**Purpose Version** — Historically distinct definition of a Processing Purpose's meaning. Material
changes create a new definition/meaning or purpose identity; cosmetic wording cannot reinterpret
history. The exact definition relevant to a past decision stays explainable.

**Processing Scope** — Exact declared use and boundaries to which a privacy fact applies: relevant
Controller, purpose meaning/version, activity or intended use, Privacy Subject where required, data
categories, and any material recipient, communication, technology, market, site, or jurisdiction
dimensions. Policy-level scope and one operation's fully resolved scope are distinguishable. Missing
a required dimension is not a wildcard or permission to widen the operation.

**Processing Activity** — Privacy-owned map of real or proposed processing: purpose/version,
Controllers and roles, data categories and Systems of Record, relevant recipients and systems,
applicability, Legal Basis Assignments, retention references, and lifecycle/provenance. Proposed
activity is not Effective processing. Activation requires complete approved applicable inputs.
Material changes are historically distinct and require assessment of related Notice/Consent/Eligibility
and retention impacts. Ending an activity stops its new use but does not itself delete owner data.

**Legal Basis** — Typed legal ground assigned for a declared Processing Scope under the applicable
rules. Consent is one possible ground, never a universal substitute for missing configuration.

**Legal Basis Assignment** — Explicit Effective decision for `Controller × Purpose Version × exact
Processing Scope`. There is one unambiguous Current decision for that exact scope and time. Legitimate
different grounds require distinguishable uses/scopes, not an opaque fallback chain. Withdrawal or a
missing/expired ground does not authorize switching grounds silently. Assignments preserve historical
versions, reasons, and evidence without transferring fact ownership or Permission.

## Privacy notices and information

**Privacy Notice** — Privacy information intended for provision in a declared scope. Content may own
authoring/publication and Channel Applications own presentation; privacy owns notice meaning,
applicability, and the historical information-step fact.

**Privacy Notice Version** — Stable identity of exact notice wording/language and its declared
applicability. It is distinct from Purpose Version and Evidence Artifact. Changing current text creates
a distinguishable version and cannot replace wording used by a historical information step.

**Privacy Notice Provision** — Historical fact that a specific notice version and actual language
were provided for the relevant Privacy Subject/context and interaction, with business and recorded
time where different. Publication, a render/send attempt, queue receipt, or a page that could have
been visited is not proof for that interaction. Each supported channel defines sufficient provision
evidence; proof of reading or comprehension is not invented as a universal technical requirement.

**Material Privacy Change** — Change in meaning or material processing conditions, not textual diff
size. Affected subjects must be informed no later than application of that changed condition under the
approved contract. Where the new scope requires Consent, information alone is insufficient: a new
explicit Consent Decision is required. Editorial notice change can create a Notice Version without
changing purpose meaning or requiring new Consent.

Privacy Notice Provision, Terms acceptance, and Consent are separate facts. A common form submission
may record independently expressed choices; one compulsory acceptance of Terms must not silently
include optional marketing/technology Consent. Silence, preselected choices, closing a banner,
registration, and Order submission are not affirmative Consent by themselves.

## Consent

**Consent** — Privacy fact grounded in a demonstrable, freely made, specific, informed affirmative
choice for an exact Consent Scope. It is not a global boolean, Permission, account state, subscription,
communication preference, Contact Point verification, Terms acceptance, or identity proof. Withdrawal
must not be made harder than granting; a supporting flow must not require unnecessary account creation
or disproportionate identity evidence merely to stop its own consent-dependent use.

**Consent Scope** — Stable business scope: one Privacy Subject, one Controller, one Processing Purpose
with a precisely known meaning, plus dimensions that materially affect that choice. Decisions pin the
relevant historical Purpose Version and information evidence. `Processing Purpose/Purpose Version` in
plans means the named purpose with that pinned meaning, not interchangeable IDs or optional historical
evidence. An editorial information version alone does not create a new scope; changed purpose meaning
or materially expanded scope cannot inherit an old grant. Communication Channel is material for
independent EMAIL/SMS choices, not a universal required field for every kind of Consent. Scope dimensions
cannot be added or omitted merely to simplify a database key.

**Consent Decision** — One historical grant, refusal, withdrawal, or new grant after withdrawal.
Absence of a decision is not refusal or grant. Every decision preserves exact scope, effective and
recorded time, provenance, relevant versions, and actual Actor/flow evidence. Withdrawal ends relevant
Current effect, not the existence of the historical grant. Re-grant is new evidence and cannot
retroactively legitimize earlier use.

**Current Consent** — Result for one exact scope from authoritative decision history at trusted
operation time. Delayed older grants and retries cannot resurrect a later withdrawal. Indistinguishable
conflicting decisions require explicit resolution rather than arrival-time or row-order preference.
A new technical retry is not a new business choice.

**Marketing Consent** — Specialization using the common lifecycle for marketing purposes. Independent
Communication Channels have independent material scopes. Communications owns subscriptions and
preferences; neither creates Consent nor is automatically changed by every Consent transition.
A flow may explicitly perform both changes, preserving their separate facts. Contact Point verification
is another independent gate where required. Transactional use with a distinct purpose is not silently
blocked by an unrelated marketing choice, nor may marketing be relabeled transactional to bypass it.

**Technology Consent** — Common Consent lifecycle applied to cookies and comparable technologies,
using Anonymous Privacy Context or sufficiently evidenced personal context as supported. Site, device,
category, and provider set matter where they change the meaning of the choice. `COOKIE_CONSENT` is a
planning capability name for this specialization, not a second registry. A necessary-technology label
is not by itself a legal ground or allow decision. Missing/lost choice is not a grant. Material provider
or purpose changes require reassessment before new use.

Personal Consent is never reused for a different Data Subject. Cross-site/device reuse requires the
same legitimate scope and sufficient evidence; shared storage or login is insufficient. Anonymous
linking cannot rewrite who historically made a decision. Retail portal self-service uses Current
Retail Portal Profile Binding and the concrete `retail.consent.manage` Permission under Commerce
contracts; non-account flows are strictly operation-scoped and still use governed system entrypoints.
A verification token is sensitive access material, not durable Consent evidence.

## Processing Eligibility

**Processing Eligibility** — Privacy-owned Current Business Policy decision for an exact intended
Processing Scope. It evaluates applicable Legal Basis, relevant Consent, objection/restriction and
other required Current privacy facts without executing the consumer operation.

Exactly one outcome is returned for a completed evaluation:

- `NOT_ALLOWED` when a reliable applicable Current fact independently establishes a blocking reason
  for the exact intended processing, even if another input is unavailable;
- `INDETERMINATE` when a mandatory fact, scope, or applicability cannot be reliably resolved and there
  is no such established definite blocking reason;
- `ALLOWED` only when all necessary Current inputs are reliable and no applicable blocker remains.

The first two outcomes stop the intended use. A partial or older allow never overrides an unknown
mandatory blocker. ALLOWED is not Permission and never bypasses authentication, authorization, module
state, or another owner Business Policy. Confirmed absence of a required legal ground/Consent can be a
blocking fact; an unavailable source is not proof of that absence.

**Eligibility Evidence** — Minimal explainability of exact evaluated scope, time, outcome/reason,
applicability/policy revisions, authoritative fact references, and relevant currentness conditions.
It is not a copied archive, permission token, or perpetual guarantee for another operation.

**Eligibility Currentness** — Explicit conditions under which a decision remains usable for a concrete
consumer operation. There is no universal TTL. Each consumer declares its last controllable boundary
before irreversible use/handoff, required recheck and invalidation/race behavior. An earlier check or
pending invalidation event alone does not prove safety at that boundary. Missing required recheck
stops use. Proven past irreversible handoff is not rewritten by later withdrawal; indeterminate
handoff requires Reconciliation before a potentially duplicating retry.

## Data Subject Requests

**Data Subject Request (DSR)** — Durable privacy Case preserving original intake, received time,
requester context, requested scope, verification, responsibility, decisions, owner work, and response.
It can coordinate several rights and Controller obligations, not six separate engines. Intake can
remain unresolved without fabricating a Controller or identity. New intentional submission is a new
Case with its own received time; a transport retry is not. Where an intake concerns multiple people,
each person's verification, Representation, rights, and output scope remain separate.

**DSR Right** — Access, Portability, Rectification, Erasure, Restriction, or Objection requested within
a Case, with its own substantive and execution scope. Access is not ordinary portal history;
Portability is not automatically the full Access dataset. Rectification uses the named owner lifecycle;
Erasure uses the shared retention model. Restriction and Objection are not implicit Consent withdrawal.

**DSR Controller Obligation** — One Controller-specific obligation scope under an explicit applicability
result, preserving rights, deadline bases, decisions, tasks, and completion evidence. A resolved Case
can have several obligations. During intake unresolved portions remain explicitly unresolved; there
may initially be no resolved obligation. Decomposition never resets original receipt or invents a
later legal commencement. Different legal receipt bases require evidence, not assignment timestamps.

**DSR Resolver** — Narrative responsibility of the Principal coordinating the Case. Every open Case
has an identifiable Current responsibility and assignment history. Reassignment/substitution does not
create Permission, change original receipt, or reset a deadline.

**DSR Verification** — Proportionate assurance that the Requester, Data Subject resolution, and any
Representation support the exact operation. Existing trustworthy evidence may be reused where its
scope and freshness suffice. No account is universally required; no Contact Point, login, or profile
is automatically sufficient for every right. Verification does not create account bindings or wider
access and must avoid unnecessary sensitive evidence.

**DSR Substantive Decision** — Controller/right/scope-specific grant, partial grant, or denial with
an applicable reason and history. It is separate from owner execution and delivery. Technical failure,
missing coverage, or owner outage is not a legal denial. An owner rejection does not replace the
responsible Controller's substantive decision.

**Processing Restriction** — Effective privacy limitation on exact stored content or intended use,
with reason, decision, review/release, and enforcement evidence. In DSR descriptions `Restriction`
refers to the requested right or this resulting limitation as explicitly identified. It is not erasure,
archive, Consent withdrawal, or a whole-person flag. Overlapping restrictions remain independent;
release does not restore withdrawn Consent or another missing prerequisite.

**Processing Objection** — Evidenced objection and its applicable effect for an exact purpose/use,
kept distinct from the DSR intake, substantive assessment, and owner enforcement. An applicable
immediate effect cannot be postponed by an internal approval queue. Direct-marketing and other
objections use their own legal rules; resolving an objection does not silently create a new Consent
or Legal Basis. Plans using `Objection` must retain these distinctions.

**DSR Owner Task** — Durable Case/Controller Obligation/right-linked work item requesting supported
lookup, contribution, or execution through a Privacy Owner Contract. `DSR Owner Work Item` in older
discovery is the same concept, not another workflow. An intake does not automatically authorize its
sensitive tasks. Dispatch/acceptance is distinct from required outcome completion.

**Final DSR Response** — Truthful response separating substantive decisions, actual measures,
justified exclusions, and unresolved work per Controller/right scope. Coordinated Case handling must
not delay an earlier obligation's required response while another obligation remains open. Bounded
partial/interim responses can precede final Case response. Closure requires each relevant obligation's
supported outcome and the required delivery evidence, not merely dispatched owner tasks.

## DSR outputs and delivery

**Temporary DSR Export** — Bounded output prepared from approved Owner Contributions for Access,
Portability, or another permitted response. It is not a permanent archive, canonical owner record, or
automatically an Evidence Artifact. Its scope, capture times, identity/revision, secure availability,
and retention are explicit. Regeneration, when permitted, must not pretend to be the original output
or resurrect prohibited old source data.

**DSR Delivery Access** — Effective, output- and recipient-scoped access mechanism for one approved
DSR delivery. It is not a general OntOS Permission or portal binding. Approved policy determines
expiry; no universal TTL is implied. Revocation prevents new access. Reissue invalidates the previous
active access for the same delivery output when the new one takes effect; concurrent reissues must
not leave competing Current replacement accesses. Governed access still validates exact recipient,
output, system authorization, and Current access conditions.

**Successful DSR Delivery** — Proven successful sending or secure availability of the approved output
to the correct verified/authorized recipient through its approved delivery contract. It does not
require open/read/download proof. Queue acceptance, an attempted send, a generated file, or failed or
indeterminate handoff is insufficient. A later authoritative failure is recorded with a necessary
follow-up, not hidden by rewriting past observations. This is the qualified meaning of `Successful
Delivery` in DSR discovery, not a general guarantee for every messaging provider.

**DSR Delivery Evidence** — Minimal linkage of exact output/revision, verified recipient/Representation
scope, channel, policy, relevant business times, delivery result, and access lifecycle. It need not
retain the full output or usable access secrets. Access expiry, Case closure, and physical payload
deletion are distinct facts; expiry without a download does not undo already proven Successful DSR
Delivery under its contract.

## Retention and disposition

**Record Content Scope** — Precisely delimited owner Resource, field/content portion, artifact, or
explicit collection to which retention or a measure applies. `Record/content scope` in plans means
this business boundary, not a universal Record table or automatic whole-person aggregate. Multiple
subjects, purposes, or Controllers can have obligations over the same physical content; they must not
be ignored when evaluating destructive operations.

**Retention Rule** — Versioned rule for an exact Record Content Scope/category and relevant Controller,
purpose, applicability, business trigger, duration/end, and disposition behavior. Multiple legitimate
requirements need explicit applicability/composition, not arbitrary longest/latest/first-wins choice.
No generic module/table/Tenant/whole-person retention period is inferred.

**Retention Rule Authority** — Business responsibility for rule governance and approved applicability.
It is not a Principal type or Permission grant.

**Retention Period** — Interval determined from an authoritative business start event and the rule
version applicable to the content. Import, retry, replay, ordinary read, technical update, exception,
and hold activation/release do not restart it merely by occurring.

**Retention Rule Version Applicability** — Explicit determination of which version governs which
content. Without an approved decision applying a new version to existing content, a version change is
prospective-only. A changed Current catalog is not a silent migration of old content. Approved changes
to existing content preserve original business triggers, historical rule references, and outcomes.
This product default is not permission to ignore newly applicable legal obligations; required changes
must be expressly qualified, approved, and applied.

**Retention Evaluation** — Current evaluation using the rule versions applicable to the precise content,
Current exceptions/holds, all relevant legitimate obligations, and authoritative owner facts. DSR
Erasure and periodic evaluation share this model. Unresolved mandatory inputs remain an unresolved
evaluation: not fabricated RETAIN, DELETE, or a fifth substantive disposition outcome. Destructive
execution stops and responsibility for resolution remains; uncertainty is not unlimited-retention
justification.

**Retention Exception** — Evidenced, time/review-bounded exception for exact content with an approved
Exception Reason Type, Exception Authority, scope, validity, and provenance. Scope changes are explicit
and historically distinguishable, not necessarily a new Resource for every edit. One exception cannot
retain all of a person's data or authorize another processing purpose.

**Exception Reason Type** — Governed versioned meaning of an ordinary Retention Exception reason.
Free-text explanation supplements, not replaces, the approved reason. It is distinct from Legal Hold
Reason Type.

**Exception Authority** — Business responsibility for approving, reviewing, changing, and ending
ordinary retention exceptions. It is distinct from Retention Rule Authority and Legal Hold Authority.
These distinct responsibilities do not themselves require three different people or silently impose
a universal four-eyes rule; each protected operation still requires its exact Permission/governance.

**Legal Hold** — Explicit legal/business blocker of destructive disposition for exact content, with
reason type, responsible authority, effective time, review, release, and enforcement evidence. It is
not a blanket Data Subject marker, Permission, Processing Purpose, ordinary Retention Rule/Exception,
or storage feature. Overlapping holds are independent. Release of the last blocker triggers Current
Retention Evaluation; it neither resets the ordinary period nor performs an automatic DELETE.

**Legal Hold Reason Type** — Governed versioned legal-hold reason, distinct from an ordinary exception
reason. Free-text justification is supplementary, not a replacement for the approved type.

**Legal Hold Authority** — Business responsibility for authorized hold activation, review, change,
and release. The label itself does not grant a Permission or implicitly inherit another authority.

**Storage-level WORM / Object Lock** — Retains its OntOS meaning: provider-enforced technical
immutability. Ending a technical lock does not release a business hold; releasing a business hold does
not remove a technical lock. A DELETE blocked only by the lock remains DELETE with blocked/pending
execution, not RETAIN or a supposedly still-active business hold.

**Disposition Decision** — Substantive result for exact content: RETAIN, RESTRICT, ANONYMIZE, or DELETE,
separate from Owner Execution Outcome. RETAIN needs a real applicable reason; RESTRICT limits use
without claiming erasure. Hiding/archiving is not DELETE. ANONYMIZE requires supported evidence that
identifiability has actually been removed in the relevant context, not merely an owner label or removal
of direct identifiers while usable linkage remains. Pseudonymized content remains subject to privacy
rules. Technical inability to execute does not change the substantive decision.

**Historical Content Disposition** — Owner-supported end of retention for a historical Resource or
explicitly separable content. Retained Snapshot values are not recalculated from Current sources.
Deleting an eligible entire historical Resource is not rewriting values inside a retained Snapshot.
Partial removal needs the owner's explicit content lifecycle and truthful unavailable/redacted
representation; no generic permission to edit immutable Snapshots is created. Redacted bytes are not
the original Evidence Artifact. This retains OntOS/Commerce historical ownership boundaries.

Consent evidence, DSR case/verification evidence, Eligibility Evidence, delivery evidence,
Anti-Resurrection Protection, and temporary outputs have distinguishable retention purposes.
Withdrawal need not erase minimum consent evidence immediately; CLOSED DSR does not authorize keeping
all contributions forever. Full temporary exports are retained only for legitimate preparation,
approved delivery/access, and retry needs unless a separate applicable reason/exception/hold exists.
After that need ends, full payloads are disposed while minimal delivery evidence may remain. Privacy
must not become a replacement copy of data legitimately removed by another owner.

## Privacy owner contracts and cross-module work

**Privacy Owner Contract** — Public contract through which a capability contributes coverage, output,
or measures while retaining its Resources and facts. It declares supported scope, authorization,
currentness, idempotency, evidence, failure and recovery semantics. Privacy never reaches into private
owner tables/repositories or invents a generic mutation bypass.

**Privacy Owner Inventory** — Declared required owning capabilities and relevant historical, derived,
temporary, external-copy, and recovery responsibilities for an exact privacy scope. It connects
Processing Activities/categories to the real Application Composition without copying personal data.
Global completeness is checked against required owners, not only respondents. An unavailable,
disabled, or replaced module does not imply NO_DATA or erase retained obligations. Authorized recovery
or supported module operations must respect Module State Gate, not bypass it.

**Owner Coverage Result** — Owner evidence of how completely its requested scope was examined. Found
data and completeness are distinct. NO_DATA is valid only with full coverage; search absence or
missing portal history is insufficient. Partial, unavailable, and indeterminate portions stay explicit.
An owner does not claim completeness for other owners merely by completing its own scope.

**Owner Contribution** — Right-specific contribution with exact owner scope, coverage, content
classification/exclusions, its own observation/capture time, and completion. Different capture times
do not alone make otherwise complete contributions incomplete. The assembled output exposes those
times and cannot claim a global atomic Snapshot. Owner-local multi-batch consistency/completeness must
be explainable. Missing contributions are not legal exclusions and cannot disappear by merging all
available files. Later owner changes do not silently rewrite a captured contribution.

**Privacy Measure** — Approved exact-scope request for correction, restriction, anonymization, or
deletion, with stable work identity, source decision/revision, intended outcome and evidence expectations.
It is executed through the owning capability's public Actions. A retry retains the same meaning;
a changed target/payload under the same idempotency identity is a conflict. Before irreversible
execution, the owner contract must safely resolve Current target/blocker races and all legitimate
obligations over that content. An eventual event alone does not prove that a new hold cannot be missed.

**Owner Execution Outcome** — Authoritative owner result, distinct from transport acknowledgement.
Contracts distinguish receipt, in-progress, achieved, partial, business rejected/not-applicable,
technical failed, blocked/pending, and indeterminate meanings. This does not prescribe one universal
implementation enum. Each result matches the measure/revision, actual scope and business time;
late/misassigned confirmations cannot finish another task. Partial results preserve known progress.
Indeterminate mutation uses owner state/Action invocation/idempotency evidence and Reconciliation
before a potentially duplicating retry. Rejection does not rewrite a DSR Substantive Decision.

**Cross-owner privacy workflow** — Coordination of independently committed owner operations through
public contracts, durable messages/outbox, idempotency and Reconciliation. It cannot create a shared
business transaction, synchronous dual write, private cross-owner mutation, or fictional rollback of
another owner's committed result. A supported compensation is a separate business Action and cannot
be a shortcut to resurrecting legitimately deleted content.

## Anti-resurrection and external obligations

**Anti-Resurrection Protection** — Minimal durable exact-scope protection of proven DELETE/ANONYMIZE
and Current RESTRICT against stale import, replay, projection rebuild, or backup recovery. Completion
must not leave an unprotected window until a later message arrives. Evidence preserves needed scope,
outcome, references and provenance, not the original deleted payload or a global person blacklist.
Its own retention covers remaining relevant stale-source risks; safe retirement requires evidence,
not an arbitrary timestamp. It never blocks independent legitimate new processing with Current grounds
and a new legitimate input, but new grounds alone do not authorize reuse of the old removed copy.

**Privacy-safe Recovery** — Import/replay/rebuild/restore contract that reconciles relevant
post-backup authoritative privacy facts and owner outcomes before ordinary access or consumer use.
Restoring old protection metadata together with old content is not proof that later measures do not
exist. Unproven scope stays unavailable for that use; recovery may reopen only proven safe portions.
Recovery sources are technical copies, not canonical domain Snapshots or Systems of Record. Recovery
must not reset retention or falsify independently retained historical facts.

**External Privacy Obligation** — Exact role-holder/measure/scope-linked duty to notify, forward, or
obtain a required outcome through an owning integration boundary. These are different expected results:
notification is not proof of downstream deletion. All known relevant downstream Recipients/Processors
are included, not merely the first hop. Unknown required downstream scope remains unresolved. Existing
public contracts, Integration Routes, Symmy Connector or owner-local Direct Provider Adapters handle
provider work; privacy is not a second integration hub. Historical recipient A remains relevant after
replacement with Current provider B. Legitimate rejection/exception is distinguished from technical
uncertainty and cannot be bypassed through private provider access.

Privacy evidence uses OntOS Evidence Artifact/Evidence Registry where appropriate. These foundations
do not own privacy purposes, decisions, or business facts and are not permanent payload archives.
Production use requires approved concrete policies, rule applicability, reason catalogs, intervals,
owner inventory, public contracts and tested recovery. A catalog value or GOLD label is not that proof.

## Terminology aliases and authority

`DSR Case` means Data Subject Request. `DSR Owner Work Item` means DSR Owner Task. In privacy-owner
plans, unqualified `Execution Outcome` means Owner Execution Outcome, not Action transport status.
`Privacy Policy` in these plans means the relevant explicit Privacy Applicability Policy or the named
owning rule, not a generic configurable script. `COOKIE_CONSENT` names Technology Consent capability.
Lowercase `snapshot` used for a contribution's capture must not imply a canonical retained domain
Snapshot or a cross-module atomic transaction. Prefer observation/capture time for contribution data.

Shared definitions of Party, Principal, Legal Entity, Counterparty, ResourceRef, Resource Alias,
System of Record, Permission, Action, Reconciliation, Evidence Artifact and Evidence Registry remain
owned by OntOS context. Commerce owns Retail Portal Profile Binding, retail Permissions, Guest Purchase
Context, Commerce Customer Profiles, Commerce Market, Storefront and its accepted Snapshot meaning.
Neither glossary extension nor a planning example enables production Party Merge contrary to ADR-0018.

Legal terminology is grounded in the [GDPR definitions and consent conditions](https://eur-lex.europa.eu/eli/reg/2016/679/oj)
and the [European Commission guidance on legal grounds and consent](https://commission.europa.eu/law/law-topic/data-protection/information-business-and-organisations/legal-grounds-processing-data_en).
These references do not replace the Controller's explicit assessment of actual processing, applicable
jurisdictions, notice obligations, retention durations, or other deployment-specific legal requirements.
