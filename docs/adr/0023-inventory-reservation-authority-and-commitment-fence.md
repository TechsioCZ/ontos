# Inventory reservation authority and commitment fence

Status: Accepted

Inventory is the public OntOS boundary for Reservation capability, while the actual `Reservation Authority` remains the owner that can enforce the exact hold and therefore remains the issuer of authoritative Reservation evidence. Immediately before Order commitment, that owner establishes an exact Reservation + Order Commitment Attempt-bound `Commitment Protection`; once established, the protected Quantity stays fenced from incompatible competing use until authoritative Order truth proves commit or proves non-commit plus closure. Physical impairment may make the protected obligation `AT_RISK`, but does not release the fence while Order truth is unresolved.

## Considered options

- A final Reservation validity read was rejected because it leaves a time-of-check/time-of-use race before the independent Order transaction commits.
- A shared Inventory/Order transaction was rejected because it violates the independently owned MicroVertical transaction boundary.
- An Attempt-bound owner fence was accepted because it preserves independent owners while making unknown Order outcome safe and reconcilable.

## Consequences

Provider-specific lock, lease, token, or hold mechanics remain private behind Inventory and must satisfy the same uninterrupted business guarantee. Reservation Confirmation remains historical/provisional proof with its own validity; Commitment Protection is a separate Attempt-bound proof in the Order Commitment Proof Set. Proven commit converges the same Inventory obligation to `COMMITTED_OBLIGATION`; proven non-commit plus closure permits safe compensation; unknown keeps the fence.