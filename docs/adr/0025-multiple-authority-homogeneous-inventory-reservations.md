---
status: accepted
---

# One Order Commitment Attempt may use multiple authority-homogeneous Inventory Reservations

For Launch, one exact Order Commitment Attempt may require one or more Inventory Reservations. Each Inventory Reservation is homogeneous to exactly one actual Reservation Authority and contains only Stock Allocations that authority can enforce. The Attempt has complete Inventory reservation coverage only when the set of Reservations collectively covers every Stock Requirement in the exact requested Quantity + Unit; one Stock Requirement may be split across multiple Reservations when its Allocations span different Reservation Authorities.

Immediately before Order commitment, every member Reservation required by the Attempt must have its own owner-issued Commitment Protection. Proven Order commit converts each member Reservation into its corresponding `COMMITTED_OBLIGATION`; proven non-commit plus definitive Attempt closure allows each provisional Reservation to be safely released, with unresolved individual owner effects remaining explicit reconciliation debt.

## Considered Options

- Allow 1..N authority-homogeneous Reservations per Attempt, including splitting one Requirement across authorities — accepted because Stock Allocation may already span multiple Positions/Locations and each real authority must remain the issuer of only the Quantity it can enforce.
- Allow multiple Reservations but require each Stock Requirement to stay under one Reservation Authority — rejected because it would add an authority-based allocation constraint not otherwise present in the confirmed multi-Position model.
- Require one Reservation and one Reservation Authority per Attempt — rejected because it would make otherwise valid multi-authority stock coverage impossible or require Inventory to fabricate a cross-owner authority.

## Consequences

There is no synthetic cross-authority Reservation Confirmation, Commitment Protection, or FIFO order. Each Reservation keeps its real issuer and proof lifecycle. Order Commitment Gate later composes the complete set of Inventory proofs for the Attempt without becoming their owner.
