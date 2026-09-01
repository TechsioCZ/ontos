# ADR-0007: No product AI in V0

Status: Accepted

## Context

The team capacity and delivery deadline require focus. Product AI features are attractive but not required for committed delivery and would create significant scope risk.

## Decision

V0 is AI-ready but not AI-first as a product. AI may be used heavily in development. User-facing AI assistant, document AI automation, autonomous agents, process autodiscovery, and vibemodule are out of V0 scope.

## Consequences

Architecture should preserve future AI hooks through ResourceRefs, actions, audit, media/documents, module-owned domain tables, and selected projections. Implementation does not depend on AI features.

## Risks

The product vision may tempt scope creep. This ADR should be revisited after V0 foundations are stable.
