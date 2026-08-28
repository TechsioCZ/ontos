# ADR-0015: Party Registry owns shared identity

Status: Accepted on 2026-08-28.

## Context

ERP and Commerce both need to refer to the same real-world people and organizations. Without one ownership rule, an imported organization, a manually entered CRM customer, a commerce buyer, and an external-system correlation can become competing identities. The word “Customer” also conflates product configuration, commercial relationship, retail behavior, and CRM workflow.

## Decision

Party Registry is a Foundational Module and the System of Record for tenant-scoped person and organization identity. It owns sparse or Unresolved Parties, official identifiers, Contact Points, provenance-backed time-bounded Party Relationships, shared Counterparties and their independently time-bounded roles, identity matching, correction, and merge. Merge preserves existing references through aliases or redirects.

Other modules address Parties and Counterparties through public ResourceRefs and Party Registry contracts. CRM owns engagement profiles and workflows; Commerce owns retail, channel, and B2B purchasing profiles and workflows. Neither duplicates shared Party identity. Connector Registries own provider-issued external-ID correlations, and Principal authorization owns permission to buy, approve, or administer access; a Party Relationship grants no authorization by itself.

Commerce also owns its separate Portal Account lifecycle and links each account/profile to stable Party/Counterparty references. Registration and authentication do not move Party identity into BetterAuth or Commerce; lifecycle events let CRM, support/ticketing, analytics, and other authorized consumers project the linkage without sharing an account realm.

Party Registry publishes identity and relationship lifecycle events for consumer projections. Imports contribute observations and match candidates but cannot write a competing canonical Party.

Party records remain independently governed per tenant. A future authorized analytical projection may correlate them through explicit provenance-backed cross-tenant links, but it must not collapse them into one mutable global Party. Platform-wide reputation or risk scoring is outside this decision and the current Commerce delivery.

## Considered options

1. **Let CRM own shared identity.** Rejected because CRM is a contextual workflow module and not every Party participates in CRM.
2. **Let each module keep its own customer/person/organization copy.** Rejected because duplicate matching, correction, merge, and references would diverge.
3. **Use one global cross-tenant Party directory.** Rejected because it breaks tenant governance and creates an unjustified platform-wide identity authority.
4. **Use tenant-scoped Party Registry with module-owned contextual profiles.** Accepted because it centralizes identity lifecycle without centralizing every business meaning or permission.

## Consequences

- “Customer” must be qualified as Customer Configuration, Retail Customer, Counterparty role, CRM profile, or another explicit context.
- One Party may participate in several Party Relationships and Counterparty Roles without identity duplication.
- Provider correlation and transport do not acquire authority over Party identity.
- Stable ResourceRefs and merge aliases let consumers preserve references while Party Registry corrects identity.
- CRM and Commerce schemas, APIs, and workflows must reference Party/Counterparty contracts instead of becoming alternative identity registries.

## Migration impact

OntOS is not live, so the current organization-shaped `crm.customers` and subordinate-contact model may be replaced with breaking schema, API, and code changes. No backfill, compatibility layer, or dual-write period is required. Detailed CRM design remains deferred; the binding migration direction is that CRM does not own shared Party identity.
