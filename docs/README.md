# OntOS documentation

This is the authority map for humans and agents. Follow the shortest route that answers the task;
do not load the full documentation tree by default.

## Authority

1. A focused [context](../CONTEXT-MAP.md) defines terminology, not behavior.
2. An accepted [ADR](adr/README.md) defines a durable architectural decision and its rationale.
3. A current document under [`app/docs/`](../app/docs/) defines detailed implementation rules.
4. The active specification explicitly named by a task defines that scoped change. It cannot
   silently override the preceding authorities.
5. Code and tests show implemented reality. A discrepancy with accepted guidance is a defect,
   unfinished work, or a decision that still needs an ADR.

Completed specifications and historical delivery evidence are records, not guidance. They are
intentionally absent from this map and from default reading routes. Read them only when a task
explicitly asks for provenance or historical evidence.

## Reading routes

- Product scope or boundaries: [Product](PRODUCT.md), then the relevant context.
- Domain language: [Context map](../CONTEXT-MAP.md), then exactly one focused context.
- Architectural rationale: [ADR index](adr/README.md), then the relevant ADR only.
- Application work: [`app/AGENTS.md`](../app/AGENTS.md), then the
  [application coding guide](../app/README.md) and the task-specific implementation document it
  names.
- A scoped change: the specification explicitly named by its GitHub issue or task. Do not browse
  implemented specifications for background.

Delivery dates, milestones, and sequencing belong in GitHub issues. Architecture documents retain
capability boundaries and decisions, not schedules.

## Canonical decision clusters

| Concern                                     | Durable decision                                                                                                                                                                                      | Current implementation rules                                                                                                |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| MicroVertical ownership and deployment seam | [ADR-0016](adr/0016-independently-deployable-microverticals.md)                                                                                                                                       | [MicroVerticals](../app/docs/architecture/MICROVERTICALS.md)                                                                |
| Module identity, contracts, and entrypoints | [ADR-0016](adr/0016-independently-deployable-microverticals.md)                                                                                                                                       | [Manifests](../app/docs/architecture/MODULE_MANIFESTS.md) and [entrypoints](../app/docs/architecture/MODULE_ENTRYPOINTS.md) |
| State changes and side effects              | [ADR-0003](adr/0003-action-driven-core-evented-side-effects.md)                                                                                                                                       | [Actions](../app/docs/architecture/ACTIONS.md)                                                                              |
| Authentication, authorization, and policy   | [ADR-0005](adr/0005-betterauth-spicedb-policy-layer.md) and [ADR-0014](adr/0014-authenticated-principal-session.md)                                                                                   | [Actions](../app/docs/architecture/ACTIONS.md) and [errors](../app/docs/architecture/ERRORS.md)                             |
| Data ownership and cross-module references  | [ADR-0004](adr/0004-postgres-canonical-neo4j-projection.md), [ADR-0006](adr/0006-explicit-domain-tables-plus-resource-ref.md), and [ADR-0010](adr/0010-separate-business-ontology-and-authz-graph.md) | [Database](../app/docs/architecture/DATABASE.md) and [governed data access](../app/docs/architecture/DATA_ACCESS.md)        |
| Asynchronous delivery                       | [ADR-0009](adr/0009-postgres-outbox-idempotent-workers.md) and [ADR-0013](adr/0013-broadcast-outbox-deliveries.md)                                                                                    | [Outbox workers](../app/docs/architecture/OUTBOX_WORKERS.md)                                                                |
| Shared Party identity                       | [ADR-0015](adr/0015-party-registry-owns-shared-identity.md) and [ADR-0018](adr/0018-party-registry-operational-boundaries.md)                                                                         | [Party Registry](../app/docs/architecture/PARTY_REGISTRY.md) and [OntOS context](contexts/ontos/CONTEXT.md)                |
| Commerce applications                       | [ADR-0017](adr/0017-commerce-application-boundaries.md)                                                                                                                                               | [Commerce boundaries](../app/docs/architecture/COMMERCE_APPLICATIONS.md)                                                    |

## Supporting diagrams

Diagrams explain current authoritative prose but never override it:

- [System context](diagrams/c4-L1-context.md)
- [Runtime containers](diagrams/c4-L2-containers.md)
- [MicroVertical structure](diagrams/c4-L3-microvertical.md)
- [Resource references](diagrams/entity-model.md)
- [Module lifecycle](diagrams/module-lifecycle.md)
- [Action flow](diagrams/runtime-action-flow.md)

## Documentation maintenance

- Give each rule one canonical owner; other documents link to it instead of repeating it.
- Put durable rationale in an ADR, current coding rules in `app/docs`, vocabulary in a context, and
  delivery work in GitHub.
- Superseded ADRs remain and point to their replacements. Redundant drafts and summaries do not.
- Keep only linked, current Mermaid sources for diagrams. Generated images and HTML are not source.
- Before deleting documentation, map every unique current decision or term to its surviving owner.

## Context reduction

Issue [#163](https://github.com/TechsioCZ/ontos/issues/163) replaced automatic bulk reading with
selective routes:

| Route                   |                                      Before |                                                            After |
| ----------------------- | ------------------------------------------: | ---------------------------------------------------------------: |
| Project orientation     | 45 files; 34,637 words; about 66,132 tokens |                         4 files; 1,217 words; about 3,204 tokens |
| Application coding base | 17 files; 19,978 words; about 38,467 tokens | 2 files; 3,314 words; about 7,239 tokens, plus one task document |

The four-file orientation measurement consists of the root README, this map, Product, and the
Context Map. Contexts, ADRs, and implementation documents are added one at a time only when the
task needs them.
