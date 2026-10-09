import { Schema } from 'effect';

import {
  AcceptedTaxTermsSchema,
  AuthoritativeOriginalAcceptedRecordSchema,
  OrderLineageSchema,
} from './accepted-tax-terms.ts';
import { TaxDecisionIdSchema } from './tax-decision.ts';
import { BoundedIdentifierSchema, distinctBy } from './tax-domain-primitives.ts';
import { NonNegativeTaxExactRationalSchema, TaxExactRationalSchema } from './tax-exact-rational.ts';
import type { TaxExactRational } from './tax-exact-rational.ts';
import {
  TAX_HISTORICAL_INPUT_UNRESOLVED,
  TaxHistoricalInputUnresolvedReasonSchema,
} from './tax-historical-input-outcome.ts';
import { SignedTaxMonetaryAmountSchema, TaxCurrencySchema, TaxMonetaryAmountSchema } from './tax-monetary-amount.ts';
import { TaxRoundingPolicySchema } from './tax-rounding.ts';
import { TaxableSupplyUnitIdSchema } from './taxable-supply-unit.ts';

/**
 * Cumulative corrected state of one original Taxable Supply Unit: remaining accepted quantity, the remaining exact
 * Line Commercial Value and allocated Shipping share of its Taxable Basis, and the remaining published Tax. The two
 * basis components stay separate so the original source allocation remains explainable (#948 F8, F17-F19, F25).
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
 * or a negative commercial-value delta of one named basis component in CZK. Never inferred from a refund, a
 * customer-facing total or a Fulfillment status (#948 F10-F11, F25, #907 F187, F193-F194).
 */
export const TaxCorrectionChangeSchema = Schema.Union([
  Schema.TaggedStruct('QUANTITY', { quantityDelta: NegativeDeltaSchema }),
  Schema.TaggedStruct('VALUE', {
    basisComponent: Schema.Literals(['LINE_COMMERCIAL_VALUE', 'SHIPPING_ALLOCATION']),
    valueDelta: NegativeDeltaSchema,
  }),
]);

export type TaxCorrectionChange = typeof TaxCorrectionChangeSchema.Type;

export const TaxCorrectionUnitRequestSchema = Schema.Struct({
  change: TaxCorrectionChangeSchema,
  expectedPreviousState: AcceptedCumulativeCorrectionStateSchema,
  taxableSupplyUnitId: TaxableSupplyUnitIdSchema,
});

export type TaxCorrectionUnitRequest = typeof TaxCorrectionUnitRequestSchema.Type;

/**
 * Explicit identity, reason and authorized changes of one supported return/correction. Each original unit appears
 * once, so the same quantity or value is never consumed twice inside one correction (#948 F2, F10-F16).
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

/** One supported return/correction of an Authoritative Original Accepted Record (#946 F15, #948 A). */
export const TaxCorrectionRequestSchema = Schema.Struct({
  acceptedTaxTerms: AcceptedTaxTermsSchema,
  ...TaxCorrectionFactsSchema.fields,
});

export type TaxCorrectionRequest = typeof TaxCorrectionRequestSchema.Type;

/**
 * Proposed next cumulative state of one unit and its signed Tax Correction Delta against the expected previous
 * Accepted state, echoed unchanged so Billing can accept it only against that exact version (#946 F16-F17, #948 F15,
 * F19, F27). The exact contribution and rounding adjustment are Tax rounding evidence of the proposed state.
 */
export const TaxCorrectionUnitDeltaSchema = Schema.Struct({
  exactTaxContribution: NonNegativeTaxExactRationalSchema,
  expectedPreviousState: AcceptedCumulativeCorrectionStateSchema,
  previous: CumulativeUnitTaxStateSchema,
  proposedNext: CumulativeUnitTaxStateSchema,
  taxableSupplyUnitId: TaxableSupplyUnitIdSchema,
  taxCorrectionDelta: SignedTaxMonetaryAmountSchema,
  taxRoundingAdjustment: TaxExactRationalSchema,
});

export type TaxCorrectionUnitDelta = typeof TaxCorrectionUnitDeltaSchema.Type;

/**
 * Tax Correction Delta of one correction: a purpose-specific result bound to its original record with its exact
 * Order/Bundle lineage, Decision and rounding policy; not a replacement original Tax Result, a Pricing Result, a
 * refund or a payable amount (#948 F13-F15, #921 F20, #907 F183, F186, F192).
 */
export const TaxCorrectionDeltaSchema = Schema.TaggedStruct('TAX_CORRECTION_DELTA', {
  correctionEventRef: BoundedIdentifierSchema,
  correctionReason: BoundedIdentifierSchema,
  correctionTaxDelta: SignedTaxMonetaryAmountSchema,
  currency: TaxCurrencySchema,
  originalOrderLineage: OrderLineageSchema,
  originalRecord: AuthoritativeOriginalAcceptedRecordSchema,
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
