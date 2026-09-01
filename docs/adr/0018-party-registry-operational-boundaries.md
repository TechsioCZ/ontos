# ADR-0018: Party Registry operational boundaries

Status: Accepted.

## Context

ADR-0015 assigns shared tenant-scoped person and organization identity to Party Registry. The
planning tree for issue #179 adds matching, correction, merge, Counterparties, Contact Points,
external evidence, search, and Contacts replacement. Several boundaries must be explicit before
those capabilities can be implemented without later replacing the identity model:

- a managed Legal Entity is also a real organization, but it is already a trusted Core scope
  Resource;
- a Party is tenant-wide while many staff permissions are limited to one Legal Entity;
- matching followed by create is unsafe when two requests race or when it reads an eventually
  consistent search projection;
- identity facts need one temporal and provenance model across identifiers, contacts,
  relationships, correction, and merge;
- preserving an absorbed Party ID is necessary but not sufficient when consuming modules own
  colliding profiles;
- the repository's current Contacts implementation is not a live authority, while a real External
  Business System may require a governed migration.

## Decision

### Legal Entity and Party stay distinct

A **Legal Entity** is the Core-owned trusted scope Resource for one managed accounting or operating
company inside a Tenant. Core owns the minimum identity and lifecycle required to establish and
validate that scope. Accounting, tax, banking, organizational-group, and other business profiles
remain with their respective owners.

An **ORGANIZATION Party** represents an organization outside the Tenant's managed Legal Entity
structure. Party Registry does not automatically create a companion Party for a Legal Entity and
does not copy a Legal Entity into Party state.

Organization Registry owns shared organizational groupings and views over managed Legal Entities.
It does not replace Core's Legal Entity scope identity and does not turn Legal Entities into Parties.

Public contracts use distinct `LegalEntityRef` and `PartyRef` values. A flow that can target either
uses an explicit tagged union or two explicit fields; it never relies on implicit conversion. A
Counterparty always joins one Party to one Legal Entity. Intercompany relationships between two
managed Legal Entities are not Counterparties in this decision.

If a future use case requires the same real-world organization to be represented on both sides of
this boundary, it requires a new accepted decision for an explicit correlation Resource, uniqueness,
ownership, synchronization, and recovery. V1 has no implicit mirror or correlation.

### Party and Counterparty authorization are different

Party identity is tenant-scoped. Party create, update, archive, correction, matching review, and
merge Actions declare `legalEntityScope: optional` and target a Tenant permission. Their public
contracts never accept a caller-supplied trusted Tenant or Legal Entity identity.

Counterparty and Counterparty Role Actions declare `legalEntityScope: required` and target the
selected Legal Entity or the Counterparty Resource as required by the operation.

A Principal with access to one Legal Entity does not automatically gain tenant-wide Party search or
unrestricted Party Contact Point access. Tenant-wide Party Read/Search requires an explicit Tenant
permission. A Legal-Entity-scoped flow reaches a Party through an authorized Counterparty contract
and receives only the Party fields declared by that contract. Party Registry does not create a
second authorization model; Actions and governed Reads use the existing CoreSDK and SpiceDB
boundaries.

### Party create owns an atomic identity decision

All Party state changes are declared Actions. Party create requires idempotency.

`PartyCreate` does not implement `search, then insert`. Inside one canonical PostgreSQL transaction
it:

1. decodes and type-normalizes the Party Candidate;
2. resolves exact active identity claims from the Party Registry operational store and
   partitions them into resolved Party claims and unclaimed claims;
3. creates or reuses a Duplicate Candidate case when resolved claims point to several Parties or
   authoritative evidence conflicts;
4. when all resolved claims point to one Party, validates every remaining authoritative fact and
   atomically acquires every compatible unclaimed claim for that Party before returning it;
5. when no claim resolves, acquires or conflicts on every type-specific uniqueness claim before
   creating one Party and its accepted initial assertions;
6. restarts canonical claim resolution after a concurrent claim conflict instead of trusting a stale
   preflight result;
7. stores one Party Match Decision linked to the Action Invocation and resulting Party or case.

`CREATED`, `MATCHED_EXISTING`, and `AMBIGUOUS` are committed Action results. Ambiguity is not an
Action failure whose rollback would erase the review case. Insufficient evidence that the Candidate
represents one real-world subject remains a typed rejection and commits no Party Match Decision or
case.

Party state, identifier claims, Party Match Decision, Duplicate Candidate case where applicable,
Audit and Data Access evidence, Domain Events, linked Outbox Messages, and the Action invocation
success marker commit atomically. Nothing is published to search or consumers before that commit.

If database acknowledgement is indeterminate, the caller uses the standard Action commit-resolution
operation. A succeeded invocation proves commit, and a governed Party Match Decision Read recovers
the same result by Action Invocation or caller idempotency identity. The caller never retries create
because an eventually consistent search result is absent.

Core Search, Neo4j, caches, and other projections are never used to enforce identity uniqueness.
Weak-signal matching may rank candidates, but it cannot replace the transactional exact-claim
invariant. Creating a Party without a strong identifier is an explicit policy path and may require an
Identity Reviewer. A Duplicate Candidate resolution may authorize `CREATE_NEW` only after a canonical
transactional recheck proves all qualifying strong claims are unclaimed. Claims already owned by an
existing Party must be matched, explicitly corrected/reassigned, or resolved through the duplicate
existing-Party flow; authoritative evidence cannot be silently discarded to create another Party.

### Party facts share assertion semantics

Official Identifiers, Contact Points, Party Relationships, Counterparty Roles, and other historical
Party facts use one semantic model even when stored in separate owner-local tables.

Each assertion records, where applicable:

- stable assertion identity and Tenant;
- owning Party, Counterparty, or relationship Resource;
- fact/type identity and normalized value;
- `validFrom` and optional `validTo` for real-world validity;
- `recordedAt` for when OntOS learned the assertion;
- lifecycle state such as active, ended, superseded, retracted, or disputed;
- provenance and optional Evidence Artifact references;
- verification state, verifier, and verification time;
- Action, Principal, and policy version that accepted or changed the assertion.

`current` is derived from lifecycle and validity; it is not an unversioned overwrite. Formal
validity, provenance, authoritative verification, freshness, and matching strength are separate
concepts. A correction retracts or supersedes a wrong assertion and preserves why it changed.

### Counterparty is a durable context

For one Tenant, the tuple `(partyId, legalEntityId)` identifies at most one Counterparty. The
Counterparty may temporarily have no current role when the commercial or contractual context is
independently evidenced. CUSTOMER and SUPPLIER are independent time-bounded Counterparty Roles.
Ending the final role does not archive the Party or delete the Counterparty.

V1 has no implicit Counterparty end triggered by role count. A future explicit Counterparty end
capability requires its own business meaning and recovery rules.

### Merge requires consumer reconciliation, not only aliases

A Party merge preserves every absorbed Party ID as a resolvable Party Alias to one canonical
survivor. New writes must target the survivor.

Before merge commit, Party Registry performs a preflight over its own facts and the declared
first-party consumer contracts. It must detect at least:

- duplicate Counterparties for the same Party and Legal Entity after resolution;
- incompatible active Official Identifier assertions;
- overlapping relationship or role periods forbidden by their types;
- multiple module-owned profiles whose owner declares a uniqueness invariant per Party;
- conflicting Connector Registry correlations.

Party-owned consolidation, the merge record, aliases, Domain Events, and Outbox Messages commit
atomically in the merge Action. Consumers reconcile their own state idempotently from the published
merge event. A consumer profile is never silently rewritten by Party Registry.

Merge execution stays disabled until every in-scope first-party consumer has a tested collision and
reconciliation contract. Absorbed Party state and the merge journal are retained; hard deletion is
forbidden. Recovery from a wrong merge must be designed and tested before production merge is
enabled. Alias preservation alone is not accepted as recovery.

### Search is a projection, never identity authority

**OntOS Core Search** owns the rebuildable physical projection, query execution, and standard
authorization gate. Party Registry owns searchable field semantics and publishes descriptors and
lifecycle events.

Party Search finds known Parties. Party Matching decides whether a Party Candidate represents an
existing Party. Search ranking, a returned search result, or an index hit never creates a MATCHED
outcome.

### External evidence and migration use named integration boundaries

An External Evidence Provider or External Business System contributes observations. It never writes
canonical Party state directly. Provider-issued identifiers are held by Connector Registry and the
exchange runs through an explicit Integration Route using a Symmy Connector or Direct Provider
Adapter as appropriate. Party Registry applies accepted evidence through its own Actions.

The current repository Contacts implementation is replaceable evidence, not a live System of
Record. Its customer and contact identity resources may be broken and replaced directly. No
compatibility layer, backfill, or dual-write is required for that repository-only replacement.

Migration work is created only for a verified live External Business System or dataset. Such work
must identify the exact fact owner, reference inventory, mapping, reconciliation, cutover, and
rollback. The product category `Contacts` or a table name is not proof of authority or active use.

## Initial delivery cut

The initial implementation includes:

- Party create/read/update/archive with PERSON, ORGANIZATION, and tightly governed UNRESOLVED;
- ICO and CZ_DIC Official Identifier types;
- EMAIL, PHONE, and structured ADDRESS Contact Points;
- Counterparty with CUSTOMER and SUPPLIER role periods;
- exact authoritative matching and atomic create claims;
- tenant-level Party authorization and Legal-Entity-scoped Counterparty authorization;
- Party/Counterparty search descriptors;
- explicit correction of Party-owned assertions;
- direct breaking replacement of the repository's current Contacts identity ownership.

The initial implementation excludes until a concrete use case and tested contract exist:

- generic OTHER identifier or relationship values;
- BUSINESS_PARTNER and BRANCH_OF production types;
- fuzzy auto-match;
- production merge execution;
- automatic ARES conflict application;
- long-lived dual-write or compatibility for the repository-only Contacts implementation.

## Consequences

- Core continues to own the trusted Legal Entity scope Resource without becoming a general company
  registry.
- Party Registry remains the sole owner of Party identity and cannot mirror managed Legal Entities.
- Tenant-wide identity permissions and Legal-Entity-scoped commercial permissions remain explicit.
- Party creation is safe under concurrency and projection lag.
- Every Party fact family can preserve history, provenance, verification, and correction coherently.
- Merge cannot ship before consumer collisions and recovery are real, tested behavior.
- Planning issues describe delivery work; this ADR and the implementation document own the durable
  boundaries.
