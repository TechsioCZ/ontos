---
name: pr-885-remediation-market-retirement
overview: Replace Market retirement's permanently unavailable fallback with a production-composed affected-use authority that inventories all currently deployable material references and returns current owner evidence before a governed retirement transition.
todos:
  - id: publish-retirement-impact-contract
    content: "Move the MarketRetirementImpactAuthority service contract into the owner-local composition surface with typed per-owner affected-use evidence, observation time, next boundary, completeness/currentness, rejection, and dependency-unavailable outcomes."
    status: completed
  - id: implement-material-reference-providers
    content: "Implement affected-use adapters for Customer Commerce Policy bootstrap references and every actually installed material owner, and publish the extension seam future Cart, Proposal and Order owners will join at their roadmap steps. Absence of a future owner must ultimately be proven by neutral Application Composition authority, never inferred from source or topology absence."
    status: completed
  - id: compose-production-retirement-authority
    content: "Build the production Market retirement aggregator from published owner clients, keep it fail-closed when any material provider is missing or stale or until the real neutral Application Composition authority is supplied, and install it in the Market Action runtime so the default deployed composition can retire a Market only when every authoritative impact result is clear."
    status: completed
  - id: retain-impact-evidence-on-transition
    content: "Persist/audit the exact provider revisions, completeness evidence, evaluation instant, and assessed Market revision used by a successful retirement so a concurrent affected-use change causes conflict or revalidation rather than silent retirement."
    status: completed
  - id: prove-production-retirement
    content: "Add production-composition integration tests using the real neutral active Application Composition authority and currently installed affected-use providers. Prove safe retirement, live bootstrap/reference rejection, provider unavailability, stale evidence, concurrent material change, retained history, and authoritative `not installed` evidence for future providers; source or topology absence is not sufficient."
    status: completed
isProject: false
---

# pr-885-remediation-market-retirement

## Execution Notes

This lane covers T0.5 and T2.3. `retire-market.action.ts` already expresses a fail-closed decision seam, but production installs no real authority. The fix is a composed owner-client implementation, not a permissive local query or a test-only fake.

The provider set must be derived from actual deployed/active capabilities. Today the repository contains Customer Context and Market Catalog but no Cart/Order deployment on this branch; absence of an implementation may be proven through authoritative module/deployment state, while a deployed owner must return its own complete affected-use result. Future owners join through the same contract without changing retirement semantics.

## Constraints

- Issues #333 and #346 are HITL-frozen. Agents may read them but must not comment on, edit, label, close, or otherwise mutate them without explicit HITL approval. Do not edit or create any other GitHub issue.
- Depends on `pr-885-remediation-architecture-scope`.
- Do not reach into another deployment's tables, repositories, or private services.
- A disabled/unimplemented owner and an unreachable enabled owner are different outcomes.
- Do not permit retirement from a partial inventory or event-silence assumption.
- Preserve Action authorization, idempotency, optimistic conflict detection, immutable history, and outbox behavior.

## Operator Guidance

This lane can run in parallel with Market eligibility after the deployment boundary is accepted. Keep each affected-use provider in its owning module and reserve the Market lane for the aggregator/composition. Validate with the focused Market Action unit suite and one database-backed production composition suite; defer broad gates to the final acceptance plan.
