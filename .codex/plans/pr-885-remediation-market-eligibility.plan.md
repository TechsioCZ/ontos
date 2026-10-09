---
name: pr-885-remediation-market-eligibility
overview: Make Commerce Market eligibility authoritative for Purchasing Subject and Storefront state, correct Market bootstrap and time evidence contracts, and remove fabricated owner evidence while preserving #346's typed outcomes and complete-set semantics.
todos:
  - id: define-subject-restriction-read
    content: "Define a Market-free owner-issued subject-restriction read for RETAIL_PROFILE and COUNTERPARTY subjects that returns fixed/allowed seller, Market, and Channel constraints as applicable, owner revision, currentness/completeness evidence, safe evidence references, and typed unavailable or unverifiable failures."
    status: completed
  - id: serve-authoritative-subject-restrictions
    content: "Implement the governed owner read and generated client from actual Retail profile and Counterparty restriction state, ensuring the result is independent of Market bootstrap and never derives ALLOWED evidence from principal scope, request fields, or caller assertions."
    status: completed
  - id: apply-subject-restrictions-to-eligibility
    content: "Wire the published subject-restriction client into Commerce Market eligibility, pass the material subject identity/revision into the persistence predicate, filter before asserting an eligible tuple set, and return typed inability whenever mandatory owner state cannot be established."
    status: completed
  - id: bind-restrictions-to-completeness
    content: "Extend eligible-set completeness/currentness evidence so every material subject restriction insert, removal, revision, or lifecycle change invalidates affected evidence, then expose only browser-safe owner evidence and delete synthesized trusted-seller-scope/trusted-principal-context ALLOWED records."
    status: completed
  - id: validate-storefront-owner-reference
    content: "Add a published owner-issued Storefront validation boundary and require associate-storefront Actions to prove Storefront existence, same-Tenant ownership, allowed Channel/context, and material owner revision before persisting an association; retain typed dependency failure separately from known invalid association."
    status: completed
  - id: correct-market-bootstrap-tuple
    content: "Remove defaultStorefrontId from DEFAULT_MARKET_TUPLE schemas, persistence, migrations/snapshots, projections, and resolution; keep Storefront only in the declared policy scope and trusted request context so CHANNEL_SELLER defaults can apply across eligible Storefronts."
    status: completed
  - id: separate-effective-and-evaluated-time
    content: "Publish the requested applicability instant as effectiveAt and the owner's actual observation instant as evaluatedAt throughout Market persistence, shared API schemas, clients, evidence, and tests instead of assigning input.at to evaluatedAt."
    status: completed
  - id: prove-market-eligibility-contract
    content: "Add focused owner-backed tests for fixed Retail seller, Counterparty restriction changes, owner unavailability, same- and cross-Tenant Storefront validation, multi-Storefront bootstrap, material completeness invalidation, actual evaluation time, and preservation of MARKET_SELECTION_REQUIRED with no AMBIGUOUS_MARKET path."
    status: completed
isProject: false
---

# pr-885-remediation-market-eligibility

## Execution Notes

This lane covers T0.1, T1.2, T1.3, T1.4, T2.4, and the duplicated hallucinated-semantics findings. The core correction is ownership: Market may consume restrictions issued by their actual owner, but it may not manufacture an owner-looking decision from `context.scope`. The restriction read must be Market-free to preserve #333's acyclic resolution order.

Primary touched areas include `app/verticals/commerce-market-catalog/shared/market-contracts.ts`, `src/api/resolve-commerce-market.read.ts`, `src/persistence/market-resolution-persistence.ts`, the Market resolution SQL migration/snapshot, association Actions/services, Market API servers/clients, and the subject owner's public API/client. Exact generated artifacts must be discovered through the repository's scaffolds rather than copied across deployments.

Preserve the existing owner-verifiable set-completeness envelope, the distinction between known business rejection and unverifiable dependency state, and the published `MARKET_RESOLVED` / `MARKET_SELECTION_REQUIRED` outcome catalog.

## Constraints

- Issues #333 and #346 are HITL-frozen. Agents may read them but must not comment on, edit, label, close, or otherwise mutate them without explicit HITL approval. Do not edit or create any other GitHub issue.
- Depends on `pr-885-remediation-architecture-scope` accepting the Market deployment boundary.
- No caller-derived, gateway-principal-derived, or request-derived value may masquerade as subject-owner evidence.
- No private cross-MicroVertical imports, shared transactions, or database reads are allowed; use generated Effect contracts and clients.
- A missing subject restriction required for authoritative eligibility is typed inability, never an empty complete set.
- Storefront syntactic validity is not owner validity.
- Do not change accepted Market identity, lifecycle, or `NO AMBIGUOUS_MARKET` semantics.
- Treat downstream Cart-to-Order composition as a parked handoff, not as a closure dependency for this Market-owner eligibility lane.

## Operator Guidance

Implement the subject-owner contract and Storefront validation contract before changing Market persistence so consumers can compile against stable schemas. Then update SQL/currentness and public projections together. Use one worker for the subject-owner provider and one for Market consumption only after their file ownership is non-overlapping; integrate before bootstrap/time contract edits. Run focused Market Catalog and subject-owner unit/integration tests after each todo, with database migration/schema checks only when migration files change.
