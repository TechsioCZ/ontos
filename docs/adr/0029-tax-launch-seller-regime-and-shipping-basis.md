---
status: accepted
---

# TAX Launch seller regime and shipping basis

Accepted by the PO on 2026-10-11.

The PO settled #907-Q01 through #907-Q13 after DEV review, recorded in
[the PO decision register](https://github.com/TechsioCZ/ontos/issues/907#issuecomment-6112360638).
This record keeps the durable decisions; the register and its 51 linked local patch comments keep
the per-issue detail.

- **Q01/Q12 — TAX-owned regime, Core-owned identity.** TAX owns the Seller VAT Regime Declaration
  (merchant-declared, append-only, import included); Core owns Selling Legal Entity identity,
  including DIČ, registered seat and registry data. TAX never verifies a declaration against
  VIES/ARES.
- **Q02 — non-payer.** A declared `NON_PAYER` seller yields a successful `SELLER_NOT_VAT_PAYER` Tax
  Decision with `0.00 CZK` tax, never an implicit `0%` rate or an error. No Shipping VAT allocation
  occurs for a non-payer, whatever the Shipping amount basis; a `0 CZK` tax outcome does not forbid
  a later commercial Shipping refund.
- **Q03 — not declared is indeterminate.** With no direct or imported declaration covering the
  Tax-Relevant Time, the outcome is `TAX_STATE_INDETERMINATE`, never a DIČ-, history- or
  absence-based fallback.
- **Q04 — deleted external-evidence model.** The superseded seller authority-contract/assertion/
  conflict machinery (developed in #1182/#1184) was removed from the unmerged TAX stack in #1198 and
  replaced by Seller VAT Regime Declarations. #957–#959 are closed `Not planned` as an explicit
  HITL-approved metadata cleanup — superseded, not DONE/merged — and the removed model is not
  reimplemented for declaration or import.
- **Q05–Q07 — Pricing stays NET; Shipping may be NET or GROSS.** Pricing publishes Line Commercial
  Values canonically NET/pre-Tax; TAX derives only the allocation weight from them and never creates
  a second Pricing total. The owner-issued Shipping charge carries its own explicit amount basis —
  NET or GROSS — and NET Shipping is a required Launch case, including for VAT payers:
  `amountBasis=NET` alone is never `TAX_CASE_UNSUPPORTED`. The Shipping charge is split across the
  affected whole lines by their gross-equivalent value (a GROSS line weighs its amount; a NET line
  weighs `amount × (1 + rate)`), with exact shares that conserve the owner-issued charge in its own
  source basis — its control total. One Pricing Result never mixes NET and GROSS *line* bases
  (`TAX_STATE_INDETERMINATE`); that rule does not forbid NET lines with a separate GROSS Shipping
  charge, or NET Shipping under Q07. The exact shares feed one HALF_UP rounding per Taxable Supply
  Unit, with totals computed as sums of those rounded amounts; a correction converts a shipping
  value change in the component's recorded Shipping amount basis, never double-taxing the payable;
  the reference for that basis is the customer-charged Shipping price, not carrier cost.
- **Q08–Q09 — import.** OntOS imports an existing seller-declared VAT regime from the source system
  through a new governed Action; no merchant re-confirmation and no external verification. Known
  effective dates, history and scheduled changes are preserved; a current-only source state with no
  date becomes effective at the migration run's stable instant (`migrationStartedAt`), never a
  fabricated earlier history. A `MIGRATED` declaration covering the Tax-Relevant Time satisfies the
  declared-regime activation condition exactly like a direct declaration; provenance is never a
  blocker. Manual entry is reserved for a seller with no usable source declaration; any later change
  to an imported regime goes through the normal `declare-seller-vat-regime` Action under CAS, never a
  re-import; a retried migration run does not shift `migrationStartedAt`.
- **Q10 — DIČ at activation.** Activation requires a DIČ for a payer seller, including one already
  scheduled to become a payer after activation. Core owns that identity in the Selling Legal Entity
  contract (Q01/Q12); Billing only holds the immutable snapshot of the DIČ it actually uses. TAX
  never derives the regime from DIČ — this is a chosen product activation policy, not an inferred
  legal timing requirement.
- **Q11 — legal items stay open.** No named legal coordinator, new authority or approval role is
  introduced. Once the tax adviser answers, whoever already holds the needed permission records the
  answer against the architecture and opens the specific patch issues it requires. The activation
  assessor keeps `evidenceLabel: 'NON_PRODUCTION'` and `activationClaim: 'NONE'`; owner-ready is
  never presented as production-activated or as full Commerce E2E.
- **Q13 — approved, not created.** The follow-ups listed in the register (Core identity, Billing
  documents, Order return authorization, Catalog Tax-purpose, the legal branch, later standalone tax
  events) are approved directions; none is created as a new issue, and downstream Order/Billing/
  Checkout work stays gated per roadmap #253.

## Consequences

- `shared/domain/tax-activation-contracts.ts` and `src/domain/tax-activation-readiness.ts` rename
  `B2C_GROSS_AMOUNT_BASIS_CONTRACT` to `PRICING_DELIVERY_AMOUNT_BASIS_CONTRACT` and drop
  `D3_CONTRACT_TEXTS_RECONCILED`, because the PO reconciled #931/#933/#935 directly in this decision.
- `docs/contexts/tax/CONTEXT.md` drops the "Launch B2C owners publish GROSS" and "Shipping charge is
  GROSS-only" language and gains `Migrated declaration`, `Migration start` and `Shipping amount
  basis` terms.
- The Q07 NET-shipping code path and the Q08 import Action are separate, already-scoped
  implementation lanes; this record does not by itself complete either.
