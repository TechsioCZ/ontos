---
name: pr-885-remediation-currency-runtime
overview: Restore and prove the closed two-purpose Purchase Currency policy contract and its published owner boundaries while keeping production purchase resolution fail-closed until the Pricing and Cart roadmap steps provide the authoritative Current inputs.
todos:
  - id: remove-extra-explicit-choice-policy
    content: "Remove EXPLICIT_CURRENCY_CHOICE_POLICY from shared schemas, domain unions, persistence/migration snapshots, administration validation, projections, fixtures, and tests so Purchase Currency contains only ALLOWED_CURRENCY_CONSTRAINT and DEFAULT_CURRENCY purposes."
    status: completed
  - id: move-explicit-choice-to-resolution
    content: "Refactor Purchase Currency Resolution so a caller-requested explicit choice is validated directly against Current policy and Pricing support with precedence over preference/default, invalid explicit choice returns its typed failure, and no policy toggle is required or silently bypassed."
    status: completed
  - id: implement-current-purchasing-context-port
    content: "Freeze the Cart-owned `PurchaseCurrencyPurchasingContextPort` production integration at roadmap step 29: retain its exact Tenant, Storefront, seller, Market, Channel, subject/Guest and context-revision contract, keep the production boundary fail-closed, record the downstream handoff in #333 through HITL, and never synthesize authority from request fields."
    status: completed
  - id: establish-pricing-currency-owner
    content: "Land or depend on a Pricing-owned governed read for the exact Current context's supported currency set (aligned with Pricing issue #759 and its public-contract/currentness issues), including Pricing revision and owner-verifiable completeness with typed unavailable/unverifiable outcomes."
    status: completed
  - id: implement-pricing-currency-adapter
    content: "Implement PurchaseCurrencyPricingPort over the Pricing owner's generated Effect client and map owner outcomes without introducing FX, local allowed lists, request-derived support, or Customer Context-owned Pricing semantics."
    status: completed
  - id: wire-currency-production-runtime
    content: "Keep default production Purchase Currency resolution fail-closed for the unavailable Cart purchasing context until roadmap step 29 while retaining the real Pricing client seam; prove that unavailable context cannot become success or request-derived authority, and record the deferred production wiring in #333 through HITL."
    status: completed
  - id: prove-currency-contract-and-runtime
    content: "Prove #333’s closed two-purpose Purchase Currency policy and owner-local resolution semantics now: valid explicit CZK, invalid explicit EUR without fallback, preference/default precedence, unsupported Pricing currency, stale/unavailable dependencies, Pricing completeness invalidation and safe evidence. Use controlled owner ports where later-roadmap owners are unavailable, record the real Cart/Pricing composed journey for steps 10 and 29, and do not claim that journey operational in PR #885."
    status: completed
isProject: false
---

# pr-885-remediation-currency-runtime

## Execution Notes

This lane covers T0.3, T1.1, and the first explicit hallucinated semantic. The implementation currently makes an extra policy rule mandatory and installs unavailable owner ports in production. The accepted #333 contract instead puts explicit-choice precedence in Purchase Currency Resolution and leaves supported currency truth with Pricing.

No Pricing owner implementation exists in the current branch. A real Pricing-owned read is therefore a hard merge dependency, not work that may be hidden inside Customer Context. Likewise, if no authoritative Cart/purchase owner is deployable, the production path must remain blocked and PR #885 cannot claim the Currency family is operational until that owner dependency lands.

Primary consumer files include `shared/domain/customer-commerce-policy.ts`, `src/integrations/purchase-currency-policy.ts`, Purchase Currency resolution ports/read code, `api/commerce-customer-context-production-layers.ts`, `api/index.ts`, migrations/snapshots, and Currency unit/integration tests.

## Constraints

- Issues #333 and #346 are HITL-frozen. Agents may read them but must not comment on, edit, label, close, or otherwise mutate them without explicit HITL approval. Do not edit or create any other GitHub issue.
- Do not create a third Purchase Currency policy purpose.
- Do not implement Pricing truth or Cart truth as Customer Context tables, environment lists, or request-derived assumptions.
- Preserve typed failures and the distinction between invalid explicit choice, known unsupported currency, missing policy, and unverifiable owner state.
- Every set-valued Pricing/policy conclusion needs owner-verifiable completeness/currentness evidence.

## Operator Guidance

The closed-contract cleanup can start after the architecture gate and can run in parallel with provider work. Treat the authoritative Purchasing Context and Pricing read as explicit upstream lanes owned by their capabilities; wire Customer Context only after their generated clients exist. Run focused Currency schema, resolver, and production-layer tests per todo; the Czech fixture is handled by the launch-fixtures plan.
