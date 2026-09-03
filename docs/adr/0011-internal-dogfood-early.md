# ADR-0011: Internal dogfooding starts early

Status: Superseded. This record preserves a historical sequencing decision; GitHub issues own
current sequencing.

## Context

The system was expected to serve a customer while the internal operator also needed an operational
slice: clients, projects, tickets, media/documents, and invoices with draft status. This appeared to
offer a low-friction way to validate foundations without displacing the customer-domain dependency
root.

## Decision

At the time of acceptance, planning assumed `property.registry` would be the first customer-domain
slice after the foundation skeleton. The `internal.delivery` MicroVertical could then start early,
using the same rails to validate ResourceRef linking, media attachment, permissions, audit, draft
invoices, and tenant-level module activation.

## Consequences

This sequencing no longer governs current work. The record remains useful as evidence of why early
dogfooding was considered and which foundation behaviors it was expected to exercise. Follow-up
proof work was tracked in [#176](https://github.com/TechsioCZ/ontos/issues/176) and
[#177](https://github.com/TechsioCZ/ontos/issues/177); GitHub owns their current state.

## Risks

Dogfooding could distract from committed customer scope. The historical decision therefore kept it
narrow and foundation-oriented.
