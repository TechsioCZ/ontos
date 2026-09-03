# Commerce language

Commerce is a reusable B2C/B2B Application Composition. Customer deployments provide evidence and
configuration; they do not create separate products or hidden forks. This glossary extends
`../ontos/CONTEXT.md`; when the two glossaries conflict, the OntOS glossary and accepted ADRs govern.

## Language rules

**Qualified customer terminology** — `Customer` is never a standalone identity type or aggregate.
Always qualify the meaning: Customer Configuration, Retail Customer, Commerce Retail Customer
Profile, Commerce Counterparty Purchasing Profile, Commerce Customer Group, Customer Archive, or
another explicit context. Avoid unqualified `customer`, `customer record`, `customer ID`, and
`B2B Customer` when the intended subject is a Party, Counterparty, Principal, account, or profile.

**Planning Identifier** — Uppercase issue keys are navigation labels for a planning tree. They do not
redefine canonical terms. A legacy or compact issue key remains addressable by issue number, but its
title and body must name the canonical concept it specifies.

**Current** — Evaluated from authoritative facts, Permissions, Business Policies, and effective
periods valid at the trusted operation time. A value retained by a Cart, client, cache, or previous
evaluation is not current merely because it still exists.

**Effective** — Valid at a stated instant under an explicit effective period. Unless an owning
capability says otherwise, `effective_from` is inclusive and `effective_to` is exclusive.

**Accepted** — Definitively used by a committed Order or another successful historical transition.
Accepted commercial terms are durable historical facts and are not recalculated from current
profiles, policies, definitions, permissions, or exchange rates.

**Snapshot** — Immutable historical representation of accepted values and source references needed
to explain a committed business result. A Snapshot does not acquire ownership of the current source
fact.

**Commerce Customer Context** — Planning umbrella for Commerce-owned profiles, commercial settings,
Counterparty access, customer-facing history, and their relationships. It is not itself a Module
Contract Identity, database aggregate, Party type, Permission, or per-purchase context.

**Commerce Purchasing Context** — Trusted context for one current purchase. It identifies the Tenant,
selling Legal Entity, Channel, Storefront, market, purchasing subject, acting Principal or Guest,
Cart, locale, current choices, and operation time needed by the decision. It is resolved per
operation and is not a durable customer profile or authorization grant.

## Delivery and applications

**Commerce Application Composition** — Shared dependency-closed set of Commerce modules used by
permitted Customer Configurations.

**Production Deployment Snapshot** — Captured deployed package proving what code and connector seams
existed at capture time. It does not prove activation, traffic, or business necessity.

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

**Storefront Application** — Independently deployed customer-facing Channel Application outside the
standard Shell. It owns presentation, routing, branding, interaction, and SEO, not canonical
commerce facts.

**Storefront Client** — Tenant-bound service Principal and rotatable credential identifying one
Storefront Application, never the browsing customer.

**Commerce Storefront API** — Thin channel edge that authenticates application and customer/Guest
context, resolves trusted Commerce Purchasing Context, authorizes, translates contracts, aggregates
bounded reads, and invokes public Actions. It owns no canonical facts or durable workflows.

**Medusa Store Compatibility Facade** — Temporary translation surface for required legacy storefront
API shapes. It is not a Medusa runtime, canonical contract, or commerce foundation.

**Commerce Operations** — Purpose-built staff application for permissioned commerce workflows and
Assisted Support over public module contracts. It is not Shell/Core or a fact owner.

**Commerce Portal Account** — Commerce-owned account in a BetterAuth realm separate from staff
authentication. It links to tenant-scoped Principals and Party/Counterparty ResourceRefs without
becoming shared Party identity or granting profile or purchasing authority by itself.

## Customers, profiles, and channels

**B2C Channel** — Retail channel in which a visitor may browse and purchase as a Guest or an
authenticated Retail Portal Principal.

**B2B Channel** — Trade channel where public information may be visible, but Counterparty-specific
assortment, pricing, availability, ordering, approval, and history require explicit current
Permissions.

**Guest Purchase Context** — Bounded anonymous B2C context for browsing, Cart, and Checkout. It is
not a Principal, Commerce Portal Account, durable-history entitlement, Retail Portal Profile Binding,
or Counterparty authority. At accepted Order time the purchase must be attributable to a Party,
which may still be sparse or Unresolved under Party Registry rules.

**Retail Customer** — Party buying or considering a purchase through a B2C Channel. It is not a
profile, account, Principal, or `B2C/B2B` discriminator.

**Commerce Retail Customer Profile** — Commerce-owned persistent retail purchasing profile for one
Retail Customer and one selling Legal Entity. Its stable business key is the pair of Retail Customer
Party ResourceRef and managed selling Legal Entity. It stores only Commerce-owned state and
references; Party Registry retains shared identity ownership.

**Commerce Counterparty Purchasing Profile** — Commerce-owned persistent purchasing profile for one
Counterparty. Its stable subject is the Counterparty ResourceRef, which already identifies the Party
and managed Legal Entity relationship. Every authorized Principal acting for that Counterparty uses
the same profile.

**Commerce Customer Profile** — Qualified umbrella for a Commerce Retail Customer Profile or a
Commerce Counterparty Purchasing Profile. Every operation still carries the concrete profile kind
and stable subject.

**Commerce Customer Profile State** — Commerce relationship lifecycle with `ACTIVE`, `SUSPENDED`,
and `ARCHIVED` states. `SUSPENDED` and `ARCHIVED` prevent acceptance of a new Order for that profile;
neither deletes identity, Permissions, history, or the profile. Reactivation uses the same profile
and does not reinstate expired assignments or revoked Permissions.

**Retail Portal Profile Binding** — Explicit Commerce-owned relation connecting one Retail Portal
Principal to one Commerce Retail Customer Profile for declared persistent portal capabilities.
Registration, matching Contact Points, Party merge, account ownership, or knowledge of the profile
alone do not create the binding or grant visibility to pre-existing guest Orders.

**Retail Portal Principal** — Principal with a valid Retail Portal Profile Binding and the concrete
Permissions required for a Retail Customer's address book, history, aftercare, favorites, or
notifications. It is optional for guest Checkout.

## Segmentation and customer commercial settings

**Commerce Customer Group** — Commerce-owned named business segment applied to Commerce Customer
Profiles, for example `DEALERS` or `STRATEGIC_CUSTOMERS`. It is not a Price Group, Party Relationship,
Principal Permission, Counterparty Role, or universal rules engine. A material change of membership
criteria creates a new group instead of redefining historical meaning.

**Commerce Customer Group Membership** — Time-bounded relation between one Commerce Customer Profile
and one Commerce Customer Group. Multiple concurrent memberships are allowed. Membership is global
within the profile and has no implicit market, Storefront, Price Group, Permission, benefit, or
priority; each consuming capability owns its own interpretation and conflict resolution.

**Price Group** — Pricing-owned reusable pricing classification. Pricing owns its definition,
lifecycle, applicability, and interpretation; Commerce Customer Profiles may only reference it.

**Customer Price Group Assignment** — Commerce-owned time-bounded reference from one Commerce
Customer Profile to one Price Group. At most one assignment may be current for a profile. Market and
Storefront are separate Pricing inputs, not alternate assignment scopes.

**Customer Price Group Resolution** — Current typed decision returning one usable assigned Price
Group, legitimate absence of a customer Price Group, or explicit broken/inconsistent configuration.
Missing assignment may proceed to Pricing's own fallback; a dangling or unusable explicit assignment
must not be silently treated as absence.

**Customer Currency Preference** — Optional `0..1` long-lived preferred purchase currency on one
Commerce Customer Profile. It is a preference, not transaction currency, Price, or FX rule.

**Explicit Purchase Currency Choice** — Currency deliberately selected for one current purchase. It
has precedence over Customer Currency Preference and does not update that preference by itself.

**Purchase Currency Resolution** — Deterministic current decision with precedence: valid Explicit
Purchase Currency Choice, valid Customer Currency Preference, then one unambiguous default from
Customer Commerce Policy. An invalid explicit choice requires a new explicit decision; an invalid
preference may fall back without changing the stored preference. No usable unambiguous currency
means the purchase cannot be accepted.

**Payment Term** — Payment-owned reusable definition of when and under which commercial conditions an
amount becomes due, for example immediate payment, `NET_14`, or `NET_30`. It is distinct from a
Payment transaction, receivable, invoice, customer entitlement, and Principal authorization.

**Customer Payment Term Entitlement** — Time-bounded Commerce-owned assignment making one Payment
Term commercially available to one Commerce Customer Profile. A profile may have `0..N` current
entitlements. Entitlement never grants a Principal Permission to act for the customer.

**Customer Payment Term Preference** — Optional `0..1` preferred Payment Term among a profile's
current entitlements. Preference is not guaranteed use and may be absent even when several terms are
available.

**Explicit Purchase Payment Term Choice** — Payment Term deliberately chosen for one current
purchase. It has precedence over preference only when currently entitled or otherwise explicitly
permitted by policy. An invalid explicit choice must not silently fall back.

**Payment Terms Resolution** — Current typed decision with precedence: valid Explicit Purchase
Payment Term Choice, valid preferred current entitlement, then one applicable Customer Commerce
Policy fallback. Every candidate must be usable in the current Commerce Purchasing Context. Broken
explicit entitlements are not absence. If no term is usable, the purchase cannot be accepted. Order
Snapshots the accepted Payment Term values and references.

## Addresses and destinations

**Commerce Address Book** — Commerce-owned reusable address collection scoped to one Commerce
Customer Profile. Retail and Counterparty address books never mix automatically; a Counterparty
address book is shared by its authorized Principals.

**Commerce Saved Address** — Reusable address-book entry used as a candidate for a future purchase.
It is either a Party-backed Saved Address or a Commerce-only Saved Address. It is not an Order
Snapshot and does not by itself prove identity, tax status, authority, billing eligibility, or
deliverability.

**Party-backed Saved Address** — Commerce reference to a Party Registry postal Contact Point. Party
Registry owns canonical address content, provenance, correction, and merge lifecycle; Commerce owns
only the reusable address-book relation and Commerce-specific label or purpose.

**Commerce-only Saved Address** — Commerce-owned reusable postal destination whose meaning is limited
to purchase use and which is not represented as a shared Party Contact Point. It must never be
presented as canonical Party identity or silently promoted to Party Registry.

**Invoice Recipient** — Party or Counterparty identity, official identifiers where required, and
billing address accepted for one purchase. Shared identity comes from Party Registry; Order or the
billing document Snapshots the accepted values. Default Billing Address is only a selection
preference and is not the complete Invoice Recipient.

**Default Billing Address** — Optional `0..1` persistent pointer from a Commerce Customer Profile to
an eligible Commerce Saved Address used to preselect the address component of an Invoice Recipient.
It is not the only permitted address and never rewrites accepted Orders or billing documents.

**Delivery Destination** — Postal or pickup destination selected for one purchase and validated by
current delivery rules. It may originate from a Commerce Saved Address or be a permitted one-time
choice. Order Snapshots the accepted destination.

**Default Delivery Destination** — Optional `0..1` persistent pointer from a Commerce Customer
Profile to a reusable Delivery Destination candidate. It is a preference, not a guarantee that the
destination is usable for every Product, Cart, carrier, market, or Storefront.

## Counterparty access and authorization

**Principal-to-Counterparty Commerce Access** — Set of current explicit Counterparty Commerce
Permissions held by one Principal for one Counterparty. An empty relation grants nothing. Selected
Counterparty context, Party Relationship, employment, job title, email domain, Customer Profile, or
Commerce Portal Account never create access.

**Counterparty Commerce Permission** — Atomic Permission allowing one Principal to perform one
declared Commerce Action or governed read for one Counterparty, optionally within a Storefront scope.
Named authorities such as Buyer, Approver, and Access Administrator are canonical Permission groups;
capabilities declare narrower Permissions for profile reads, customer-settings management,
address-book use/management, Purchase Limit management, and `OWN_ORDERS` or
`ALL_COUNTERPARTY_ORDERS` history.

**Counterparty Buyer** — Principal allowed to prepare and submit purchases for a Counterparty within
current Permissions and purchasing policy. `Approval Required` does not remove the right to submit
the exact proposal into Purchasing Approval.

**Counterparty Approver** — Principal allowed to perform a decision for a Purchase Approval Request
when both current Counterparty Approver Permission and the request's current Approval Route make the
Principal eligible. Permission alone does not assign a request; hierarchy alone is not authorization.

**Counterparty Access Administrator** — Principal allowed to manage declared Counterparty Commerce
Permissions within an explicit administrative scope. It manages authorization, not Party identity,
Party Relationships, Commerce Portal Account lifecycle, customer business facts, or Approval
Hierarchy. Holding it does not automatically grant the Permissions being administered.

**Storefront-scoped Permission** — Counterparty Commerce Permission constrained to a trusted resolved
Storefront context. The Storefront Application neither owns nor grants the Permission.

**Counterparty Access Grant** — Audited Action granting one declared Counterparty Commerce Permission
to an existing Principal for one Counterparty and optional Storefront scope. V1 grants are immediate;
no other Permission is implied.

**Counterparty Access Revoke** — Audited Action removing one declared Counterparty Commerce
Permission from a Principal for one Counterparty and optional Storefront scope. V1 revocation is
immediate for new operations and does not erase historical attribution or unrelated Permissions.

**Counterparty Access Invitation** — Time-limited, one-time, revocable invitation to complete
Commerce Portal Account/Principal enrollment and then invoke explicit Counterparty Access Grants.
The invitation is not a Permission or current access. Email domain, Party Relationship, account
existence, or invitation delivery alone never grant authority.

## Purchasing limits and approval

**Purchase Value** — Derived net commercial value used only for purchasing-limit assessment: current
line values after discounts, plus shipping/delivery charges and commercial fees, excluding VAT and
other taxes. It carries amount, currency, and source revision and does not transfer Pricing or FX
ownership.

**Purchase Limit Policy** — Explicit current amount-driven purchasing policy for a Counterparty or a
Principal + Counterparty pair. It is either `MONETARY_LIMIT(amount, currency)` or `UNLIMITED`.
Missing configuration is neither variant and must not be interpreted as unlimited authority.

**Purchase Limit** — Monetary boundary of independent purchasing authority for one current B2B
purchase under a `MONETARY_LIMIT` policy. `Purchase Value <= Effective Purchase Limit` is Within
Limit; a greater value is Approval Required. It is not a period budget, cumulative spend, credit
exposure, accounting balance, or hard financial maximum.

**Unlimited Purchase Limit Policy** — Explicit Purchase Limit Policy stating that amount alone does
not require Purchasing Approval for the scoped Principal/Counterparty. It is not missing data and
does not bypass other Permissions, approval rules, or commercial checks.

**Counterparty Purchase Limit** — Current default Purchase Limit Policy for one Counterparty.

**Principal Purchase Limit Override** — Optional current Purchase Limit Policy for one Principal and
one Counterparty. When present it fully replaces the Counterparty Purchase Limit and may lower,
raise, or explicitly remove the monetary boundary through `UNLIMITED`.

**Effective Purchase Limit Policy** — Current Principal Purchase Limit Override when one exists;
otherwise the current Counterparty Purchase Limit. A missing or inconsistent policy is a typed
configuration result, not silent fallback.

**Effective Purchase Limit** — Monetary amount and currency inside an Effective Purchase Limit
Policy of kind `MONETARY_LIMIT`. Cross-currency evaluation requires an authoritative comparable
Purchase Value in the limit currency.

**Purchase Limit Evaluation** — Current deterministic evaluation of Purchase Value and Effective
Purchase Limit Policy. Its amount-driven business outcomes are Within Limit and Approval Required;
missing/inconsistent policy, unavailable comparable value, and stale input are separate typed
configuration results. It does not authorize, approve, reject, or create an Order.

**Within Limit** — Purchase Limit Evaluation outcome permitting the Counterparty Buyer to proceed
without amount-triggered Purchasing Approval. It also applies to explicit `UNLIMITED`. Other
Permissions, commercial checks, and independent approval policies still apply.

**Approval Required** — Purchase Limit Evaluation outcome produced when Purchase Value is greater
than the Effective Purchase Limit. It requires a Purchase Approval Request and is not rejection,
blocking, approval, or an Order.

**Purchase Approval Trigger** — Boundary transition from Approval Required into Purchasing Approval.
It is the canonical meaning previously described by the planning alias `Approval Threshold`; there
is no second stored Approval Threshold amount or currency.

**Purchase Proposal Revision** — Immutable Snapshot of one submitted Cart revision that can be
reviewed and approved. It contains the exact purchasing subject, acting Buyer, item/configuration,
quantities, Purchase Value, currency, resolved commercial terms, Invoice Recipient, Delivery
Destination, and source revisions needed to identify what was approved. It is not an Order and does
not guarantee stock, price, or Payment beyond explicit owner contracts.

**Purchase Approval Request** — Purchasing Approval-owned workflow for one Purchase Proposal
Revision. Its lifecycle is `PENDING`, `RETURNED`, `APPROVED`, `REJECTED`, `CANCELLED`, `EXPIRED`, or
`SUPERSEDED`. Approval is always tied to the exact revision.

**Approval Hierarchy** — Explicit, versioned Counterparty purchasing-policy structure describing
ordered approval levels and eligible Principals or pools, optionally scoped by Storefront or value
range. It is not inferred from Party Relationship, employment, job title, email domain, Commerce
Portal Account, or Access Administrator Permission.

**Approval Route** — Current resolved ordered set of approval levels and eligible Principals for one
Purchase Approval Request. Every decision still requires current Counterparty Approver Permission.
If no valid route exists, submission returns an explicit configuration result and the Cart/proposal
remains available.

**Approval Decision** — Audited `approve`, `return`, or `reject` Action against one current Purchase
Approval Request and exact Purchase Proposal Revision. `return` requests a new Buyer revision;
`reject` terminates the current request. Self-approval is denied unless an explicit Purchasing
Approval Business Policy allows it.

**Purchasing Approval** — Domain owning Purchase Approval Requests, Approval Hierarchies, Approval
Routes, levels, assignments, decisions, expiry, supersession, and revalidation. It does not own
Counterparty Approver Permission, Purchase Limits, Cart, Pricing, or Order. An approved request
authorizes only the exact proposal revision to attempt final Order acceptance.

**Approval Revalidation** — Check that an approved Purchase Proposal Revision still matches the Cart
and current acceptance inputs. Any material change to purchasing subject, Buyer, item identity or
configuration, quantity, accepted price/discount/fee/tax, currency, Payment Term, Invoice Recipient,
Delivery Destination, Purchase Value, or applicable approval policy supersedes approval and requires
a new revision and route. Final availability, reservation, Payment, and Order acceptance checks still
run.

## History, archive, and repeat purchase

**Retail Customer Order History** — Authorized read-only view over customer-facing Orders visible to
one Commerce Retail Customer Profile. It requires current Retail Portal Profile Binding, concrete
history Permission, and Order-level portal visibility. It creates no Order copy.

**Guest Order Claim** — Explicit verified Action that may make an eligible guest Order visible in one
Retail Customer Order History. Registration, matching Contact Points, Retail Portal Profile Binding,
Party matching/correction/merge, or account ownership alone never perform the claim. Automatic guest
Order claiming is not part of the current Launch Capability unless separately accepted.

**Counterparty Order History** — Authorized read-only view over customer-facing Orders of one
Counterparty. Current Principal-to-Counterparty Commerce Access is required together with explicit
history scope `OWN_ORDERS` or `ALL_COUNTERPARTY_ORDERS`. Buyer, Approver, or Access Administrator
Permission alone does not imply all-Order visibility.

**Customer Archive** — Authorized read-only access to retained Orders, documents, and Claims. It is
not the statutory accounting or tax archive, retention owner, duplicate record store, or the
`ARCHIVED` state of a Commerce Customer Profile.

**Repeat Order** — Authorized Action constructing a new Cart from still-sellable historical Order
items and valid configurations on a best-effort basis. Current Permissions, Products, quantities,
prices, availability, currency, Invoice Recipient, Delivery Destination, Payment Terms, Purchase
Limits, and approval policy apply; historical terms and authority are not reinstated.

**Assisted Support** — Audited staff capability exposing customer context without silently assuming
customer identity. Customer-affecting Actions remain explicit and attributed to the operator.

## Commerce domains

**Product** — Good or service with stable commercial identity. Price and availability are not part
of that identity.

**Catalog** — Domain owning Product identity, variants, configuration, classification, descriptive
facts, media references, and relationships.

**Assortment** — Products eligible for visibility or purchase in a Channel or by a Counterparty.

**Pricing** — Domain determining prices, discounts, fees, tax inputs, quantity tiers, quotations,
and Price Group definitions for an explicit Commerce Purchasing Context.

**Inventory** — Domain owning stock and reservations when the Customer Configuration owns those
lifecycles.

**Availability** — Current promise that a Product can be sold and delivered in a Commerce Purchasing
Context. It may derive from Inventory or an External Business System that owns the relevant fact.

**Cart** — Mutable prospective set of Product selections under an explicit Commerce Purchasing
Context. A Cart is not an Order, approval, reservation, quotation, or historical fact.

**Checkout** — Process coordinating current validation, customer choices, Cart submission, and the
handoff to Purchasing Approval or Order Commitment Gate. It owns no source facts or resulting Order.

**Order Commitment Gate** — Final consistency boundary that revalidates required current Permissions,
commercial facts, exact approval evidence, availability/reservation, and Payment conditions before
an Order is committed. It cannot use stale approval or silently mix incompatible decision revisions.

**Order** — Durable accepted purchase and Snapshot of accepted commercial terms and actor
attribution. It remains the System of Record for the historical purchase even when current source
definitions later change.

**Payment** — Domain owning Payment Term definitions plus collection, authorization, settlement,
cancellation, refund, and reconciliation outcomes. Customer entitlement and purchase selection
remain separate facts.

**Fulfillment** — Domain for preparation, handoff, delivery, tracking, and delivery exceptions.

**Aftercare** — Customer and operator work coordinated over Order, Payment, Fulfillment, Billing
Documents, and Claim lifecycles without replacing their ownership.

**Claim** — Governed request concerning durable Order lines, with its own evidence, communication,
deadlines, state, and resolution history.

**Customer Commerce Policy** — Declarative Customer Configuration of shared Channel, purchasing,
quantity, market, currency, Payment Terms, approval, and legal policy. It supplies explicit defaults
and constraints, not arbitrary hidden executable logic. Different executable semantics require a
shared module change or an explicitly catalogued implementation.
