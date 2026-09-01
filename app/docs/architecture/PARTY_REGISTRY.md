# Party Registry

This document defines current implementation rules for the `party.registry` Foundational Module. The
durable decision is [ADR-0018](../../../docs/adr/0018-party-registry-operational-boundaries.md).
General Action, governed Read, database, ResourceRef, event, outbox, authorization, and
MicroVertical rules still apply.

## Ownership

`party.registry` is the System of Record for:

- tenant-scoped Party identity;
- PERSON, ORGANIZATION, and UNRESOLVED Party type;
- Party Official Identifiers;
- Party Contact Points;
- Party Relationships;
- Counterparties and Counterparty Role periods;
- Party Matching decisions and Duplicate Candidate cases;
- Party Correction;
- Party Merge records and Party Aliases once merge is enabled.

It does not own:

- Legal Entity scope identity or lifecycle;
- Principal, credentials, sessions, or authorization grants;
- Contacts engagement profiles;
- Commerce purchasing profiles or Portal Accounts;
- employee, contract, order, invoice, procurement, or tax-profile lifecycle;
- provider-issued identifiers or transport state;
- physical search infrastructure;
- immutable snapshots owned by completed business documents.

## Resource boundaries

The initial public resources are:

```text
party.registry/
├── Party
├── PartyOfficialIdentifier
├── PartyContactPoint
├── PartyRelationship
├── Counterparty
├── CounterpartyRolePeriod
├── PartyMatchDecision
├── DuplicateCandidateCase
├── PartyCorrection
├── PartyMerge
└── PartyAlias
```

Every ResourceRef carries Tenant, module identity, resource type, and resource identity. Public
contracts never accept a raw identifier when a ResourceRef is required.

`PartyRef` and `LegalEntityRef` are different types. A handler must not construct one from the other.
A public contract that can refer to either uses a tagged union:

```ts
type OrganizationSubjectRef =
  | { readonly kind: 'party'; readonly party: PartyRef }
  | { readonly kind: 'legal_entity'; readonly legalEntity: LegalEntityRef };
```

Do not add this union to a contract that only needs one side. Counterparty always uses a PartyRef and
a LegalEntityRef explicitly.

## Action and Read scope

All state changes use declared Actions and require idempotency unless the general Action rules
explicitly justify otherwise.

| Capability                            | Legal Entity scope | Permission target            | Required authority                  |
| ------------------------------------- | ------------------ | ---------------------------- | ----------------------------------- |
| Party create/update/archive/unarchive | optional           | Tenant                       | manage Party identity               |
| Official Identifier add/end/correct   | optional           | Tenant                       | manage Party identity               |
| Contact Point add/end/correct         | optional           | Tenant                       | manage Party identity/contact data  |
| Party Relationship create/end/correct | optional           | Tenant                       | manage Party relationships          |
| Party Matching review                 | optional           | Tenant                       | review Party identity               |
| Party Merge                           | optional           | Tenant                       | merge Party identity                |
| Party Read/Search                     | optional           | Tenant                       | read Party identity/contact data    |
| Counterparty create/read/search       | required           | Legal Entity or Counterparty | read/manage that commercial context |
| Counterparty Role add/end             | required           | Counterparty                 | manage that commercial context      |

`legalEntityScope: optional` means trusted session context may contain a selected Legal Entity. It
does not scope the Party fact or grant authority. The Action payload never supplies or overrides
trusted Tenant or Legal Entity context.

A caller authorized only for one Legal Entity does not receive tenant-wide Party Search. It reaches a
Party through an authorized Counterparty Read and receives the explicitly declared minimum Party
projection required by that contract. Adding a field to that projection is an authorization and
privacy change, not a serializer convenience.

## Canonical persistence

Use owner-local PostgreSQL tables. No Party invariant depends on Core Search, Neo4j, a cache, or a
consumer database.

The initial logical table set is:

```text
party.parties
party.party_official_identifiers
party.party_identifier_claims
party.party_contact_points
party.party_relationships
party.counterparties
party.counterparty_role_periods
party.party_match_decisions
party.duplicate_candidate_cases
party.party_corrections
party.party_merges
party.party_aliases
```

Exact names may follow the repository's generated naming rules. The semantic separation is
required even when an implementation co-locates supporting records.

Every tenant-owned table has an explicit Tenant column, a tenant-qualified unique key for its
Resource identity, enabled and forced RLS, owner-local foreign keys, and no cross-MicroVertical
foreign key.

Required uniqueness invariants include:

```text
Party identity             unique (tenant_id, party_id)
Counterparty context       unique (tenant_id, party_id, legal_entity_id)
Party match decision       unique (tenant_id, action_invocation_id)
Party alias                unique (tenant_id, alias_party_id)
Strong identifier claim    unique (tenant_id, identifier_type_key, namespace, normalized_value)
Current preferred contact  type/purpose-specific partial uniqueness where the type allows one
```

A `party_identifier_claims` row exists only when the Identifier Type and verification/provenance
state permit an exclusive identity claim. An unverified or non-exclusive identifier assertion may
exist without a claim and cannot create an automatic MATCHED outcome.

## Party Candidate

A Party Candidate is an immutable request snapshot used before an existing or new Party is chosen.
It may contain:

- asserted Party Type or UNRESOLVED;
- names or labels with provenance;
- Official Identifier observations;
- Contact Point observations;
- Source Record References;
- Evidence Artifact references;
- caller intent and policy version.

A Party Candidate is not a Party and has no Party ID. A Source Record Reference identifies a record
inside one External Business System or migration dataset. It is neither an Official Identifier nor
evidence that a new real-world subject exists.

When matching is ambiguous, the Duplicate Candidate case stores the canonical decoded Candidate
snapshot and the evaluated evidence. It does not retain raw secrets or unbounded provider payloads.

## Atomic Party create

Party create must be safe under concurrent requests and projection lag.

```text
PartyCreate(candidate)
  normalize candidate with versioned type rules
  reject insufficient evidence that one real-world subject exists

  begin canonical transaction
    lock/reuse Action idempotency anchor
    resolve every qualifying strong identifier claim
    partition them into resolved Party claims and unclaimed claims

    if resolved claims point to several Parties or contradict authoritative evidence
      create/reuse DuplicateCandidateCase
      persist AMBIGUOUS PartyMatchDecision
      return AMBIGUOUS(caseRef, decisionRef)

    if resolved claims point to exactly one Party
      validate every remaining authoritative fact against that Party
      acquire every compatible unclaimed strong claim for that Party
        conflict means restart claim resolution in a fresh transaction
      insert accepted compatible assertions on that Party
      persist MATCHED PartyMatchDecision
      return MATCHED_EXISTING(partyRef, decisionRef)

    if no strong claim exists
      require explicit create-without-strong-identifier policy
      if review is required
        create/reuse DuplicateCandidateCase
        persist AMBIGUOUS PartyMatchDecision
        return AMBIGUOUS(caseRef, decisionRef)

    reserve every unclaimed qualifying claim for one prospective Party identity
    conflict means restart claim resolution in a fresh transaction
    insert one Party
    insert accepted initial assertions
    attach every reserved claim to that Party
    persist CREATED PartyMatchDecision
    collect PartyCreated and linked Outbox Messages
    return CREATED(partyRef, decisionRef)

  commit canonical state, decision/case state, Action evidence,
    Domain Events, linked Outbox Messages, and invocation success atomically
```

A preflight fuzzy search may improve user experience, but the transaction repeats every invariant
read against the Party Registry operational store. A result from Core Search is never sufficient to
create, match, or reject a Party.

The create Action result is:

```text
CREATED(partyRef, decisionRef)
MATCHED_EXISTING(partyRef, decisionRef)
AMBIGUOUS(caseRef, decisionRef)
```

Insufficient evidence that the Candidate represents one real-world subject is a typed domain
rejection and persists no Party Match Decision or Duplicate Candidate case. Identifier conflicts
that require durable review produce the committed `AMBIGUOUS` result instead of returning an Action
failure whose transaction would roll back the case.

`NO_MATCH` is an internal matching result, not proof that an insert will remain safe after the
transaction begins.

### Commit, publication, and recovery

`PartyMatchDecision` is the durable result reference for Party Create. It records the Action
Invocation, Candidate fingerprint, Match Rule version, outcome, and exactly one of `partyRef` or
`caseRef`. The decision commits in the same transaction as the resulting Party or Duplicate
Candidate case.

No search descriptor, projection update, consumer notification, or external publication occurs
before commit. The successful Action commits its Party-owned state, Audit and Data Access evidence,
Domain Events, linked Outbox Messages, Party Match Decision, and invocation success marker
atomically. Outbox Workers publish projections and integration effects only after that commit.

If the database acknowledgement is indeterminate, the caller uses the standard Action commit
resolution operation with the Action Invocation identity. A `succeeded` invocation proves commit;
the caller then performs a governed Party Match Decision Read by Action Invocation or caller
idempotency identity to recover the same `partyRef`, `caseRef`, and outcome. It never reruns create
because Party Search did or did not return a result. A repeated request with the same idempotency key
and request hash must resolve to the same committed decision without executing the handler again.

## Party assertion semantics

Fact families use separate schemas and type rules but share these semantics:

```text
assertionId
subject/resource identity
fact/type identity
normalized value or structured payload
validFrom / validTo          real-world effective time
recordedAt                   when OntOS learned the assertion
state                        active | ended | superseded | retracted | disputed
provenance                   source and method
verification                 state, verifier, verifiedAt
acceptedBy                   Action, Principal, policy version
supersedes/retracts          optional prior assertion reference
```

Rules:

1. `recordedAt` never substitutes for `validFrom`.
2. Ending a fact does not delete its assertion.
3. Correction retracts or supersedes a wrong assertion; it is not an in-place value overwrite.
4. A legitimate new real-world value ends the old period and adds a new assertion where the fact
   type is historical.
5. Formal validity, authoritative verification, freshness, and matching strength remain separate.
6. Raw provider payloads stay with the adapter or Evidence Artifact boundary. Party Registry stores
   bounded normalized evidence and references.
7. A current projection is derived from accepted assertion state and effective time.

Use the same vocabulary in code, schemas, events, and user-facing audit explanations. Avoid generic
`updated`, `removed`, or `verified` fields whose exact meaning cannot be determined from the type.

## Party Type

V1 values are:

```text
PERSON
ORGANIZATION
UNRESOLVED
```

UNRESOLVED means one evidenced real-world subject whose person-versus-organization type is unknown.
It is not an import staging row, anonymous Principal, missing-name placeholder, or Duplicate
Candidate case.

Allowed transitions:

```text
UNRESOLVED -> PERSON          enrichment
UNRESOLVED -> ORGANIZATION    enrichment
PERSON -> ORGANIZATION        correction
ORGANIZATION -> PERSON        correction
```

A Party Type change never creates a Principal, Counterparty, role, or module-owned profile.

## Official Identifiers

Initial Identifier Types are `ICO` and `CZ_DIC`.

Each Identifier Type declares:

- canonical key and human label;
- issuer/namespace and jurisdiction;
- normalization and formal validation;
- allowed Party Types;
- multiplicity and effective-time rules;
- whether a qualifying assertion may hold an exclusive claim;
- verification/provenance required for that claim;
- matching rules permitted to consume it.

Do not persist `OTHER`, generic `VAT_ID`, connector IDs, or Source Record References as Official
Identifiers.

`CZ_DIC` is the Czech tax identifier. Current VAT registration, payer status, reverse-charge
eligibility, and tax treatment remain outside Party Registry.

## Contact Points

Initial Contact Point Types are `EMAIL`, `PHONE`, and structured `ADDRESS`.

Contact Points are contactability facts, not credentials or identity keys. The same normalized email
or phone may belong to several Parties. Matching may use them only under explicit Match Rules.

ADDRESS may carry compatible purposes:

```text
REGISTERED
BILLING
DELIVERY
CORRESPONDENCE
```

BILLING and DELIVERY are reusable Party-level defaults only when independent of a Legal Entity,
Counterparty, contract, or transaction. Context-specific preferences remain with that context. A
completed document owns the exact address snapshot it used.

Any searchable Contact Point requires an explicit privacy classification and Read permission. Do
not index inactive, retracted, or disputed values as current facts.

## Party Relationships

A Party Relationship joins two Party Resources and never grants authorization.

Initial production type:

```text
CONTACT_PERSON_OF   PERSON -> ORGANIZATION
```

`EMPLOYEE_OF` remains deferred until a concrete external-organization use case proves it is not a
second employee/HR lifecycle. `BRANCH_OF` and `OTHER` are not production types.

Relationship endpoints and type are immutable. Changing either ends or corrects the old assertion
and creates a new relationship. Relationship periods may be open-ended but cannot overlap when the
type forbids overlap.

## Counterparty

A Counterparty is one durable commercial or contractual context:

```text
Counterparty = Party × Legal Entity
```

The tuple is unique per Tenant. A Counterparty is created only from provenance-backed evidence of a
commercial or contractual relationship. Knowing or displaying a Party is insufficient.

Initial role types are:

```text
CUSTOMER
SUPPLIER
```

Each role is a separate time-bounded period. Several roles may coexist. Ending one role does not end
another, the Counterparty, or the Party. A Counterparty may have no current role when the underlying
commercial context is still evidenced or retained historically.

`BUSINESS_PARTNER` is not a role. The Counterparty already represents the generic commercial or
contractual context. Future distributor, reseller, accounting-office, or other capacities require
named types with their own preconditions.

## Matching

Party Matching returns:

```text
MATCHED
NO_MATCH
AMBIGUOUS
```

Every decision records the Match Rule version and bounded evidence explanation.

Rule order:

1. contradictory authoritative claims -> AMBIGUOUS;
2. one qualifying exclusive claim -> MATCHED;
3. several candidate Parties after exact rules -> AMBIGUOUS;
4. weak signals -> candidate ranking only;
5. no qualifying evidence -> NO_MATCH.

Weak signals include names, unverified email/phone, address similarity, and provider classification.
No numeric score may override an authoritative conflict. An ML model may rank review candidates but
cannot produce canonical identity authority.

## Duplicate Candidate cases

A case is opened or reused when matching cannot safely decide. It contains:

- immutable Candidate snapshot;
- candidate PartyRefs;
- evaluated Match Rules and evidence;
- lifecycle state;
- assigned/reviewing Principal where applicable;
- resolution outcome, reason, and recorded time.

Allowed resolution outcomes are:

```text
MATCH_EXISTING
CREATE_NEW
CORRECT_CLAIM_AND_MATCH
NEEDS_EVIDENCE
DISMISSED_AS_NON_SUBJECT
CONFIRMED_DUPLICATE_PARTIES
```

`CREATE_NEW` is available only when a transactional recheck proves that every qualifying strong claim
is still unclaimed, or when the Candidate legitimately has no strong claim and the explicit
create-without-strong-identifier policy allows creation. It is forbidden while any qualifying strong
claim is owned by an existing Party. A reviewer cannot drop authoritative evidence merely to make
creation pass.

A case whose strong claims resolve to one or several existing Parties must instead match an existing
Party, correct/retract/reassign the wrong claim through an authorized Party Correction and then match,
confirm duplicate existing Parties for the separate merge flow, request evidence, or dismiss the input
as not representing a subject. Every resolution re-enters the atomic Party Create/Match boundary and
repeats claim resolution; the case decision alone never bypasses uniqueness.

Creating or reusing the case and its AMBIGUOUS Party Match Decision is a committed successful Action
outcome. Resolution is a separate Action. Repeated identical evidence reuses the prior open or
resolved case unless a new fact, policy version, or Candidate meaning changes the decision input.

## Correction

Correction applies only when a previously accepted Party-owned assertion was wrong at the time it
was asserted. It records:

- corrected assertion;
- correction reason;
- replacement or retraction;
- evidence and optional Evidence Artifact references;
- acting and approving Principals;
- policy version;
- affected current projections and emitted event.

Enrichment of a previously unknown value and legitimate real-world change are not corrections.
Correction does not merge two Parties.

## Merge

Production merge remains disabled for the initial implementation. The schemas and contracts may be
prepared, but no Action is published as executable until the following behavior is tested end to
end:

1. same-Tenant duplicate confirmation;
2. deterministic survivor selection;
3. Party-owned assertion conflict resolution;
4. Counterparty collision resolution;
5. alias-chain flattening and cycle rejection;
6. consumer dry-run collision detection;
7. atomic merge record, aliases, events, and outbox;
8. idempotent consumer reconciliation;
9. failure and wrong-merge recovery without dangling ResourceRefs.

Required merge event shape:

```text
PartyMerged {
  tenantId
  mergeId
  survivorPartyRef
  absorbedPartyRefs[]
  occurredAt
  policyVersion
}
```

The event contains identities, not mutable Party payload copies. Consumers resolve current state
through public Party Registry contracts.

A consumer that owns at most one profile per Party must provide real behavior for collision
detection and reconciliation. A descriptor or marker without tested behavior does not make merge
safe.

## Search

OntOS Core Search owns the physical projection and query runtime. Party Registry publishes safe
search descriptors and lifecycle events.

V1 Party Search fields:

- current display name or organization name;
- active Official Identifiers;
- active EMAIL and PHONE Contact Points when the caller has the required permission.

V1 Counterparty Search adds required Legal Entity scope and current CUSTOMER/SUPPLIER filters.
Archived Parties are excluded by default and may be included explicitly. Party Alias hits resolve to
the canonical Party and never appear as a second current Party.

Search remains eventually consistent. Reads by ResourceRef, exact identifier claims, create
uniqueness, correction, and merge resolution use the canonical Party Registry store.

## External evidence

ARES is an External Evidence Provider reached through an owner-local Direct Provider Adapter or an
approved Symmy Connector and an explicit Integration Route.

The read side returns bounded normalized evidence with source and observed time. It does not mutate
Party state. Applying evidence invokes Party Registry Actions fact by fact.

Initial delivery may support read-only ARES lookup for ICO. Automatic conflict correction, merge, or
bulk field overwrite is excluded.

Connector Registry owns provider-issued record correlations. It does not own ICO, CZ_DIC, Party
identity, or the accepted Party state.

## Contacts replacement

The repository's current Contacts implementation is not a production System of Record. Replace it
with a breaking change:

```text
current Contacts customer/contact identity
  -> Party Registry Party/Contact Point/Relationship/Counterparty Resources
  -> Contacts-owned engagement profile referencing PartyRef/CounterpartyRef
```

Required implementation sequence:

1. publish Party Registry Resources, Actions, Reads, and events;
2. add Contacts PartyRef/CounterpartyRef contracts;
3. move shared identity writes to Party Registry Actions;
4. make Contacts own only engagement profile/workflow facts;
5. remove legacy Contacts customer and subordinate-contact identity ownership;
6. update tests and fixtures to create Party state through public contracts.

Do not build repository-only backfill, dual-write, compatibility aliases, or long-lived migration
mapping. Create a migration only when a verified live External Business System or dataset exists.

## Required focused validation

The initial implementation is not complete until these behaviors pass:

- two concurrent creates with the same qualifying ICO produce one Party;
- projection lag cannot produce a duplicate Party;
- a conflicting authoritative identifier commits one ambiguity case and one Party Match Decision;
- an insufficient-subject-evidence rejection commits neither a case nor a decision;
- an indeterminate Party Create commit recovers the same outcome through invocation resolution and
  Party Match Decision Read;
- a repeated idempotent Party Create never executes the handler again and resolves the same result;
- unverified shared email or phone never auto-matches;
- cross-Tenant identifier equality never resolves or conflicts across Tenants;
- a Legal Entity cannot be supplied where PartyRef is required;
- a Legal-Entity-only Principal cannot perform tenant-wide Party Search;
- Counterparty uniqueness holds under concurrent create;
- CUSTOMER and SUPPLIER periods coexist and end independently;
- ending the final role preserves the Counterparty;
- correction preserves the old assertion and removes it from current matching/search use;
- archived Party ResourceRefs remain readable but are unavailable for new selection;
- every Action emits only declared Domain Events and linked Outbox Messages atomically;
- all Party tables enforce Tenant isolation with enabled and forced RLS;
- Contacts no longer owns shared person/organization identity after the breaking replacement.

Run the smallest affected dependency cone for each implementation increment. File presence, a
manifest declaration, or a generated marker is not evidence that these behaviors work.
