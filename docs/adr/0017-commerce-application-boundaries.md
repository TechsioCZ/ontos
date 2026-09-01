# ADR-0017: Commerce application boundaries

Status: Accepted.

## Context

OntOS Commerce must serve B2C and B2B without coupling customer presentation, staff operations, customer authentication, provider routing, or customer-specific executable code to Shell/Core. Existing `new-engine` storefronts use Medusa Store-shaped hooks and must be delivered quickly, while the long-term channel model must also admit native storefronts and Agentic Shopping through MCP, UCP, or comparable protocols.

Earlier guidance made Customer Configuration entirely declarative, prohibited every customer-specific module implementation, described an Application Composition as a customer-selectable version, and left Storefront placement open. That wording hid the operational distinction between explicit implementation alternatives and uncontrolled forks, and it did not define the separate staff, storefront-service, and portal-user identities.

## Decision

### Application surfaces

Commerce is one shared, continuously delivered Application Composition for B2C and B2B. A Customer Configuration/Tenant may enable several independently deployed Storefront Applications, including separate B2C and B2B applications. Storefront Applications remain outside the standard OntOS Shell deployment and own framework, routing, rendering, layout, interaction design, branding, assets, and SEO.

Each Storefront Application uses a storefront-local BFF/proxy and a distinct tenant-bound Storefront Client credential. OntOS exposes a thin Commerce Storefront API that authenticates application and customer/guest context, authorizes, translates channel contracts, aggregates bounded reads, and invokes public module Actions. It owns no canonical facts or durable workflows.

Native Commerce contracts are authoritative. A temporary Medusa Store Compatibility Facade may translate only the Store API shapes required by existing `new-engine` hooks. It does not introduce a Medusa runtime, schema, workflow owner, copied source, or permanent canonical contract. Future MCP/UCP Agentic Shopping Adapters are peer channel adapters over native Commerce contracts, not clients of the Medusa facade.

Commerce Operations is a purpose-built staff application for order, approval, fulfillment, claim, reconciliation, and recovery work over the same public module contracts. It uses the existing staff authentication boundary and does not become Shell/Core, a canonical fact owner, or a private mutation path.

### Authentication and identity

Both staff and commerce portal authentication use BetterAuth, but they are separate realms:

- Shell owns staff accounts, sessions, cookies, Tenant selection, Legal Entity context, and Authenticated Principal Sessions.
- Commerce owns Portal Account registration and a separate BetterAuth configuration/schema, account lifecycle, cookies, and sessions. A Portal Account is never a Shell staff account.
- Each Storefront Client credential resolves to one tenant-bound service Principal and identifies the application, not the customer.
- A separate portal token/session identifies an authenticated retail or B2B Principal and its Party/Counterparty context. Anonymous traffic receives only a bounded guest/cart context.

Commerce links Portal Accounts and profiles to stable Party/Counterparty references and emits lifecycle facts for CRM, support/ticketing, analytics, and other authorized consumers. Party Registry continues to own shared identity; Principal bindings and permissions own access; Connector Registries own provider correlations.

### Module identity and delivery

Customer Configuration remains declarative and may select permitted optional modules and explicit Module Implementation Identities. A Module Contract Identity names stable public semantics. A Module Implementation Identity names one catalogued executable implementation, such as `standard` or `akros`.

Compatible implementations may share a Module Contract Identity only when public semantics and contract remain the same. Different public semantics require a distinct module identity. The catalog records implementation identity, immutable build revision and digest, public-contract hash/version, migration set, owner, and health. Invisible same-identity forks are forbidden.

OntOS controls continuous mainline delivery; customers cannot pin a whole-product `v1` release line. Immutable revisions, public-contract compatibility, skew checks, canaries, and rollback remain mandatory operational evidence. An independently delivered customer-specific module implementation is not a separate OntOS version.

### External systems

There is no universal gateway. Customer Configuration selects one Integration Route per External Business System and fact family: One-time Migration, a Symmy Route through the Symmy Connector, or a Direct Provider Route through an owner-local Direct Provider Adapter. Symmy is preferred and non-exclusive. Module-owned workers, reconciliation, and business authority remain with the owner regardless of route.

## Consequences

- Storefront frameworks and customer presentation can change without coupling to Shell/Core or commerce ownership.
- One backend supports B2C and B2B while customers choose their channel/application split.
- Staff, Storefront Client, portal-user, and guest identities cannot be conflated.
- The Medusa facade accelerates delivery but must carry an explicit supported-route inventory, semantic-difference log, observability, and retirement criteria.
- Explicit implementation identities make exceptional customer code visible, compatible, testable, deployable, and removable.
- Continuous forward delivery increases the need for exact artifact, compatibility, canary, and rollback evidence.

Production acceptance must prove tenant/client isolation, dual application/customer authentication, anonymous boundaries, Portal Account linking, B2C/B2B authorization, dependency degradation, implementation selection, skew rejection, rollout/rollback, and route-specific recovery.

## Considered options

1. **Deploy Storefronts inside Shell/OntOS.** Rejected because customer presentation has a different release, risk, and technology lifecycle.
2. **Use one BetterAuth realm for staff and portal customers.** Rejected because it conflates account lifecycle, cookies, Tenant selection, and trust boundaries.
3. **Route every provider through Symmy.** Rejected because provider families and customer system needs differ.
4. **Forbid every customer-specific implementation.** Rejected because it hides real exceptional code or forces customer behavior into Shell/Core; explicit catalogued alternatives preserve governance.
5. **Allow customer-pinned product versions.** Rejected because OntOS operates one forward-moving monorepo product; compatibility and rollback are operational controls, not customer release choices.

## Superseded guidance

This ADR supersedes statements that Customer Configuration cannot select an explicit customer-specific implementation, that Application Composition `version` is a customer-controlled release choice, that Storefront placement is topology-neutral, or that every compatibility facade is prohibited. It does not weaken the bans on Core forks, invisible module forks, private cross-module imports, or a third-party commerce-engine runtime/derived source.

Product decision: [TSNheathen/wayrepo — Commerce application boundaries](https://github.com/TSNheathen/wayrepo/blob/main/docs/product/commerce-application-boundaries.md).
