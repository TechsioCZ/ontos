# ADR-0011: Internal dogfooding starts early

Status: Historical planning record. Current delivery sequencing belongs in GitHub issues; this ADR
does not select the next product slice or define current architecture.

## Historical context

The system was expected to serve a customer while the internal operator also needed a narrow
operational slice: clients, projects, tickets, media/documents, and draft invoices. The proposal
used dogfooding to validate foundations without displacing customer-domain work.

## Historical decision

At the time of this decision, `property.registry` was expected to be the first customer-domain
slice after the foundation skeleton. `internal.delivery` could follow early to validate
ResourceRef linking, media attachment, permissions, audit, draft invoices, and tenant module
activation on the same rails.

## Historical consequences

Customer-domain work was intended to prove the backbone first, with internal dogfooding following
closely enough to expose usability and architecture problems.

## Historical risk

Dogfooding could distract from committed customer scope and therefore had to stay narrow and
foundation-oriented.
