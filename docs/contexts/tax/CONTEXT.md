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

**Launch Tax Coverage** — Closed-world activated Tax capability for ordinary domestic Czech taxable
B2C/B2B purchases in CZK with a Current Czech VAT-registered Selling Legal Entity and explicit
supported domestic Tax Classifications/Tax Rules. OSS, reverse charge, export, foreign VAT regimes,
generic exemption/special-treatment flows, additional selling currencies, and generic multi-supply
Set monetary decomposition are not activated by Launch.
_Avoid_: legacy feature breadth as Launch scope, implicit domestic fallback, future regime enabled by data presence.

**Tax Decision** — Tax-owned Current purchase-scoped determination of tax applicability,
jurisdiction, treatment, rate or exemption, and taxable-basis interpretation for exact inputs and one
exact Tax-Relevant Time; Currentness of its material inputs is evaluated at Tax Evaluation Time. One
successful purchase Tax Decision preserves the exact set of Taxable Supply Units and their unit-specific
Tax meanings; equal values or rates never merge their identities. It is distinct from an Official
Identifier, a retained previous evaluation, a Pricing Decision, or a commitment-validity proof.
_Avoid_: VAT identifier as tax decision, B2B Channel as tax treatment, Pricing Quotation as tax guarantee,
rate-only decision without exact subject/context, one independent Tax Decision per UI/Pricing line by default.

**Tax Result** — Tax-owned purchase-scoped tax amounts and decomposition for the exact inputs and
interpretation used by one successful Tax Decision. It preserves one authoritative published Tax
amount per exact Taxable Supply Unit under Tax Rounding and one purchase Tax total equal to the exact
sum of those published unit amounts; it does not perform a second purchase-level rounding. Its
Pricing inputs are the authoritative published rounded Line Commercial Values and required
breakdown/evidence, not an alternative reconstruction of the Pricing total. A non-success Tax outcome
does not fabricate a Tax Result.
_Avoid_: Pricing Result including tax, rate-bucket identity replacing Taxable Supply Units,
purchase-level re-rounding, tax revision alone as monetary result, frontend-computed tax.

**Tax Outcome** — Business result of one Tax evaluation: either a successful Tax Decision with its
Tax Result, or one explicit non-success meaning. Launch non-success meanings include unsupported case,
unmet prerequisite, missing/overlapping/conflicting rule state, stale input, unavailable dependency,
and indeterminate authoritative state; none is represented as successful zero.
_Avoid_: generic ERROR, provider-specific timeout as public Tax meaning, null/zero as failure.

**Taxable Basis** — Monetary basis to which an applicable tax calculation relates, determined by
Tax from authoritative owner-issued commercial amounts and the relevant breakdown. It is not a
second Pricing total or authority to change already published Line Commercial Values.
_Avoid_: Pricing total automatically treated as a universal taxable basis, duplicate Fee addition.

**Tax Evidence** — Owner-qualified evidence supporting a stated tax determination for exact inputs
and an explicit use. Evidence about an Invoice Recipient is not by itself the Tax Result for a
purchase, and retaining evidence does not by itself prove Current validity.
_Avoid_: recipient validation as complete purchase tax, a timestamp or revision label as owner proof.

**Tax Classification** — Tax-owned interpretation of one exact Catalog Selection for a declared Tax
use, derived from the minimum complete set of authoritative Catalog evidence that can change that Tax
meaning. It is not a manually maintained Product/SKU tax flag and does not transfer Catalog ownership
into Tax.
_Avoid_: Product-level VAT field as universal classification, SKU/display name as Tax authority,
generic staff CRUD over Tax Classification.

**Tax Rule** — Tax-owned stable business rule identity whose immutable revisions carry the explicit
Tax treatment/rate or other governing meaning for an Effective Period. Applicable revision is chosen
from complete authoritative rule state and Tax-Relevant Time; historical revisions remain
addressable and are never overwritten by later Current meaning.
_Avoid_: mutable currentRate, newest/first row as rule selection, in-place correction of a historical
revision.

**Tax Fact Authority Contract** — Tax-owned governance fact declaring, for one exact Tax fact family
and explicit scope/use, which System of Record may decide the fact and which sources may provide
supporting evidence. It governs authority/evidence roles; it does not itself set the source fact's
business value and is distinct from an Integration Route or provider credential.
_Avoid_: ERP/VIES/ARES as global Tax authority, authority inferred from transport route, manual
override of a source-owned fact through the authority contract.

**Tax Source Assertion** — One immutable source statement about one exact Tax fact subject, scope and
business-validity meaning, retained with provenance independently from the external source record and
from the canonical Tax business fact it may support.
_Avoid_: provider payload as canonical Tax profile, arrival order as Currentness, source record ID as Tax fact identity.

**Selling Legal Entity VAT Registration** — Tax-relevant business fact that one exact Selling Legal
Entity is VAT-registered for one jurisdiction and business-valid period under its declared System of
Record. It is distinct from the Selling Legal Entity identity and from Official Identifiers such as DIČ.
_Avoid_: DIČ as registration proof, Legal Entity existence as VAT-registration state.

**Tax-Relevant Time** — Tax-owned business time used to select the legally/business-relevant Tax Rule
meaning for an exact Tax Decision. For the supported Launch Order use, Accepted Tax Terms are bound to
the actual Order acceptance instant, but that product boundary is not automatically the statutory
DUZP or another VAT tax point. Trusted operation/evaluation time remains a separate Currentness
meaning.
_Avoid_: client clock as Tax-Relevant Time, Pricing Quotation time as VAT tax point, treating Order
acceptance as statutory DUZP by definition.

**Tax Evaluation Time** — Trusted operation time at which one Tax evaluation resolves Current material
facts and evidence. It is provenance/currentness time, not the business instant that selects the
applicable Tax Rule.
_Avoid_: Tax Evaluation Time as Tax-Relevant Time, client/request timestamp as authority.

**Tax Fact Currentness Evidence** — Owner-qualified Tax Evidence proving that one exact material Tax
fact is usable as Current at a stated Tax Evaluation Time under its owner contract. A retained
assertion, latest timestamp, cache freshness, or event silence is not this evidence by itself.
_Avoid_: latest row as Currentness proof, retained positive assertion as perpetual Current fact.

**Tax Materiality** — Tax-owned determination of whether a change can alter the exact Tax business
meaning for a declared purchase/use. Matching amount, rate, IDs or hashes do not prove equivalence;
preserved meaning is non-material only when TAX can support that conclusion with owner-qualified evidence.
_Avoid_: consumer-inferred Tax equivalence, same total as non-materiality proof, every context field as Tax-material.

**Taxable Supply Unit** — Tax-owned legal/business interpretation of one exact taxable-supply meaning
inside a supported purchase. It is traceable to the relevant Purchase Demand Occurrence(s), Catalog
evidence and owner-issued monetary inputs, but it is not identical by definition to a Pricing Line,
Cart line, Order line or Catalog component. For Launch, an ordinary non-Set occurrence maps to one
Taxable Supply Unit; a supported whole-treatment Set maps to one unit; cases requiring generic
multi-supply Set monetary decomposition remain unsupported.
_Avoid_: Pricing Line as statutory supply identity, rate bucket as canonical Tax identity, merging
equal occurrences, invented component prices.

**Tax Commitment Confirmation** — Tax-owned immutable attempt-bound guarantee that the material Tax
business meaning of one exact prospective Tax Decision/Tax Result remains equivalent for one exact
Order Commitment Attempt and unchanged Order Acceptance Decision Bundle throughout a declared bounded
validity interval. It belongs to the Order Commitment Proof Set rather than the Bundle; the prospective
Decision's Tax-Relevant Time does not become the later Order acceptance instant merely because the
Confirmation remains valid.
_Avoid_: retained Tax Result as commitment proof, Confirmation inside Bundle hash, Pricing 30-second
TTL as implicit Tax law or Tax policy, treating confirmation validity as identity of two different
Tax-Relevant Times.

## Monetary boundaries

**Tax Rounding** — Tax-owned rounding meaning for tax amounts, separate from Pricing's final line
rounding and Pricing Line Rounding Adjustment. For Launch CZ, TAX calculates the exact tax contribution
for each Taxable Supply Unit, then publishes that unit's Tax amount at `0.01 CZK` using
`ROUND_HALF_UP`; the purchase Tax total is the exact sum of those published unit Tax amounts and is
not rounded again. The exact pre-round contribution and resulting rounding difference remain
explainable as Tax Evidence. This Launch policy is an OntOS product decision, not a claim that Czech
VAT law universally mandates `ROUND_HALF_UP per line`.
_Legal_: [ZDPH § 36](https://www.zakonyprolidi.cz/cs/2004-235#p36),
[§ 37](https://www.zakonyprolidi.cz/cs/2004-235#p37), and
[Finanční správa — Výpočet DPH a zaokrouhlování od 1. 10. 2019](https://financnisprava.gov.cz/cs/financni-sprava/novinky/novinky-2019/vypocet-dph-a-zaokrouhlovani-od-1-10-2019).
_Avoid_: reusing Pricing rounding as an implicit Tax policy, rate-group or purchase-level re-rounding,
frontend balancing pennies, assigning an arbitrary balancing haler to another Taxable Supply Unit.

**Pre-Tax Source Normalization** — Authoritative normalization of a tax-inclusive source assertion
into canonical pre-Tax commercial input, preserving its original tax meaning and normalization
evidence. It belongs to the source/Integration Route boundary rather than Pricing's calculation of
a purchase.
_Avoid_: Pricing guessing a tax rate, reverse-calculating net inside Pricing, tax-inclusive canonical
Price mode.

## Accepted history

**Accepted Tax Terms** — Immutable accepted-time Tax meaning for one exact historical handoff,
including exact Taxable Supply Unit mapping, the actual handoff Tax-Relevant Time, Tax Rounding
policy/revision, amounts, and safe source/rule evidence. For an Accepted Order they preserve lineage
to the prospective Tax Decision/Tax Result and exact Tax Commitment Confirmation that proved equivalent
Tax business meaning through the actual Order acceptance instant; they do not pretend that an earlier
prospective Decision used the later acceptance instant. They are historical lineage for later Billing
or correction work, not a universal substitute for a later event's own legally relevant Tax
determination; each owner retains its own immutable Snapshot and Current rules never rewrite history.
_Legal_: for later supply timing see [ZDPH § 20a](https://www.zakonyprolidi.cz/cs/2004-235#p20a),
[§ 21](https://www.zakonyprolidi.cz/cs/2004-235#p21), and rate timing in
[§ 47 odst. 2](https://www.zakonyprolidi.cz/cs/2004-235#p47); for supported corrections see
[§ 42](https://www.zakonyprolidi.cz/cs/2004-235#p42) and
[§ 45](https://www.zakonyprolidi.cz/cs/2004-235#p45).
_Avoid_: recomputing historical tax from today's rules, treating a prospective Tax Result as Accepted,
blindly copying Accepted Order Tax Terms into a later Billing/supply event with its own Tax-relevant
facts, sharing one mutable Order/Billing Tax snapshot.


## Czech legal reference index — Launch

These references map OntOS Tax terms to the current Czech VAT-law concepts they rely on. They do not
turn OntOS product terms into statutory terminology, and they do not transfer ownership between
domains.

- **Taxable Supply Unit** — OntOS term mapped to the statutory concept of a `zdanitelné plnění`:
  [ZDPH § 2 odst. 2](https://www.zakonyprolidi.cz/cs/2004-235#p2), with supply meanings further
  defined for goods/services in [§ 13](https://www.zakonyprolidi.cz/cs/2004-235#p13) and
  [§ 14](https://www.zakonyprolidi.cz/cs/2004-235#p14). Basis/calculation/rate consequences are
  governed by [§ 36](https://www.zakonyprolidi.cz/cs/2004-235#p36),
  [§ 37](https://www.zakonyprolidi.cz/cs/2004-235#p37) and
  [§ 47](https://www.zakonyprolidi.cz/cs/2004-235#p47).
- **Taxable Basis** — statutory anchor:
  [ZDPH § 36](https://www.zakonyprolidi.cz/cs/2004-235#p36).
- **Tax Result** — monetary calculation anchor:
  [ZDPH § 37](https://www.zakonyprolidi.cz/cs/2004-235#p37); applicable rate meaning:
  [§ 47](https://www.zakonyprolidi.cz/cs/2004-235#p47).
- **Tax-Relevant Time** — OntOS product term. Statutory VAT timing remains a separate legal meaning;
  see [ZDPH § 21](https://www.zakonyprolidi.cz/cs/2004-235#p21) and rate timing in
  [§ 47 odst. 2](https://www.zakonyprolidi.cz/cs/2004-235#p47). Order acceptance is not declared by
  OntOS to be statutory DUZP merely because it is the Launch order-side Tax-Relevant Time.
- **Tax Rounding** — statutory calculation/basis anchors:
  [ZDPH § 36](https://www.zakonyprolidi.cz/cs/2004-235#p36) and
  [§ 37](https://www.zakonyprolidi.cz/cs/2004-235#p37). Supporting administrative guidance:
  [Finanční správa — Výpočet DPH a zaokrouhlování od 1. 10. 2019](https://financnisprava.gov.cz/cs/financni-sprava/novinky/novinky-2019/vypocet-dph-a-zaokrouhlovani-od-1-10-2019).
- **Accepted Tax Terms** — OntOS historical meaning, not a statutory snapshot object. Accepted Order
  Tax Terms do not by themselves establish a later Billing/supply event's statutory timing; see
  [ZDPH § 20a](https://www.zakonyprolidi.cz/cs/2004-235#p20a),
  [§ 21](https://www.zakonyprolidi.cz/cs/2004-235#p21) and
  [§ 47 odst. 2](https://www.zakonyprolidi.cz/cs/2004-235#p47).
  Supported correction lineage is anchored by
  [§ 42](https://www.zakonyprolidi.cz/cs/2004-235#p42) and corrective-document data by
  [§ 45](https://www.zakonyprolidi.cz/cs/2004-235#p45).
- **Tax Decision**, **Tax Evidence** and **Tax Commitment Confirmation** are OntOS domain terms without
  a one-to-one statutory synonym. Their statutory substance is explained by the referenced
  applicability, supply, basis, calculation, rate and timing provisions above.
