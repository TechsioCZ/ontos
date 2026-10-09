# Availability language

This context names the accepted B13 Availability boundary within Commerce. Shared purchase identity and
context retain their owners in the [Commerce](../commerce/CONTEXT.md) context; stock facts and
Reservation guarantees retain their owners in the [Inventory](../inventory/CONTEXT.md) context.
Detailed delivery scope belongs in GitHub issues; durable architectural trade-offs belong in ADRs.

## Decision language

**Availability** — Domain owning the Current prospective promise for one exact `Catalog Selection`
and exact requested `Quantity + Unit` in one trusted `Commerce Purchasing Context`. Availability
applies Availability-owned promise policy over Current owner evidence without taking ownership of
Catalog identity, Assortment eligibility, Inventory stock truth or Reservation lifecycle, exact
Delivery Destination/carrier/method decisions, or Order acceptance.
_Avoid_: Product/SKU availability, `ON_HAND` as Availability, Assortment `ELIGIBLE` as Availability,
Reservation guarantee as Availability, exact-address deliverability as Availability.

**Availability Decision** — One Availability-owned Current evaluation for one exact Catalog Selection,
requested Quantity + Unit, trusted Commerce Purchasing Context, and stated use boundary. The Decision
has exactly one Availability Decision Outcome and retains the Decision Evidence required to explain
and validate that result.
_Avoid_: boolean `isAvailable`, Product-level status, Search/listing flag as authority, result reused
across different purchase contexts.

**Availability Decision Outcome** — The business result of one Availability Decision:
`AVAILABLE`, `UNAVAILABLE`, or `INDETERMINATE`. Evidence health such as Inventory
`STALE`, `MISSING`, `UNKNOWN`, source unavailability, conflict, or unresolved Reservation
effects is reason/evidence meaning rather than an additional top-level Availability outcome.
_Avoid_: null/false as overloaded outcome, `STALE` as a fourth Availability outcome, source timeout
as authoritative `UNAVAILABLE`.

**AVAILABLE** — Positive Current Availability Decision establishing that the entire exact requested
Quantity + Unit may be promised under the Current Availability policy and owner evidence for the
exact request. It is prospective only: it is not Assortment eligibility, an Inventory Reservation,
Reservation Confirmation, Commitment Protection, exact Delivery Destination guarantee, or Order
acceptance.
_Avoid_: partial quantity silently substituted for the request, `ON_HAND > 0` as sufficient proof,
positive Search projection as purchase authority.

**UNAVAILABLE** — Authoritative Current negative Availability Decision establishing, from sufficiently
complete owner evidence, that the entire exact requested Quantity + Unit cannot be promised under the
Current Availability policy. A known smaller promisable quantity does not change the request in
Launch.
_Avoid_: missing/stale/unknown evidence treated as zero, incomplete Position set treated as a proven
negative, automatic partial offer as the original decision.

**INDETERMINATE** — Availability Decision Outcome meaning the Current business conclusion cannot be
established truthfully from the required owner evidence. It is neither implicit allow nor
authoritative negative.
_Avoid_: fail-open, fail-to-zero, technical tie-break, last-known positive reused as Current.

## Evidence and Currentness

**Availability Decision Evidence** — Owner-qualified evidence supporting one exact Availability
Decision, including the exact evaluated subject/context, safe provenance, material source meanings,
Currentness evidence, and Owner-Verifiable Set Completeness Evidence where presence or absence of
another owner fact can change the result. It preserves owner meanings rather than collapsing them
into one stock number.
_Avoid_: raw provider payload as public business evidence, cache timestamp as Currentness proof,
`ON_HAND - RESERVED` as universal evidence model.

**Availability Current Evaluation** — Authoritative Availability Decision whose material owner facts
and every required Owner-Verifiable Set Completeness Evidence remain valid for the exact requested
use boundary. Final Checkout requires a Current evaluation for the submitted purchase; Order
Commitment may use Availability positively only while owner-verifiable validity covers the required
actual commitment use boundary.
_Avoid_: old Cart/listing result as authority, event silence as Current proof, "checked recently" as
a guarantee.

**Stale Availability Result** — Previously valid Availability Decision whose material evidence no
longer qualifies as Current for the requested use. The historical result may be retained for
explanation, but it is not a Current Availability Decision and is not converted into
`UNAVAILABLE`.
_Avoid_: stale `AVAILABLE` as entitlement, stale positive as zero, history rewritten after later
source change.

**Availability Informational Projection** — Derived, non-authoritative presentation result for
Storefront/listing/Cart use. It may represent a previously evaluated Availability result but never
becomes the System of Record or purchase authority merely by being cached, indexed, or displayed.
_Avoid_: Search hit as Current `AVAILABLE`, Search omission as `UNAVAILABLE`, projection TTL as
business Currentness.

## Authority and Inventory boundary

**Launch Availability Source Authority** — For Launch, stock-dependent Availability evidence is
consumed only through the Inventory public boundary. The selected `Inventory Backend` remains the
actual System of Record for the stock facts it owns; Availability neither bypasses Inventory to query
another External Business System nor switches backends as outage fallback.
_Avoid_: direct-EBS Availability mode in Launch, try-another-ERP fallback, Integration Route as
authority, provider arrival order as authority.

**Availability Position Coverage** — Availability may jointly evaluate several Current usable
`Stock Position` evidence items for the same Stock Item and Unit to establish whether the exact
requested Quantity is coverable. This does not create a `Stock Allocation`, Inventory Reservation,
or routing commitment. A negative quantity conclusion requires owner-verifiable completeness of the
relevant usable Position set.
_Avoid_: double counting across Positions, incomplete Position set as authoritative negative,
Availability-owned Allocation.

**Availability Promise Policy** — Availability-owned business policy translating owner evidence into
the Current prospective promise without changing the owner facts themselves. Launch has no safety
buffer, partial Availability, backorder, preorder, supplier-promise fallback, or optimistic
last-known fallback.
_Avoid_: safety buffer stored as `RESERVED`, Availability rewriting `ON_HAND`, fallback policy
silently changing System of Record.

## Delivery and commitment boundaries

**Availability Delivery Boundary** — Availability may decide its general prospective promise before
an exact Delivery Destination exists. Exact postal/pickup suitability, carrier/method compatibility,
and Fulfillment execution remain downstream owner decisions. A later destination or carrier
non-success does not retroactively rewrite the prior Availability Decision.
_Avoid_: circular Availability ↔ Delivery Destination dependency, carrier selection inside
Availability, shipment execution as Availability.

**Availability Commitment Handoff** — Availability evidence may be retained in the
`Order Acceptance Decision Bundle` when it forms part of the represented prospective purchase
meaning. Availability issues no Launch `Availability Confirmation`. If required fresh validation
discovers changed Availability evidence/meaning already represented in the Bundle, the existing
Attempt is not patched; the governed #331 replacement semantics apply.
_Avoid_: same-Attempt Bundle patch, Availability proof manufactured to mimic Inventory or Assortment
Confirmation, stale Bundle evidence accepted because the outcome token is unchanged.
