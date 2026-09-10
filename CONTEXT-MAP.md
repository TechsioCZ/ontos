# OntOS context map

This file selects product context; it is not a default reading list. Open only rows whose trigger
materially matches the task. Most tasks need one context, while a cross-domain decision may need
more than one. Stop when the required product meaning is resolved.

| Context                                       | Read when the task concerns                                                                                |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| [OntOS](docs/contexts/ontos/CONTEXT.md)       | Core, modules, identity, shared business semantics, integrations, deployment, or evidence                  |
| [Projects](docs/contexts/projects/CONTEXT.md) | Tasks, collections, properties, views, access, search, sorting, or change history                          |
| [Commerce](docs/contexts/commerce/CONTEXT.md) | B2C/B2B channels, catalog, customers, ordering, payments, fulfillment, storefronts, or commerce operations |
| [Consent + Privacy](docs/contexts/privacy/CONTEXT.md) | personal data, privacy responsibility/applicability, processing purposes, legal basis, notices, Consent, Processing Eligibility, DSR, retention/disposition, Legal Hold, or privacy owner contracts |

Contexts own canonical product semantics and vocabulary, not storage, file layout, transport, or
other implementation mechanics. Accepted durable architecture lives in
[ADRs](docs/adr/README.md); current implementation rules live under [`app/docs/`](app/docs/). Keep
unsettled terms in the relevant GitHub issue until agreed.
