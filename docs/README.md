# OntOS documentation

This is the authority map for humans and agents. Follow the shortest route that answers the task;
do not load the documentation tree by default.

## Authority

Authority follows concern; it is not a generic precedence ladder.

1. [Product](PRODUCT.md) owns current product scope and boundaries.
2. One focused [context](../CONTEXT-MAP.md) owns canonical vocabulary and stable semantic
   distinctions, not implementation behavior.
3. An accepted [ADR](adr/README.md) owns a durable architectural decision and its rationale.
4. A current document under [`app/docs/`](../app/docs/) owns detailed implementation rules.
5. A `planned` or `in_progress` specification explicitly named by the task owns only that scoped
   change. It cannot silently redefine product, language, architecture, or current application
   guidance.
6. Code and tests show implemented reality.

When two sources claim the same concern, stop and surface the conflict. It is documentation debt,
unfinished implementation, or a decision that still needs an ADR; do not reconcile it silently.

Completed specifications and [`evidence/`](evidence/) are historical records, not current guidance.
Read them only when a task explicitly asks for provenance.

## Reading routes

- Product scope or boundaries: [Product](PRODUCT.md).
- Domain terms: [Context map](../CONTEXT-MAP.md), then one focused context. Open only the needed
  shared OntOS section when that context explicitly depends on a shared term.
- Architectural rationale: [ADR index](adr/README.md), then the relevant ADR only.
- Application work: [`app/AGENTS.md`](../app/AGENTS.md), the
  [application coding guide](../app/README.md), then one task-specific document selected by its
  routing table.
- Scoped delivery work: the active specification explicitly named by the task or GitHub issue.
- Historical investigation: the exact completed specification or evidence path named by the task.

Delivery dates, priority, milestones, and sequencing belong in GitHub issues.

## Canonical decision clusters

| Concern                                     | Durable decision                                                                                                                                                                                      | Current implementation rules                                                                                                                                                                                         |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MicroVertical ownership and deployment seam | [ADR-0016](adr/0016-independently-deployable-microverticals.md)                                                                                                                                       | [MicroVerticals](../app/docs/architecture/MICROVERTICALS.md)                                                                                                                                                         |
| Module identity, contracts, and entrypoints | [ADR-0016](adr/0016-independently-deployable-microverticals.md)                                                                                                                                       | [Manifests](../app/docs/architecture/MODULE_MANIFESTS.md) and [entrypoints](../app/docs/architecture/MODULE_ENTRYPOINTS.md)                                                                                          |
| State changes and side effects              | [ADR-0003](adr/0003-action-driven-core-evented-side-effects.md)                                                                                                                                       | [Actions](../app/docs/architecture/ACTIONS.md)                                                                                                                                                                       |
| Authentication, authorization, and policy   | [ADR-0005](adr/0005-betterauth-spicedb-policy-layer.md), [ADR-0014](adr/0014-authenticated-principal-session.md), and [ADR-0019](adr/0019-explicit-action-authorization.md)                          | [MicroVerticals](../app/docs/architecture/MICROVERTICALS.md), [Actions](../app/docs/architecture/ACTIONS.md), and [errors](../app/docs/architecture/ERRORS.md)                                                       |
| Data ownership and cross-module references  | [ADR-0004](adr/0004-postgres-canonical-neo4j-projection.md), [ADR-0006](adr/0006-explicit-domain-tables-plus-resource-ref.md), and [ADR-0010](adr/0010-separate-business-ontology-and-authz-graph.md) | [Database](../app/docs/architecture/DATABASE.md) and [governed data access](../app/docs/architecture/DATA_ACCESS.md)                                                                                                 |
| Asynchronous delivery                       | [ADR-0009](adr/0009-postgres-outbox-idempotent-workers.md) and [ADR-0013](adr/0013-broadcast-outbox-deliveries.md)                                                                                    | [Outbox workers](../app/docs/architecture/OUTBOX_WORKERS.md)                                                                                                                                                         |
| Shared Party identity                       | [ADR-0015](adr/0015-party-registry-owns-shared-identity.md)                                                                                                                                           | Vocabulary: [OntOS context](contexts/ontos/CONTEXT.md). Until a dedicated guide exists, use topology and source to locate the owning MicroVertical, then inspect its code/tests and any task-named active specification. |
| Commerce applications                       | [ADR-0017](adr/0017-commerce-application-boundaries.md)                                                                                                                                               | [Commerce boundaries](../app/docs/architecture/COMMERCE_APPLICATIONS.md)                                                                                                                                             |

## Supporting diagrams

Diagrams explain current authoritative prose but never override it:

- [System context](diagrams/c4-L1-context.md)
- [Runtime containers](diagrams/c4-L2-containers.md)
- [MicroVertical structure](diagrams/c4-L3-microvertical.md)
- [Resource references](diagrams/entity-model.md)
- [Module lifecycle](diagrams/module-lifecycle.md)
- [Action flow](diagrams/runtime-action-flow.md)

## Documentation maintenance

- Give each rule one canonical owner; other documents link to it.
- Put product scope in `PRODUCT.md`, stable domain semantics in contexts, durable rationale in ADRs,
  implementation mechanics in `app/docs`, scoped delivery evidence in specs, and current delivery
  state in GitHub.
- Point mutable facts to executable sources: tool versions to `.mise.toml` and `package.json`,
  commands and generators to `package.json`, topology to `app/topology/`, and implemented contracts
  to code and tests.
- Superseded ADRs and specifications remain clearly marked as history and point to their current
  replacement or authority.
- Keep only linked Mermaid sources. Generated images and HTML are not source.
- Before deleting documentation, map every unique current rule or term to its surviving owner.

Issue [#163](https://github.com/TechsioCZ/ontos/issues/163) and
[PR #308](https://github.com/TechsioCZ/ontos/pull/308) record the original documentation
consolidation and its measured baseline.
