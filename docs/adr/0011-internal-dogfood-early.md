# ADR-0011: Internal dogfooding starts early

Status: Superseded planning decision. Property-first sequencing is stale; current architecture
proof work is tracked in [OntOS #176](https://github.com/TechsioCZ/ontos/issues/176) and
[#177](https://github.com/TechsioCZ/ontos/issues/177).

## Context

The system will be used by a customer, but the internal operator also needs an operational slice: clients, projects, tickets, media/documents, and invoices with draft status. This is a low-friction way to validate foundations, but it must not displace the customer-domain dependency root.

## Decision

Current planning assumption: `property.registry` is the likely first customer-domain slice after the foundation skeleton. The `internal.delivery` MicroVertical can start early after those rails are proven, validating ResourceRef linking, media attachment, permissions, audit, invoices with `status = draft`, and tenant-level module activation without distracting from committed customer scope.

## Consequences

The customer-domain backbone is explored first. The team still experiences its own UX and architecture issues early, but dogfooding follows the same rails instead of setting the initial direction.

## Risks

Dogfooding must not distract from committed customer scope. It should remain narrow and foundation-oriented.
