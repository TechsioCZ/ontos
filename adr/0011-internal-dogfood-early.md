# ADR-0011: Internal dogfooding starts early

Status: Proposed

## Context

The system will be used by a customer, but the internal operator also needs an operational slice: clients, projects, tickets, documents, and invoice drafts. This is a low-friction way to validate foundations before customer workflows carry all the risk.

## Decision

The `internal.delivery` MicroVertical should be one of the first implemented slices after the PoC. It should validate entity linking, document attachment, permissions, audit, invoice drafts, and module activation.

## Consequences

The team experiences its own UX and architecture issues early. Dogfooding generates real feedback without waiting for customer data.

## Risks

Dogfooding must not distract from committed customer scope. It should remain narrow and foundation-oriented.
