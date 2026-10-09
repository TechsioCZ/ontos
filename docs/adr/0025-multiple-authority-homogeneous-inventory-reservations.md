---
status: superseded
superseded_by: ADR-0026
---

# One Order Commitment Attempt may use multiple authority-homogeneous Inventory Reservations

This ADR is retained as discovery history and is **not Current Launch design**.

It was superseded after the product-owner decision that one Customer Configuration / Launch Inventory operating scope uses exactly one configured Inventory Backend: either a customer-provided External Business System (for example an ERP such as ABRA) or the OntOS-provided WMS. Simultaneous authoritative use of both is not supported.

The multi-authority problem that motivated this ADR therefore does not exist in the supported Launch model. Current behavior is defined by ADR-0026.

## Historical decision

The former decision allowed one Order Commitment Attempt to use multiple authority-homogeneous Inventory Reservations when Stock Allocations spanned different Reservation Authorities. That model is superseded and must not be used as implementation guidance.

## Superseding consequence

Current Launch uses:

- one configured Inventory Backend for the applicable Customer Configuration / Inventory operating scope;
- one actual Reservation Authority provided by that selected backend;
- one Inventory Reservation per exact Order Commitment Attempt;
- 1..N Stock Allocations inside that Reservation across supported Stock Positions/Locations of the same selected backend;
- one Reservation Confirmation and one Commitment Protection for that Reservation;
- one corresponding `COMMITTED_OBLIGATION` after proven Order commit.

Changing from one backend to another is a migration/cutover operation, not a normal runtime dual-authority mode.
