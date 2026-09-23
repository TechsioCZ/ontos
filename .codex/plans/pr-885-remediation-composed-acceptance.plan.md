---
name: pr-885-remediation-composed-acceptance
overview: Prove #333/#346 owner behavior at their roadmap cutline, preserve fail-closed boundaries for later owners, run final PR validation, and reserve full Cart-to-Order journey acceptance for its actual roadmap steps.
todos:
  - id: replace-boolean-acceptance-harness
    content: "Replace literal readiness claims with owner-scoped acceptance that invokes available production-like governed reads and explicitly proves fail-closed handoffs where downstream owners are not yet delivered. Record persisted Cart/Pricing/Payment/Checkout/Order composition as deferred in #333/#346 through HITL instead of fabricating readiness."
    status: completed
  - id: prove-market-owner-behavior
    content: "Exercise actual subject restriction and Storefront owner reads, Retail fixed seller, Counterparty restriction invalidation, zero/one/many eligible tuples, invalid explicit/default choice, material association insert invalidation, and authoritative Market selection evidence."
    status: completed
  - id: prove-currency-and-payment-behavior
    content: "Exercise #333 owner-level Currency and Payment Term policy semantics: Czech `{CZK}` allowed/default behavior, invalid EUR without fallback, Payment applicability plus fallback, definition/entitlement boundary mapping, and typed unavailable/stale outcomes. Controlled ports are valid for owners scheduled later; record the real combined purchase journey as downstream rather than claiming it operational."
    status: completed
  - id: prove-quantity-owner-behavior
    content: "Exercise the real Catalog adapter with exact selection/normalization evidence, Package/Set basis, Quantity 7 versus multiple 5, split equivalent rows, material Catalog change invalidation, and owner-unavailable behavior."
    status: completed
  - id: prove-retirement-production-composition
    content: "Invoke deployed Market retirement through the real neutral Application Composition authority and real currently installed affected-use providers. Prove safe success, live-use rejection, stale evidence, provider unavailability and authoritative `not installed` evidence for future providers without fake authority or topology inference."
    status: completed
  - id: run-focused-owner-gates
    content: "Run the package-filtered Market Catalog, Customer Context, Catalog, Pricing, Payment Term, shared-contract, script, migration, RLS, API-boundary, and module-contract checks selected by the files changed in the remediation, fixing only confirmed in-scope failures."
    status: completed
  - id: run-final-pr-gates
    content: "After every focused lane is green, run the repository's full required check/build and production-artifact proofs, resolve the existing Deployment Impact Planner and Cloudflare Workerd failures if caused by PR #885, and record exact commands/results in the PR."
    status: completed
  - id: reconcile-review-and-pr-claims
    content: "Map every T0–T3 finding and applicable owner-level acceptance gate to evidence; update PR #885 to state the owner cutline and remove unsupported downstream operational claims; verify the authorized downstream/freeze notes exist only in #333 and #346; require HITL before any later mutation of those issues; do not edit or create any other issue."
    status: completed
isProject: false
---

# pr-885-remediation-composed-acceptance

## Execution Notes

This lane covers T2.1-T2.4 and the audit's full acceptance gate. It is the downstream integration lane: it must consume the real production-composed ports built by the other plans and should not paper over missing owners with fakes. Unit tests for pure algorithms remain valuable but are not launch evidence.

The test suite should retain the existing good invariants: immutable Rule Revisions, no `AMBIGUOUS_MARKET`, quantity selector/assignment ordering, conjunctive non-relaxable constraints, no silent commercial rounding, and separate typed business rejection versus dependency inability.

## Constraints

- Issues #333 and #346 are HITL-frozen. Agents may read them but must not comment on, edit, label, close, or otherwise mutate them without explicit HITL approval. Do not edit or create any other GitHub issue.
- Depends on all owner-integration plans and `pr-885-remediation-launch-fixtures`.
- Do not mark a todo complete from manifest presence, schema decoding, a fake injected success, or literal readiness flags.
- Keep focused validation during active todos; run broad `check`/`build` only once at final integration.
- Do not expand into repository-wide cleanup or unrelated analyzer work.
- The current PR has failing Deployment Impact Planner and Cloudflare Workerd checks; classify and fix them only if the remediated diff causes them.

## Operator Guidance

One integration owner should control the composed harness and merge sequencing. Independent workers may add owner-specific production integration cases after their lanes land, but they must not edit the same acceptance file concurrently. Preserve a traceable matrix from audit finding to test. Use `mise exec -- pnpm check:local --scope <scope>` and package-filtered tests during implementation, then `mise exec -- pnpm check` and `mise exec -- pnpm build` once at the end.
