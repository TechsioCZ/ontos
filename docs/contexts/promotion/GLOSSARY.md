# Promotion

Promotion owns named promotional offers, their vouchers and the applications of those offers to an exact purchase. Shared meanings such as Tenant, Current, Accepted, Selling Legal Entity, Commerce Market and Purchasing Subject remain in the [Commerce context](../commerce/CONTEXT.md) and [OntOS context](../ontos/CONTEXT.md).

## Language

### Offer identity and activation

**Promotion**:
A published, named promotional offer with immutable business meaning, its own identity, activation mode, target, effect, eligibility and Effective Period. It is distinct from a Pricing-owned Catalog Discount or Contractual Discount.
_Avoid_: voucher code as Promotion identity, Promotion Revision, generic discount when ownership matters.

**Draft Promotion**:
An unpublished, editable proposal for a Promotion. It is not an offer already available for application to a purchase.
_Avoid_: editing a published offer as a draft change, published Promotion Revision.

**Successor Promotion**:
A distinct Promotion identity that replaces or follows an earlier published offer with different business meaning. The earlier identity continues to explain its historical applications.
_Avoid_: in-place business revision, rebinding past applications to the new offer.

**Voucher**:
A Promotion-owned identity bound to one immutable Promotion and made available for explicit use through a Voucher Code. It is not stored monetary value, a gift card or the code text itself.
_Avoid_: code as historical identity, stored credit, implicit rebinding to a Successor Promotion.

**Voucher Code**:
The customer-entered lookup text for a Voucher, compared after trimming outer whitespace and ignoring letter case within a Tenant. A published code retains its Voucher attribution rather than being recycled for a different Voucher.
_Avoid_: canonical Voucher identity, globally unique code without Tenant qualification.

**Product Voucher**:
A Voucher explicitly chosen for one original product line in an exact purchase. It occupies that line's single product-voucher choice, not an additional automatic product-promotion layer.
_Avoid_: automatic Catalog Discount, two voucher slots distinguished only by effect kind.

**Cart Voucher**:
A Voucher explicitly chosen for a merchandise-cart monetary Promotion. It participates in the same cart-promotion selection as eligible automatic monetary Promotions rather than granting an additional cart-benefit slot.
_Avoid_: cart voucher always outranks automatic offers, second cart monetary application.

**Automatic Promotion**:
A named Promotion activated by its declared eligibility without a customer-entered Voucher Code. Its accepted monetary target is the merchandise cart, not a separately discounted product or category.
_Avoid_: automatic product discount as Promotion, generic targeting engine.

**Free-shipping Promotion**:
A Promotion whose benefit makes an eligible Shipping target free of charge. Promotion owns the eligibility and benefit meaning; Delivery/Shipping owns the shipping monetary component.
_Avoid_: merchandise-cart monetary discount, Promotion-owned shipping price.

### Eligibility, selection and application order

**Promotion Target**:
The exact business subject to which a promotional benefit applies: an original product line, the merchandise cart, or an explicit Shipping target. It is distinct from the conditions used to establish eligibility and from the lines receiving an allocation.
_Avoid_: eligibility filter as benefit target, allocation recipient as another Promotion.

**Promotion Eligibility**:
The satisfaction of an offer's declared conditions for an exact purchase and trusted commercial context. An eligible offer is not necessarily selected or applied.
_Avoid_: eligible means applied, permission to administer means eligibility to receive a benefit.

**Cart Promotion Priority**:
The explicit merchant-managed ranking used to select at most one eligible merchandise-cart monetary Promotion, including Cart Vouchers. It is distinct from benefit size and from the order of calculating product and cart benefits.
_Avoid_: best-price winner, database order as priority, eligibility as a conflict by itself.

**Promotion Application Order**:
The fixed product-before-cart sequence: Product Vouchers apply to their lines before the selected merchandise-cart monetary Promotion. Fixed-amount and percentage effect kinds do not reverse these layers.
_Avoid_: fixed-first or percentage-first arithmetic overriding product-before-cart, selection priority as calculation order.

**Promotion Combination Policy**:
The merchant-managed permission or restriction on jointly using fixed-amount and percentage benefits through otherwise allowed applications. It does not add a second Product Voucher to a line, add a second merchandise-cart monetary Promotion, or change Promotion Application Order.
_Avoid_: combination permission as unlimited stacking, changing cardinality through policy.

### Monetary meaning

**Promotion Effect Kind**:
The kind of benefit promised by a Promotion, distinct from its activation mode and target. A monetary effect is either a fixed monetary reduction or a percentage reduction; free shipping has its own Shipping-target meaning.
_Avoid_: fixed means product-scoped, percentage means cart-scoped, effect kind as selection priority.

**Fixed Monetary Benefit**:
A configured reduction expressed as a non-negative amount in an explicit currency. It is not a replacement final selling price, and its applied value can be smaller when the eligible capacity is insufficient.
_Avoid_: fixed price, final price override, unused benefit as credit.

**Percentage Benefit**:
A configured proportional reduction of an eligible monetary basis. The percentage is distinct from the monetary amount actually granted by its application.
_Avoid_: percentage value as applied currency amount.

**Resolved Promotion Monetary Basis**:
The authoritative tax-inclusive or tax-exclusive basis used consistently by the merchandise monetary applications in one purchase. It records the applicable business meaning of the benefit, not a choice of tax rate or tax treatment.
_Avoid_: B2B flag as basis, gross/net display preference as authority, Promotion deciding VAT.

**Remaining Promotion Eligible Capacity**:
The positive monetary value still available to receive a particular benefit on its eligible target after earlier applicable reductions. For a cart benefit it is measured after Product Vouchers in the same resolved monetary basis.
_Avoid_: original undiscounted value, negative capacity repaired through ordinary voucher application, carry-over credit.

### Applied results and evidence

**Promotion Application**:
The attributable application of one immutable Promotion to an exact purchase and target, with its actually granted benefit and relevant evidence. It is distinct from the reusable offer and from a Voucher Code entered by the customer.
_Avoid_: Promotion definition as application, anonymous aggregate discount.

**Promotion Application Set**:
The ordered result of a Promotion evaluation that preserves the separate identities, targets and evidence of its applications. Product-voucher applications on different original lines, the selected cart application and any Shipping-target benefit remain distinguishable.
_Avoid_: single anonymous benefit, losing the selected offer identity by aggregation.

**Cart Promotion Allocation**:
The attribution of one applied cart monetary benefit to eligible original product lines in proportion to their positive remaining eligible basis. The line allocations explain that same single cart application; they are not additional Promotions or product-voucher applications.
_Avoid_: one new cart Promotion per line, proportional allocation as stacking multiple offers.

**Accepted Promotion Evidence**:
The identities, applied benefits, allocations and relevant source meaning retained for a successful historical purchase. It explains the accepted result without turning historical evidence into a Current offer or migrating an external voucher identity.
_Avoid_: recalculating accepted benefits from current policy, historical evidence as current eligibility.
