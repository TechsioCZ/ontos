import { Match, Schema } from 'effect';

import {
  AcceptedTaxTermsSchema,
  AuthoritativeOriginalAcceptedRecordSchema,
  OrderLineageSchema,
  isBillingDocumentRecord,
} from './accepted-tax-terms.ts';
import { TaxDecisionIdSchema } from './tax-decision.ts';
import { BoundedIdentifierSchema, distinctBy } from './tax-domain-primitives.ts';
import { NonNegativeTaxExactRationalSchema, TaxExactRationalSchema } from './tax-exact-rational.ts';
import type { TaxExactRational } from './tax-exact-rational.ts';
import {
  TAX_HISTORICAL_INPUT_UNRESOLVED,
  TaxHistoricalInputUnresolvedReasonSchema,
} from './tax-historical-input-outcome.ts';
import {
  SignedTaxMonetaryAmountSchema,
  TaxCurrencySchema,
  TaxMonetaryAmountSchema,
  signedTaxMonetaryAmountMinorUnits,
  taxMonetaryAmountMinorUnits,
} from './tax-monetary-amount.ts';
import type { SignedTaxMonetaryAmount, TaxMonetaryAmount } from './tax-monetary-amount.ts';
import { TaxRoundingPolicySchema } from './tax-rounding.ts';
import { TaxAmountBasisSchema } from './taxable-basis.ts';
import { SellerNotVatPayerTreatmentSchema, TaxDecisionTreatmentSchema } from './tax-treatment.ts';
import { TaxableSupplyUnitIdSchema } from './taxable-supply-unit.ts';

/**
 * Cumulative corrected state of one original Taxable Supply Unit: remaining accepted quantity, the remaining exact
 * Line Commercial Value and allocated Shipping share of its Taxable Basis, and the remaining published Tax. The two
 * basis components stay separate so the original source allocation remains explainable (#948 F8, F17-F19, F25).
 * Value deltas and remaining bases stay in the component's own recorded amount basis (PO decision D3 on #907).
 */
export const CumulativeUnitTaxStateSchema = Schema.Struct({
  remainingLineBasis: NonNegativeTaxExactRationalSchema,
  remainingPublishedTax: TaxMonetaryAmountSchema,
  remainingQuantity: NonNegativeTaxExactRationalSchema,
  remainingShippingBasis: NonNegativeTaxExactRationalSchema,
});

export type CumulativeUnitTaxState = typeof CumulativeUnitTaxStateSchema.Type;

/**
 * Billing-owned Accepted Cumulative Correction State of one original unit as handed to TAX: either no Accepted
 * correction yet (the original record is the initial state) or the state after all Accepted corrections with its
 * opaque version. TAX only reads and echoes it; Billing alone accepts the next state against that exact version
 * (#946 F15-F18, #948 F17, F26-F31; glossary Accepted Cumulative Correction State).
 */
export const AcceptedCumulativeCorrectionStateSchema = Schema.Union([
  Schema.TaggedStruct('NO_ACCEPTED_CORRECTION', {}),
  Schema.TaggedStruct('ACCEPTED', {
    state: CumulativeUnitTaxStateSchema,
    stateVersion: BoundedIdentifierSchema,
  }),
]);

export type AcceptedCumulativeCorrectionState = typeof AcceptedCumulativeCorrectionStateSchema.Type;

/**
 * A supported ordinary return/correction reduces the original supply; it is never a repricing upward or a reversal
 * of an Accepted corrective document, which stays in the sequence (#948 F9, F19 "the remaining state decreases",
 * #948 E arbitrary post-order repricing).
 */
const NegativeDeltaSchema = TaxExactRationalSchema.check(
  Schema.makeFilter(
    (value: TaxExactRational) => value.numerator.startsWith('-') || 'A supported correction must reduce the original',
  ),
);

/**
 * Explicit authorized reduction of one original unit: a negative quantity delta in the unit's accepted quantity unit,
 * or a negative commercial-value delta of one named basis component in CZK with its own explicit amount basis
 * (PO decision D3 on #907). Billing and Order never compute the net or gross amount themselves (#948 F14); TAX
 * converts the delta into the component's recorded basis at the original unit's treatment. A Shipping Allocation
 * value change is always GROSS, mirroring `ShippingAllocationBasisSchema.amountBasis` and Unit 11's shipping rule
 * (F16). Never inferred from a refund, a customer-facing total or a Fulfillment status
 * (#948 F10-F11, F25, #907 F187, F193-F194).
 */
export const TaxCorrectionChangeSchema = Schema.Union([
  Schema.TaggedStruct('QUANTITY', { quantityDelta: NegativeDeltaSchema }),
  Schema.TaggedStruct('VALUE', {
    amountBasis: TaxAmountBasisSchema,
    basisComponent: Schema.Literals(['LINE_COMMERCIAL_VALUE', 'SHIPPING_ALLOCATION']),
    valueDelta: NegativeDeltaSchema,
  }).check(
    Schema.makeFilter(
      ({ amountBasis, basisComponent }) =>
        basisComponent !== 'SHIPPING_ALLOCATION' ||
        amountBasis === 'GROSS' ||
        'A Shipping Allocation value change must be GROSS',
    ),
  ),
]);

export type TaxCorrectionChange = typeof TaxCorrectionChangeSchema.Type;

/**
 * Which basis component a change moves: a quantity change and a Line Commercial Value change both move the unit's
 * goods component; a Shipping Allocation value change moves its Shipping component. The two components are disjoint,
 * so a correction may carry at most one goods change and one Shipping change for the same unit (D2/H5: the scope,
 * reason and Shipping delta are Order-issued, never derived from quantity).
 */
export const correctionComponentOf = (change: TaxCorrectionChange): 'GOODS' | 'SHIPPING' =>
  Match.value(change).pipe(
    Match.tagsExhaustive({
      QUANTITY: () => 'GOODS' as const,
      VALUE: ({ basisComponent }) =>
        basisComponent === 'LINE_COMMERCIAL_VALUE' ? ('GOODS' as const) : ('SHIPPING' as const),
    }),
  );

/**
 * One correction may carry a goods change (quantity or Line Commercial Value) and a Shipping-value change for the
 * same unit, each at most once; the Order-authorized Shipping delta is never derived from a quantity change
 * ("never 1/quantity"). The scope, reason and Shipping delta of a return are Order-issued (D2/H5), not Fulfillment.
 */
export const TaxCorrectionUnitRequestSchema = Schema.Struct({
  changes: Schema.NonEmptyArray(TaxCorrectionChangeSchema).check(
    distinctBy(correctionComponentOf, 'A correction changes each basis component of a unit at most once'),
  ),
  expectedPreviousState: AcceptedCumulativeCorrectionStateSchema,
  taxableSupplyUnitId: TaxableSupplyUnitIdSchema,
});

export type TaxCorrectionUnitRequest = typeof TaxCorrectionUnitRequestSchema.Type;

/**
 * Explicit identity, reason and authorized changes of one supported return/correction. Each original unit appears
 * once, so the same quantity or value is never consumed twice inside one correction (#948 F2, F10-F16).
 * `correctionEventRef` and `correctionReason` are the Order return authorization (D2/H5), not Fulfillment.
 */
export const TaxCorrectionFactsSchema = Schema.Struct({
  correctionEventRef: BoundedIdentifierSchema,
  correctionReason: BoundedIdentifierSchema,
  units: Schema.NonEmptyArray(TaxCorrectionUnitRequestSchema).check(
    distinctBy(
      ({ taxableSupplyUnitId }: TaxCorrectionUnitRequest) => taxableSupplyUnitId,
      'A correction must not change one original unit twice',
    ),
  ),
});

/**
 * One supported return/correction of an Authoritative Original Accepted Record (#946 F15, #948 A). A correction of
 * an invoiced sale uses the accepted Billing Document as its original record; the Order Snapshot is only ever the
 * confirmed pre-document boundary and is never a correction baseline (H10).
 */
export const TaxCorrectionRequestSchema = Schema.Struct({
  acceptedTaxTerms: AcceptedTaxTermsSchema,
  ...TaxCorrectionFactsSchema.fields,
}).check(
  Schema.makeFilter(
    ({ acceptedTaxTerms }) =>
      isBillingDocumentRecord(acceptedTaxTerms.authoritativeRecord) ||
      'A correction of an invoiced sale uses the accepted Billing Document as its original record',
  ),
);

export type TaxCorrectionRequest = typeof TaxCorrectionRequestSchema.Type;

const isSellerNotVatPayerTreatment = Schema.is(SellerNotVatPayerTreatmentSchema);
const isZeroExact = (value: TaxExactRational): boolean => value.numerator === '0';
const isZeroTaxMonetaryAmount = (value: TaxMonetaryAmount): boolean => taxMonetaryAmountMinorUnits(value) === 0n;
const isZeroSignedTaxMonetaryAmount = (value: SignedTaxMonetaryAmount): boolean =>
  signedTaxMonetaryAmountMinorUnits(value) === 0n;

const isFullyReversedState = (state: CumulativeUnitTaxState): boolean =>
  isZeroExact(state.remainingQuantity) &&
  isZeroExact(state.remainingLineBasis) &&
  isZeroExact(state.remainingShippingBasis);

/**
 * Proposed next cumulative state of one unit and its signed Tax Correction Delta against the expected previous
 * Accepted state, echoed unchanged so Billing can accept it only against that exact version (#946 F16-F17, #948 F15,
 * F19, F27). The exact contribution and rounding adjustment are Tax rounding evidence of the proposed state.
 * `treatment` echoes the original unit's own Tax Decision treatment: every correction uses the same treatment as the
 * original sale, under the same rate (Unit 12 B1, B4).
 *
 * Two invariants:
 * - **Treatment consequence** (OWNERSHIP §5 "Non-payer corrections"): for `SELLER_NOT_VAT_PAYER`, the exact
 *   contribution, the Tax rounding adjustment and the signed delta are all zero, and both the previous and proposed
 *   remaining published Tax are 0.00.
 * - **Full reversal** (LEGAL §2 Credits): once the proposed next state has no remaining quantity, line or Shipping
 *   basis, its remaining published Tax is 0.00 and the signed delta is the exact negation of the previous remaining
 *   published Tax — "a full reversal is the exact negation of the stored tax" is a contract invariant here, not
 *   just an arithmetic outcome.
 */
export const TaxCorrectionUnitDeltaSchema = Schema.Struct({
  exactTaxContribution: NonNegativeTaxExactRationalSchema,
  expectedPreviousState: AcceptedCumulativeCorrectionStateSchema,
  previous: CumulativeUnitTaxStateSchema,
  proposedNext: CumulativeUnitTaxStateSchema,
  taxableSupplyUnitId: TaxableSupplyUnitIdSchema,
  taxCorrectionDelta: SignedTaxMonetaryAmountSchema,
  taxRoundingAdjustment: TaxExactRationalSchema,
  treatment: TaxDecisionTreatmentSchema,
}).check(
  Schema.makeFilter(
    ({ exactTaxContribution, previous, proposedNext, taxCorrectionDelta, taxRoundingAdjustment, treatment }) =>
      !isSellerNotVatPayerTreatment(treatment) ||
      (isZeroExact(exactTaxContribution) &&
        isZeroExact(taxRoundingAdjustment) &&
        isZeroSignedTaxMonetaryAmount(taxCorrectionDelta) &&
        isZeroTaxMonetaryAmount(previous.remainingPublishedTax) &&
        isZeroTaxMonetaryAmount(proposedNext.remainingPublishedTax)) ||
      'SELLER_NOT_VAT_PAYER corrections carry no Tax contribution, adjustment or delta',
  ),
  Schema.makeFilter(
    ({ previous, proposedNext, taxCorrectionDelta }) =>
      !isFullyReversedState(proposedNext) ||
      (isZeroTaxMonetaryAmount(proposedNext.remainingPublishedTax) &&
        signedTaxMonetaryAmountMinorUnits(taxCorrectionDelta) ===
          -taxMonetaryAmountMinorUnits(previous.remainingPublishedTax)) ||
      'A full reversal is the exact negation of the previous remaining published Tax',
  ),
);

export type TaxCorrectionUnitDelta = typeof TaxCorrectionUnitDeltaSchema.Type;

/**
 * Tax Correction Delta of one correction: a purpose-specific result bound to its original record with its exact
 * Order/Bundle lineage, Decision and rounding policy; not a replacement original Tax Result, a Pricing Result, a
 * refund or a payable amount (#948 F13-F15, #921 F20, #907 F183, F186, F192). `originalRecord` narrows to the
 * accepted Billing Document member: the original record of a correction is the accepted Billing Document (H10).
 */
export const TaxCorrectionDeltaSchema = Schema.TaggedStruct('TAX_CORRECTION_DELTA', {
  correctionEventRef: BoundedIdentifierSchema,
  correctionReason: BoundedIdentifierSchema,
  correctionTaxDelta: SignedTaxMonetaryAmountSchema,
  currency: TaxCurrencySchema,
  originalOrderLineage: OrderLineageSchema,
  originalRecord: AuthoritativeOriginalAcceptedRecordSchema.members[1],
  originalTaxDecisionId: TaxDecisionIdSchema,
  taxRoundingPolicy: TaxRoundingPolicySchema,
  units: Schema.NonEmptyArray(TaxCorrectionUnitDeltaSchema),
});

export type TaxCorrectionDelta = typeof TaxCorrectionDeltaSchema.Type;

/**
 * The owner (Order or Billing) cannot establish the Authoritative Original Accepted Record of the supply to correct:
 * it is missing, or several records could be it. The owner must recover it; TAX never reconstructs it from Current
 * sources, equal totals or a guessed zero (#946 F12, #947 F13, #948 F7).
 */
export const OriginalRecordUnavailableSchema = Schema.TaggedStruct('ORIGINAL_RECORD_UNAVAILABLE', {
  reason: Schema.Literals(['MISSING', 'AMBIGUOUS']),
});

const UnresolvedUnitSchema = Schema.Struct({
  reason: TaxHistoricalInputUnresolvedReasonSchema,
  taxableSupplyUnitId: TaxableSupplyUnitIdSchema,
});

export type UnresolvedUnit = typeof UnresolvedUnitSchema.Type;

export const isUnresolvedUnit = Schema.is(UnresolvedUnitSchema);

/** A unit may appear twice in `TaxCorrectionOutOfBoundsSchema.units`, once per failing component (F4). */
const OutOfBoundsUnitSchema = Schema.Struct({
  reason: Schema.Literals(['EXCEEDS_REMAINING_QUANTITY', 'EXCEEDS_REMAINING_BASIS_COMPONENT']),
  taxableSupplyUnitId: TaxableSupplyUnitIdSchema,
});

export type OutOfBoundsUnit = typeof OutOfBoundsUnitSchema.Type;

export const isOutOfBoundsUnit = Schema.is(OutOfBoundsUnitSchema);

/**
 * Explicit unresolved historical input (#947 F13, #948 F7, PO default D4): the owner cannot establish its Authoritative
 * Original Accepted Record (missing or ambiguous), the record it handed over is internally inconsistent (its Tax
 * Result does not follow from its Tax Decision), or named units cannot be established from that record. No Tax amount,
 * guessed zero or Current-source fallback.
 */
export const TaxCorrectionHistoricalInputUnresolvedSchema = Schema.TaggedStruct(TAX_HISTORICAL_INPUT_UNRESOLVED, {
  unresolved: Schema.Union([
    OriginalRecordUnavailableSchema,
    Schema.TaggedStruct('ORIGINAL_RECORD_INCONSISTENT', {}),
    Schema.TaggedStruct('UNITS', { units: Schema.Array(UnresolvedUnitSchema).check(Schema.isMinLength(1)) }),
  ]),
});

/**
 * The authorized reduction exceeds what remains of the original unit's quantity or of the named basis component:
 * already corrected quantity or basis would be consumed twice. It is rejected, never clamped or moved to another
 * unit (#948 F16, F24).
 */
export const TaxCorrectionOutOfBoundsSchema = Schema.TaggedStruct('TAX_CORRECTION_OUT_OF_BOUNDS', {
  units: Schema.Array(OutOfBoundsUnitSchema).check(Schema.isMinLength(1)),
});

export const TaxCorrectionOutcomeSchema = Schema.Union([
  TaxCorrectionDeltaSchema,
  TaxCorrectionHistoricalInputUnresolvedSchema,
  TaxCorrectionOutOfBoundsSchema,
]);

export type TaxCorrectionOutcome = typeof TaxCorrectionOutcomeSchema.Type;
