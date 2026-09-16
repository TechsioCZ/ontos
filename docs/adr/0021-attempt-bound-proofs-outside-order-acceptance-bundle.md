# Keep attempt-bound proofs outside the Order Acceptance Decision Bundle

Status: Accepted

`Order Acceptance Decision Bundle` is the immutable pre-attempt representation of one exact prospective purchase. One `Order Commitment Attempt` binds to that Bundle hash/version, and any owner proof whose meaning requires that Attempt belongs instead to the attempt-scoped `Order Commitment Proof Set` (for example Approval Revalidation, Assortment Commitment Confirmation, Reservation Confirmation or Payment Authorization). This avoids the recursive `Bundle -> Attempt -> proof -> changed Bundle` identity cycle while allowing legitimate proof renewal for the same unchanged Attempt + Bundle under the owning contract.

## Considered options

- A final Bundle containing Attempt-bound proofs was rejected because the Attempt would need a Bundle identity before those proofs could exist.
- An Attempt not permanently bound to one exact Bundle was rejected because it would weaken idempotency/recovery and allow changed purchase meaning to masquerade as the same retry.

## Consequences

Changed source evidence represented by #330 still creates a new Bundle and follows replacement-attempt/reconciliation rules. Renewal of an Attempt-bound proof alone does not change the Bundle hash; the committed Order preserves the exact Bundle plus the exact Proof Set accepted by the Gate.