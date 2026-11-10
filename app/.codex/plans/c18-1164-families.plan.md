---
name: c18-1164-families
overview: 'Implement only the five accepted Promotion activation/target families and their supported effect boundaries.'
todos:
  - id: families-model
    content: 'Adapt generated Promotion contracts to distinguish voucher/automatic activation, occurrence/cart/selected-Delivery target and monetary/free-shipping effects.'
    status: completed
  - id: families-validation
    content: 'Reject unsupported combinations and add the accepted free-shipping configuration with optional CZK threshold, allowed owner-issued methods and half-open period.'
    status: completed
  - id: families-tests
    content: 'Test all five families, forbidden automatic product discounts, separate shipping slots and absence of Promotion-owned Shipping amounts.'
    status: completed
  - id: review-1164
    content: 'Review every acceptance criterion and BDD in issue 1164, repair findings and rerun focused tests before releasing this lane.'
    status: completed
isProject: false
---

# c18-1164-families

## Execution Notes

Authority: [#1164](https://github.com/TechsioCZ/ontos/issues/1164), root #1160 and the Promotion glossary. Read global constraints and generator rules in [foundation](c18-00-foundation.plan.md).

Adapt the generated owner contracts under `verticals/promotion/shared/` and owner validation services. The five accepted families are product voucher fixed/percentage, cart voucher fixed/percentage, automatic cart fixed/percentage, automatic free shipping, and voucher-triggered free shipping. Fixed means a reduction, not a replacement selling price. A product target is an original occurrence, not global Product/category targeting. Pricing retains Catalog/Contractual Discounts, tiers and fees.

A shipping offer preserves activation, optional minimum, currency, allowed Delivery-owned method references and Effective Period. Equality meets the minimum. No configured minimum means absent criterion, not zero. Selection and published threshold verification are delivered by the later selection/evaluation lanes. Fields need to preserve their meaning now.

## Constraints

No generic DSL, gifts, points, loyalty, personalization, flash sale, stored value, new Delivery method catalog or canonical ShippingTarget. A reference to a chosen external Delivery Offer is not an owner-defined delivery identity. Authoritative Shipping zero may exist independently; entitlement creates no extra credit. Follow foundation constraints.

## Operator Guidance

Depends on foundation. Own only generated definition/eligibility contract adaptations and family validation tests. Keep the contract layout stable for lifecycle, proof and administration work. Tests must prove unsupported shapes fail rather than merely snapshot generated files. Run owner `test:unit` once registered by foundation, and the contract checks relevant to edited schemas. Independent review of #1164 is a prerequisite for the lifecycle lane.
