# Architecture decision records

ADRs preserve durable decisions and their rationale. Read the index, then only the decision relevant
to the task. An accepted ADR is current unless a later ADR explicitly supersedes it.

| ADR                                                        | Decision                                                  | Status                       |
| ---------------------------------------------------------- | --------------------------------------------------------- | ---------------------------- |
| [0001](0001-microverticals-are-unified-vertical-slices.md) | MicroVerticals are unified vertical slices                | Superseded by 0016           |
| [0002](0002-modular-monolith-for-v0.md)                    | V0 uses a modular monolith                                | Superseded by 0016           |
| [0003](0003-action-driven-core-evented-side-effects.md)    | Actions own state changes; events/outbox own side effects | Accepted                     |
| [0004](0004-postgres-canonical-neo4j-projection.md)        | PostgreSQL is canonical; Neo4j is optional projection     | Accepted                     |
| [0005](0005-betterauth-spicedb-policy-layer.md)            | Separate authentication, authorization, and policy        | Accepted                     |
| [0006](0006-explicit-domain-tables-plus-resource-ref.md)   | Explicit domain tables plus ResourceRef                   | Accepted                     |
| [0007](0007-no-product-ai-in-v0.md)                        | Product AI is outside the initial product boundary        | Accepted                     |
| [0008](0008-module-activation-state-model.md)              | Module activation and state model                         | Partially superseded by 0016 |
| [0009](0009-postgres-outbox-idempotent-workers.md)         | PostgreSQL outbox and idempotent workers                  | Accepted                     |
| [0010](0010-separate-business-ontology-and-authz-graph.md) | Separate business and authorization graphs                | Accepted                     |
| [0011](0011-internal-dogfood-early.md)                     | Historical product sequencing                             | Superseded planning          |
| [0012](0012-pulsar-for-machine-prediction.md)              | Integrate specialist machine prediction                   | Proposed                     |
| [0013](0013-broadcast-outbox-deliveries.md)                | Broadcast outbox deliveries                               | Accepted                     |
| [0014](0014-authenticated-principal-session.md)            | Authenticated Principal Session                           | Accepted                     |
| [0015](0015-party-registry-owns-shared-identity.md)        | Party Registry owns shared identity                       | Accepted                     |
| [0016](0016-independently-deployable-microverticals.md)    | Independent MicroVertical deployment seams                | Accepted                     |
| [0017](0017-commerce-application-boundaries.md)            | Commerce application boundaries                           | Accepted                     |
| [0018](0018-party-registry-operational-boundaries.md)      | Party Registry operational boundaries                     | Accepted                     |

## Status meanings

- **Proposed** — preserved proposal; do not implement as an accepted rule.
- **Accepted** — current durable decision.
- **Superseded** — retained history; follow the linked replacement or current planning source.

Dates and delivery sequencing are intentionally not part of ADR status. Git history records when a
decision changed.
