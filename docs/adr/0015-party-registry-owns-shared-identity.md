# ADR-0015: Party Registry owns shared identity

Status: Accepted.

## Context

ERP and Commerce both need to refer to the same real-world people and organizations. Without one
ownership rule, an imported organization, a manually entered Contacts customer, a commerce buyer,
and an external-system correlation can become competing identities. The word “Customer” also
conflates product configuration, commercial relationship, retail behavior, and Contacts workflow.

## Decision

Party Registry is a Foundational Module and the System of Record for tenant-scoped person and
organization identity outside the Tenant's managed Legal Entity structure. It owns sparse or
UNRESOLVED Parties, Official Identifiers, Contact Points, provenance-backed time-bounded Party
Relationships, shared Counterparties and their independently time-bounded roles, identity matching,
correction, and merge. Merge preserves existing references through Party Aliases.

A Legal Entity remains the Core-owned trusted scope Resource for one managed accounting or operating
company. Party Registry does not automatically mirror a Legal Entity as an ORGANIZATION Party.
Organization Registry owns shared groupings and views over managed Legal Entities, not their trusted
scope identity. Detailed operational boundaries, authorization scopes, atomic Party Create,
assertion semantics, merge readiness, and migration rules are defined by
[ADR-0018](0018-party-registry-operational-boundaries.md).

Other modules address Parties and Counterparties through public ResourceRefs and Party Registry
contracts. Contacts owns engagement profiles and workflows; Commerce owns retail, channel, and B2B
purchasing profiles and workflows. Neither duplicates shared Party identity. Connector Registries
own provider-issued external-ID correlations, and Principal authorization owns permission to buy,
approve, or administer access; a Party Relationship grants no authorization by itself.

Commerce also owns its separate Portal Account lifecycle and links each account/profile to stable
Party/Counterparty references. Registration and authentication do not move Party identity into
BetterAuth or Commerce; lifecycle events let Contacts, support/ticketing, analytics, and other
authorized consumers project the linkage without sharing an account realm.

Party Registry publishes identity and relationship lifecycle events for consumer projections.
Imports contribute observations and Party Candidates but cannot write a competing canonical Party.

Party records remain independently governed per Tenant. A future authorized analytical projection
may correlate them through explicit provenance-backed cross-Tenant links, but it must not collapse
them into one mutable global Party. Platform-wide reputation or risk scoring is outside this
decision and the current Commerce delivery.

## Considered options

1. **Let Contacts own shared identity.** Rejected because Contacts is a contextual workflow module
   and not every Party participates in Contacts.
2. **Let each module keep its own customer/person/organization copy.** Rejected because duplicate
   matching, correction, merge, and references would diverge.
3. **Use one global cross-Tenant Party directory.** Rejected because it breaks Tenant governance and
   creates an unjustified platform-wide identity authority.
4. **Automatically mirror every Legal Entity as a Party.** Rejected because it creates two canonical
   owners for one managed company and makes synchronization and recovery implicit.
5. **Use tenant-scoped Party Registry with module-owned contextual profiles.** Accepted because it
   centralizes Party identity lifecycle without centralizing every business meaning or permission.

## Consequences

- “Customer” must be qualified as Customer Configuration, Retail Customer, Counterparty Role,
  Contacts profile, or another explicit context.
- One Party may participate in several Party Relationships and Counterparty Roles without identity
  duplication.
- LegalEntityRef and PartyRef remain distinct; contracts do not convert them implicitly.
- Provider correlation and transport do not acquire authority over Party identity.
- Stable ResourceRefs and Party Aliases let consumers preserve references while Party Registry
  corrects identity.
- Contacts and Commerce schemas, APIs, and workflows must reference Party/Counterparty contracts
  instead of becoming alternative identity registries.
- Party identity Actions require explicit Tenant authority; Counterparty Actions require explicit
  Legal Entity or Counterparty authority.
- Core Search is a projection and cannot enforce Party uniqueness or decide Party Matching.

## Migration impact

OntOS is not live, so the current repository-owned Contacts customer and subordinate-contact
resources may be replaced with breaking schema, API, fixture, and code changes. No repository-only
backfill, compatibility layer, or dual-write period is required. Detailed Contacts design remains
deferred; the binding direction is that Contacts does not own shared Party identity.

A verified live External Business System or production dataset is different. It requires an explicit
Integration Route, fact ownership, reference inventory, mapping, reconciliation, cutover, and
rollback. A product label such as Contacts, a table name, or deployed code alone does not prove that
such a migration is needed.
