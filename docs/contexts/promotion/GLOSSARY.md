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
A Promotion activated when its declared eligibility holds without a Voucher Code; automatic monetary offers target the merchandise cart, while automatic free-shipping offers target the selected Delivery Offer.
_Avoid_: automatic product discount as Promotion, generic targeting engine.

**Free-shipping Promotion**:
An immutable offer that grants a Free-shipping Entitlement for a selected Delivery Offer when its declared activation, optional minimum, permitted method and Effective Period match. Delivery/Shipping, not Promotion, owns the offered delivery service and its customer-charged amount.
_Avoid_: merchandise-cart monetary discount, a new canonical ShippingTarget object, Promotion-owned delivery method or price, carrier cost as customer charge.

### Eligibility, selection and application order

**Promotion Target**:
The exact business subject receiving an offered benefit: an original Purchase Demand Occurrence, the merchandise cart or the selected Delivery Offer for free shipping. “Shipping target” describes the last Delivery-owned choice, not a separate Promotion resource or an eligibility condition.
_Avoid_: eligibility filter as benefit target, allocation recipient as another Promotion, delivery method catalog as the selected purchase delivery.

**Promotion Eligibility**:
The satisfaction of an offer's declared conditions for an exact purchase and trusted commercial context. An eligible offer is not necessarily selected or applied.
_Avoid_: eligible means applied, permission to administer means eligibility to receive a benefit.

**Promotion Eligible Basis**:
The monetary value of original purchase occurrences eligible for a particular benefit, on the purchase's resolved GROSS/NET basis after any earlier applicable reductions. The complete purchase retains all original occurrences for identity and evidence, but unrelated occurrences do not become eligible recipients.
_Avoid_: complete purchase sum as proof of eligible capacity, removing unrelated occurrences from purchase identity, original undiscounted subtotal as post-voucher basis.

**Cart Promotion Priority**:
The explicit merchant-managed ranking used to select at most one eligible merchandise-cart monetary Promotion, including Cart Vouchers. It is distinct from benefit size and from the order of calculating product and cart benefits.
_Avoid_: best-price winner, database order as priority, eligibility as a conflict by itself, fixed-first as a second arithmetic layer.

**Free-shipping Priority**:
The merchant-managed ranking that selects at most one eligible free-shipping Promotion for a selected Delivery Offer, independent of merchandise-cart priority. Missing or tied required ordering is a configuration conflict, not an implied best-price winner.
_Avoid_: free-shipping offers sharing the monetary cart slot, multiple selected shipping offers for the same delivery, arbitrary winner.

**Free-shipping Minimum**:
An optional merchandise threshold checked against authoritative Published Merchandise Value after applicable product and cart discounts, in the purchase's resolved GROSS/NET basis and excluding Shipping. Equality meets the threshold; the minimum introduces neither another basis selector nor another price-rounding rule.
_Avoid_: pre-discount basket threshold, exact unpublished subtotal as the published threshold input, a second B2B basis decision, including Shipping in the minimum, treating a NET publication as GROSS.

**Promotion Application Order**:
The fixed sequence in which Product Voucher benefits apply before the one selected cart monetary benefit. Free-shipping minimum eligibility follows publication of the completed merchandise value; fixed and percentage benefit kinds do not reverse that order.
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
The purchase-wide tax-inclusive (GROSS) or tax-exclusive (NET) basis on which merchandise Promotion benefits are applied, distinct from taxable basis or legal tax treatment. It does not change independently owned Pricing publication amounts or Tax calculations.
_Avoid_: B2B flag as basis, gross/net display preference as authority, Promotion deciding VAT, relabeling a published NET amount as GROSS.

**Remaining Promotion Eligible Capacity**:
The positive monetary value still available to receive a particular benefit on its eligible target after earlier applicable reductions. For a cart benefit it is measured after Product Vouchers in the same resolved monetary basis, before final price publication.
_Avoid_: original undiscounted value, rounded display as exact capacity, negative capacity repaired through ordinary voucher application, carry-over credit.

**Applied Monetary Benefit**:
The actual attributable monetary reduction from a Promotion Application after eligibility and capacity limits, retained at supported calculation precision. It is distinct from the configured benefit and from subsequent price-rounding differences, which never rewrite it.
_Avoid_: configured fixed amount as necessarily fully applied, independently rounded savings as a second deduction, rounding adjustment as a Promotion benefit, negative contribution notation as a second benefit.

**Published Merchandise Value**:
The authoritative purchase-bound post-discount merchandise amount with explicit currency, NET/GROSS basis and current owner evidence, excluding Shipping and distinct from unpublished intermediate values. It is neither a new Promotion-owned monetary total nor the full Purchase Payable Amount, and published NET cannot stand in for GROSS.
_Avoid_: frontend subtotal as authority, exact pre-publication sum as a published amount, published NET silently treated as GROSS, total payable including Shipping as merchandise value.

### Applied results and evidence

**Promotion Application**:
The attributable application of one immutable Promotion to an exact purchase and target, with its actually granted benefit and relevant evidence. It is distinct from the reusable offer and from a Voucher Code entered for lookup.
_Avoid_: Promotion definition as application, anonymous aggregate discount.

**Promotion Application Set**:
The attributable ordered result of Promotion applications preserving each actual target, benefit and evidence, including product, cart and any free-shipping results. Its merchandise monetary part may be complete before Shipping eligibility is known; that completeness must not be mistaken for a verified whole-purchase Shipping or payable outcome.
_Avoid_: single anonymous benefit, losing the selected offer identity by aggregation, unverified shipping eligibility represented as complete success.

**Merchandise Monetary Proof**:
The complete Current proof of selected or demonstrably absent product-voucher and cart monetary applications for an exact purchase, including their exact benefits, allocations and selection evidence. It is the merchandise portion of a Promotion Application Set, available before free-shipping eligibility is decided without claiming a complete Shipping result or payable.
_Avoid_: a second Promotion Application, a complete Shipping decision, a guess that an absent owner response means no eligible promotion.

**Cart Promotion Allocation**:
The exact attribution of one cart Applied Monetary Benefit to eligible original Purchase Demand Occurrences in proportion to their remaining positive basis, conserving the applied total and each recipient's capacity. It is neither another Promotion application nor a Pricing price-rounding adjustment.
_Avoid_: new cart Promotion per recipient, proportional allocation as stacking offers, mandatory cent rounding of each allocation, Tax allocation as the same owner fact.

**Free-shipping Entitlement**:
The attributable benefit of a selected free-shipping Promotion for the purchase's selected Delivery Offer, independent of the actual customer-charged Shipping amount. An authoritative zero charge yields no extra monetary credit, while a missing Shipping charge is not proof of zero.
_Avoid_: entitlement as proof of a missing Shipping amount, anonymous zero replacing offer attribution, additional monetary cart allocation, carrier cost reimbursement.

**Accepted Promotion Evidence**:
The historical record of Promotion/Voucher identities, applied benefits, allocations and source meaning actually used in an accepted purchase. It remains distinct from current eligibility and from separately owned price-publication or rounding evidence.
_Avoid_: recalculating accepted benefits from current policy, historical evidence as current eligibility, rewriting historical discounts to balance a rounded total.

### Shared-language references

**Original Product Line**:
A descriptive alias for the existing Commerce Purchase Demand Occurrence used as a product-voucher target or merchandise allocation recipient. Pricing Line is Pricing's view of that same occurrence, not a new Promotion identity.
_Avoid_: Product ID, SKU, display-row position or price equality as occurrence identity; merging equal-valued occurrences.

**Pricing Rounding Adjustment**:
The Pricing-owned signed difference between an original line's published commercial value and its exact pre-publication value. It is neither another discount nor a cart-allocation remainder or Tax rounding.
_Avoid_: a new voucher or fee, adjusting the actual discount to balance the basket, another independent rounding of the sum of published lines, Tax rounding as Pricing rounding.

**Promotion Administration**:
Management of offers, vouchers, cart monetary ranking and a distinct free-shipping ranking by an acting Principal with the required Current permission in the trusted business scope. Tenant isolation, Customer Configuration, Selling Legal Entity and Storefront Application retain their existing separate Commerce/OntOS meanings.
_Avoid_: shop owner title as a permission grant, storefront hostname as monetary authority, Tenant as seller identity, copying Payment's configuration key into a new Promotion scope.

**Promotion Consumer Boundary**:
The distinction between the Promotion benefit and independently owned Pricing commercial values, Taxable Supply Units and tax results, Checkout's Purchase Payable Amount, and Payment collection/refund facts. A shared purchase reference preserves correlation without making a Pricing Line, a Taxable Supply Unit and an owner-issued refundable item interchangeable.
_Avoid_: Payment recalculating discounts or Tax, subtracting the same benefit twice, inferring refundable-item decomposition from a UI row, conflating allocation precision with final monetary publication.
