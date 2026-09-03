# OntOS documentation

This is the authority and routing map for humans and agents. Follow the shortest route that
answers the task; do not load the documentation tree by default.

## Authority by question

| Question                                      | Canonical owner                                                                                                      |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| What is the product shape or boundary?        | [Product](PRODUCT.md)                                                                                                |
| What does a domain term or invariant mean?    | The matching focused [context](../CONTEXT-MAP.md)                                                                    |
| Why is a durable architecture choice accepted? | The relevant accepted [ADR](adr/README.md)                                                                           |
| How must the current application implement it? | The matching current document under [`app/docs/`](../app/docs/)                                                      |
| What exactly must this scoped change deliver? | The active specification explicitly named by the task or GitHub issue                                                |
| What is implemented now?                       | Code, generated contracts, configuration, and tests                                                                  |

These sources have different jobs rather than interchangeable rank. A context does not prescribe
implementation mechanics. A specification cannot silently override accepted product semantics,
an ADR, or current application guardrails. Code and tests show reality; disagreement with accepted
guidance is a defect, unfinished work, or a decision that still needs to be recorded.

Completed specifications and delivery evidence are historical records, not current guidance.
Read them only when a task explicitly asks for provenance, regression evidence, or an earlier
decision.

## Reading routes

- Product scope or boundaries: [Product](PRODUCT.md), then every context row whose trigger matches.
- Product language or invariants: [Context map](../CONTEXT-MAP.md), then only the matching context
  sections.
- Architectural rationale: [ADR index](adr/README.md), then only the relevant ADR.
- Application work: [`app/AGENTS.md`](../app/AGENTS.md), the
  [application coding guide](../app/README.md), and only the implementation documents selected by
  its routing table.
- A scoped change: the specification explicitly named by its GitHub issue or task. Do not browse
  completed specifications for background.

Delivery dates, sequencing, open alternatives, and prioritization belong in GitHub issues.

## Canonical decision clusters

| Concern                                     | Durable decision                                                                                                                                                                                      | Next focused source                                                                                                         |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| MicroVertical ownership and deployment seam | [ADR-0016](adr/0016-independently-deployable-microverticals.md)                                                                                                                                       | [MicroVerticals](../app/docs/architecture/MICROVERTICALS.md)                                                                |
| Module identity, contracts, and entrypoints | [ADR-0016](adr/0016-independently-deployable-microverticals.md)                                                                                                                                       | [Manifests](../app/docs/architecture/MODULE_MANIFESTS.md) and [entrypoints](../app/docs/architecture/MODULE_ENTRYPOINTS.md) |
| State changes and side effects              | [ADR-0003](adr/0003-action-driven-core-evented-side-effects.md)                                                                                                                                       | [Actions](../app/docs/architecture/ACTIONS.md)                                                                              |
| Authentication, authorization, and policy   | [ADR-0005](adr/0005-betterauth-spicedb-policy-layer.md), [ADR-0014](adr/0014-authenticated-principal-session.md), and [ADR-0019](adr/0019-explicit-action-authorization.md)                          | [MicroVerticals](../app/docs/architecture/MICROVERTICALS.md), [Actions](../app/docs/architecture/ACTIONS.md), and [errors](../app/docs/architecture/ERRORS.md) |
| Data ownership and cross-module references  | [ADR-0004](adr/0004-postgres-canonical-neo4j-projection.md), [ADR-0006](adr/0006-explicit-domain-tables-plus-resource-ref.md), and [ADR-0010](adr/0010-separate-business-ontology-and-authz-graph.md) | [Database](../app/docs/architecture/DATABASE.md) and [governed data access](../app/docs/architecture/DATA_ACCESS.md)        |
| Asynchronous delivery                       | [ADR-0009](adr/0009-postgres-outbox-idempotent-workers.md) and [ADR-0013](adr/0013-broadcast-outbox-deliveries.md)                                                                                    | [Outbox workers](../app/docs/architecture/OUTBOX_WORKERS.md)                                                                |
| Shared Party identity                       | [ADR-0015](adr/0015-party-registry-owns-shared-identity.md)                                                                                                                                           | [OntOS context](contexts/ontos/CONTEXT.md)                                                                                  |
| Commerce applications                       | [ADR-0017](adr/0017-commerce-application-boundaries.md)                                                                                                                                               | [Commerce context](contexts/commerce/CONTEXT.md) and [application boundaries](../app/docs/architecture/COMMERCE_APPLICATIONS.md) |

## Supporting diagrams

Diagrams explain authoritative prose but never override it:

- [System context](diagrams/c4-L1-context.md)
- [Runtime containers](diagrams/c4-L2-containers.md)
- [MicroVertical structure](diagrams/c4-L3-microvertical.md)
- [Resource references](diagrams/entity-model.md)
- [Module lifecycle](diagrams/module-lifecycle.md)
- [Action flow](diagrams/runtime-action-flow.md)

## Documentation maintenance

- Give each rule one canonical owner; other documents link to it instead of paraphrasing it.
- Put accepted product semantics in a context, durable architectural rationale in an ADR, current
  implementation mechanics in `app/docs`, and open or scheduled work in GitHub.
- Label accepted target architecture separately from the currently implemented contract.
- Derive versions, scripts, package inventory, topology, and generated fields from their source
  files. Do not cache them in prose.
- Keep completed specifications and delivery evidence out of default reading routes.
- Keep measurements and cleanup history in the issue or pull request that produced them.
- Retain superseded ADRs, normalize their status, and point to the replacement without presenting
  superseded details as current.
- Keep only linked Mermaid sources for diagrams. Generated images and HTML are not source.
- Before deleting documentation, map every unique current decision or term to its surviving owner.
