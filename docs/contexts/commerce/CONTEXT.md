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

**Commerce Market** — Stable declarative commercial/legal selling context for exactly one Selling
Legal Entity inside a Tenant. It may correspond to a country or region but is not a Tenant,
Environment, Deployment Topology, Storefront, currency, or fact owner; one Storefront may serve
several Markets and one Market may be served by several Storefronts. A different Selling Legal
Entity requires a different Commerce Market identity rather than reusing the same Market label.

**Commerce Market Resolution** — Current decision establishing one exact eligible Selling Legal
Entity + Commerce Market + Channel tuple for purchase-ready use. It validates explicit/default
selection against Market lifecycle and Storefront associations without inferring authority from
hostname, locale, IP, shipping address, currency, or technical ordering. When eligibility is a set
claim, the result uses the shared OntOS Owner-Verifiable Set Completeness Evidence contract.

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
requests to resolve context, never trusted authority. Storefront may be present for routing,
presentation, audit, security, or Market resolution, but it is not a Pricing monetary selector.

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
Commerce facts. Storefront identity, hostname, route, locale, or branding never select Price,
Quantity Tier, Pricing-owned Discount, Pricing Commercial Fee, ZERO_FLOOR Authorization, or another
canonical Pricing monetary result.
_Avoid_: Storefront price list, Storefront price override, frontend-owned monetary calculation.

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

**Commerce Portal Account** — Commerce-governed authentication account represented by one stable
Commerce Portal Account Subject in the dedicated Commerce Authentication Namespace. It is not
Tenant-scoped; each Tenant uses a separate Principal Auth Binding to map the same account subject to
one Tenant-scoped Principal. The authentication provider owns credentials, Authentication
Identifiers and sessions; the account is not Party identity, Principal, profile access, or purchasing
authority.
_Avoid_: email/telephone as account identity, Tenant as part of the account identity, provider
technology name without realm/namespace qualification, Portal Account used as Purchasing Subject.

**Commerce Portal Account Subject** — Exact external authentication subject representing one
Commerce Portal Account: `(Authentication Namespace, subjectType=user, providerSubjectId)`.
`providerSubjectId` is the provider's stable opaque user-subject identifier; `subjectType=user` is an
explicit Commerce Launch invariant, not an omitted identity dimension. The subject is cross-Tenant;
Tenant belongs to the separate Core Principal Auth Binding key, not to account-subject identity. It
is not an Authentication Identifier, Session, Principal, Party, profile, or Permission.
_Avoid_: `(Tenant, providerSubjectId)` as account identity, email/telephone as subject, provider
technology name as namespace, provider-local ID without namespace/subject type.

**Authentication Identifier** — Provider-owned login or recovery identifier for a Commerce Portal
Account, such as email, telephone, or provider login handle. It is not a Party Registry Contact Point
merely because the literal value is equal, and proving control of it does not prove Party/profile or
Counterparty authority.

**Commerce Portal Session** — Provider-owned session proving authentication of one exact Commerce
Portal Account Subject. It is not a Tenant selection, Principal Auth Binding, Retail Portal Profile
Binding, Counterparty access, or Permission.

**Commerce Portal Enrollment Attempt** — Commerce-owned durable correlation and recovery anchor for
one exact portal enrollment intent across separately owned account, Core identity, Party/profile, and
access transitions. Once known, it correlates the exact Commerce Portal Account Subject without
becoming owner of that subject or pretending downstream facts share one business transaction.

**Account Recovery** — Authentication flow restoring access to the same exact Commerce Portal
Account Subject under approved recovery evidence. It does not silently reactivate a Principal Auth
Binding, Retail Portal Profile Binding or Permission Grant, Counterparty Permission, or Guest Order
visibility.

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

**Retail Portal Profile Binding** — Explicit Commerce-owned relation connecting one Tenant-scoped
Principal to one Commerce Retail Customer Profile. It identifies the profile relation only;
registration, Authentication Identifier/Contact Point equality, Party correction/merge, account
ownership, or knowledge of the profile do not create or move it or grant Permission.

**Retail Portal Permission Catalog** — Versioned contract defining stable atomic Retail Portal
Permission meanings and reviewed authority-group membership. It does not itself grant a Permission;
individual Current grants are separately owned through the Retail Portal Profile Binding capability.

**Retail Portal Permission Grant** — Explicit Commerce-owned Current grant of one atomic Retail
Portal Permission through one Retail Portal Profile Binding. Binding existence or authority-group
membership alone is not a grant, and Account Recovery does not silently recreate a revoked grant.

**Retail Portal Principal** — Principal with a Current Retail Portal Profile Binding and every exact
Retail Portal Permission Grant required for the operation. It is optional for Guest Checkout and
remains distinct from the Commerce Portal Account used to authenticate it.

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

**Price Group** — Pricing-owned reusable classification used as an explicit Pricing input. It is not
a price list, price amount, discount, Commerce Customer Group, Permission, or customer assignment;
Pricing owns its stable meaning, lifecycle, compatibility and interpretation while customer profiles
may only reference it through Customer Price Group Assignment. A Price Group may distinguish one
exact group-specific Price from the corresponding exact no-group Price; it never broadens Variant,
Selling Legal Entity, Channel, Commerce Market, currency, or pricing-basis matching.

**Price Group Compatibility Evidence** — Pricing-owner evidence that one exact Price Group
definition is usable under one required compatibility contract at a trusted operation time. It may
identify definition, contract and catalog/evaluation revisions, but that revision tuple is evidence,
not another Price Group identity and not a requirement that all revision numbers be equal.
_Avoid_: Price Group Compatibility Identity, revision tuple as classification identity, catalog
revision equality as definition of compatibility.

**Customer Price Group Assignment** — Commerce-owned time-bounded reference from one Commerce
Customer Profile to one Price Group. At most one assignment may be Current for a profile. Commerce
Market is resolved separately as part of the purchase-ready commercial context; Storefront is not a
Pricing monetary input and neither Market nor Storefront is an assignment scope.

**Customer Price Group Resolution** — Current typed decision returning one usable assigned Price
Group, legitimate absence of a customer Price Group, or explicit broken/inconsistent configuration.
Missing assignment may proceed to Pricing's own fallback; a dangling, incompatible, or unusable
explicit assignment must not be silently treated as absence. `ASSIGNED`, `NONE`, and
`INCONSISTENT` cardinality claims require owner-verifiable completeness of the relevant Current
assignment set; individual returned assignments alone do not prove that set complete.

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
The invitation is not a Permission or Current access. Delivery endpoint, email domain, Party
Relationship, account existence, or invitation delivery alone never grant authority.

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
of exactly one Product. Every Product has `1..N` Variants; a Product with only one realization still
has one explicit Variant rather than a Product-only selectable target. A draft Variant may be
incomplete and is not thereby a validated selection. A material change of an atomic realization
requires a different Variant; a Set Variant uses the explicitly versioned succession semantics of Set
Composition Revision. Variant is not SKU, Quantity, stock, Price, or an Assortment decision.
_Avoid_: implicit/default/fallback Variant chosen by Pricing when an exact Variant is missing.

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
Attribute Definition. Rename preserves identity only for unchanged meaning. Retirement prevents
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
Product Type, identity, Set marker, packaging marker or selling policy.
Absence of a type does not permit arbitrary undeclared structured attributes.

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
must belong to the explicitly presented prospective purchase representation before Pricing, approval
and final acceptance; normalization never silently modifies an already approved or committing
purchase representation.

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
missing/conflicting/unverifiable inputs. It never silently changes the requested Quantity or creates
Permission, Price, Availability or an Order.

## Purchasing limits and approval

**Purchase Value** — Non-negative Monetary Amount used only for purchasing-limit assessment. Pricing
contributes its authoritative `pricing_net_commercial_total`, which already includes Pricing-owned
Commercial Fees, Pricing-owned Discounts, Promotion allocations, any governed ZERO_FLOOR
adjustments, and Pricing line rounding. Purchase Value then adds only separately owner-issued
Delivery/Shipping and other commercial components not already included, and excludes VAT and other
taxes. A Pricing Fee total is breakdown evidence and must never be added again. Purchase Value carries
the source evidence required by its owners and does not transfer Pricing or FX ownership.

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

**Purchase Demand Occurrence** — Stable immutable value identity for one independent demand occurrence in one exact prospective purchase, carrying one exact Catalog Selection and requested Quantity + Unit. The same occurrence identity is preserved into the Order Acceptance Decision Bundle and is the upstream identity consumed by Pricing and Inventory; equal-valued occurrences remain distinct.
_Avoid_: array position as identity, assuming Cart line identity is automatically equivalent, Pricing Line owning the occurrence identity, or merging equal Catalog Selection + Quantity values.
**Purchase Proposal Revision** — Immutable prospective representation of one submitted Cart revision
that can be reviewed and approved. It contains exact Purchasing Subject, acting Buyer, Purchase Demand Occurrences with their exact
Catalog Selections + Quantities + Units, Purchase Value, currency, resolved commercial terms, Invoice Recipient,
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
unchanged evidence hashes. When produced for one exact Order Commitment Attempt, the revalidation is
an attempt-bound proof in that Attempt's Order Commitment Proof Set rather than part of the Bundle
hash that identified the Attempt.

## Order acceptance and recovery

**Reservation Confirmation** — Inventory-owned Attempt-bound proof issued by the selected Reservation Authority through Inventory's public boundary that one exact Inventory Reservation is provisionally guaranteed within its declared validity interval. Commerce consumes this proof in the Order Commitment Proof Set; its cardinality, health, renewal and recovery semantics remain owned by Inventory.
_Avoid_: Availability as issuer, treating the proof as an Order or Availability promise, or redefining Inventory proof lifecycle in Commerce.

**Payment Authorization** — Payment-owned proof that the required Payment method/amount/currency is
authorized for one exact Order Commitment Attempt under the resolved Payment Term. It is distinct
from capture, settlement, refund, and Order. It has explicit provider correlation, idempotency,
Current status, and validity; secrets or payment instruments never enter Commerce business payloads.

**Order Acceptance Decision Bundle** — Immutable, versioned, canonical-hashable **pre-attempt**
representation of one exact prospective purchase and the owner-issued decisions/evidence that define
that purchase meaning. It includes trusted scope, Purchasing Subject/Actor, Cart revision, exact
Purchase Demand Occurrences and their Catalog Selections + Quantities + Units, Monetary Amounts, Pricing/Tax/currency, Payment Term, Invoice
Recipient, Delivery Destination, Purchase Value/limit result, Assortment and other prospective source
evidence. It excludes any proof whose meaning requires an Order Commitment Attempt. Changed
Bundle-contained evidence produces a distinct Bundle even when an owner proves unchanged business
meaning. The Bundle owns none of the source facts.
_Avoid_: attempt-bound Confirmation inside the Bundle hash, Bundle mutated after Attempt creation,
generic `Decision Bundle` when this exact cross-owner purchase representation is intended.

**Order Commitment Attempt** — Durable idempotency and recovery anchor bound permanently to one exact
Order Acceptance Decision Bundle hash/version and used to attempt at most one Order. It tracks
preparation correlations, Current attempt-bound proof state, commit proof, compensation/reconciliation
state and conflicts. A different Bundle cannot reuse the same Attempt identity.

**Order Commitment Proof Set** — Exact set of owner-issued validations/confirmations used to prove one
Order Commitment Attempt + its exact Bundle through the commitment boundary. It may include Approval
Revalidation, Assortment Commitment Confirmation, the Reservation Confirmation and Commitment
Protection for the Attempt's one Inventory Reservation, Payment Authorization or analogous
attempt-bound proofs. Where the owning contract supports renewal, legitimate renewal may replace an
expired proof for the same unchanged Attempt + Bundle without changing the Bundle hash. Inventory
Reservation Confirmation is an explicit Launch exception: its owning contract does not support
renewal or successor Confirmation after pre-Protection expiry or definitive revocation.
_Avoid_: Proof Set as prospective purchase identity, proofs from different Attempts unioned together,
proof renewal used to smuggle changed Bundle meaning into the same Attempt.

**Order Commitment Gate** — Final consistency boundary that resolves one Order Commitment Attempt,
rechecks Current profile/Permissions/Business Policies, validates its exact Order Acceptance Decision
Bundle, establishes the exact Order Commitment Proof Set, validates any approved proposal revision,
and commits exactly one Order. It coordinates public contracts and never opens a shared cross-module
business transaction or silently modifies customer choices. Owner validity through commitment must
be established rather than inferred from an earlier read or an undelivered change event.

**Order Commitment Reconciliation** — Owner-governed recovery that first proves whether Order commit
occurred, then converges the exact Attempt's proof/preparation state and provisional
reservation/Payment effects without duplicating Orders or provider operations. Definite pre-commit
failure may trigger idempotent release/void; a proven committed Order is never erased as false
rollback. Where an owning contract legitimately supports renewal, a renewed attempt-bound proof never
mutates the Attempt's Bundle identity; Inventory Reservation Confirmation itself is not renewable in
Launch.

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

**Assortment** — Commerce Business Policy domain determining typed `VISIBILITY` or `PURCHASE`
eligibility under the canonical contract in `../assortment/CONTEXT.md`. `VISIBILITY` is Product-level.
The unit of one independent `PURCHASE` evaluation is an `Assortment Purchase Constituent`: exactly
one exact Catalog Selection in the trusted Commerce Purchasing Context for a Guest Purchase Context
or Purchasing Subject. Non-Set purchase has one constituent; Set purchase composes the top-level Set
constituent with every required exact non-set component constituent from the pinned Set Composition
Revision. `Assortment Purchase Constituent` is distinct from `Assortment Candidate`, which is a
Binding+Revision resolver participant inside one constituent. Guest is not a Purchasing Subject. An
Assortment result never creates Permission, Price, Availability, publication, or Order acceptance,
and Product-level `VISIBILITY` is not proof that any Variant or Package Option is `PURCHASE` eligible.

**Pricing** — Domain determining the canonical pre-Tax commercial value of one exact whole purchase
candidate. One Pricing Decision evaluates `1..N stable Pricing Lines`; each line uses the upstream
Purchase Demand Occurrence identity and its exact Catalog Selection, resulting Quantity and Unit.
Pricing owns Price, Price Revision, Quantity Tier, Pricing-owned Discount, Pricing Commercial Fee,
Pricing Result, Pricing Quotation, Pricing Commitment Confirmation, ZERO_FLOOR Authorization, and
Price Group interpretation. Pricing does not create, merge, or split purchase occurrences. Product
alone is never a Pricing target, and Storefront never determines canonical monetary truth.

**Pricing Commercial Scope** — Exact Selling Legal Entity + Channel + Commerce Market used by
Pricing. All three are required for authoritative Pricing; missing Market is not a wildcard and
Channel alone is not a complete Pricing scope. Storefront is outside this scope and cannot narrow,
override, or otherwise select a monetary result.

**Pricing Decision** — Pricing-owned Current commercial decision for one exact whole purchase
candidate with `1..N stable Pricing Lines` in one explicit currency, trusted Commerce Purchasing
Context, and trusted operation time. A single-line candidate uses the same model as a multi-line
candidate. PRICE_RESOLVED means the complete authoritative pre-Tax Pricing Result, not merely that a
base Price was found.

**Pricing Line** — Pricing view of one Purchase Demand Occurrence in one exact purchase candidate.
Its identity is the upstream occurrence identity and it carries that occurrence's exact Catalog
Selection, resulting Quantity and Unit. Pricing does not create, merge, or split occurrence
identities, and Pricing Line does not define Cart or Order line lifecycle.

**Price** — Pricing-owned reusable non-negative pre-Tax commercial fact for one exact priced meaning.
Its stable identity binds one exact Catalog Selection meaning containing a concrete Variant, one
Pricing Commercial Scope, currency, pricing Unit/basis, and an explicit Price Group selector or its
absence. Product alone, Storefront, Cart, Order, Purchase Demand Occurrence, Quantity, source row ID,
or write time are not Price identity dimensions. An exact Price is looked up by its complete key;
there is no Product-to-Variant, Channel-only, Storefront, or multi-axis specificity inheritance.
_Avoid_: Product Price, Storefront Price, broad runtime Price rule, cheapest/latest Price winner.

**Price Revision** — Immutable version of one Price when amount, effectivity, or provenance changes
without changing the Price identity. Changing the exact Variant/selection meaning, Selling Legal
Entity, Channel, Commerce Market, currency, pricing Unit/basis, or Price Group selector creates a
different Price rather than moving the existing identity.

**Pricing Revision Schedule** — Effective-time sequence of non-overlapping revisions for one
revisioned Pricing meaning, including any explicitly retained gaps; it is not the Quantity Tier
threshold set or a new Resource. A value-only Current edit preserves the existing interval end,
gaps and future revisions; changing their effectivity, cancelling or rescheduling them requires
explicit intent rather than an automatic extension to the next future start.

**Pricing Schedule Acknowledgement** — Operator's explicit acknowledgement of the already scheduled
future changes that a Current edit will preserve, required before that edit is committed. It applies
only to the schedule state presented to the operator, requires renewed acknowledgement if that state
changes, and does not authorize altering the future revisions.
_Avoid_: informational toast as consent, acknowledgement as permission to cancel future changes.

**Pricing Currency Support** — One Pricing-owned Tenant-level capability with immutable revisions
and Effective Periods defining the enabled purchase currencies within the actually supported
capability, with Launch enabled support exactly `{CZK}`. It is not a per-Cart, subject, Selling Legal
Entity, Channel, Market or Storefront setting, purchase-currency preference or choice, and is not
expanded by imported Price rows or inferred FX.

**Quantity Tier** — Pricing-owned threshold rule belonging to exactly one Price identity. The highest
reached inclusive positive Quantity threshold supplies one resulting non-negative pre-Tax Unit Price
for the whole relevant aggregated Quantity. A Tier never participates in choosing a different Price,
and purpose-specific Tier aggregation never changes the underlying Pricing Line identities.

**Pricing-owned Discount** — Pricing-owned pre-Tax reduction fact with distinct family, audience,
target scope and effect meanings. Launch supports line-scoped CATALOG_DISCOUNT and manually managed
CONTRACTUAL_DISCOUNT in its explicitly supported line or whole-purchase combinations; Product-level
administration only expands explicit Variant facts and never creates inheritance for future Variants.
_Avoid_: fixed amount as a synonym for line scope, Counterparty replacing Price Group.

**Contractual Discount** — Manually managed CONTRACTUAL_DISCOUNT fact for a Price Group or one exact
Counterparty, not an automatically earned level, campaign, voucher or loyalty status. Applicable
Price Group and Counterparty benefits are independent and stack with each other and with any
Group-specific base Price; the base-Price lookup does not remove the actual contractual audience.

**Pricing Discount Scope** — Declared application scope: VARIANT_LINE applies to an eligible original
Variant-based Pricing Line, while WHOLE_PURCHASE applies once to the whole Pricing Decision. Launch
permits Price Group or Counterparty VARIANT_LINE percentage/fixed effects, and only exact Counterparty
WHOLE_PURCHASE fixed effects; an allocation onto lines does not change the fact's scope.

**Pricing Discount Effect** — PERCENTAGE with a level from 0 to 100 percent, or FIXED_MONETARY_AMOUNT
with an explicit non-negative amount and currency. The effect describes the reduction, not its
application count: fixed VARIANT_LINE is once per applicable line, fixed WHOLE_PURCHASE once per
applicable Pricing Decision, and fixed-per-unit Discount is outside Launch.

**Pricing Discount Revision** — Immutable effective version of one logical Discount, with at most one
effective revision of the same logical key at a trusted instant. Value/level changes retain that
identity, while changes of family, audience, scope, Variant/commercial scope, effect kind or other
identity-defining currency/basis meaning create a different logical Discount rather than rewriting
its history.

**Pricing Discount Contribution** — Non-positive applied pre-Tax reduction produced from one
applicable Discount revision for its declared scope. It is distinct from the configured non-negative
Discount level and from any per-line allocation of a whole-purchase contribution.

**Whole-purchase Contractual Discount** — Exact Counterparty WHOLE_PURCHASE fixed benefit applicable
once per Pricing Decision only when the Whole-purchase Contractual Eligible Basis is strictly greater
than its fixed amount. At or below that amount it does not apply or allocate; the amount itself is
the activation threshold, with no separate minimum-purchase parameter or carried-over credit.

**Whole-purchase Contractual Eligible Basis** — Sum of strictly positive merchandise line values after
Price/Tier, Fees and every line-scoped Pricing-owned Discount, but before the whole-purchase
contribution and Promotion. Shipping/Delivery and non-positive lines are not recipients or weights;
these intermediate values are not the final published Line Commercial Values.

**Whole-purchase Contractual Allocation** — Deterministic proportional distribution of one applicable
whole-purchase contractual contribution over its eligible original lines, preserving the full
contribution and never allocating a reduction greater than a recipient's eligible value. Allocation
precision and remainder preserve both properties before final-line rounding, without new Discount
facts or ZERO_FLOOR used to repair allocation-induced negatives.

**Pricing Commercial Fee** — Pricing-owned non-negative pre-Tax charge applied at runtime to one
concrete Variant-based Pricing Line. Launch families are RECYCLING_FEE and COPYRIGHT_FEE, with
FIXED_PER_LINE or FIXED_PER_UNIT basis. Product-level administration is only bulk expansion to
explicit Variant Fee facts; Product is not a runtime Fee target. Competing Current Fees of the same
family and exact meaning are a configuration conflict; different Fee families may both contribute.

**Discountable Line Basis** — Exact pre-Tax basis equal to Base Line Value plus all applicable Pricing
Commercial Fees before line-scoped Pricing-owned Discounts. Every applicable percentage contribution,
including the independent Price Group and Counterparty contractual layers, uses this same basis
rather than compounding sequentially.

**Line Commercial Value** — Authoritative non-negative pre-Tax value of one stable Pricing Line after
Price/Tier, Pricing Commercial Fees, Pricing-owned Discounts, owner-issued Promotion allocation,
any governed ZERO_FLOOR adjustment, and the one final Pricing line rounding boundary.

**Pricing Result** — Complete authoritative pre-Tax result for one exact whole purchase candidate. It
preserves the exact candidate/line bindings, one actually used Price/Price Revision per line,
applicable Tier and contribution breakdown, final Line Commercial Values, Pricing total, and material
owner evidence. It contains no Tax amount and is complete without a Tax Decision.

**Pricing Quotation** — Pricing-owned immutable guarantee of exact pre-Tax terms for one exact whole
purchase candidate and binding context during its half-open validity interval. A matching unexpired
Quotation is not repriced or revoked by ordinary Current Price changes, is not transferable merely
through possession of its reference, and is distinct from a retained read, Approval or commitment proof.

**Pricing Commitment Confirmation** — Pricing-owned immutable guarantee for one exact Order Commitment
Attempt and its unchanged Order Acceptance Decision Bundle, issued through the Current-backed or
Quotation-backed path. It belongs to the Order Commitment Proof Set rather than the Bundle, lasts at
most 30 seconds, and is not revoked by ordinary source changes during its valid exact binding.

**Current-backed Pricing Confirmation** — Pricing Commitment Confirmation issued from a fresh complete
Current PRICE_RESOLVED evaluation with required final fact and set validation. It guarantees the
resulting terms for its own exact Attempt, unchanged Bundle and bounded interval, not for another
purchase or a later reprice.

**Quotation-backed Pricing Confirmation** — Pricing Commitment Confirmation issued after current
verification of a still-valid exact Pricing Quotation's authenticity, interval and candidate/context
binding, preserving the quoted terms even when ordinary Current Prices differ. Its expiry is no later
than either 30 seconds after issuance or the source Quotation's expiry, and it bypasses no independent
commitment gate.

**Pricing Confirmation Renewal** — Issuance of a new Pricing Commitment Confirmation instance, never
an in-place extension, for the same Attempt only while the Bundle and purchase meaning remain
unchanged. The Current-backed path requires fresh complete Current evaluation; the Quotation-backed
path requires renewed verification of the still-valid exact Quotation and retains its expiry cap,
with Accepted history preserving the actual Quotation/Confirmation lineage used.

**ZERO_FLOOR Authorization** — Pricing-owned reusable versioned governance permitting raw-negative
line arithmetic to be explicitly adjusted to zero only within its covered business scope, bounded
economic coverage and Effective Period, with governance/audit evidence. Without applicable coverage
the raw-negative calculation fails; the authorization is not a per-Order approval, Storefront
exception, Tenant-wide clamp, Discount, Fee, Promotion, Tax adjustment or rounding rule.

**ZERO_FLOOR Economic Coverage** — Explicit approved bounds on the floor-relevant economic meaning
covered by one ZERO_FLOOR Authorization. Changes within those bounds and the same business scope may
reuse the authorization after current verification, while exceeding the bounds or expanding scope
requires a new/successor authorization and never rewrites Accepted evidence.
_Avoid_: unbounded enabled flag, revision tuple as economic coverage, automatic coverage expansion.

**Pricing Line Rounding Adjustment** — Signed difference between the authoritative published final
Line Commercial Value and the exact post-guard pre-round value. Each Pricing Line has one ordinary
final monetary rounding boundary; Pricing total is the exact sum of those already rounded final line
values, not a separately rounded candidate total.

**Price Reconfirmation** — Explicit confirmation by the purchasing user/Buyer of changed proposed
prices, required for both increases and decreases before proceeding under those changed terms. A
lower price is not automatic consent, and an unchanged valid Quotation-backed price is not repriced
merely because ordinary Current Prices moved.

**Inventory** — Domain owning Stock Items, Stock Locations/Positions, Catalog-to-Stock Binding, Stock Requirements/Allocations, stock evidence, and Inventory-recognized obligations. It consumes Purchase Demand Occurrence identity without changing its exact Catalog Selection, Quantity or Unit; Reservation and authority lifecycle semantics are owned by the Inventory context and accepted ADRs.

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

**Customer Commerce Policy** — Declarative typed Business Policy family configured by one Customer
Configuration for shared Channel, Selling Legal Entity, Commerce Market, Storefront, purchasing,
quantity, currency, Payment Term, approval, delivery, visibility and legal defaults/constraints. It
is part of Customer Configuration rather than a synonym for the whole configuration; replaceable
defaults and independently applicable non-relaxable constraints have explicit composition, scope,
absence and conflict semantics. The bounded Commerce Quantity Rule family also owns explicit Customer
Quantity Rule Assignments; profiles, customer settings and other domain facts retain their owners.

**Customer Commerce Policy Field** — One closed, versioned typed semantic contract inside the
Customer Commerce Policy family. It declares one field/purpose's meaning, allowed scope/selectors,
composition, legitimate absence, conflict, Currentness/materiality, owner and consumer boundaries; it
is not a generic mutable policy record or customer-defined executable rule language.

**Customer Commerce Policy Resolution** — Current typed result for one declared policy field/purpose,
retaining the chosen replacement/default, every applicable non-relaxable constraint, relevant rule
or assignment revisions, trusted context and owner-issued validity evidence. When another Current
policy fact could change winner, absence, conflict or applicable constraints, the resolution uses
Owner-Verifiable Set Completeness Evidence; a winning rule alone is not proof of complete state.
