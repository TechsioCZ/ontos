# Tax language

This context names the accepted Tax boundary within Commerce. Shared identities and purchase
meanings retain their owners in the [OntOS](../ontos/CONTEXT.md) and
[Commerce](../commerce/CONTEXT.md) contexts.

## Decisions and values

**Tax** — Domain owning Current tax applicability, jurisdiction, rate/exemption, taxable-basis
interpretation, tax amounts and decomposition, and tax rounding. It supplies tax inputs to Accepted
Order and Billing Documents Snapshots without owning Pricing, shared Party identity, the Accepted
Order, or Billing Document lifecycle.
_Avoid_: Pricing-owned tax calculation, Core tax policy, Tax as invoice owner.

**Tax Decision** — Tax-owned Current determination of tax applicability, jurisdiction, rate or
exemption, and taxable-basis interpretation for exact inputs in a trusted Commerce Purchasing
Context at the trusted operation time. It is distinct from an Official Identifier, a retained
previous evaluation, or a Pricing Decision.
_Avoid_: VAT identifier as tax decision, B2B Channel as tax treatment, Pricing Quotation as tax guarantee.

**Tax Result** — Tax-owned tax amounts and their decomposition for the exact inputs and
interpretation used by a Tax Decision. Its Pricing inputs are the authoritative published rounded
Line Commercial Values and required breakdown/evidence, not an alternative reconstruction of the
Pricing total.
_Avoid_: Pricing Result including tax, tax revision alone as monetary result, frontend-computed tax.

**Taxable Basis** — Monetary basis to which an applicable tax calculation relates, determined by
Tax from authoritative owner-issued commercial amounts and the relevant breakdown. It is not a
second Pricing total or authority to change already published Line Commercial Values.
_Avoid_: Pricing total automatically treated as a universal taxable basis, duplicate Fee addition.

**Tax Evidence** — Owner-qualified evidence supporting a stated tax determination for exact inputs
and an explicit use. Evidence about an Invoice Recipient is not by itself the Tax Result for a
purchase, and retaining evidence does not by itself prove Current validity.
_Avoid_: recipient validation as complete purchase tax, a timestamp or revision label as owner proof.

## Monetary boundaries

**Tax Rounding** — Tax-owned rounding meaning for tax amounts, separate from Pricing's final line
rounding and Pricing Line Rounding Adjustment. It does not replace published Pricing line amounts
or reconstruct an alternative Pricing total from high-precision intermediates.
_Avoid_: reusing Pricing rounding as an implicit Tax policy, frontend balancing pennies.

**Pre-Tax Source Normalization** — Authoritative normalization of a tax-inclusive source assertion
into canonical pre-Tax commercial input, preserving its original tax meaning and normalization
evidence. It belongs to the source/Integration Route boundary rather than Pricing's calculation of
a purchase.
_Avoid_: Pricing guessing a tax rate, reverse-calculating net inside Pricing, tax-inclusive canonical
Price mode.

## Accepted history

**Accepted Tax Terms** — Tax values and safe source evidence definitively used in an Accepted Order
or Billing Document and retained in its Snapshot. These historical values are not a fresh Tax
Decision and are not silently rewritten by changes to Current rules or source facts.
_Avoid_: recomputing historical tax from today's rules, treating a prospective Tax Result as Accepted.
