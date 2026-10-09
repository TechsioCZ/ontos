---
name: pr-885-remediation-launch-fixtures
overview: Make the deterministic Czech Launch fixture satisfy the corrected Market, Currency, Payment Term, and Quantity owner contracts instead of validating incomplete policy defaults or manually asserted readiness flags.
todos:
  - id: seed-czech-currency-policy
    content: "Update czech-launch-commerce-fixture.mts to create and coherently activate both ALLOWED_CURRENCY_CONSTRAINT = {CZK} and DEFAULT_CURRENCY = CZK, with no EXPLICIT_CURRENCY_CHOICE_POLICY revision."
    status: completed
  - id: seed-czech-payment-term-policy
    content: "Create the required complete Payment Term applicability constraint set plus the accepted fallback, referencing real Payment Term owner definitions/entitlements and retaining their independent owner revisions."
    status: completed
  - id: seed-corrected-market-bootstrap
    content: "Update Market bootstrap fixture data to store only the seller + Commerce Market + Channel tuple and express Storefront solely through the declared scope and trusted context."
    status: completed
  - id: seed-authoritative-quantity-basis
    content: "Seed or reference actual Catalog-owner Product/Variant/Package selection, Unit, normalization/divisibility, and evidence needed by the production Quantity adapter instead of toggling catalogQuantityBasisCurrent or supplying policy-side substitutes."
    status: completed
  - id: order-owner-initialization
    content: "Update local initialization order so Storefront, Market, Catalog, Pricing currency support, Payment Term, subject restrictions, and Customer Commerce Policy facts exist before composed reads, with idempotent reruns and typed failure when an owner dependency is absent."
    status: completed
  - id: prove-fixture-coherence
    content: "Extend fixture/initializer tests to assert both Currency purposes, Payment applicability plus fallback, corrected Market tuple scope, real Catalog quantity evidence, deterministic generations, and coherent activation boundaries."
    status: completed
isProject: false
---

# pr-885-remediation-launch-fixtures

## Execution Notes

This lane covers T0.4, T1.5, and the fixture items from the audit remediation order. It runs only after the corrected Market, Quantity, and Currency contracts are stable. The fixture is executable launch configuration, not a schema sample, so each owner must issue the facts consumed by the production-like reads.

Primary files include `app/scripts/czech-launch-commerce-fixture.mts`, `app/scripts/initialize-local-development.mts`, their script tests, relevant owner seed helpers, and migration-safe fixture identifiers.

## Constraints

- Issues #333 and #346 are HITL-frozen. Agents may read them but must not comment on, edit, label, close, or otherwise mutate them without explicit HITL approval. Do not edit or create any other GitHub issue.
- Depends on Market eligibility/bootstrap, Quantity/Catalog, and Currency/Pricing contracts.
- Do not collapse the Currency allowed set and default into one revision.
- Do not treat Payment fallback as an applicability set or acquire Payment Term definition/entitlement ownership.
- Do not embed Storefront in the default Market tuple.
- Do not use booleans or request payloads as owner evidence.
- These fixtures prove deterministic owner configuration at the #333/#346 cutline, not a complete Cart-to-Order production journey; that later journey is a parked handoff.

## Operator Guidance

Implement each owner seed in its owning package, then compose them in the repository initializer. Preserve deterministic IDs and idempotency. Run `mise exec -- pnpm test:scripts` plus package-filtered owner tests; database migration/verification is required only for owners whose persisted schema or seed path changed.
