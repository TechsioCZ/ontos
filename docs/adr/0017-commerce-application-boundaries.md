# ADR-0017: Commerce application boundaries

Status: Accepted.

## Context

OntOS Commerce must serve B2C and B2B without coupling customer presentation, staff operations, Commerce Portal Account authentication, provider routing, or customer-specific executable code to Shell/Core. Existing `new-engine` Storefront Applications use Medusa Store-shaped hooks and must be delivered quickly, while the long-term channel model must also admit native Storefront Applications and Agentic Shopping through MCP, UCP, or comparable protocols.

Earlier guidance made Customer Configuration entirely declarative, prohibited every customer-specific module implementation, described an Application Composition as a customer-selectable version, and left Storefront placement open. That wording hid the operational distinction between explicit implementation alternatives and uncontrolled forks, and it did not define the separate staff Principal, Storefront Client, Commerce Portal Account Principal, Counterparty Principal, and Guest Purchase Context boundaries.

## Decision

### Application surfaces

Commerce is one shared, continuously delivered Application Composition for B2C and B2B. A Customer Configuration/Tenant may enable several independently deployed Storefront Applications, including separate B2C and B2B applications. Storefront Applications remain outside the standard OntOS Shell deployment and own framework, routing, rendering, layout, interaction design, branding, assets, and SEO.

Each Storefront Application uses a Storefront-local BFF/proxy and a distinct Tenant-bound Storefront Client credential. OntOS exposes a thin Commerce Storefront API that authenticates the Storefront Client and Commerce Portal Account or Guest Purchase Context independently, resolves trusted Commerce Purchasing Context, authorizes the exact governed read or Action, translates Channel contracts, aggregates bounded reads, and invokes public module Actions. It owns no canonical facts or durable workflows.

Native Commerce contracts are authoritative. A temporary Medusa Store Compatibility Facade may translate only the Store API shapes required by existing `new-engine` hooks. It does not introduce a Medusa runtime, schema, workflow owner, copied source, or permanent canonical contract. Future MCP/UCP Agentic Shopping Adapters are peer Channel adapters over native Commerce contracts, not clients of the Medusa facade.

Commerce Operations is a purpose-built staff application for Order, Purchasing Approval, Fulfillment, Claim, reconciliation, recovery, and Assisted Support work over the same public module contracts. It uses the existing staff authentication boundary and does not become Shell/Core, a canonical fact owner, or a private mutation path.

### Authentication, profiles, and authorization

Both staff and Commerce Portal Account authentication use BetterAuth, but they are separate realms:

- Shell owns staff accounts, sessions, cookies, Tenant selection, Legal Entity context, and Authenticated Principal Sessions.
- Commerce owns Commerce Portal Account registration and a separate BetterAuth configuration/schema, account lifecycle, cookies, and sessions. A Commerce Portal Account is never a Shell staff account.
- Each Storefront Client credential resolves to one Tenant-bound service Principal and identifies the application, never the Retail Customer, Counterparty, or acting customer Principal.
- A separate Commerce Portal Account token/session resolves to a tenant-scoped Principal. Retail persistent capabilities additionally require an explicit Retail Portal Profile Binding; B2B capabilities require explicit Principal-to-Counterparty Commerce Access and the concrete Counterparty Commerce Permission.
- Anonymous traffic receives only a bounded Guest Purchase Context. It is not a Principal, durable-history entitlement, or Counterparty authority.

Commerce links Commerce Portal Accounts through owner-local bindings to tenant-scoped Principals and stable Party/Counterparty ResourceRefs. Party Registry continues to own shared identity; Commerce owns Commerce Retail Customer Profiles, Commerce Counterparty Purchasing Profiles, account/profile bindings, and Commerce workflows; the SpiceDB Authorization Graph and owning authorization capability enforce Permissions; Connector Registries own provider correlations.

Registration, matching Contact Points, Party correction/merge, account ownership, selected context, profile existence, or Party Relationship must never silently create a Retail Portal Profile Binding, claim a guest Order, or grant a Counterparty Commerce Permission.

### Module identity and delivery

Customer Configuration remains declarative and may select permitted optional modules and explicit Module Implementation Identities. A Module Contract Identity names stable public semantics. A Module Implementation Identity names one catalogued executable implementation, such as `standard` or `akros`.

Compatible implementations may share a Module Contract Identity only when public semantics and contract remain the same. Different public semantics require a distinct module identity. The catalog records implementation identity, immutable Build Revision and digest, public-contract hash/version, migration set, owner, and health. Invisible same-identity forks are forbidden.

OntOS controls continuous mainline delivery; customers cannot pin a whole-product `v1` release line. Immutable revisions, public-contract compatibility, skew checks, canaries, and rollback remain mandatory operational evidence. An independently delivered customer-specific module implementation is not a separate OntOS version.

### External systems

There is no universal gateway. Customer Configuration selects one Integration Route per External Business System and fact family: One-time Migration, a Symmy Route through the Symmy Connector, or a Direct Provider Route through an owner-local Direct Provider Adapter. Symmy is preferred and non-exclusive. Module-owned workers, reconciliation, and business authority remain with the owner regardless of route.

## Consequences

- Storefront frameworks and customer presentation can change without coupling to Shell/Core or commerce ownership.
- One backend supports B2C and B2B while customers choose their Channel/Application split.
- Staff Principal, Storefront Client, Commerce Portal Account Principal, Retail Portal Profile Binding, Counterparty Commerce Permission, and Guest Purchase Context cannot be conflated.
- Authentication and selected context never become authorization; each protected operation checks the exact current Permission and Business Policy.
- Guest Order visibility cannot be inferred from registration or identity similarity.
- The Medusa facade accelerates delivery but must carry an explicit supported-route inventory, semantic-difference log, observability, and retirement criteria.
- Explicit implementation identities make exceptional customer code visible, compatible, testable, deployable, and removable.
- Continuous forward delivery increases the need for exact artifact, compatibility, canary, and rollback evidence.

Production acceptance must prove Tenant/Storefront Client isolation, separate application and Commerce Portal Account/Guest authentication, Retail Portal Profile Binding, Counterparty Permission checks, anonymous boundaries, guest Order claim prohibition, dependency degradation, implementation selection, skew rejection, rollout/rollback, and route-specific recovery.

## Considered options

1. **Deploy Storefront Applications inside Shell/OntOS.** Rejected because customer presentation has a different release, risk, and technology lifecycle.
2. **Use one BetterAuth realm for staff and Commerce Portal Accounts.** Rejected because it conflates account lifecycle, cookies, Tenant selection, and trust boundaries.
3. **Route every provider through Symmy.** Rejected because provider families and customer system needs differ.
4. **Forbid every customer-specific implementation.** Rejected because it hides real exceptional code or forces customer behavior into Shell/Core; explicit catalogued alternatives preserve governance.
5. **Allow customer-pinned product versions.** Rejected because OntOS operates one forward-moving monorepo product; compatibility and rollback are operational controls, not customer release choices.

## Superseded guidance

This ADR supersedes statements that Customer Configuration cannot select an explicit customer-specific implementation, that Application Composition `version` is a customer-controlled release choice, that Storefront placement is topology-neutral, or that every compatibility facade is prohibited. It does not weaken the bans on Core forks, invisible module forks, private cross-module imports, shared business transactions, or a third-party commerce-engine runtime/derived source.

Product decision: [TSNheathen/wayrepo — Commerce application boundaries](https://github.com/TSNheathen/wayrepo/blob/main/docs/product/commerce-application-boundaries.md).
