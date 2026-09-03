# OntOS context map

This file selects domain language; it is not a glossary. Start with one context. When that context
references a shared OntOS term that remains unclear, consult only the relevant section of the OntOS
context rather than loading both documents in full.

| Context                                       | Read when the task concerns                                                                                                      |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| [OntOS](docs/contexts/ontos/CONTEXT.md)       | Core, Shell, module contracts, Party or Principal identity, authorization, integrations, deployment, or evidence                 |
| [Projects](docs/contexts/projects/CONTEXT.md) | Tasks, collections, properties, views, access, search, sorting, or change history                                                |
| [Commerce](docs/contexts/commerce/CONTEXT.md) | Channels, storefronts, catalog, assortment, pricing, carts, orders, payments, fulfillment, or Commerce customer purchasing roles |

Contexts define canonical vocabulary and stable semantic distinctions. They do not define
implementation mechanics, delivery state, schedules, or exceptions to accepted decisions. Accepted
decisions live in [ADRs](docs/adr/README.md); current implementation rules live under
[`app/docs/`](app/docs/); delivery work lives in GitHub issues. Keep unsettled language in the
relevant issue until agreed.
