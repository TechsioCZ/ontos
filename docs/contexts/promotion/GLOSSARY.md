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

**Free-shipping Voucher**:
A Voucher that explicitly activates an eligible free-shipping Promotion for the selected Delivery Offer. It uses the existing Voucher Code identity, normalization, lifecycle and B2C reuse rules; it occupies neither a product-voucher slot nor the merchandise-cart monetary slot.
_Avoid_: free-shipping code as second cart monetary discount, a new consumption or credit model.

**Automatic Promotion**:
A named Promotion activated by its declared eligibility without an entered Voucher Code. Its accepted monetary target is the merchandise cart, not a separately discounted product or category. A free-shipping Promotion can also have automatic activation for the selected Delivery Offer.
_Avoid_: automatic product discount as Promotion, generic targeting engine.

**Free-shipping Promotion**:
A Promotion offering a Free-shipping Entitlement for the selected Delivery Offer of an exact purchase. Its merchant-defined meaning includes automatic or Voucher-triggered activation, an optional Free-shipping Minimum, permitted delivery methods and an Effective Period. These conditions belong to the immutable published offer; Delivery/Shipping owns the offered delivery service and its customer-charged amount.
_Avoid_: merchandise-cart monetary discount, a new canonical ShippingTarget object, Promotion-owned delivery method or price, carrier cost as customer charge.

### Eligibility, selection and application order

**Promotion Target**:
The exact business subject receiving a benefit: a Purchase Demand Occurrence, the merchandise cart, or the selected Delivery Offer / Shipping component for free shipping. "Shipping target" is a descriptive reference to the Delivery-owned choice, not a new canonical resource. A target is distinct from eligibility conditions and from the recipients of a cart allocation.
_Avoid_: eligibility filter as benefit target, allocation recipient as another Promotion, delivery method catalog as the selected purchase delivery.

**Promotion Eligibility**:
The satisfaction of an offer's declared conditions for an exact purchase and trusted commercial context. An eligible offer is not necessarily selected or applied.
_Avoid_: eligible means applied, permission to administer means eligibility to receive a benefit.

**Promotion Eligible Basis**:
The monetary basis of the original purchase occurrences eligible for a particular monetary Promotion, in its Resolved Promotion Monetary Basis. Eligibility may concern only a subset of the complete purchase. For a cart Promotion, its basis follows the applicable Product Vouchers. Retaining the complete purchase for binding and evidence does not make every occurrence an eligible recipient.
_Avoid_: complete purchase sum as proof of eligible capacity, removing unrelated occurrences from purchase identity, original undiscounted subtotal as post-voucher basis.

**Cart Promotion Priority**:
The explicit merchant-managed ranking used to select at most one eligible merchandise-cart monetary Promotion, including Cart Vouchers. It is distinct from benefit size and from the order of calculating product and cart benefits.
_Avoid_: best-price winner, database order as priority, eligibility as a conflict by itself, fixed-first as a second arithmetic layer.

**Free-shipping Priority**:
The separate merchant-managed ranking of eligible free-shipping Promotions, whether automatic or Voucher-triggered, for the selected Delivery Offer of one exact purchase. At most one offer is selected for that delivery; an ambiguous required ranking is a configuration conflict rather than an implicit winner. This ranking is distinct from the merchandise-cart monetary priority.
_Avoid_: free-shipping offers sharing the monetary cart slot, multiple selected shipping offers for the same delivery, arbitrary winner.

**Free-shipping Minimum**:
An optional merchant-configured merchandise purchase threshold for a free-shipping Promotion. It is compared with the authoritative Published Merchandise Value after Product Vouchers and the selected cart monetary Promotion, in the same purchase-level resolved GROSS/NET basis as those benefits. It excludes the Shipping charge; equality with the minimum satisfies the condition. There is no independent NET/GROSS selector or rounding rule for this minimum.
_Avoid_: pre-discount basket threshold, exact unpublished subtotal as the published threshold input, a second B2B basis decision, including Shipping in the minimum, treating a NET publication as GROSS.

**Promotion Application Order**:
The fixed product-before-cart sequence: Product Vouchers apply to their occurrences before the selected merchandise-cart monetary Promotion. A Free-shipping Minimum is assessed against the published merchandise value after both monetary layers. Fixed-amount and percentage effect kinds do not reverse these layers.
_Avoid_: fixed-first or percentage-first arithmetic overriding product-before-cart, selection priority as calculation order.

**Product–Cart Discount Combination**:
The permitted joint use of a product voucher and the single selected cart monetary Promotion when each is eligible, for every fixed-amount or percentage pairing. It retains one product voucher per occurrence, one cart monetary application per purchase and the fixed product-before-cart order.
_Avoid_: merchant switch forbidding mixed product/cart effect kinds, stacking two cart monetary Promotions, same effect kind granting another slot.

### Monetary meaning

**Promotion Effect Kind**:
The kind of benefit promised by a Promotion, distinct from activation mode and target. A monetary effect is either a fixed monetary reduction or a percentage reduction; free shipping has its own entitlement meaning.
_Avoid_: fixed means product-scoped, percentage means cart-scoped, effect kind as selection priority.

**Fixed Monetary Benefit**:
A configured reduction expressed as a non-negative amount in an explicit currency. It is not a replacement final selling price, and its applied value can be smaller when eligible capacity is insufficient.
_Avoid_: fixed price, final price override, unused benefit as credit.

**Percentage Benefit**:
A configured proportional reduction of an eligible monetary basis. The percentage is distinct from the monetary amount actually granted by its application.
_Avoid_: percentage value as applied currency amount.

**Resolved Promotion Monetary Basis**:
The authoritative tax-inclusive or tax-exclusive basis used consistently by merchandise monetary applications in one purchase. It expresses the benefit's commercial meaning, not a tax rate, Taxable Basis or legal tax treatment. It does not change the basis of independently owned Pricing or Tax outputs.
_Avoid_: B2B flag as basis, gross/net display preference as authority, Promotion deciding VAT, relabeling a published NET amount as GROSS.

**Remaining Promotion Eligible Capacity**:
The positive monetary value still available to receive a particular benefit on its eligible target after earlier applicable reductions. For a cart benefit it is measured after Product Vouchers in the same resolved monetary basis, before final price publication.
_Avoid_: original undiscounted value, rounded display as exact capacity, negative capacity repaired through ordinary voucher application, carry-over credit.

**Applied Monetary Benefit**:
The attributable monetary reduction actually granted by a Promotion Application, after its eligibility and capacity rules. It retains its supported calculation precision, distinct from the configured benefit and from the final published price. A later price-rounding difference does not retroactively change the applied benefit.
_Avoid_: configured fixed amount as necessarily fully applied, independently rounded savings as a second deduction, rounding adjustment as a Promotion benefit, negative contribution notation as a second benefit.

**Published Merchandise Value**:
The authoritative post-discount monetary value of the merchandise for an exact purchase, with an explicit currency, NET/GROSS basis and owner evidence. The term distinguishes a published commercial value from exact intermediate calculation values; it does not create another monetary owner or a new Pricing GROSS total. Its basis must match the purpose for which it is consumed, including a Free-shipping Minimum. It excludes the separately owned Shipping charge and is not the complete Purchase Payable Amount.
_Avoid_: frontend subtotal as authority, exact pre-publication sum as a published amount, published NET silently treated as GROSS, total payable including Shipping as merchandise value.

### Applied results and evidence

**Promotion Application**:
The attributable application of one immutable Promotion to an exact purchase and target, with its actually granted benefit and relevant evidence. It is distinct from the reusable offer and from a Voucher Code entered for lookup.
_Avoid_: Promotion definition as application, anonymous aggregate discount.

**Promotion Application Set**:
The ordered result preserving each application's separate identity, target and evidence. Product-voucher applications on different occurrences, the selected cart application and any Free-shipping Entitlement remain distinguishable. Completeness describes the evidenced result, not an assumption that all required foreign-owner facts are already available.
_Avoid_: single anonymous benefit, losing the selected offer identity by aggregation, unverified shipping eligibility represented as complete success.

**Cart Promotion Allocation**:
The attribution of one Applied Monetary Benefit to eligible original Purchase Demand Occurrences in proportion to their positive remaining eligible basis. The allocations retain supported calculation precision, preserve the total applied benefit and stay within each recipient's capacity. They explain the same single cart application; they are not additional Promotions or product-voucher applications. Allocation remainders are distinct from final price publication rounding.
_Avoid_: new cart Promotion per recipient, proportional allocation as stacking offers, mandatory cent rounding of each allocation, Tax allocation as the same owner fact.

**Free-shipping Entitlement**:
The attributable result of a selected free-shipping Promotion for an exact purchase and chosen Delivery Offer. It records why the purchase qualifies for free shipping; it is not itself the Delivery/Shipping owner's published customer charge. An already-zero authoritative Shipping charge does not create another monetary reduction or credit, and an unavailable charge is not proof of zero.
_Avoid_: entitlement as proof of a missing Shipping amount, anonymous zero replacing offer attribution, additional monetary cart allocation, carrier cost reimbursement.

**Accepted Promotion Evidence**:
The identities, applied benefits, allocations and relevant source meaning retained for a successful historical purchase. It explains that accepted result without turning history into a Current offer or importing an external voucher identity. The exact applied benefit and the separately owned publication evidence retain their distinct meanings.
_Avoid_: recalculating accepted benefits from current policy, historical evidence as current eligibility, rewriting historical discounts to balance a rounded total.

### Shared-language references

**Original Product Line**:
A descriptive alias for the existing Commerce Purchase Demand Occurrence used as a product-voucher target or merchandise allocation recipient. Pricing Line is Pricing's view of that same occurrence, not a new Promotion identity.
_Avoid_: Product ID, SKU, display-row position or price equality as occurrence identity; merging equal-valued occurrences.

**Pricing Rounding Adjustment**:
The existing Pricing-owned signed difference between an original line's published commercial value and its exact final value before publication. It explains final price publication without changing the Applied Monetary Benefit. It is distinct from Tax's rounding difference and from Cart Promotion Allocation remainders.
_Avoid_: a new voucher or fee, adjusting the actual discount to balance the basket, another independent rounding of the sum of published lines, Tax rounding as Pricing rounding.

**Promotion Administration**:
Management of offers, vouchers, cart monetary ranking and a distinct free-shipping ranking by an acting Principal with the required Current permission in the trusted business scope. Tenant isolation, Customer Configuration, Selling Legal Entity and Storefront Application retain their existing separate Commerce/OntOS meanings.
_Avoid_: shop owner title as a permission grant, storefront hostname as monetary authority, Tenant as seller identity, copying Payment's configuration key into a new Promotion scope.

**Promotion Consumer Boundary**:
The distinction between the Promotion benefit and independently owned Pricing commercial values, Taxable Supply Units and tax results, Checkout's Purchase Payable Amount, and Payment collection/refund facts. A shared purchase reference preserves correlation without making a Pricing Line, a Taxable Supply Unit and an owner-issued refundable item interchangeable.
_Avoid_: Payment recalculating discounts or Tax, subtracting the same benefit twice, inferring refundable-item decomposition from a UI row, conflating allocation precision with final monetary publication.
