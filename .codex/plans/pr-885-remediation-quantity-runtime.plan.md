---
name: pr-885-remediation-quantity-runtime
overview: Replace Commerce Quantity Resolution's hard-coded unavailable Catalog port with a real published Catalog owner read and production adapter while preserving the already-correct quantity policy algorithm and fail-closed behavior.
todos:
  - id: establish-catalog-owner-dependency
    content: "Rebase or integrate against the approved Catalog owner implementation from issue #398 / PR #873 and confirm its public contract, rather than Customer Context, owns exact Current Catalog Selection, Unit, Quantity Normalization, physical divisibility, Package/Set meaning, hierarchy identity, equivalence grouping, and owner evidence."
    status: completed
  - id: publish-current-quantity-basis-read
    content: "In the Catalog owner, add or complete the governed generated read that returns the exact quantity basis required by CommerceQuantityCatalogPort, including owner revision, next boundary, and complete/current evidence with typed invalid, unavailable, and unverifiable outcomes."
    status: completed
  - id: implement-catalog-quantity-adapter
    content: "Implement the Customer Context adapter over the Catalog owner's generated Effect client, map its typed outcomes without accepting request facts as authority, and preserve exact PRODUCT / VARIANT / PACKAGE_OPTION identities and equivalent-selection grouping."
    status: completed
  - id: wire-quantity-production-runtime
    content: "Replace unavailableCommerceQuantityCatalogPort in the governed production read and production layers with the real adapter while retaining the unavailable implementation only as an explicit negative-test/configuration path."
    status: completed
  - id: prove-production-quantity-resolution
    content: "Add a production-like integration test using persisted/served Catalog owner data and the real adapter, plus owner-unavailable/stale evidence cases; retain tests for selector precedence, non-relaxable constraints, split equivalent rows, Quantity 7 versus multiple 5, Package/Set basis, and no silent rounding."
    status: completed
isProject: false
---

# pr-885-remediation-quantity-runtime

## Execution Notes

This lane covers T0.2 and T2.2. The pure resolver in PR #885 is intentionally preserved; the defect is the production composition in `commerce-quantity-resolution.read.ts` and related layers. The Catalog owner is not present on this branch, but an open owner implementation exists in PR #873. This plan must integrate through its public generated contract or land the missing owner read there; it must not duplicate Catalog truth in Customer Context.

Primary consumer files include `shared/domain/commerce-quantity-catalog-port.ts`, `src/api/commerce-quantity-resolution.read.ts`, production API layers, Catalog client integration, and the governed-read tests.

## Constraints

- Issues #333 and #346 are HITL-frozen. Agents may read them but must not comment on, edit, label, close, or otherwise mutate them without explicit HITL approval. Do not edit or create any other GitHub issue.
- PR #873 or an equivalent accepted Catalog owner delivery is a hard prerequisite; an in-memory production stub does not satisfy this plan.
- Do not copy Catalog persistence/domain code into Customer Context.
- Do not change the accepted policy selector ranking, assignment ranking, aggregation, non-relaxable constraints, or typed outcome semantics unless a focused regression proves an existing defect.
- Every successful result retains Catalog owner revision and completeness/currentness evidence.
- Treat the later Cart-to-Order production journey as a parked handoff, not as a closure dependency for this Catalog-backed quantity-owner lane.

## Operator Guidance

Coordinate the Catalog-owner contract change separately from the Customer Context adapter to avoid cross-owner edits by one worker. Land/generate the provider API first, then the client adapter, runtime wiring, and production-like test. Use package-filtered Catalog and Customer Context tests and schema checks for the active todo only.
