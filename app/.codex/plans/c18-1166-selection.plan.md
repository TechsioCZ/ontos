---
name: c18-1166-selection
overview: 'Implement deterministic product/cart order and separate tenant ranking for merchandise and free-shipping offers.'
todos:
  - id: selection-context
    content: 'Validate exact context, original occurrences and single explicit product choice without deriving identity or authority from SKU or Storefront.'
    status: completed
  - id: selection-cart
    content: 'Select one eligible cart offer across submitted vouchers and automatic promotions by explicit tenant ranking after product benefits.'
    status: completed
  - id: selection-shipping
    content: 'Select at most one eligible shipping offer for the chosen owner-issued target using separate ranking and published post-discount minimum.'
    status: completed
  - id: selection-tests
    content: 'Test all four monetary pairings, mixed activation ranking, conflicting priorities, equal selections on distinct occurrences and shipping boundary cases.'
    status: completed
  - id: review-1166
    content: 'Review issue 1166 including all BDD, repair deterministic/cardinality failures and rerun selection tests.'
    status: completed
isProject: false
---

# c18-1166-selection

## Execution Notes

Authority: [#1166](https://github.com/TechsioCZ/ontos/issues/1166). Follow [foundation](c18-00-foundation.plan.md). Own owner-local eligibility and winner-selection services/tests. Consume the reviewed Voucher and arithmetic contracts. One product Voucher per occurrence precedes the sole cart monetary winner. All fixed/percentage pairings are permitted under their own eligibility. For basis `1000`, product/cart fixed `100` or percentage `10` yields remaining `800,810,800,810` for fixed+fixed, fixed+percentage, percentage+fixed, percentage+percentage respectively.

Automatic cart offers and submitted cart vouchers share one explicit merchant order. Voucher activation has no intrinsic priority. Multiple eligible offers with one unique priority winner are success. Missing or ambiguous relevant order is configuration conflict, never newest, cheapest, largest benefit or DB winner. Do not demand a ranking for irrelevant candidates or invent a second application from an allocation.

Shipping selection is separate, supports automatic/voucher activation, optional minimum, allowed methods and half-open period, and occupies neither merchandise slot. Minimum uses authoritative published post-discount merchandise in the same resolved basis and excludes Shipping. `1600` before discounts, `1400` after, minimum `1500` fails. `1500` published equals threshold and passes; no minimum imposes no monetary test. Required published GROSS unavailable means typed non-success. Method/offer evidence remains externally owned; absence or unverifiability is not zero Shipping. Different shipping candidates use a separate merchant ranking and yield one winner for the selected target.

## Constraints

No configurable fixed-first/percentage-first order or effect-kind combination ban. No automatic product discount, best-price fallback, multi-shipment model or Shipping charge calculation. Follow foundation constraints.

## Operator Guidance

Depends on reviewed #1168 and #1169. This joins reusable identity and precise monetary behavior, while proof and administration may finish in parallel. Include reordered inputs and unchanged winner/allocations as a determinism test. Cover customer removal then replacement, duplicate submitted targets, all ranking outcomes and absent optional minimum. Run owner unit tests. Review #1166 separately; integration into #1170 is not a substitute for its acceptance.
