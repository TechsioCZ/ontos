---
name: pricing-741-exact-resolution
overview: Coordinate the executable #761–#765 leaves for Price Group interpretation, legitimate no-group fallback, exact Current lookup, collision handling, and fail-closed explicit input semantics under tracking parent #741.
todos:
  - id: implement-issue-761
    content: 'Implement #761 typed Price Group interpretation from owner-issued assignment/compatibility evidence, distinguishing usable ASSIGNED(G), legitimate NONE, and broken/inconsistent/unverifiable states without treating Group as price, discount, or permission.'
    status: completed
  - id: review-issue-761
    content: 'Independently review #761 against Price Group Catalog and Commerce assignment public contracts, completeness evidence, Tenant/scope binding, and typed edge cases; resolve findings before advancing.'
    status: completed
  - id: implement-issue-762
    content: 'Implement #762 exact fallback rules: usable ASSIGNED(G) tries the G key and falls back only on proven legitimate absence; NONE/Guest uses no-group directly; conflict, invalidity, broken assignment, or unverifiable evidence never falls back.'
    status: completed
  - id: review-issue-762
    content: 'Independently review #762 with the full assigned/no-group outcome matrix, more-expensive Group Price case, Guest path, and fail-closed negative tests; resolve findings before advancing.'
    status: completed
  - id: implement-issue-763
    content: 'Implement #763 one exact Current Price/Revision lookup by complete identity and trusted instant, including authoritative absence and owner-verifiable fact/set evidence without partial-order, cheapest, latest, or maximal-specificity resolution.'
    status: completed
  - id: review-issue-763
    content: 'Independently review #763 exact-key construction, temporal query/persistence indexes, uniqueness evidence, stable outcome serialization, and tests rejecting broader Product/Channel/Storefront lookup; resolve findings before advancing.'
    status: completed
  - id: implement-issue-764
    content: 'Implement #764 explicit conflict outcomes for competing Current same-key Price facts even when amounts match, preserving each claimant and evidence for authorized diagnosis without a technical winner.'
    status: completed
  - id: review-issue-764
    content: 'Independently review #764 collision detection under concurrency/migration, equal-amount conflicts, safe diagnostics/redaction, and absence of latest/priority tie-breakers; resolve findings before advancing.'
    status: completed
  - id: implement-issue-765
    content: 'Implement #765 fail-closed broken explicit input handling for malformed/dangling Price Group, currency, basis, selection, commercial scope, and required evidence, keeping invalid, absent, conflict, stale, unavailable, and unverifiable outcomes distinct.'
    status: completed
  - id: review-issue-765
    content: 'Independently review #765 exhaustive typed outcomes and HTTP mappings, no silent default/fallback, nested error sanitization, and focused invalid-input tests; resolve findings before advancing.'
    status: completed
isProject: false
---

# pricing-741-exact-resolution

## Execution Notes

This is a coordination plan for executable leaves #761–#765 under tracking parent [#741](https://github.com/TechsioCZ/ontos/issues/741); it does not claim that #741 itself was implemented. The completed todo states preserve the execution and review history of those leaves. This follows the tracking-versus-execution distinction in the authoritative roadmap comment on [#253](https://github.com/TechsioCZ/ontos/issues/253#issuecomment-5661414584). The leaf work builds on the persistent facts from #740. Integrate with generated Price Group and customer-context clients only; private registrations and database tables remain owner-local.

## Constraints

- Exact-key resolution is deterministic evidence evaluation, not a rules-scoring engine.
- Group-specific base Price and later Group/Counterparty discounts are independent layers.
- Proven absence requires owner-verifiable completeness; zero rows alone are not proof.
- Preserve typed failure channels through the generated Effect BFF client and framework edge.

## Operator Guidance

Execute and review sequentially because each outcome vocabulary constrains the next step. Add table-driven unit tests plus owner-contract integration tests covering every fallback and conflict branch.
