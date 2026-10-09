---
status: accepted
---

# Launch Order Tax is fixed at one Order Commitment Time

For Launch e-shop ordering, final Checkout submission freezes one exact purchase candidate and captures one trusted server-side `Order Commitment Time`. TAX performs one complete authoritative evaluation for that exact purchase/time, and the resulting `Tax Decision` + `Tax Result` are immutable pre-attempt content of the `Order Acceptance Decision Bundle`; the same Bundle is not Tax-recomputed during Order Commitment or retry.

This deliberately rejects a Tax-specific TTL, expiring/renewable commitment confirmation, repeated final Tax revalidation, and cross-owner Tax fencing. Those mechanisms solve a different class of problem. Owners such as Inventory, Payment or Assortment may still require attempt-bound reservation/authorization/confirmation proofs under their own contracts.

A customer/operator edit or later final submission is a new purchase candidate with a new Order Commitment Time, new final Tax determination, new Bundle and new commitment. If final Tax differs materially from an earlier approved prospective Tax meaning, Approval Revalidation decides the required reapproval path before the final Bundle is created.
