# OntOS context map

This file selects product context; it is not a default reading list. Open only rows whose trigger
materially matches the task. Most tasks need one context, while a cross-domain decision may need
more than one. Stop when the required product meaning is resolved.

| Context                                       | Read when the task concerns                                                                                |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| [OntOS](docs/contexts/ontos/CONTEXT.md)       | Core, modules, identity, shared business semantics, integrations, deployment, or evidence                  |
| [Projects](docs/contexts/projects/CONTEXT.md) | Tasks, collections, properties, views, access, search, sorting, or change history                          |
| [Commerce](docs/contexts/commerce/CONTEXT.md) | B2C/B2B channels, catalog, customers, ordering, payments, fulfillment, storefronts, or commerce operations |
| [Tax](docs/contexts/tax/CONTEXT.md) | Launch Tax coverage, Tax Classification/Rules/Outcomes, Tax Decision/Result, taxable basis, Tax Evidence/currentness/materiality, Tax-Relevant/Evaluation Time, commitment-time Tax Decision/Result, Tax Fact Authority/source assertions, tax rounding, pre-Tax source normalization, or Accepted Tax Terms |
| [Inventory](docs/contexts/inventory/CONTEXT.md) | Catalog-to-Stock Binding, Stock Items, Stock Locations/Positions, Quantity/Unit semantics, Stock Requirements/Allocations, physical stock evidence, Reservations, Commitment Protection, obligations, or Inventory migration |
| [Availability](docs/contexts/availability/CONTEXT.md) | Availability decisions/outcomes, promise policy, stock-evidence interpretation, Currentness, informational projections, delivery boundary, or consumer handoff |
| [Assortment](docs/contexts/assortment/CONTEXT.md) | Assortment purposes/outcomes, selectors, subject targeting, rule lifecycle/resolution, evidence/currentness, administration, migration, or cutover |
| [Consent + Privacy](docs/contexts/privacy/CONTEXT.md) | personal data, privacy responsibility/applicability, processing purposes, legal basis, notices, Consent, Processing Eligibility, DSR, retention/disposition, Legal Hold, or privacy owner contracts |

Contexts own canonical product semantics and vocabulary, not storage, file layout, transport, or
other implementation mechanics. Accepted durable architecture lives in
[ADRs](docs/adr/README.md); current implementation rules live under [`app/docs/`](app/docs/). Keep
unsettled terms in the relevant GitHub issue until agreed.
