# Commerce language

Commerce is a reusable B2C/B2B Application Composition. Customer deployments provide evidence and
configuration; they do not create separate products or hidden forks. This context owns accepted
Commerce semantics and vocabulary, not storage or transport mechanics. It extends
`../ontos/CONTEXT.md`; when the two contexts conflict, the OntOS context and accepted ADRs govern.

## Language rules and shared purchase context

**Qualified customer terminology** — `Customer` is never a standalone identity type or aggregate.
Always qualify the meaning: Customer Configuration, Retail Customer, Commerce Retail Customer
Profile, Commerce Counterparty Purchasing Profile, Commerce Customer Group, Customer Archive, or
another explicit context. Avoid unqualified `customer`, `customer record`, `customer ID`, and
`B2B Customer` when the intended subject is a Party, Counterparty, Principal, account, role, or
profile.

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
source fact. An immutable prospective representation, such as a Purchase Proposal Revision, is not
an Accepted Order Snapshot.

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

## Catalog language and exact selection

Catalog terms describe shared Commerce semantics, not customer-specific implementations. Product,
Variant and definition identities are Tenant-scoped. A ResourceRef names its owning Resource; an
immutable value or source revision must not acquire a fabricated Resource identity merely because a
consumer needs to retain it. A planning branch is not automatically a separate deployable module.

**Product** — Tenant-scoped Catalog Resource representing one good or service with stable commercial
identity. Channel, Selling Legal Entity, name, SKU, Price, Assortment, Inventory, Availability, or
presentation do not by themselves create another Product. A materially different real-world thing
must not silently replace the meaning of an existing selection.

**Variant** — Catalog Resource identifying one predefined independently distinguishable realization
of exactly one Product. Every Product has `1..N` Variants, including a Product with only one
realization. A draft Variant may be incomplete and is not thereby a validated selection. A material
change of an atomic realization requires a different Variant; a Set Variant uses the explicitly
versioned succession semantics of Set Composition Revision. Variant is not SKU, Quantity, stock,
Price, or an Assortment decision.

**Catalog Selection Target** — Stable predefined target before purchase Quantity is applied: exactly
one Variant, or a Package Option belonging to that Variant. Product alone is not an exact target.
Product Configuration refines a target but is not another predefined target. A target reference alone
does not replace required configuration, package-content or set-composition revisions.

**Catalog Revision Reference** — Owner-qualified reference to one immutable version of a Catalog
fact or definition, identifying its source Resource and exact revision. It is not a bare revision
number, edit timestamp, ResourceRef with an implicit latest value, or necessarily a separate Resource.
It preserves the version used without claiming that this version remains Current.

**Catalog Selection** — Canonical immutable business value describing exactly what a prospective
line requests before purchase Quantity and non-Catalog commercial decisions. It contains Product and
Variant ResourceRefs, optional Package Option reference with exact Package Content Revision,
optional complete Product Configuration, and exact Set Composition Revision when the Variant is a
Set, including a packaged Set. It never contains a moving latest-composition reference. Cart and all
purchase consumers use this same meaning rather than reconstructing identity from SKU or display.

**Catalog Selection Evidence** — Catalog-issued validation result for one exact selection at trusted
operation time. It preserves relevant lifecycle, definition, inherited-value, component, unit and
other source revisions, applicable validity, and material facts needed to detect stale meaning.
Indirect changes can invalidate it without editing the selected Variant. It contains no Price,
Assortment, Inventory, Availability, Permission, approval, Payment or Order decision. A timestamp or
hash alone is not an owner guarantee of validity through a later commitment window.

**Catalog-ready** — Current condition that the concrete selection and its Product satisfy all
applicable Catalog-owned minimum rules. Readiness is assessed for the required use and realization;
it is not merely a manually set flag and is not Assortment, Price, stock, Availability, publication,
or Permission. Draft, retirement and incomplete data are distinct from this derived condition.

**Catalog Correction** — Evidence-backed correction of an incorrectly recorded Catalog fact about
the same real-world subject. It may preserve stable identity while changing the meaning of an open
selection, which then needs revalidation. It never rewrites retained prior evidence or Accepted Order
values. An unclassified material change is not presumed to be a correction.

**SKU** — Internal commercial code for one Catalog Selection Target. One target has `0..1` primary
Current SKU, unique within its Tenant; quantity is separate. Comparison ignores outer whitespace and
letter case, not inner characters or leading zeroes. The original presentation is retained. SKU is
not Product identity and is not universally required merely for Product existence.

**Historical SKU** — Previously used internal SKU preserved against its original target. A
legitimately used code is not reassigned to another target, including after retirement. Correction
of a proven mistaken assignment retains the old attribution and ambiguity rather than pretending
all historical occurrences identified the corrected target. Lookup does not grant new sellability.

**GTIN/EAN** — Standard trade-item identifier for a predefined item or identified packaging level.
It is not internal SKU, serial identity of one physical instance, Product identity or external record
ID. Format validity and correct attribution are separate facts. Packaging-level identification does
not by itself make that level a separately selectable Package Option.

**Product Type** — Catalog Resource defining structured-data requirements for a kind of Product.
One Product has `0..1` Current Product Type; a draft may have none. A type declares its allowed
Attribute Definitions and required subset. Required/optional belongs to that use, not globally to
the attribute. Product Type is not Category, identity, Set marker, packaging marker or selling policy.
Absence of a type does not permit arbitrary undeclared structured attributes.

**Attribute Definition** — Stable Catalog Resource defining one structured Product/Variant fact,
its business meaning, value kind, applicable subject levels, canonical measurement unit where
relevant, range/precision and single/multiple multiplicity. Similar names do not establish equal
meaning. Materially changing what is measured or described requires a distinct definition.

**Attribute Value** — Concrete value of one Attribute Definition for a Product or Variant, not a
copy of the definition. Missing is not automatically zero, empty text, unknown or not applicable.
Every value follows its definition and the Product Type allowed set; measured values preserve exact
business meaning under permitted unit conversions.

**Variant Attribute Override** — Explicit Variant-level value taking precedence over an inherited
Product value where that attribute applies. Product edits do not overwrite it. Removing it restores
inheritance; an explicitly allowed unknown/not-applicable value is a different state and must not
silently fall back. Inheritance cannot silently change the identity of an existing Variant.

**Variant Axis** — Product-specific role of an existing Attribute Definition distinguishing its
predefined Variants. Complete axis combinations distinguish Current Variants within one Product;
SKU cannot substitute for a missing distinguishing axis. An axis copies neither definitions nor
controlled values. Individual allowed values never create a Cartesian product of existing Variants.
A single-Variant Product may have no axes.

**Controlled Attribute Value** — Stable Catalog-owned value in a governed vocabulary for an
Attribute Definition. Rename preserves identity only when meaning is unchanged. Retirement prevents
new assignment while retaining existing references and their explanation; it is not automatically
Product retirement. Reactivation preserves the same identity. Color and Size are specialized values.

**Color** — Shared Catalog-owned controlled identity of a color meaning, separate from its name,
general color group or visual preview. Same name or HEX/RGB does not prove the same actual color;
an authoritative swatch system may provide evidence, not replace Catalog identity. Product/Variant
uses the shared value without copying it.

**Color Preview** — Illustrative display representation of a Color, for example a swatch or
HEX/RGB value. It is not proof of physical shade, material, finish, compatibility or identity.

**Size** — Shared Catalog-owned controlled value such as S, M, L or 80, without a mandatory separate
Size System identity scope. Products using the same Size may have different physical dimensions.
Order belongs to the concrete usage list, not a universal Size ordering. Equivalence or conversion
requires scoped evidence; a numeric Size label is not a measured value with an inferred unit.

**Product Category** — Stable Catalog classification Resource with `0..1` direct parent; multiple
roots are allowed. Rename preserves identity only for unchanged classification meaning. Hierarchy
is acyclic. No shared primary/main Product Category exists in the Current model. Category is not
Product Type, navigation, publication, Assortment or Permission.

**Direct Category Assignment** — Explicit Product-to-Product Category relation. A Product has
`0..N` such assignments; removing one preserves independent others. A Variant uses the classification
of its Product, not an implicit second category taxonomy.

**Ancestor Classification** — Broader classification derived from the current ancestors of a direct
Product Category. It is not another direct assignment. A consumer explicitly chooses direct or
ancestor-inclusive meaning; moving a category can change its result even if direct assignment stays.

**Brand** — Stable Catalog-owned identity of the commercial designation under which a Product is
presented, with `0..1` Current Brand per Product in the base model. Missing Brand differs from
confirmed unbranded; neither requires a pseudo-Brand. Variants normally use their Product's Brand;
a different Brand requires an identity-boundary review, not an ordinary attribute override.
Brand is not Party, Manufacturer, Supplier, Product identity or marketing Content.

**Manufacturer** — The real-world subject that manufactures a Product or Variant, not a Brand,
Supplier, Counterparty Role or acting Principal. It may be an external person/organization Party or
a managed Legal Entity; the latter must not be mirrored as a Party to fill a manufacturer field.

**Manufacturer Relation** — Catalog-owned Product/Variant fact pointing to the Manufacturer's typed
Party ResourceRef or managed Legal Entity ResourceRef. Catalog owns applicability and provenance,
never the referenced identity. Base scope has at most one resolved Current Manufacturer for an
exact realization. Unknown/ambiguous evidence is not a guessed relation. Identity correction or
alias resolution remains with the respective identity owner and does not automatically prove a
product relation or grant Permission.

**Supplier** — Commercial sourcing meaning describing from whom a managed Legal Entity obtains or
may obtain a Product. Shared external identity and Counterparty Role truth belong to Party Registry.
Product-specific sourcing requires an explicit procurement owner; a Supplier role alone does not
prove supply of a particular Product and is never inferred into Manufacturer semantics.

**Unit** — Explicit Catalog-governed unit meaning used by Quantity or measurement. A label alone is
not a unit identity or conversion rule. Compatible measurement conversion preserves the same
quantity kind; product attributes and purchase Quantity retain their different purposes.

**Quantity** — Exact amount paired with an explicit Unit and target meaning. Purchase Quantity is
separate from dimensions of one item. Accepted Quantity preserves the unit and any package-content
basis used; a count of packages is not a count of their contained pieces.

**Quantity Step** — Smallest permitted purchase-quantity increment declared for a Unit in the
Tenant's Catalog, together with deterministic rounding semantics. Target divisibility is a separate
Catalog fact. This unit-level rule does not impose purchase rounding on measured Attribute Values or
Product Configuration choices; stricter commercial multiples belong to Commerce Quantity Rules.

**Quantity Normalization** — Catalog-governed interpretation of a requested purchase Quantity under
its unit step and target divisibility. A meaningful off-step divisible amount may be automatically
rounded under the explicit unit rule, retaining and reporting requested and resulting values.
A nonsensical fractional indivisible item is rejected, not legalized by rounding. A changed amount
must belong to the explicitly presented candidate before Pricing, approval and final acceptance;
normalization never silently modifies an already approved or committing candidate.

**Package Definition** — Catalog Resource describing a required homogeneous packaging level for
exactly one Variant. Its content and conversions are versioned. A higher level may refer to a
precisely versioned lower level of the same Variant, with finite acyclic contents. A packaging level
used only to explain a quantity is not automatically independently selectable or separately stocked.

**Package Option** — Independently selectable role of a Package Definition whose packaging itself
is part of a legitimately different requested item. It uses that definition's stable Resource
identity, not a parallel duplicate record. The option belongs to exactly one Variant and may have
its own SKU/GTIN. Same quantity, different Price, package name or commercial multiple alone does not
establish this role; replacing it with loose pieces requires an explicit changed selection.

**Package Content Revision** — Immutable, owner-qualified revision of a Package Definition's exact
homogeneous contents, quantities, units and lower-level revision references. A material change always
creates a distinguishable revision, not automatically another Product or SKU. Successive contents
may retain the packaging identity; concurrently independently selected different packages require
distinct Package Options. An exact package selection pins its revision, never latest contents.

**Product Configuration Definition** — Product-level Catalog Resource defining supported individual
choices and constraints. Variant rules can refine applicability without copying the definition.
Launch scope supports Single Choice and Measured Value, not an unrestricted expression engine,
free-text configurator, multi-choice tree or buyer-configurable Set composition.

**Configuration Choice** — Stably distinguished question within a Product Configuration Definition,
with explicit meaning, required/optional status and allowed kind. Its display label is not its
identity. An optional omitted choice is distinct from a missing definition or required value.

**Single Choice** — One chosen value from an explicitly defined set for a Configuration Choice.
A binary choice can use two named alternatives without a separate Boolean type. Selection does not
create a new predefined Variant or SKU.

**Measured Value** — One exact numeric configuration value with an explicit compatible Unit,
applicable bounds, boundary inclusion and step/origin when constrained. No minimum, maximum,
inclusion or step is inferred from absence. Confirmed lack of a constraint differs from unknown.

**Product Configuration Definition Revision** — Immutable semantic revision with explicit
`effective_from` and unambiguous Current applicability. It is separate from the selected values.
A materially affected prospective selection requires Current revalidation; an old Cart has no
implicit entitlement to obsolete rules. Equivalence across revisions is confirmed by Catalog only
for the actual target, meaning and admissibility being evaluated.

**Product Configuration** — Immutable value refining an exact Catalog Selection Target with its
complete business-significant choices, values and units. Product/Variant/Package target is part of
its meaning; display labels and presentation order are not. It is not a required new Resource,
Product, Variant, Package Option or SKU. Its definition revision is retained as validation evidence,
not confused with the identity of the chosen physical meaning.

**Product Configuration Validation** — Catalog decision returning VALID for a fully admissible
selection, INVALID with a known violated rule, or INDETERMINATE when decisive facts cannot be
established. Validation never silently rounds a Measured Value or substitutes another choice.
Permission denial, dependency outage and an uncertain write outcome are not fabricated product rules.

**Set Product** — Ordinary Product representing a multi-component whole, not another top-level
identity registry. Set is the short Catalog alias for Set Product. Its independently selectable
whole is a Variant; the exact selected content additionally requires Set Composition Revision.
Launch Sets are fixed and flat: no buyer component alternatives, optional extras inside composition,
or nested Set component, including nesting hidden through a Package Option.

**Set Composition Revision** — Immutable Catalog-owned revision of one Set Variant's exact fixed
components, component Catalog Selections, quantities and units. Every material content change has a
different revision. A successor of the same stable Set may retain Product/Variant identity; two
concurrently or independently selected different wholes need distinct Variants, and different stable
product families need distinct Products. This explicit Set succession rule does not permit in-place
replacement of an atomic Variant. Existing selections retain their exact revision, not the successor.

**Product Relationship Type** — Governed meaning of a product relation. Supported semantics are
ACCESSORY_FOR (doložené příslušenství pro), RELATED_PRODUCT (související produkt without implied
technical compatibility) and SUCCESSOR (nástupce for a new explicit selection). These names are
semantic identifiers, not a prescribed wire encoding. OTHER plus arbitrary text is not a new type.

**Product Relationship** — Explicit directional Catalog relation with Product or Variant endpoints
and evidence for the entire stated scope. Reverse lookup preserves meaning. Multiplicity is `0..N`
unless a supported type explicitly narrows it; successor is not implicitly singular. Effective Period
is used where known/needed, without inventing historical dates. Retirement of an endpoint does not
automatically erase a still-meaningful relation. Relations never define Set contents or authorize
silent substitution.

**Catalog Descriptive Fact** — Catalog-owned factual name or description of a Product, distinct from
Content-owned marketing copy. A completed Product has at least one nonempty catalog name; a general
long description is not universally required. A display text never overrides an authoritative
structured fact merely because it is newer or more prominent.

**Catalog Localized Value** — Language representation of the same Catalog fact, not another Product
or another fact owner. A missing requested locale is explicit; Storefront presentation fallback does
not create the absent translation.

**Catalog Document Reference** — Catalog-owned applicability relation from Product/Variant to a
Documents Center Resource. Live use follows that same Resource's Current version without a separate
Catalog approval for each compatible version; replacing the Resource is an explicit relation change.
Applicability and access still govern. Evidence required for an Accepted result pins the actual
version/bytes, not the later live reference. Catalog owns no duplicate document store.

**Catalog Media Assignment** — Catalog-owned relation recording media Resource, Product/Variant
applicability, purpose and explicit order. Variant media takes precedence; absent Variant media uses
the Product media set. Main medium means the first item, including after removal, regardless of
purpose. A fallback depicting another realization is illustrative, not proof of the selected Color
or dimensions. Presentation must preserve this distinction; access and bytes remain document-owned.

**Catalog Permission** — Atomic OntOS Permission for a declared Catalog Action or governed read in
an explicit Resource/Tenant scope. Purchasing access, job title, identity relations, client identity
or commercial eligibility do not create it. Its enforcement uses existing Core authorization.

**Catalog Authority Bundle** — Reviewed named grouping of Catalog Permissions, not another role or
authorization engine. Catalog Reader groups bounded reads; Product Editor groups ordinary product
editing; Catalog Definition Manager groups shared-definition changes; Catalog Lifecycle Manager
groups high-impact lifecycle changes. These bundles do not imply one another or grant newly added
Actions without explicit permission-catalog review.

**Catalog Source Assertion** — Provenance-backed claim received about a Catalog fact, retaining
issuing source, source record, source revision/validity, recorded time and acceptance outcome.
Received is not automatically Current. Fact-specific authority, exact target resolution and Catalog
invariants govern adoption; later delivery, omission or duplicate delivery is not a new authority.

**Catalog Local Override** — Explicit governed Catalog decision changing Current resolution of one
Catalog-owned fact/scope over an accepted authoritative external base assertion. It retains actor,
reason, scope and lifecycle without changing the source System of Record. New source assertions
continue to be retained as base evidence. Release resolves the newest usable authoritative base;
a conflict or absent base is explicit, not a fallback to stale data. Override is not an identity,
Permission, price or stock override.

**Catalog Policy Scope** — Typed selector through which a consuming Business Policy refers to
Catalog identities. Supported selector kinds and precedence must be declared by that policy family;
there is no implicit SKU/name matching, arbitrary Catalog query or automatic category inheritance.
A declared selector does not transfer Catalog facts to the consumer.

**Commerce Quantity Rule** — Customer Commerce Policy-owned typed, versioned commercial rule for
purchase quantities, packaging multiples or minimum-order conditions. Its exact commercial context,
Catalog Policy Scope, unit/basis and fallback or non-relaxable-constraint meaning are explicit. It
consumes Catalog quantity facts without redefining divisibility, content, Price or physical identity.

**Customer Quantity Rule Assignment** — Explicit, effective Customer Commerce Policy-owned binding
of a Commerce Quantity Rule to one concrete Commerce Customer Profile. It is the bounded
quantity-specific assignment, not ownership of the profile, Party or other customer settings.
An assignment cannot relax Catalog validity or a non-relaxable commercial constraint and cannot be
inferred from Principal identity, group membership or a missing rule.

**Commerce Quantity Resolution** — Current policy-owned result for exact Catalog Selection and
Quantity in a trusted Commerce Purchasing Context, retaining rule/assignment revisions and Catalog
basis. It distinguishes permitted quantity, known violated commercial conditions and explicit
missing/conflicting/unverifiable inputs. It neither changes the requested candidate silently nor
creates Permission, Price, Availability or an Order.

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

**Purchase Proposal Revision** — Immutable prospective representation of one submitted Cart revision
that can be reviewed and approved. It contains exact Purchasing Subject, acting Buyer, Catalog
Selections and Quantities, Purchase Value, currency, resolved commercial terms, Invoice Recipient,
Delivery Destination and source revisions needed to identify what was approved. It is not an
Accepted Order Snapshot and does not reserve stock, guarantee price or authorize Payment unless a
separate owner-issued reservation/quotation/Payment contract explicitly says so.

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
and Current acceptance inputs. A material change to Purchasing Subject, Buyer, Catalog Selection,
Quantity, proposed price/discount/fee/tax, currency, Payment Term, Invoice Recipient, Delivery
Destination, Purchase Value or applicable approval policy supersedes approval and requires a new
revision and route. Owner-attested non-material source changes may retain approval, not fabricate
unchanged evidence hashes. Final Availability, reservation, Payment and acceptance checks still run.

## Order acceptance and recovery

**Reservation Confirmation** — Inventory/Availability-owner-issued proof that specified Catalog
Selections and quantities, or their explicitly mapped stock requirements, are provisionally reserved
for one exact Order Commitment Attempt until an explicit expiry/lease boundary. It has owner-scoped
idempotency and correlation. Mapping to stock does not reinterpret package or Set contents. It is not
an Order or permanent Availability guarantee; an expired/unverifiable confirmation is not Current.

**Payment Authorization** — Payment-owned proof that the required Payment method/amount/currency is
authorized for one exact Order Commitment Attempt under the resolved Payment Term. It is distinct
from capture, settlement, refund, and Order. It has explicit provider correlation, idempotency,
Current status, and validity; secrets or payment instruments never enter Commerce business payloads.

**Order Acceptance Decision Bundle** — Immutable, versioned, canonical-hashable representation of
one exact purchase candidate and its owner-issued Current decisions. It includes trusted scope,
Purchasing Subject/Actor, Cart revision, exact Catalog Selections and Quantities, Monetary Amounts,
Pricing/Tax/currency, Payment Term, Invoice Recipient, Delivery Destination, Purchase Value/limit
result, Assortment/Availability evidence, approval evidence when required and exact source
revisions/validity. Product Configuration is retained as a value, not a fabricated Configuration
ResourceRef. Changed evidence produces a distinct representation even when owners prove unchanged
business meaning. The bundle is prospective and owns none of the source facts.

**Order Commitment Attempt** — Durable idempotency and recovery anchor for attempting to turn one
exact Order Acceptance Decision Bundle into at most one Order. It tracks preparation correlations,
commit proof, compensation/reconciliation state, and conflicts. A different bundle cannot reuse the
same idempotency identity.

**Order Commitment Gate** — Final consistency boundary that resolves one Order Commitment Attempt,
rechecks Current profile/Permissions/Business Policies, validates one exact Decision Bundle and any
approved proposal revision, verifies required Reservation Confirmations and Payment Authorization,
and commits exactly one Order. It coordinates public contracts and never opens a shared cross-module
business transaction or silently modifies customer choices. Owner validity through commitment must
be established rather than inferred from an earlier read or an undelivered change event.

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

**Repeat Order** — Authorized Action constructing a new Cart from historical Order-line Catalog
Selections on a best-effort basis. Every line is resolved and revalidated as a new Current Catalog
Selection; no historical SKU, successor relation, Set component, Package Content Revision or Product
Configuration rule silently substitutes a Current alternative. Current Permissions, Assortment,
Quantities, Pricing, Availability, currency, Invoice Recipient, Delivery Destination, Payment Terms,
Purchase Limits and approval policy apply; historical terms and authority are not reinstated.

**Assisted Support** — Audited staff capability exposing customer context without silently assuming
customer identity. Customer-affecting Actions remain explicit and attributed to the operator.

## Commerce domains

**Catalog** — Domain owning Product, Variant, Product Type, Attribute Definition/Value, Brand,
Manufacturer Relation, Product Category, Package Definition/Option, Product Configuration meaning,
Set Composition, Product Relationship, product identifiers, descriptive facts, media/document
reference semantics and Current Catalog Selection validation. It provides Catalog Selection Evidence
but owns no Price, Assortment, Inventory, Availability, Permission, approval, Payment or Accepted Order.

**Assortment** — Domain determining eligibility of an exact Product/Catalog Selection for visibility
or purchase in a Channel, Commerce Market, Storefront, Retail Customer context or Counterparty
context. A Product-level browsing result is not proof that every Variant or Package Option may be
purchased. Catalog existence or publication does not imply eligibility.

**Pricing** — Domain determining prices, discounts, fees, tax inputs, quantity tiers, quotations,
and Price Group definitions for an explicit Commerce Purchasing Context and exact Catalog Selection
and Quantity. Set/Package prices are not silently derived from component sums or loose-piece prices.

**Inventory** — Domain owning stock and reservations when the Customer Configuration owns those
lifecycles. Inventory maps exact Catalog selections to explicitly owned stock requirements without
redefining product identity or package/composition semantics. Separate Catalog selection identity
neither requires separate stock nor permits double reservation of a Set and its components.

**Availability** — Current promise that an exact Catalog Selection and Quantity can be sold and
delivered in a Commerce Purchasing Context. It may derive from Inventory or an External Business
System that owns the relevant fact. Catalog-ready or Assortment-eligible does not mean Available.

**Cart** — Mutable prospective collection of Catalog Selections, Quantities and Current choices in
one Commerce Purchasing Context. Incomplete preparation may be retained but is not a validated
complete selection for submission. A Cart is not an Order, approval, Reservation Confirmation,
quotation or Accepted historical fact.

**Checkout** — Process coordinating Current validation, customer choices, Cart submission and the
handoff to Purchasing Approval or Order Commitment Gate. It owns no source facts or resulting Order.

**Order** — Durable Accepted purchase and Snapshot of Accepted Catalog Selections, Quantities,
commercial terms, source evidence and Actor attribution. It remains the System of Record for the
historical purchase even when Current Catalog or other source definitions later change.

**Payment** — Domain owning Payment Term definitions plus Payment authorization, collection,
settlement, cancellation, refund, and reconciliation outcomes. Customer entitlement, preference,
purchase selection, and Order Snapshot remain separate facts.

**Fulfillment** — Domain for preparation, handoff, delivery, tracking, partial fulfillment and
delivery exceptions. It acts on Accepted line and component meaning; current Catalog revisions do
not silently replace the items to be fulfilled.

**Aftercare** — Customer and operator work coordinated over Order, Payment, Fulfillment, Billing
Documents, and Claim lifecycles without replacing their ownership.

**Claim** — Governed request concerning durable Order lines, with its own evidence, communication,
deadlines, state, and resolution history.

**Customer Commerce Policy** — Declarative Customer Configuration of shared Channel, purchasing,
quantity, Commerce Market, currency, Payment Terms, approval, delivery and legal Business Policy.
A typed field may declare Catalog Policy Scope; the bounded Commerce Quantity Rule family also owns
explicit Customer Quantity Rule Assignments. Other profiles, customer settings and domain facts keep
their respective owners. Defaults, constraints, scope precedence and absence are explicit, never
arbitrary executable logic. Different executable semantics require a shared module change or an
explicitly catalogued implementation.
