---
name: pricing-742-quantity-tiers
overview: Coordinate the executable #766–#769 leaves for Price-owned Quantity Tier facts, inclusive threshold resolution, bounded aggregation, and Catalog-owned quantity/unit/package evidence under tracking parent #742.
todos:
  - id: implement-issue-766
    content: 'Implement #766 versioned Quantity Tier definitions belonging to one exact Price identity, with positive thresholds, compatible quantity basis, non-negative resulting Unit Price, immutable revisions, and same-key temporal uniqueness.'
    status: completed
  - id: review-issue-766
    content: 'Independently review #766 generated artifacts, identity/revision separation, persistence constraints, currency/basis compatibility, and invalid/conflicting tier tests; resolve findings before advancing.'
    status: completed
  - id: implement-issue-767
    content: 'Implement #767 highest-reached inclusive threshold selection for the whole relevant quantity, retaining the base Price below the first threshold and rejecting ambiguous, incompatible, or unverifiable tier sets.'
    status: completed
  - id: review-issue-767
    content: 'Independently review #767 boundary cases at/below/above thresholds, one resulting Unit Price semantics, set completeness, and absence of graduated-band or cheapest-tier behavior; resolve findings before advancing.'
    status: completed
  - id: implement-issue-768
    content: 'Implement #768 purpose-specific Tier aggregation only across lines with the same exact Price identity, Catalog-confirmed equivalent selection meaning, compatible basis, and relevant context while preserving every original occurrence as a downstream recipient.'
    status: completed
  - id: review-issue-768
    content: 'Independently review #768 grouping equivalence/evidence, stable line identities, no cross-selection or cross-context pooling, and tests proving later fee/discount/allocation/rounding remain per original line; resolve findings before advancing.'
    status: completed
  - id: implement-issue-769
    content: 'Implement #769 strict Quantity, Unit, pricing-basis, package-content, and conversion-evidence compatibility at the Catalog/Pricing boundary without treating configuration Measured Value as purchase Quantity or inventing conversion.'
    status: completed
  - id: review-issue-769
    content: 'Independently review #769 against Catalog owner contracts, package/configuration cases, unit mismatch failures, evidence currentness, and absence of Pricing-owned quantity normalization; resolve findings before advancing.'
    status: completed
isProject: false
---

# pricing-742-quantity-tiers

## Execution Notes

This is a coordination plan for executable leaves #766–#769 under tracking parent [#742](https://github.com/TechsioCZ/ontos/issues/742); it does not claim that #742 itself was implemented. The completed todo states preserve the execution and review history of those leaves. This follows the tracking-versus-execution distinction in the authoritative roadmap comment on [#253](https://github.com/TechsioCZ/ontos/issues/253#issuecomment-5661414584). The leaf work can run in parallel with exact resolution and discount fact work after the Price fact foundation is reviewed.

## Constraints

- A Tier belongs to a Price and never selects a different Price.
- Highest-reached applies to the whole relevant quantity; no graduated bands in Launch.
- Aggregation is evaluation-only and never merges persistent occurrence identities.
- Catalog owns quantity normalization and conversion evidence.

## Operator Guidance

Review each issue independently. Use generated Resource/Action/API starting points, transaction-scoped persistence, and exact decimal schemas. Include property/table tests for thresholds and multi-line aggregation.
