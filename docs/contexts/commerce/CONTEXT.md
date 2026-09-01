# Commerce language

Commerce is a reusable B2C/B2B Application Composition. Customer deployments provide evidence and
configuration; they do not create separate products or hidden forks.

## Delivery and applications

**Commerce Application Composition** — Shared dependency-closed set of Commerce modules used by
permitted Customer Configurations.

**Production Deployment Snapshot** — Captured deployed package proving what code and connector
seams existed at capture time. It does not prove activation, traffic, or business necessity.

**Deployed Capability** — Behavior present in a deployment whose current activation or use has not
been established.

**Active Behavior** — Behavior confirmed by observation, runtime evidence, or an operator. It is
input to a cutline, not an automatic requirement.

**Production-complete Launch** — Point at which a replacement can safely take over every accepted
launch channel and required end-to-end outcome. It does not mean parity with all legacy behavior.

**Launch Capability** — Capability required for launch because it is active, revenue-critical,
operationally necessary, legally required, or explicitly promised.

**Later Capability** — Useful capability deliberately deferred because launch does not depend on it.

**Archived Capability** — Historical behavior or data retained read-only for service, audit,
accounting, or legal obligations.

**Retired Capability** — Behavior deliberately absent because it is unused, obsolete, unsafe, or
unvalidated legacy breadth.

**Storefront Application** — Independently deployed customer-facing Channel Application outside
the standard Shell. It owns presentation, routing, branding, interaction, and SEO, not canonical
commerce facts.

**Storefront Client** — Tenant-bound service Principal and rotatable credential identifying one
Storefront Application, never the browsing customer.

**Commerce Storefront API** — Thin channel edge that authenticates application and customer/guest
context, authorizes, translates contracts, aggregates bounded reads, and invokes public Actions. It
owns no canonical facts or durable workflows.

**Medusa Store Compatibility Facade** — Temporary translation surface for required legacy storefront
API shapes. It is not a Medusa runtime, canonical contract, or commerce foundation.

**Commerce Operations** — Purpose-built staff application for permissioned commerce workflows and
Assisted Support over public module contracts. It is not Shell/Core or a fact owner.

**Commerce Portal Account** — Commerce-owned account in a BetterAuth realm separate from staff
authentication. It links to tenant-scoped Principals and Party/Counterparty references without
becoming shared Party identity.

## Customers and channels

**B2C Channel** — Retail channel in which a visitor may browse and purchase as a guest or an
authenticated Retail Portal Principal.

**Retail Customer** — Party buying or considering a purchase through a B2C Channel.

**Retail Portal Principal** — Principal authorized for a Retail Customer's saved addresses,
history, aftercare, favorites, or notifications. It is optional for guest checkout.

**B2B Channel** — Trade channel where public information may be visible, but Counterparty-specific
assortment, pricing, availability, and ordering require an approved Principal.

**Counterparty Buyer** — Principal allowed to prepare and submit purchases for a Counterparty within
assigned limits.

**Counterparty Approver** — Principal allowed to approve or return purchases requiring approval.

**Counterparty Access Administrator** — Principal allowed to manage who may act for a Counterparty
and with which permissions.

**Repeat Order** — Request to construct a new Cart from still-sellable historical Order items.
Current commercial rules apply; historical terms are not reinstated.

**Assisted Support** — Audited staff capability exposing customer context without silently assuming
customer identity. Customer-affecting Actions remain explicit and attributed to the operator.

**Customer Archive** — Authorized read-only access to retained Orders, documents, and Claims. It is
not the statutory accounting or tax archive.

## Commerce domains

**Product** — Good or service with stable commercial identity. Price and availability are not part
of that identity.

**Catalog** — Domain owning Product identity, variants, configuration, classification, descriptive
facts, media references, and relationships.

**Assortment** — Products eligible for visibility or purchase in a Channel or by a Counterparty.

**Pricing** — Domain determining prices, discounts, fees, tax inputs, quantity tiers, and quotations
for an explicit commercial context.

**Inventory** — Domain owning stock and reservations when the Customer Configuration owns those
lifecycles.

**Availability** — Current promise that a Product can be sold and delivered in a commercial
context. It may derive from Inventory or an external fact owner.

**Cart** — Mutable prospective set of Product selections under an explicit commercial context.

**Checkout** — Process coordinating final validation, customer choices, and Cart submission. It
does not own source facts or the resulting Order.

**Order** — Durable accepted purchase and snapshot of accepted commercial terms.

**Payment** — Domain for collection, authorization, settlement, cancellation, refund, and
reconciliation outcomes.

**Fulfillment** — Domain for preparation, handoff, delivery, tracking, and delivery exceptions.

**Aftercare** — Customer and operator work coordinated over Order, Payment, Fulfillment, and Claim
lifecycles without replacing their ownership.

**Claim** — Governed request concerning durable Order lines, with its own evidence, communication,
deadlines, state, and resolution history.

**Customer Commerce Policy** — Declarative Customer Configuration of shared channel, purchasing,
quantity, market, and legal policy. Different executable semantics require a shared module change or
an explicitly catalogued implementation.
