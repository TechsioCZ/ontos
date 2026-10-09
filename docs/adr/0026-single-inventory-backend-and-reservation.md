---
status: accepted
---

# One configured Inventory Backend and one Inventory Reservation per Order Commitment Attempt

This decision supersedes ADR-0025 for the Launch Inventory authority and Reservation-cardinality model.

For Launch, the whole Customer Configuration selects exactly one **Inventory Backend** for stock and Reservation enforcement.

The selected backend is exactly one of:

- a customer-provided External Business System, accessed through its supported API / Integration Route; or
- the OntOS-provided WMS.

The two modes are alternatives. Backend selection is not split by Stock Location, Channel, Selling Legal Entity, or Order Commitment Attempt, and a Launch deployment never composes both as simultaneous authoritative stock/reservation backends.

Inventory remains the public OntOS boundary and preserves provider-neutral Stock Item, Stock Position, Stock Requirement, Stock Allocation, Reservation, evidence and recovery semantics. The selected Inventory Backend remains the actual System of Record for the stock facts it owns and the actual Reservation Authority for the supported Reservation lifecycle.

## Reservation cardinality and proof identity

One exact Order Commitment Attempt has exactly one normal-runtime Inventory Reservation.

That Reservation may contain 1..N Stock Allocations across supported Stock Positions/Locations, but every Allocation is enforced through the same selected Inventory Backend / Reservation Authority. One Stock Requirement may still be split across several Stock Positions as long as Stock Item and Unit remain unchanged.

The Reservation is successful only when it covers every required Stock Requirement in the exact requested Quantity + Unit. A failed or indeterminate create may leave real backend effects that require recovery, but it does not create a second or partial-valid Reservation.

One successful Reservation/Attempt has one Reservation Confirmation identity and one Commitment Protection identity. Launch Inventory Confirmation is bounded and is not renewed, extended, reissued, or replaced by a successor Confirmation after pre-Protection expiry or definitive revocation.

Immediately before Order commitment, the selected Reservation Authority must authoritatively establish the Attempt-bound Commitment Protection while the Confirmation is valid. Actual establishment time/evidence is decisive: recovery may later prove that the original Protection effect was established in time, but expiry cannot be used to establish a new Protection.

Proven Order commit continues the same underlying Reservation stock-obligation identity as one corresponding `COMMITTED_OBLIGATION`; it does not create a second parallel obligation. Proven non-commit plus definitive Attempt closure permits safe whole-Reservation release.

## External-backend rule

If a customer keeps its own External Business System, OntOS talks to that system directly through the supported owner contract/API. The OntOS-provided WMS is neither an intermediary nor an automatic fallback.

If the selected external backend cannot provide the Reservation guarantee required by the standard Launch purchase contract, that Customer Configuration cannot report successful guaranteed Reservation through another implicit backend or local synthetic hold.

## Cutover rule

Changing the selected Inventory Backend is an explicit migration/cutover decision, not ordinary runtime composition or outage recovery.

The cutover boundary applies atomically to the whole Customer Configuration. Before the boundary, only the pre-cutover backend is selected; from the boundary onward, only the post-cutover backend is selected. Migration tooling may read, copy, or verify data in both systems, but that does not create two runtime stock/reservation authorities.

Every pre-cutover provisional Reservation and any known or possible unresolved pre-cutover create/effect debt that could still constrain stock must be authoritatively resolved before the switch. An unresolved effect blocks the whole Customer Configuration backend switch; Launch does not cut over only unaffected Stock Locations.

Pre-cutover provisional Reservations never rebind to the replacement backend and the old backend does not remain Reservation Authority after the switch. Proven committed obligations may continue through migration/reconstruction only with preserved origin and source lineage. External identifier/correlation evidence also preserves its actual issuer/backend origin across the boundary: the same namespace/kind/text identifier under the pre-cutover and post-cutover backends is not one external key, and delayed pre-cutover evidence is never re-qualified through the replacement backend. Late pre-cutover data or effects remain migration/Reconciliation evidence or debt and cannot establish post-cutover Current truth merely because they arrive later.

## Considered options

- Select exactly one Inventory Backend for the whole Customer Configuration and use one Reservation per Attempt — **accepted** because this matches the supported product modes and keeps one enforceable owner for each Launch stock/reservation lifecycle.
- Compose an External Business System for physical stock with a different WMS/Inventory authority for Reservations in one Launch deployment — rejected because this creates unsupported dual authority.
- Allow one Attempt to span multiple Reservation Authorities — rejected because the supported Launch model has one selected backend and one Reservation per Attempt.
- Automatically fall back from an unavailable external backend to the OntOS-provided WMS — rejected because changing backend authority is an explicit migration/configuration decision, not outage recovery.
- Renew or replace an expired Inventory Reservation Confirmation inside the same Attempt — rejected for Launch because expiry before Protection terminates Inventory readiness for that Attempt; a later purchase retry uses a new Attempt only after safe predecessor resolution.

## Consequences

There is no active `Attempt Reservation Coverage` aggregate, member-Reservation partition, cross-authority Confirmation, cross-authority Commitment Protection, cross-authority shortage-priority problem, or supported per-Location backend split in Launch.

Provider-specific mechanics remain private. Inventory contracts continue to distinguish Current evidence, Reservation proof health, actual Commitment Protection establishment, idempotent effect recovery, safe Release, continuing committed obligation identity, Source Coverage Evidence, and migration provenance.
