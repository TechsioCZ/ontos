# Commerce language

Commerce is a reusable B2C/B2B Application Composition. Customer deployments provide evidence and
configuration; they do not create separate products or hidden forks. This glossary extends
`../ontos/CONTEXT.md`; when the two glossaries conflict, the OntOS glossary and accepted ADRs govern.

## Language rules and shared purchase context

**Qualified customer terminology** — `Customer` is never a standalone identity type or aggregate.
Always qualify the meaning: Customer Configuration, Retail Customer, Commerce Retail Customer
Profile, Commerce Counterparty Purchasing Profile, Commerce Customer Group, Customer Archive, or
another explicit context. Avoid unqualified `customer`, `customer record`, `customer ID`, and
`B2B Customer` when the intended subject is a Party, Counterparty, Principal, account, role, or
profile.

**Planning Identifier** — Uppercase issue keys are navigation labels for a planning tree. They do not
redefine canonical terms. A legacy or compact issue key remains addressable by issue number, but its
current title and description must name the canonical concept it specifies. Current issue
descriptions and this glossary override older discovery/GOLD comments.

**Current** — Evaluated from authoritative facts, Permissions, Business Policies, and Effective
Periods valid at the trusted operation time. A value retained by a Cart, client, cache, proposal, or
previous evaluation is not Current merely because it still exists.

**Effective** — Valid at a stated instant under an explicit Effective Period. Unless an owning
capability says otherwise, `effective_from` is inclusive and `effective_to` is exclusive.

**Accepted** — Definitively used by a committed Order or another successful historical transition.
Accepted commercial terms are durable historical facts and are not recalculated from Current
profiles, policies, definitions, Permissions, or exchange rates.

**Snapshot** — Immutable historical representation of Accepted values and safe source references
needed to explain a committed business result. A Snapshot does not acquire ownership of the Current
source fact.

**Monetary Amount** — Exact decimal amount paired with an explicit currency and supported precision.
Binary floating-point values and currency-less amounts are forbidden at business boundaries. The
owning capability defines permitted sign and rounding; Purchase Value and Purchase Limit are
non-negative.

**Selling Legal Entity** — Managed Legal Entity making the commercial offer, accepting the Order, and
acting as seller/invoice issuer for one Commerce Purchasing Context. It is explicit and is not
inferred from Tenant, Storefront hostname, or the Counterparty's Party.

**Commerce Market** — Declarative commercial/legal market context used by Assortment, Pricing, Tax,
currency, Payment Terms, delivery, and Customer Commerce Policy. It may correspond to a country or
region but is not a Tenant, Environment, Deployment Topology, Storefront, or fact owner. One
Storefront may serve several markets and one market may be served by several Storefronts.

**Purchasing Subject** — Commercial subject whose Commerce profile and settings apply to one
purchase: either a Retail Customer in relation to a Selling Legal Entity, or one Counterparty. The
Purchasing Subject is distinct from the acting Principal or Guest.

**Commerce Customer Context** — Planning umbrella for Commerce-owned profiles, commercial settings,
Counterparty access, customer-facing history, and their relationships. It is not itself a Module
Contract Identity, database aggregate, Party type, Permission, or per-purchase context.

**Commerce Purchasing Context** — Trusted context for one Current purchase. It identifies Tenant,
Selling Legal Entity, Channel, Storefront, Commerce Market, Purchasing Subject, acting Principal or
Guest, Cart, locale, Current choices, and operation time needed by the decision. It is resolved per
operation and is not a durable profile or authorization grant. Client-supplied identifiers are
requests to resolve context, never trusted authority.

## Delivery and applications

**Commerce Application Composition** — Shared dependency-closed set of Commerce modules used by
permitted Customer Configurations.

**Production Deployment Snapshot** — Captured deployed package proving what code and Connector seams
existed at capture time. It does not prove activation, traffic, or business necessity.

**Deployed Capability** — Behavior present in a deployment whose Current activation or use has not
been established.

**Active Behavior** — Behavior confirmed by observation, runtime evidence, or an operator. It is
input to a cutline, not an automatic requirement.

**Production-complete Launch** — Point at which a replacement can safely take over every Accepted
launch Channel and required end-to-end outcome. It does not mean parity with all legacy behavior.

**Launch Capability** — Capability required for launch because it is active, revenue-critical,
operationally necessary, legally required, or explicitly promised.

**Later Capability** — Useful capability deliberately deferred because launch does not depend on it.

**Archived Capability** — Historical behavior or data retained read-only for service, audit,
accounting, or legal obligations.

**Retired Capability** — Behavior deliberately absent because it is unused, obsolete, unsafe, or
unvalidated legacy breadth.

**Storefront Application** — Independently deployed customer-facing Channel Application outside the
standard Shell. It owns presentation, routing, branding, interaction, and SEO, not canonical
Commerce facts.

**Storefront Client** — Tenant-bound service Principal and rotatable credential identifying one
Storefront Application, never the browsing customer or acting customer Principal.

**Commerce Storefront API** — Thin Channel edge that authenticates the Storefront Client and
Commerce Portal Account or Guest context independently, resolves trusted Commerce Purchasing
Context, authorizes, translates contracts, aggregates bounded reads, and invokes public Actions. It
owns no canonical facts or durable workflows.

**Medusa Store Compatibility Facade** — Temporary translation surface for required legacy Store API
shapes. It is not a Medusa runtime, canonical contract, commerce foundation, or fact owner.

**Commerce Operations** — Purpose-built staff application for permissioned Commerce workflows and
Assisted Support over public module contracts. It is not Shell/Core or a fact owner.

**Commerce Portal Account** — Commerce-owned account in a BetterAuth realm separate from staff
authentication. It links through owner-local bindings to Tenant-scoped Principals and
Party/Counterparty ResourceRefs without becoming shared Party identity or granting profile or
purchasing authority by itself.

## Customers, profiles, and channels

**B2C Channel** — Retail Channel in which a visitor may browse and purchase as a Guest or an
authenticated Retail Portal Principal.

**B2B Channel** — Trade Channel where public information may be visible, but Counterparty-specific
Assortment, Pricing, Availability, ordering, approval, and history require explicit Current
Permissions.

**Guest Purchase Context** — Bounded anonymous B2C context for browsing, Cart, and Checkout. It is
not a Principal, Commerce Portal Account, durable-history entitlement, Retail Portal Profile
Binding, or Counterparty authority. At Accepted Order time the purchase is attributable to a Party,
which may still be sparse or Unresolved under Party Registry rules.

**Retail Customer** — Party buying or considering a purchase through a B2C Channel. It is not a
profile, account, Principal, or `B2C/B2B` discriminator.

**Commerce Retail Customer Profile** — Commerce-owned persistent retail purchasing profile for one
Retail Customer and one Selling Legal Entity. Its stable business key is the pair of Retail Customer
Party ResourceRef and Selling Legal Entity. It stores only Commerce-owned state and references;
Party Registry retains shared identity ownership.

**Commerce Counterparty Purchasing Profile** — Commerce-owned persistent purchasing profile for one
Counterparty. Its stable subject is the Counterparty ResourceRef, which already identifies the Party
and managed Legal Entity relationship. Every authorized Principal acting for that Counterparty uses
the same profile.

**Commerce Customer Profile** — Qualified umbrella for a Commerce Retail Customer Profile or a
Commerce Counterparty Purchasing Profile. Every operation still carries the concrete profile kind
and stable subject.

**Commerce Customer Profile State** — Commerce relationship lifecycle with `ACTIVE`, `SUSPENDED`,
and `ARCHIVED` states. `SUSPENDED` and `ARCHIVED` prevent acceptance of a new Order for that profile;
neither deletes identity, Permissions, history, profile, or separately owned settings. Reactivation
uses the same profile and lets each owning capability determine which facts remain Current; it does
not reinstate expired assignments or revoked Permissions.

**Commerce Customer Profile Reconciliation Case** — Durable workflow created when Party Registry
correction, alias, merge, or import correlation causes several Commerce Customer Profiles to resolve
to one canonical business key. It preserves original ResourceRefs, blocks ambiguous writes, assigns
each conflicting fact to its owner, and never silently unions Permissions, claims Guest Orders, or
rewrites historical Resources.

**Retail Portal Profile Binding** — Explicit Commerce-owned relation connecting one Retail Portal
Principal to one Commerce Retail Customer Profile for declared persistent portal capabilities.
Registration, matching Contact Points, Party correction/merge, account ownership, or knowledge of
the profile alone do not create the binding or grant visibility to pre-existing Guest Orders.

**Retail Portal Principal** — Principal with a valid Retail Portal Profile Binding and the concrete
Permissions required for a Retail Customer's address book, history, aftercare, favorites, or
notifications. It is optional for Guest Checkout.

## Segmentation and customer commercial settings

**Commerce Customer Group** — Commerce-owned named business segment applied to Commerce Customer
Profiles, for example `DEALERS` or `STRATEGIC_CUSTOMERS`. It is not a Price Group, Party
Relationship, Principal Permission, Counterparty Role, benefit, or universal rules engine. A
material change of membership criteria creates a new group instead of redefining historical
meaning.

**Commerce Customer Group Membership** — Time-bounded relation between one Commerce Customer Profile
and one Commerce Customer Group. Multiple concurrent memberships are allowed. Membership is global
within the profile and has no implicit Commerce Market, Storefront, Price Group, Permission,
benefit, or priority; each consuming capability owns its own interpretation and conflict resolution.

**Price Group** — Pricing-owned reusable pricing classification. Pricing owns its definition,
revision, lifecycle, applicability, and interpretation; Commerce Customer Profiles may only
reference it.

**Customer Price Group Assignment** — Commerce-owned time-bounded reference from one Commerce
Customer Profile to one Price Group. At most one assignment may be Current for a profile. Commerce
Market and Storefront are separate Pricing inputs, not alternate assignment scopes.

**Customer Price Group Resolution** — Current typed decision returning one usable assigned Price
Group, legitimate absence of a customer Price Group, or explicit broken/inconsistent configuration.
Missing assignment may proceed to Pricing's own fallback; a dangling, incompatible, or unusable
explicit assignment must not be silently treated as absence.

**Customer Currency Preference** — Optional `0..1` long-lived preferred purchase currency on one
Commerce Customer Profile. It is a preference, not transaction currency, Price, or FX rule.

**Explicit Purchase Currency Choice** — Currency deliberately selected for one Current purchase. It
has precedence over Customer Currency Preference and does not update that preference by itself.

**Purchase Currency Resolution** — Deterministic Current decision with precedence: valid Explicit
Purchase Currency Choice, valid Customer Currency Preference, then one unambiguous default from
Customer Commerce Policy. An invalid explicit choice requires a new explicit decision; an invalid
preference may fall back without changing the stored preference. No usable unambiguous currency
means the purchase cannot be Accepted.

**Payment Term** — Payment-owned reusable semantic definition of when and under which commercial
conditions an amount becomes due, for example immediate payment, `NET_14`, or `NET_30`. A material
semantic change creates a new immutable definition revision/identity; it does not rewrite existing
entitlements or Accepted Orders silently. A Payment Term is distinct from a Payment transaction,
receivable, invoice, customer entitlement, and Principal authorization.

**Customer Payment Term Entitlement** — Time-bounded Commerce-owned assignment making one Payment
Term commercially available to one Commerce Customer Profile. A profile may have `0..N` Current
entitlements. Entitlement never grants a Principal Permission to act for the customer.

**Customer Payment Term Preference** — Optional `0..1` preferred Payment Term among a profile's
Current entitlements. Preference is not guaranteed use and may be absent even when several terms are
available.

**Explicit Purchase Payment Term Choice** — Payment Term deliberately chosen for one Current
purchase. It has precedence over preference only when Current entitlement or Customer Commerce
Policy permits it. An invalid explicit choice must not silently fall back.

**Payment Terms Resolution** — Current typed decision with precedence: valid Explicit Purchase
Payment Term Choice, valid preferred Current entitlement, then one applicable Customer Commerce
Policy fallback. Every candidate must be usable in the Current Commerce Purchasing Context. Broken
explicit entitlements are not absence. If no term is usable, the purchase cannot be Accepted. Order
Snapshots the Accepted Payment Term values and references.

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

**Invoice Recipient** — Party or Counterparty identity, Official Identifiers where required, and
billing address Accepted for one purchase. Shared identity comes from Party Registry; Order or the
billing document Snapshots the Accepted values. Default Billing Address is only a selection
preference and is not the complete Invoice Recipient.

**Default Billing Address** — Optional `0..1` persistent pointer from a Commerce Customer Profile to
an eligible Commerce Saved Address used to preselect the address component of an Invoice Recipient.
It is not the only permitted address and never rewrites Accepted Orders or billing documents.

**Delivery Destination** — Postal or pickup destination selected for one purchase and validated by
Current delivery rules. It may originate from a Commerce Saved Address or be a permitted one-time
choice. Order Snapshots the Accepted destination.

**Default Delivery Destination** — Optional `0..1` persistent pointer from a Commerce Customer
Profile to a reusable Delivery Destination candidate. It is a preference, not a guarantee that the
destination is usable for every Product, Cart, carrier, Commerce Market, or Storefront.

## Counterparty access and authorization

**Principal-to-Counterparty Commerce Access** — Set of Current explicit Counterparty Commerce
Permissions held by one Principal for one Counterparty. An empty relation grants nothing. Selected
Counterparty context, Party Relationship, employment, job title, email domain, Commerce Customer
Profile, or Commerce Portal Account never create access.

**Counterparty Permission Catalog** — Versioned contract listing every atomic Counterparty Commerce
Permission, owning capability, protected Actions/reads, supported scope, delegation metadata,
evidence sensitivity, and membership in named authority groups. Adding a new Permission to an
existing group is a security-relevant compatibility change and cannot happen silently.

**Counterparty Commerce Permission** — Atomic Permission allowing one Principal to perform one
declared Commerce Action or governed read for one Counterparty, optionally within a Storefront
scope. Capabilities declare exact Permissions for profile read, purchase preparation/submission,
approval decision, access administration, customer-settings management, address-book use/management,
Purchase Limit management, Approval Hierarchy management, and `OWN_ORDERS` or
`ALL_COUNTERPARTY_ORDERS` history.

**Counterparty Authority Group** — Reviewed bundle of atomic Counterparty Commerce Permissions, such
as Counterparty Buyer, Counterparty Approver, or Counterparty Access Administrator. It is not an
alternate authorization system. V1 group contents are explicit in the Counterparty Permission
Catalog; changing them requires security review and migration/rollout evidence.

**Counterparty Buyer** — Principal whose Counterparty Buyer authority group permits profile read,
purchase preparation/submission, and use of permitted address-book candidates in the exact
Counterparty/Storefront scope. It does not imply history, settings management, access administration,
Purchase Limit management, Approval Hierarchy management, or approval decision. `Approval Required`
does not remove the right to submit the exact proposal into Purchasing Approval.

**Counterparty Approver** — Principal whose Counterparty Approver authority group permits bounded
request/proposal read and approval decision when the Purchase Approval Request's Current Approval
Route also makes the Principal eligible. Permission alone does not assign a request; hierarchy alone
is not authorization.

**Counterparty Access Administrator** — Principal whose Counterparty Access Administrator authority
group permits reading and managing delegable Counterparty Commerce Permissions within an explicit
administrative scope. It manages authorization, not Party identity, Party Relationships, Commerce
Portal Account lifecycle, customer business facts, or Approval Hierarchy. Holding it does not
automatically grant the Permissions being administered.

**Storefront-scoped Permission** — Counterparty Commerce Permission constrained to a trusted resolved
Storefront context. The Storefront Application neither owns nor grants the Permission.

**Positive-grant scope union** — V1 effective Permission is the union of Current positive grants for
the exact Permission code whose scopes contain the trusted request. Counterparty-wide scope covers
all otherwise permitted Storefront contexts; a Storefront grant covers only that Storefront. A
narrower grant never denies a wider grant. V1 has no implicit negative/deny override.

**Counterparty Access Grant** — Audited Action granting one declared Counterparty Commerce Permission
to an existing Principal for one Counterparty and optional Storefront scope. V1 grants are immediate;
no other Permission is implied.

**Counterparty Access Revoke** — Audited Action removing one declared Counterparty Commerce
Permission from a Principal for one Counterparty and optional Storefront scope. V1 revocation is
immediate for new operations and does not erase historical attribution or unrelated Permissions.

**Counterparty Access Invitation** — Time-limited, one-time, revocable invitation to complete
Commerce Portal Account/Principal enrollment and then invoke explicit Counterparty Access Grants.
The invitation is not a Permission or Current access. Email domain, Party Relationship, account
existence, or invitation delivery alone never grant authority.

## Purchasing limits and approval

**Purchase Value** — Non-negative Monetary Amount used only for purchasing-limit assessment: Current
line values after discounts, plus shipping/delivery charges and commercial fees, excluding VAT and
other taxes. It carries source revision and does not transfer Pricing or FX ownership.

**Purchase Limit Policy** — Explicit Current amount-driven purchasing policy for a Counterparty or a
Principal + Counterparty pair. It is either `MONETARY_LIMIT(non-negative amount, currency)` or
`UNLIMITED`. Missing configuration is neither variant and must not be interpreted as unlimited
authority.

**Purchase Limit** — Non-negative Monetary Amount representing the boundary of independent
purchasing authority for one Current B2B purchase under a `MONETARY_LIMIT` policy. A zero limit
means every positive Purchase Value is Approval Required. `Purchase Value <= Effective Purchase
Limit` is Within Limit; a greater value is Approval Required. It is not a period budget, cumulative
spend, credit exposure, accounting balance, or hard financial maximum.

**Unlimited Purchase Limit Policy** — Explicit Purchase Limit Policy stating that amount alone does
not require Purchasing Approval for the scoped Principal/Counterparty. It is not missing data and
does not bypass other Permissions, approval rules, or commercial checks.

**Counterparty Purchase Limit** — Current default Purchase Limit Policy for one Counterparty.

**Principal Purchase Limit Override** — Optional Current Purchase Limit Policy for one Principal and
one Counterparty. When present it fully replaces the Counterparty Purchase Limit and may lower,
raise, set zero, or explicitly remove the monetary boundary through `UNLIMITED`.

**Effective Purchase Limit Policy** — Current Principal Purchase Limit Override when one exists;
otherwise the Current Counterparty Purchase Limit. A missing or inconsistent policy is a typed
configuration result, not silent fallback.

**Effective Purchase Limit** — Monetary Amount inside an Effective Purchase Limit Policy of kind
`MONETARY_LIMIT`. Cross-currency evaluation requires an authoritative comparable Purchase Value in
the limit currency, with source revision and rounding already decided by the authoritative source.

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
reviewed and approved. It contains exact Purchasing Subject, acting Buyer, Product/configuration,
quantities, Purchase Value, currency, resolved commercial terms, Invoice Recipient, Delivery
Destination, and source revisions needed to identify what was approved. It is not an Order and does
not reserve stock, guarantee price, or authorize Payment unless a separate owner-issued
reservation/quotation/Payment contract explicitly says so.

**Purchase Approval Request** — Purchasing Approval-owned workflow for one Purchase Proposal
Revision. Its lifecycle is `PENDING`, `RETURNED`, `APPROVED`, `REJECTED`, `CANCELLED`, `EXPIRED`, or
`SUPERSEDED`. Approval is always tied to the exact revision.

**Approval Hierarchy** — Explicit, versioned Counterparty purchasing-policy structure describing
ordered approval levels and eligible Principals or pools, optionally scoped by Storefront or value
range. It is not inferred from Party Relationship, employment, job title, email domain, Commerce
Portal Account, or Access Administrator Permission.

**Approval Route** — Current resolved ordered set of approval levels and eligible Principals for one
Purchase Approval Request. Every decision still requires Current Counterparty Approver Permission.
If no valid route exists, submission returns an explicit configuration result and the Cart/proposal
remains available.

**Approval Decision** — Audited `approve`, `return`, or `reject` Action against one Current Purchase
Approval Request and exact Purchase Proposal Revision. `return` requests a new Buyer revision;
`reject` terminates the Current request. Self-approval is denied unless an explicit Purchasing
Approval Business Policy allows it.

**Purchasing Approval** — Domain owning Purchase Approval Requests, Approval Hierarchies, Approval
Routes, levels, assignments, decisions, expiry, supersession, and revalidation. It does not own
Counterparty Approver Permission, Purchase Limits, Cart, Pricing, or Order. An approved request
authorizes only the exact proposal revision to attempt final Order acceptance.

**Approval Revalidation** — Check that an approved Purchase Proposal Revision still matches the Cart
and Current acceptance inputs. Any material change to Purchasing Subject, Buyer, Product identity or
configuration, quantity, Accepted price/discount/fee/tax, currency, Payment Term, Invoice Recipient,
Delivery Destination, Purchase Value, or applicable approval policy supersedes approval and requires
a new revision and route. Final Availability, reservation, Payment, and Order acceptance checks still
run.

## Order acceptance and recovery

**Reservation Confirmation** — Inventory/Availability-owner-issued proof that specified Product or
stock quantities are provisionally reserved for one exact Order Commitment Attempt until an explicit
expiry/lease boundary. It has owner-scoped idempotency and correlation. It is not an Order or
permanent Availability guarantee, and an expired/unverifiable confirmation is not Current.

**Payment Authorization** — Payment-owned proof that the required Payment method/amount/currency is
authorized for one exact Order Commitment Attempt under the resolved Payment Term. It is distinct
from capture, settlement, refund, and Order. It has explicit provider correlation, idempotency,
Current status, and validity; secrets or payment instruments never enter Commerce business payloads.

**Order Acceptance Decision Bundle** — Immutable, versioned, canonical-hashable representation of
one exact purchase candidate and its owner-issued Current decisions. It includes trusted scope,
Purchasing Subject/Actor, Cart revision, Products/configurations/quantities, Monetary Amounts,
Pricing/Tax/currency, Payment Term, Invoice Recipient, Delivery Destination, Purchase Value/limit
result, approval evidence when required, and source revisions/validity needed for final acceptance.
It is prospective and owns none of the source facts.

**Order Commitment Attempt** — Durable idempotency and recovery anchor for attempting to turn one
exact Order Acceptance Decision Bundle into at most one Order. It tracks preparation correlations,
commit proof, compensation/reconciliation state, and conflicts. A different bundle cannot reuse the
same idempotency identity.

**Order Commitment Gate** — Final consistency boundary that resolves one Order Commitment Attempt,
rechecks Current profile/Permissions/Business Policies, validates one exact Decision Bundle and any
approved proposal revision, verifies required Reservation Confirmations and Payment Authorization,
and commits exactly one Order. It coordinates public contracts and never opens a shared cross-module
business transaction or silently modifies customer choices.

**Order Commitment Reconciliation** — Owner-governed recovery that first proves whether Order commit
occurred, then converges provisional reservation/Payment effects and downstream work without
duplicating Orders or provider operations. Definite pre-commit failure may trigger idempotent
release/void; a proven committed Order is never erased as false rollback. Indeterminate outcomes and
post-commit debt remain explicit and retryable.

## History, archive, and repeat purchase

**Customer-facing Record Visibility** — Owning capability's Current decision that one retained record
or field may be exposed to one Retail Customer or Counterparty context. It is separate from
retention, authorship, profile/account binding, and broad history Permission. A retained record may
be non-customer-facing; current access cannot override owner-level restriction.

**Retail Customer Order History** — Authorized read-only view over customer-facing Orders visible to
one Commerce Retail Customer Profile. It requires Current Retail Portal Profile Binding, concrete
history Permission, and Order-level Customer-facing Record Visibility. It creates no Order copy.

**Guest Order Claim** — Explicit verified Action that may make an eligible Guest Order visible in one
Retail Customer Order History. Registration, matching Contact Points, Retail Portal Profile Binding,
Party matching/correction/merge, or account ownership alone never perform the claim. Automatic Guest
Order claiming is not part of the Current Launch Capability unless separately accepted.

**Counterparty Order History** — Authorized read-only view over customer-facing Orders of one
Counterparty. Current Principal-to-Counterparty Commerce Access is required together with explicit
history scope `OWN_ORDERS` or `ALL_COUNTERPARTY_ORDERS`, plus each record's Customer-facing Record
Visibility. Buyer, Approver, or Access Administrator Permission alone does not imply all-Order
visibility.

**Customer Archive** — Authorized read-only access to retained Orders, documents, and Claims. It is
not the statutory accounting or tax archive, retention owner, duplicate record store, or the
`ARCHIVED` state of a Commerce Customer Profile.

**Repeat Order** — Authorized Action constructing a new Cart from still-sellable historical Order
items and valid configurations on a best-effort basis. Current Permissions, Products, quantities,
prices, Availability, currency, Invoice Recipient, Delivery Destination, Payment Terms, Purchase
Limits, and approval policy apply; historical terms and authority are not reinstated.

**Assisted Support** — Audited staff capability exposing customer context without silently assuming
customer identity. Customer-affecting Actions remain explicit and attributed to the operator.

## Commerce domains

**Product** — Good or service with stable commercial identity. Price and Availability are not part
of that identity.

**Catalog** — Domain owning Product identity, variants, configuration, classification, descriptive
facts, media references, and relationships.

**Assortment** — Products eligible for visibility or purchase in a Channel, Commerce Market,
Storefront, Retail Customer context, or Counterparty context.

**Pricing** — Domain determining prices, discounts, fees, tax inputs, quantity tiers, quotations,
and Price Group definitions for an explicit Commerce Purchasing Context.

**Inventory** — Domain owning stock and reservations when the Customer Configuration owns those
lifecycles.

**Availability** — Current promise that a Product can be sold and delivered in a Commerce Purchasing
Context. It may derive from Inventory or an External Business System that owns the relevant fact.

**Cart** — Mutable prospective set of Product selections under an explicit Commerce Purchasing
Context. A Cart is not an Order, approval, Reservation Confirmation, quotation, or historical fact.

**Checkout** — Process coordinating Current validation, customer choices, Cart submission, and the
handoff to Purchasing Approval or Order Commitment Gate. It owns no source facts or resulting Order.

**Order** — Durable Accepted purchase and Snapshot of Accepted commercial terms, source evidence,
and Actor attribution. It remains the System of Record for the historical purchase even when Current
source definitions later change.

**Payment** — Domain owning Payment Term definitions plus Payment authorization, collection,
settlement, cancellation, refund, and reconciliation outcomes. Customer entitlement, preference,
purchase selection, and Order Snapshot remain separate facts.

**Fulfillment** — Domain for preparation, handoff, delivery, tracking, partial fulfillment, and
delivery exceptions.

**Aftercare** — Customer and operator work coordinated over Order, Payment, Fulfillment, Billing
Documents, and Claim lifecycles without replacing their ownership.

**Claim** — Governed request concerning durable Order lines, with its own evidence, communication,
deadlines, state, and resolution history.

**Customer Commerce Policy** — Declarative Customer Configuration of shared Channel, purchasing,
quantity, Commerce Market, currency, Payment Terms, approval, delivery, and legal Business Policy.
It supplies explicit defaults and constraints, not arbitrary hidden executable logic. Different
executable semantics require a shared module change or an explicitly catalogued implementation.
