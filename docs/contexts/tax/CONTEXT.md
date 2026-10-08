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
supported domestic Tax Classifications/Tax Rules, including mixed-rate purchases with one shared
ancillary Shipping amount. OSS, reverse charge, export, foreign VAT regimes, generic
exemption/special-treatment flows, additional selling currencies, and generic multi-supply Set
monetary decomposition are not activated by Launch. TAX owner activation-ready is not full Commerce
production readiness.
_Avoid_: legacy feature breadth as Launch scope, implicit domestic fallback, future regime enabled
by data presence.

**Tax Decision** — Tax-owned purchase-scoped determination of tax applicability, Tax Jurisdiction,
Tax Treatment, rate or exemption, and taxable-basis interpretation for exact inputs and one exact
Tax-Relevant Time, preserving the exact Taxable Supply Units and their unit-specific meanings. A
prospective (preview) evaluation carries its own Tax-Relevant Time and is Current only under its
Currentness contract. For Launch final Order commitment, TAX establishes one immutable, recoverable
final Tax Decision for the exact frozen purchase candidate (Commerce-owned submission/candidate
identity) and its Commerce-owned Order Commitment Time. An evaluation candidate whose material
evidence was invalidated before finalization cannot become that final Tax Decision, and a failed or
uncommitted final result remains prospective evidence.
_Avoid_: VAT identifier as tax decision, B2B Channel as tax treatment, retained preview as Accepted
tax, Pricing Quotation as tax guarantee, rate-only decision without exact subject/context, one
independent Tax Decision per UI/Pricing line by default, Tax commitment proof/TTL/renewal,
same-Bundle recomputation.

**Tax Result** — Tax-owned purchase-scoped tax amounts and decomposition for the exact inputs and
interpretation used by one successful Tax Decision. It preserves one authoritative published Tax
amount per exact Taxable Supply Unit under Tax Rounding and one purchase Tax total equal to the exact
sum of those published unit amounts; it does not perform a second purchase-level rounding. Its
Pricing inputs are the authoritative published rounded Line Commercial Values and required
breakdown/evidence, not an alternative reconstruction of the Pricing total. A non-success Tax outcome
does not fabricate a Tax Result.
_Avoid_: Pricing Result including tax, rate-bucket identity replacing Taxable Supply Units,
purchase-level re-rounding, tax revision alone as monetary result, frontend-computed tax.

**Customer-Safe Tax Projection** — Tax-owned, versioned, explicitly allowlisted presentation of one
authoritative Tax Outcome: amounts, currency, presentation-safe rate/treatment and only the
decomposition the view needs. It never recomputes Tax and is distinct from purpose-specific internal
Tax Evidence handoffs.
_Avoid_: frontend Tax calculation, internal evidence or source payloads in customer output,
projection as a second Tax truth.

**Tax Outcome** — Business result of one Tax evaluation: either a successful Tax Decision with its
Tax Result, or exactly one typed non-success meaning. Launch codes: `TAX_CASE_UNSUPPORTED` (scope
failure; never missing configuration), `TAX_PREREQUISITE_NOT_MET` (known-negative required Launch
prerequisite such as authoritatively ended/non-registered seller VAT registration),
`TAX_RULE_MISSING` (supported case with a complete authoritative empty applicable rule set),
`TAX_RULE_OVERLAP` (complete rule state with simultaneously applicable revisions where mutual
exclusion is required), `TAX_RULE_CONFLICT` (complete rule state with incompatible applicable
meanings and no governing composition; explicit permitted composition is not conflict),
`TAX_INPUT_STALE` (required material evidence known outside its usable Current validity),
`TAX_DEPENDENCY_UNAVAILABLE` (required authority/dependency cannot safely be used),
`TAX_STATE_INDETERMINATE` (complete authoritative truth cannot safely be concluded; an incomplete
material set or unresolved authority conflict may yield it under its owning contract). Unknown,
unavailable and stale are never negative; none is represented as successful zero.
_Avoid_: generic ERROR, provider-specific timeout as public Tax meaning, null/zero as failure,
unknown or unavailable seller state as `TAX_PREREQUISITE_NOT_MET`, partial observation as
`TAX_RULE_MISSING`.

**Taxable Basis** — Basis to which an applicable tax calculation relates, determined by Tax per
Taxable Supply Unit from authoritative owner-issued commercial amounts: published Line Commercial
Values with Discounts/Fees/Promotion contributions included exactly once, and the separately
owner-issued Shipping amount. Ancillary Shipping is allocated exactly across the affected Taxable
Supply Units by the approved legally relevant allocation values/evidence; exact allocations conserve
the owner-issued Shipping amount before rounding and may be exact rational values rather than
published Monetary Amounts. It is not a second Pricing total or authority to change already
published Line Commercial Values.
_Avoid_: Pricing total automatically treated as a universal taxable basis, duplicate Fee addition,
Shipping as Pricing Fee, missing Shipping as zero Shipping, equal/count-based split as default
allocation, rounding an allocation merely to force a decimal Monetary Amount.

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

**Tax Rule Revision** — Immutable, separately addressable revision of one Tax Rule carrying its Tax
Treatment/rate meaning for one Effective Period `[effective_from, effective_to)`. It is selected by
Tax-Relevant Time from complete authoritative rule state, retained in Tax Evidence and Accepted Tax
Terms, and never overwritten: a confirmed-wrong revision stays addressable while a correction
records new Current meaning with explicit replacement/correction provenance. A revision confirmed
materially wrong already for an original Tax-Relevant Time differs from an ordinary later rule
change, which never reopens a finalized result; the wrong-at-T disposition is the PO decision
recorded on #907/#930.
_Avoid_: newest/highest revision or `created_at` as selector, deleting or editing a historical
revision, Tax Rule correction confused with a return/Billing correction.

**Tax Treatment** — Explicit Tax meaning carried by an applicable Tax Rule Revision and preserved
per Taxable Supply Unit in a Tax Decision; for Launch, supported ordinary domestic taxable treatment
with its rate. Zero-rate is an explicit treatment/rate meaning, exemption an explicit Tax Decision
meaning, and tax-not-applicable an explicit applicability Decision meaning; each may exist in the
language without being Launch-activated, and a purchase requiring an unactivated one is
`TAX_CASE_UNSUPPORTED`. A `0 CZK` amount never implies any of them.
_Avoid_: treatment inferred from amount, B2B Channel or buyer VAT status as treatment, missing rule
as zero-rate/exemption/not-applicable.

**Tax Jurisdiction** — Tax-owned determination of tax jurisdiction/place meaning for one Taxable
Supply Unit, derived only from authoritative owner-resolved purchase facts such as Selling Legal
Entity, Delivery Destination and Invoice Recipient. For Launch it is Czech domestic; any other
result is `TAX_CASE_UNSUPPORTED`.
_Avoid_: Commerce Market, Channel, Storefront, hostname, locale, IP or currency as jurisdiction;
jurisdiction as Permission authority.

**Tax Fact Authority Contract** — Tax-owned governance fact declaring, for one exact Tax fact family
and explicit scope/use, which System of Record may decide the fact and which sources may provide
supporting evidence. It governs authority/evidence roles; it does not itself set the source fact's
business value and is distinct from an Integration Route or provider credential. A Tax fact family
is the unit of authority assignment: Tax-owned families may have OntOS TAX as System of Record,
while Tax-relevant facts such as Selling Legal Entity VAT Registration keep their external declared
System of Record. Contract revisions carry an explicit authority period, stay historically
explainable and change only through governed Actions; standard public sources such as VIES/ARES may
have system-preconfigured evidence-source defaults, which never preconfigure authority. One fact has
one System of Record per business instant: competing System-of-Record authorities for one
fact/instant are an authority configuration conflict and a fact without any declared authority is an
authority gap; both block affected determination and readiness and are distinct from Tax Rule
overlap/conflict and from evidence-provider disagreement. An authority handoff is an explicit
fact-level boundary; shadow results before it are never Current.
_Avoid_: ERP/VIES/ARES as global Tax authority, authority inferred from transport route, manual
override of a source-owned fact through the authority contract.

**Tax Source Assertion** — One immutable source statement about one exact Tax fact subject, scope
and business-validity meaning, retained with provenance independently from the external source
record and from the canonical Tax business fact it may support. Evaluating one assertion against its
fact-level contract yields exactly one source acceptance outcome: `ACCEPTED` (eligible for
owner-governed Tax fact resolution, not payload promotion), `REJECTED` (a known reason prevents its
use for the declared Tax use), `NEEDS_REVIEW` (understandable but owner-governed undecided) or
`UNVERIFIABLE` (subject, authority, scope or validity cannot be safely confirmed). This family is
distinct from Tax Outcome codes.
_Avoid_: provider payload as canonical Tax profile, arrival order as Currentness, source record ID
as Tax fact identity.

**Selling Legal Entity VAT Registration** — Tax-relevant business fact that one exact Selling Legal
Entity is VAT-registered for one jurisdiction and business-valid period under its declared System of
Record. It is distinct from the Selling Legal Entity identity and from Official Identifiers such as
DIČ. For one evaluation its state is exactly one of Current positive, known ended/non-registered,
unknown, unavailable, stale, or unresolved (incompatible authoritative assertions without valid
correction/temporal semantics); Currentness is judged at Tax Evaluation Time under the owner
contract. Only known ended/non-registered is `TAX_PREREQUISITE_NOT_MET`.
_Avoid_: DIČ as registration proof, Legal Entity existence as VAT-registration state, nullable
boolean as registration state, OntOS Unresolved Party as this unresolved state.

**Tax-Relevant Time** — Tax-owned business time used to select the legally/business-relevant Tax Rule
meaning for an exact Tax Decision. For the supported Launch Order use, it is the Commerce-owned
Order Commitment Time captured once for the exact frozen purchase; if commitment succeeds, Accepted
Tax Terms preserve that same instant. It is not automatically statutory DUZP or another VAT tax point.
_Avoid_: client/browser click time as authority, database commit time substituted after the fact,
Pricing Quotation time as VAT tax point, treating Order commitment as statutory DUZP by definition.

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

**Taxable Supply Unit** — Tax-owned legal/business interpretation of one exact taxable-supply
meaning inside a supported purchase. It is traceable to the relevant Purchase Demand Occurrence(s),
Catalog evidence and owner-issued monetary inputs, but it is not identical by definition to a
Pricing Line, Cart line, Order line or Catalog component. For Launch, an ordinary non-Set occurrence
maps to one Taxable Supply Unit; a supported whole-treatment Set maps to one unit; cases requiring
generic multi-supply Set monetary decomposition remain unsupported. Ancillary Shipping is allocated
into affected units and is not a separate unit; a separate Shipping supply requires its own explicit
Tax meaning. A supported whole-treatment Set has one legally valid Tax Treatment for its whole
published amount; a Catalog Set is not by itself a statutory § 47 odst. 7 goods set.
_Avoid_: Pricing Line as statutory supply identity, rate bucket as canonical Tax identity, merging
equal occurrences, invented component prices, Catalog Set label as proof of the statutory goods-set
regime, one-treatment Set as a separate term.

## Monetary boundaries

**Tax Rounding** — Tax-owned rounding meaning for tax amounts, separate from Pricing's final line
rounding and Pricing Line Rounding Adjustment. For Launch CZ, TAX calculates the exact tax
contribution for each Taxable Supply Unit, then publishes that unit's Tax amount at `0.01 CZK` using
`ROUND_HALF_UP`; the purchase Tax total is the exact sum of those published unit Tax amounts and is
not rounded again. The exact pre-round contribution and resulting rounding difference remain
explainable as Tax Evidence. This Launch policy is an OntOS product decision, not a claim that Czech
VAT law universally mandates `ROUND_HALF_UP per line`. The Tax rounding policy is versioned;
Accepted Tax Terms retain the revision actually used. Per unit, `Tax rounding adjustment = published
Tax − exact Tax contribution` is Tax-owned evidence, not a Discount, Fee, Shipping or Pricing Line
Rounding Adjustment, and the exact contribution may carry more precision than a Monetary Amount.
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

**Accepted Tax Terms** — Immutable Tax meaning actually used by one successful historical handoff,
including exact Taxable Supply Unit mapping, the Order Commitment Time used as Tax-Relevant Time,
Tax Rounding policy/revision, amounts, and safe source/rule evidence. For an Accepted Order they
preserve lineage to the exact final Tax Decision/Tax Result from the accepted Bundle and its
original Order Commitment Time; actual recording/proof times stay separate. Later Current changes
never recompute that Order. An ordinary supported return or correction gets no fresh Tax
determination: it uses the fixed Tax and final prices of the Authoritative Original Accepted Record
and yields a Tax Correction Delta. Only a genuinely independent supported Tax-relevant event (for
example a later first supply) receives its own declared-purpose Tax determination with its own
Tax-Relevant Time, scoped to the affected subset and retaining original unit lineage.
_Legal_: for later supply timing see [ZDPH § 20a](https://www.zakonyprolidi.cz/cs/2004-235#p20a),
[§ 21](https://www.zakonyprolidi.cz/cs/2004-235#p21), and rate timing in
[§ 47 odst. 2](https://www.zakonyprolidi.cz/cs/2004-235#p47); for supported corrections see
[§ 42](https://www.zakonyprolidi.cz/cs/2004-235#p42) and
[§ 45](https://www.zakonyprolidi.cz/cs/2004-235#p45).
_Avoid_: recomputing historical tax from today's rules, treating a prospective Tax Result as
Accepted, blindly copying Accepted Order Tax Terms into a later Billing/supply event with its own
Tax-relevant facts, sharing one mutable Order/Billing Tax snapshot, live re-evaluation of original
sale Tax inside a return, erroneous-document remediation performed inside an ordinary return.

**Authoritative Original Accepted Record** — The accepted purchase document/record whose recorded
Tax, final prices, basis, treatment, allocations and Taxable Supply Unit mapping are authoritative
for a supported return/correction: the final accepted Order Snapshot for B2C where it is the final
authoritative record, or the relevant accepted Billing Document wherever one exists for the invoiced
supply. A missing or ambiguous record or unit mapping is an explicit unresolved historical-input
outcome, never Current reconstruction, equal-total matching or guessed zero.
_Avoid_: "original invoice" read as requiring an invoice for every B2C return, consumer choosing a
baseline by matching total, live Catalog/Inventory/Pricing/Tax Rule/registration lookup as baseline.

**Accepted Cumulative Correction State** — Billing-owned, versioned cumulative corrected published
Tax state of one original Taxable Supply Unit after all Accepted corrections, starting from the
Authoritative Original Accepted Record. TAX reads it as a baseline and proposes a next state; only
Billing accepts and advances it.
_Avoid_: TAX-owned correction ledger, preview as an accepted state, state without an expected
version.

**Tax Correction Delta** — Tax-owned purpose-specific result for one supported return/correction,
computed per original Taxable Supply Unit as the proposed new cumulative corrected published Tax
state minus the Accepted Cumulative Correction State, bound to that state's expected version.
Rounding remainder stays within that unit's lineage; full exhaustion of the original basis leaves
exactly `0.00 CZK` remaining published Tax for that unit. It is neither a replacement Tax Result nor
a new sale Tax determination; a TAX preview advances no Accepted sequence.
_Avoid_: independently rounded negative sale, cross-unit balancing, Payment refund or Fulfillment
state alone as correction, TAX as a competing Billing ledger.

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
  [§ 47 odst. 2](https://www.zakonyprolidi.cz/cs/2004-235#p47). Order Commitment Time is not
  declared by OntOS to be statutory DUZP merely because it is the Launch order-side Tax-Relevant
  Time; actual Order acceptance/recording times are preserved separately.
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
- **Tax Decision** and **Tax Evidence** are OntOS domain terms without a one-to-one statutory synonym.
  Their statutory substance is explained by the referenced applicability, supply, basis, calculation,
  rate and timing provisions above.
