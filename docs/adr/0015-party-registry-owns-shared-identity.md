# ADR-0015: Party Registry owns shared identity

Status: Accepted.

## Context

ERP and Commerce both need to refer to the same real-world people and organizations. Without one ownership rule, an imported organization, a manually entered CRM customer record, a Commerce buyer, and an external-system correlation can become competing identities. The word “Customer” also conflates Customer Configuration, commercial relationship, retail behavior, profile state, and CRM workflow.

## Decision

Party Registry is a Foundational Module and the System of Record for tenant-scoped person and organization identity. It owns sparse or Unresolved Parties, Official Identifiers, Contact Points, provenance-backed time-bounded Party Relationships, shared Counterparties and their independently time-bounded Counterparty Roles, identity matching, correction, and merge. Merge preserves existing references through aliases or redirects.

Other modules address Parties and Counterparties through public ResourceRefs and Party Registry contracts. CRM owns engagement profiles and workflows. Commerce owns Commerce Retail Customer Profiles, Commerce Counterparty Purchasing Profiles, channel workflows, customer commercial settings, and their explicit profile/account bindings. Neither duplicates shared Party identity. Connector Registries own provider-issued external-ID correlations. Principal authorization owns Permissions to buy, approve, administer access, read history, or manage customer settings. A Party Relationship, Counterparty Role, selected context, profile, or account grants no authorization by itself.

Commerce owns its separate Commerce Portal Account lifecycle. A Commerce Portal Account may resolve through owner-local bindings to tenant-scoped Principals and stable Party/Counterparty ResourceRefs, but authentication alone creates neither a Retail Portal Profile Binding nor Principal-to-Counterparty Commerce Access. Registration, matching Contact Points, Party correction/merge, or account ownership must never silently grant profile access, Counterparty Permission, or guest Order visibility.

Party Registry publishes identity and relationship lifecycle events for authorized consumer projections. Imports contribute observations and match candidates but cannot write a competing canonical Party. Consumer modules reconcile their ResourceRefs and contextual profiles through public contracts; they do not reinterpret a Party merge as permission or historical-record transfer.

Party records remain independently governed per Tenant. A future authorized analytical projection may correlate them through explicit provenance-backed cross-Tenant links, but it must not collapse them into one mutable global Party. Platform-wide reputation or risk scoring is outside this decision and the current Commerce delivery.

## Considered options

1. **Let CRM own shared identity.** Rejected because CRM is a contextual workflow module and not every Party participates in CRM.
2. **Let each module keep its own customer/person/organization copy.** Rejected because duplicate matching, correction, merge, and references would diverge.
3. **Use one global cross-Tenant Party directory.** Rejected because it breaks Tenant governance and creates an unjustified platform-wide identity authority.
4. **Use tenant-scoped Party Registry with module-owned contextual profiles.** Accepted because it centralizes identity lifecycle without centralizing every business meaning, profile, account, or Permission.

## Consequences

- `Customer` must always be qualified, for example Customer Configuration, Retail Customer, Counterparty Role `CUSTOMER`, CRM Engagement Profile, Commerce Retail Customer Profile, Commerce Counterparty Purchasing Profile, or Customer Archive.
- One Party may participate in several Party Relationships and Counterparty Roles without identity duplication.
- A Counterparty is a relationship between one Party and one managed Legal Entity, not another organization record or a generic “B2B Customer”.
- Provider correlation, authentication transport, profile binding, and selected context do not acquire authority over Party identity or Principal authorization.
- Stable ResourceRefs and merge aliases let consumers preserve addressability while Party Registry corrects identity.
- CRM and Commerce schemas, APIs, and workflows must reference Party/Counterparty contracts instead of becoming alternative identity registries.
- Historical Resources retain their accepted facts and actor attribution; current Party correction or merge does not rewrite them.

## Migration impact

OntOS is not live, so the current organization-shaped `crm.customers` and subordinate-contact model may be replaced with breaking schema, API, and code changes. No backfill, compatibility layer, or dual-write period is required. Detailed CRM design remains deferred; the binding migration direction is that CRM does not own shared Party identity.
