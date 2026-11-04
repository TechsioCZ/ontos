# Promotion

Promotion owns named promotional offers, their vouchers and applications to an exact purchase. Shared language remains owned by the [Commerce context](../commerce/CONTEXT.md), [OntOS context](../ontos/CONTEXT.md) and [Tax context](../tax/CONTEXT.md); this glossary does not define implementation or a second purchase, tax or payment model.

## Language

### Offer identity and activation

**Promotion**:
A published, named promotional offer with immutable business meaning, its own identity, activation mode, target, effect, eligibility and Effective Period. It is distinct from a Pricing-owned Catalog Discount or Contractual Discount.
_Avoid_: Voucher Code as Promotion identity, Promotion Revision, unqualified discount when ownership matters.

**Draft Promotion**:
An unpublished, editable proposal for a Promotion. It is not an offer already available for application to a purchase.
_Avoid_: editing a published offer as a draft change.

**Successor Promotion**:
A distinct Promotion identity that replaces or follows an earlier published offer with different business meaning. The earlier identity continues to explain its historical applications.
_Avoid_: in-place business revision, rebinding past applications to the new offer.

**Voucher**:
A Promotion-owned identity bound to one immutable Promotion and made available for explicit use through a Voucher Code. It is not stored monetary value, a gift card or the code text itself.
_Avoid_: code as historical identity, stored credit, implicit rebinding to a Successor Promotion.

**Voucher Code**:
The entered lookup text for a Voucher, compared after trimming outer whitespace and ignoring letter case within a Tenant. A published code retains its Voucher attribution rather than being recycled for a different Voucher.
_Avoid_: canonical Voucher identity, globally unique code without Tenant qualification.

**Product Voucher**:
A Voucher explicitly chosen for one Purchase Demand Occurrence in an exact purchase, occupying that occurrence's single product-voucher slot. Its target is the original occurrence, not every purchase of the same Product or SKU.
_Avoid_: automatic Catalog Discount, two voucher slots distinguished by effect kind, one voucher slot per physical unit.

**Cart Voucher**:
A Voucher explicitly chosen for a merchandise-cart monetary Promotion. It participates in the same cart-promotion selection as eligible automatic monetary Promotions rather than granting an additional cart-benefit slot.
_Avoid_: cart voucher always outranks automatic offers, second cart monetary application.

**Automatic Promotion**:
A named Promotion activated by its declared eligibility without an entered Voucher Code. Its accepted monetary target is the merchandise cart, not a separately discounted product or category.
_Avoid_: automatic product discount as Promotion, generic targeting engine.

**Free-shipping Promotion**:
A Promotion whose benefit makes an eligible explicit Shipping target free of charge. Promotion owns eligibility and benefit meaning; Delivery/Shipping owns the customer-charged shipping monetary component.
_Avoid_: merchandise-cart monetary discount, Promotion-owned shipping price, missing shipping amount as free shipping, carrier cost as customer charge.

### Eligibility, selection and application order

**Promotion Target**:
The exact business subject receiving a benefit: a Purchase Demand Occurrence, the merchandise cart, or an explicit Shipping target. It is distinct from eligibility conditions and from the recipients of a cart allocation.
_Avoid_: eligibility filter as benefit target, allocation recipient as another Promotion.

**Promotion Eligibility**:
The satisfaction of an offer's declared conditions for an exact purchase and trusted commercial context. An eligible offer is not necessarily selected or applied.
_Avoid_: eligible means applied, permission to administer means eligibility to receive a benefit.

**Cart Promotion Priority**:
The explicit merchant-managed ranking used to select at most one eligible merchandise-cart monetary Promotion, including Cart Vouchers. It is distinct from benefit size and from the order of calculating product and cart benefits.
_Avoid_: best-price winner, database order as priority, eligibility as a conflict by itself, fixed-first as a second arithmetic layer.

**Promotion Application Order**:
The fixed product-before-cart sequence: Product Vouchers apply to their occurrences before the selected merchandise-cart monetary Promotion. Fixed-amount and percentage effect kinds do not reverse these layers.
_Avoid_: fixed-first or percentage-first arithmetic overriding product-before-cart, selection priority as calculation order.

**Product–Cart Discount Combination**:
The permitted joint use of a product voucher and the single selected cart monetary Promotion when each is eligible, for every fixed-amount or percentage pairing. It retains one product voucher per occurrence, one cart monetary application per purchase and the fixed product-before-cart order.
_Avoid_: merchant switch forbidding mixed product/cart effect kinds, stacking two cart monetary Promotions, same effect kind granting another slot.

### Monetary meaning

**Promotion Effect Kind**:
The kind of benefit promised by a Promotion, distinct from activation mode and target. A monetary effect is either a fixed monetary reduction or a percentage reduction; free shipping has its own Shipping-target meaning.
_Avoid_: fixed means product-scoped, percentage means cart-scoped, effect kind as selection priority.

**Fixed Monetary Benefit**:
A configured reduction expressed as a non-negative amount in an explicit currency. It is not a replacement final selling price, and its applied value can be smaller when eligible capacity is insufficient.
_Avoid_: fixed price, final price override, unused benefit as credit.

**Percentage Benefit**:
A configured proportional reduction of an eligible monetary basis. The percentage is distinct from the monetary amount actually granted by its application.
_Avoid_: percentage value as applied currency amount.

**Resolved Promotion Monetary Basis**:
The authoritative tax-inclusive or tax-exclusive basis used consistently by merchandise monetary applications in one purchase. It expresses the benefit's commercial meaning, not a tax rate, Taxable Basis or legal tax treatment.
_Avoid_: B2B flag as basis, gross/net display preference as authority, Promotion deciding VAT.

**Remaining Promotion Eligible Capacity**:
The positive monetary value still available to receive a particular benefit on its eligible target after earlier applicable reductions. For a cart benefit it is measured after Product Vouchers in the same resolved monetary basis.
_Avoid_: original undiscounted value, negative capacity repaired through ordinary voucher application, carry-over credit.

### Applied results and evidence

**Promotion Application**:
The attributable application of one immutable Promotion to an exact purchase and target, with its actually granted benefit and relevant evidence. It is distinct from the reusable offer and from a Voucher Code entered for lookup.
_Avoid_: Promotion definition as application, anonymous aggregate discount.

**Promotion Application Set**:
The ordered result preserving each application's separate identity, target and evidence. Product-voucher applications on different occurrences, the selected cart application and any Shipping-target benefit remain distinguishable.
_Avoid_: single anonymous benefit, losing the selected offer identity by aggregation.

**Cart Promotion Allocation**:
The attribution of one applied cart monetary benefit to eligible original Purchase Demand Occurrences in proportion to their positive remaining eligible basis. These allocations explain the same single cart application; they are not additional Promotions or product-voucher applications.
_Avoid_: new cart Promotion per recipient, proportional allocation as stacking offers, Tax allocation as the same owner fact.

**Accepted Promotion Evidence**:
The identities, applied benefits, allocations and relevant source meaning retained for a successful historical purchase. It explains that accepted result without turning history into a Current offer or importing an external voucher identity.
_Avoid_: recalculating accepted benefits from current policy, historical evidence as current eligibility.

### Shared-language references

**Original Product Line**:
A descriptive alias for the existing Commerce Purchase Demand Occurrence used as a product-voucher target or merchandise allocation recipient. Pricing Line is Pricing's view of that same occurrence, not a new Promotion identity.
_Avoid_: Product ID, SKU, display-row position or price equality as occurrence identity; merging equal-valued occurrences.

**Promotion Administration**:
Management of offers, vouchers and cart priority by an acting Principal with the required Current permission in the trusted business scope. Tenant isolation, Customer Configuration, Selling Legal Entity and Storefront Application retain their existing separate Commerce/OntOS meanings.
_Avoid_: shop owner title as a permission grant, storefront hostname as monetary authority, Tenant as seller identity, copying Payment's configuration key into a new Promotion scope.

**Promotion Consumer Boundary**:
The distinction between the Promotion benefit and independently owned Pricing commercial values, Taxable Supply Units and tax results, Checkout's Purchase Payable Amount, and Payment collection/refund facts. A shared purchase reference preserves correlation without making a Pricing Line, a Taxable Supply Unit and an owner-issued refundable item interchangeable.
_Avoid_: Payment recalculating discounts or Tax, subtracting the same benefit twice, inferring refundable-item decomposition from a UI row, conflating allocation precision with final monetary publication.
