---
name: pricing-743-discounts-fees
overview: Coordinate the executable #770–#774 leaves for Pricing-owned Discount families, applicability, composition/cardinality, commercial Fees, and conservative allocation semantics under tracking parent #743.
todos:
  - id: implement-issue-770
    content: 'Implement #770 explicit Discount family, audience, scope, and effect contracts for CATALOG_DISCOUNT and manual CONTRACTUAL_DISCOUNT, including Group/Counterparty line effects and Counterparty whole-purchase fixed effects without automatic levels or campaign ownership.'
    status: completed
  - id: review-issue-770
    content: 'Independently review #770 schema vocabulary, supported combination matrix, currency/sign bounds, rejected out-of-launch combinations, and separation from Promotion/loyalty; resolve findings before advancing.'
    status: completed
  - id: implement-issue-771
    content: 'Implement #771 exact Discount applicability and immutable revisions over Variant/commercial scope/audience/effect identity, with Product administration as snapshot bulk expansion and no runtime inheritance.'
    status: completed
  - id: review-issue-771
    content: 'Independently review #771 identity versus revision, temporal uniqueness, audience evidence, per-target bulk outcomes/retry, and no future-Variant coverage; resolve findings before advancing.'
    status: completed
  - id: implement-issue-772
    content: 'Implement #772 composition/cardinality so Catalog, Group, and Counterparty line layers independently contribute from the same fee-inclusive basis, Group-specific Price does not replace discounts, and at most one contribution exists per supported layer/path plus one applicable whole-purchase contribution.'
    status: completed
  - id: review-issue-772
    content: 'Independently review #772 layer matrix, percentage non-compounding, fixed application counts, collision behavior, and tests distinguishing revision uniqueness from family cardinality; resolve findings before advancing.'
    status: completed
  - id: implement-issue-773
    content: 'Implement #773 RECYCLING_FEE and COPYRIGHT_FEE facts with FIXED_PER_LINE/FIXED_PER_UNIT basis on exact Variant lines, compatible currency/basis, composable different families, and conflicts for competing same-family same-key facts.'
    status: completed
  - id: review-issue-773
    content: 'Independently review #773 Fee identity/revisions, per-line/per-unit arithmetic inputs, family composition, Product bulk management, and exclusions for Shipping/Payment/Tax; resolve findings before advancing.'
    status: completed
  - id: implement-issue-774
    content: 'Implement #774 strict whole-purchase contractual applicability B>D over positive merchandise intermediates after line discounts, deterministic proportional allocation preserving SUM(a_i)=D and 0<=a_i<=v_i, declared precision/remainder, original recipients, and generic allocation evidence without using ZERO_FLOOR as repair.'
    status: completed
  - id: review-issue-774
    content: 'Independently review #774 B<D/B=D/B>D behavior, Shipping/non-positive exclusions, full contribution conservation and capacity, deterministic ordering, and the mandatory 9.7097/90.2975/D=100 sub-cent fixture; resolve findings before advancing.'
    status: completed
isProject: false
---

# pricing-743-discounts-fees

## Execution Notes

This is a coordination plan for executable leaves #770–#774 under tracking parent [#743](https://github.com/TechsioCZ/ontos/issues/743); it does not claim that #743 itself was implemented. The completed todo states preserve the execution and review history of those leaves. This follows the tracking-versus-execution distinction in the authoritative roadmap comment on [#253](https://github.com/TechsioCZ/ontos/issues/253#issuecomment-5661414584). Definitions and revisions are owner-local persistent Resources; evaluation services emit typed contributions and evidence consumed later by the calculation lane.

## Constraints

- Effect kind never implies application scope.
- Fixed VARIANT_LINE applies once per original eligible line; fixed WHOLE_PURCHASE once per decision.
- Allocation must preserve both contribution sum and recipient capacity before final-line rounding.
- Promotion remains a separate owner contract; no campaign/voucher algorithm is introduced here.

## Operator Guidance

This lane can run with Quantity Tiers after Price facts. Review each issue before the next. Use exact decimals and include deterministic/property-based conservation tests in addition to examples.
