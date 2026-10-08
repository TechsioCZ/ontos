import { Array as Arr, Match, Option, Order, Result, Schema, pipe } from 'effect';

import {
  AcceptedTaxTermsSchema,
  AuthoritativeOriginalAcceptedRecordSchema,
  originalUnitBaseline,
} from './accepted-tax-terms.ts';
import type { AcceptedTaxTerms, OriginalUnitBaseline } from './accepted-tax-terms.ts';
import { TaxDecisionIdSchema } from './tax-decision.ts';
import { BoundedIdentifierSchema, distinctBy } from './tax-domain-primitives.ts';
import {
  NonNegativeTaxExactRationalSchema,
  TaxExactRationalSchema,
  addTaxExactRationals,
  divideTaxExactRationals,
  isNonNegativeTaxExactRational,
  multiplyTaxExactRationals,
  subtractTaxExactRationals,
  taxExactRationalFromMinorUnits,
} from './tax-exact-rational.ts';
import type { NonNegativeTaxExactRational, TaxExactRational } from './tax-exact-rational.ts';
import {
  TAX_HISTORICAL_INPUT_UNRESOLVED,
  TaxHistoricalInputUnresolvedReasonSchema,
} from './tax-historical-input-outcome.ts';
import {
  CZK_MINOR_UNITS_PER_MAJOR_UNIT,
  SignedTaxMonetaryAmountSchema,
  TaxCurrencySchema,
  TaxMonetaryAmountSchema,
  publishedTaxAmountRoundedHalfUp,
  signedTaxMonetaryAmountFromMinorUnits,
  signedTaxMonetaryAmountMinorUnits,
  taxMonetaryAmountMinorUnits,
} from './tax-monetary-amount.ts';
import type { TaxMonetaryAmount } from './tax-monetary-amount.ts';
import { TaxRoundingPolicySchema } from './tax-rounding.ts';
import { TaxableSupplyUnitIdSchema } from './taxable-supply-unit.ts';

/** Cumulative corrected published Tax state of one original Taxable Supply Unit (#948 F17-F19). */
export const CumulativeUnitTaxStateSchema = Schema.Struct({
  remainingBasis: NonNegativeTaxExactRationalSchema,
  remainingPublishedTax: TaxMonetaryAmountSchema,
  remainingQuantity: NonNegativeTaxExactRationalSchema,
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

const nonZero = Schema.makeFilter(
  (value: TaxExactRational) => value.numerator !== '0' || 'A correction must change quantity or value',
);

/**
 * Explicit authorized change of one original unit: a signed quantity delta in the unit's accepted quantity unit, or
 * a signed commercial-value delta of its Taxable Basis in CZK. Never inferred from a refund, a customer-facing total
 * or a Fulfillment status (#948 F10-F11, #907 F187, F193-F194).
 */
export const TaxCorrectionChangeSchema = Schema.Union([
  Schema.TaggedStruct('QUANTITY', { quantityDelta: TaxExactRationalSchema.check(nonZero) }),
  Schema.TaggedStruct('VALUE', { valueDelta: TaxExactRationalSchema.check(nonZero) }),
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
 * Tax Correction Delta of one correction: a purpose-specific result bound to its original record, Decision and
 * rounding policy; not a replacement original Tax Result, a Pricing Result, a refund or a payable amount
 * (#948 F13-F15, #921 F20, #907 F186, F192).
 */
export const TaxCorrectionDeltaSchema = Schema.TaggedStruct('TAX_CORRECTION_DELTA', {
  correctionEventRef: BoundedIdentifierSchema,
  correctionReason: BoundedIdentifierSchema,
  correctionTaxDelta: SignedTaxMonetaryAmountSchema,
  currency: TaxCurrencySchema,
  originalRecord: AuthoritativeOriginalAcceptedRecordSchema,
  originalTaxDecisionId: TaxDecisionIdSchema,
  taxRoundingPolicy: TaxRoundingPolicySchema,
  units: Schema.NonEmptyArray(TaxCorrectionUnitDeltaSchema),
});
export type TaxCorrectionDelta = typeof TaxCorrectionDeltaSchema.Type;

const UnresolvedUnitSchema = Schema.Struct({
  reason: TaxHistoricalInputUnresolvedReasonSchema,
  taxableSupplyUnitId: TaxableSupplyUnitIdSchema,
});
type UnresolvedUnit = typeof UnresolvedUnitSchema.Type;
const isUnresolvedUnit = Schema.is(UnresolvedUnitSchema);

const OutOfBoundsUnitSchema = Schema.Struct({
  reason: Schema.Literals(['QUANTITY_OUTSIDE_ORIGINAL', 'BASIS_OUTSIDE_ORIGINAL']),
  taxableSupplyUnitId: TaxableSupplyUnitIdSchema,
});
type OutOfBoundsUnit = typeof OutOfBoundsUnitSchema.Type;
const isOutOfBoundsUnit = Schema.is(OutOfBoundsUnitSchema);

/** Explicit unresolved historical input of one or more requested units (#947 F13, #948 F7, PO default D4). */
export const TaxCorrectionHistoricalInputUnresolvedSchema = Schema.TaggedStruct(TAX_HISTORICAL_INPUT_UNRESOLVED, {
  units: Schema.Array(UnresolvedUnitSchema).check(Schema.isMinLength(1)),
});

/**
 * The authorized change would leave the original unit's quantity or basis outside `[0, original]`: already corrected
 * quantity or basis would be consumed twice, or the correction would reprice above the original sale. It is
 * rejected, never clamped or moved to another unit (#948 F9, F16, F24).
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

const isNonNegative = Schema.is(NonNegativeTaxExactRationalSchema);

const exactValueOf = (amount: TaxMonetaryAmount): TaxExactRational =>
  taxExactRationalFromMinorUnits(taxMonetaryAmountMinorUnits(amount), CZK_MINOR_UNITS_PER_MAJOR_UNIT);

const isAtMost = (value: TaxExactRational, limit: TaxExactRational) =>
  isNonNegativeTaxExactRational(subtractTaxExactRationals(limit, value));

/** Published Tax of a remaining basis at the original rate and the original single per-unit boundary (#948 F18, F21). */
const publishedTaxOf = (baseline: OriginalUnitBaseline, basis: NonNegativeTaxExactRational) => {
  const exact = NonNegativeTaxExactRationalSchema.make(multiplyTaxExactRationals(basis, baseline.rate));
  const published = publishedTaxAmountRoundedHalfUp(exact);
  return { adjustment: subtractTaxExactRationals(exactValueOf(published), exact), exact, published };
};

/** The original record is the initial Accepted state of every unit (#948 F19). */
const initialState = (baseline: OriginalUnitBaseline): CumulativeUnitTaxState => ({
  remainingBasis: baseline.originalBasis,
  remainingPublishedTax: baseline.originalPublishedTax,
  remainingQuantity: NonNegativeTaxExactRationalSchema.make(baseline.originalQuantity),
});

const previousStateOf = (baseline: OriginalUnitBaseline, expected: AcceptedCumulativeCorrectionState) =>
  Match.value(expected).pipe(
    Match.tagsExhaustive({
      ACCEPTED: ({ state }) => state,
      NO_ACCEPTED_CORRECTION: () => initialState(baseline),
    }),
  );

/**
 * An Accepted state can only have followed from the original record by this arithmetic: within the original quantity
 * and basis, and published at the original rate and boundary. Anything else is an unresolved historical input for
 * Billing to recover, not a state TAX repairs (#947 F13-F14, #948 F7).
 */
const followsFromOriginalRecord = (baseline: OriginalUnitBaseline, state: CumulativeUnitTaxState) =>
  isAtMost(state.remainingQuantity, baseline.originalQuantity) &&
  isAtMost(state.remainingBasis, baseline.originalBasis) &&
  publishedTaxOf(baseline, state.remainingBasis).published.amount === state.remainingPublishedTax.amount;

/**
 * Next remaining basis. A quantity change moves the unit's original Line Commercial Value pro rata to the accepted
 * quantity; an allocated Shipping share changes only through an explicit value change, so arithmetic never invents
 * a Shipping refund. A value change moves the basis by exactly the authorized amount (#948 F8, F10-F11, F25).
 */
const nextRemaining = (baseline: OriginalUnitBaseline, previous: CumulativeUnitTaxState, change: TaxCorrectionChange) =>
  Match.value(change).pipe(
    Match.tagsExhaustive({
      QUANTITY: ({ quantityDelta }) => ({
        basis: Option.match(
          divideTaxExactRationals(
            multiplyTaxExactRationals(baseline.originalLineBasis, quantityDelta),
            baseline.originalQuantity,
          ),
          {
            onNone: () => previous.remainingBasis,
            onSome: (share) => addTaxExactRationals(previous.remainingBasis, share),
          },
        ),
        quantity: addTaxExactRationals(previous.remainingQuantity, quantityDelta),
      }),
      VALUE: ({ valueDelta }) => ({
        basis: addTaxExactRationals(previous.remainingBasis, valueDelta),
        quantity: previous.remainingQuantity,
      }),
    }),
  );

const calculateUnit = (
  terms: AcceptedTaxTerms,
  request: TaxCorrectionUnitRequest,
): Result.Result<TaxCorrectionUnitDelta, UnresolvedUnit | OutOfBoundsUnit> => {
  const { taxableSupplyUnitId } = request;
  const baselineOption = originalUnitBaseline(terms, taxableSupplyUnitId);
  if (Option.isNone(baselineOption)) {
    return Result.fail({ reason: 'UNIT_NOT_IN_ORIGINAL_RECORD', taxableSupplyUnitId });
  }
  const baseline = baselineOption.value;
  const previous = previousStateOf(baseline, request.expectedPreviousState);
  if (!followsFromOriginalRecord(baseline, previous)) {
    return Result.fail({ reason: 'STATE_INCONSISTENT_WITH_ORIGINAL_RECORD', taxableSupplyUnitId });
  }
  const next = nextRemaining(baseline, previous, request.change);
  if (!isNonNegative(next.quantity) || !isAtMost(next.quantity, baseline.originalQuantity)) {
    return Result.fail({ reason: 'QUANTITY_OUTSIDE_ORIGINAL', taxableSupplyUnitId });
  }
  if (!isNonNegative(next.basis) || !isAtMost(next.basis, baseline.originalBasis)) {
    return Result.fail({ reason: 'BASIS_OUTSIDE_ORIGINAL', taxableSupplyUnitId });
  }
  const tax = publishedTaxOf(baseline, next.basis);
  return Result.succeed({
    exactTaxContribution: tax.exact,
    expectedPreviousState: request.expectedPreviousState,
    previous,
    proposedNext: {
      remainingBasis: next.basis,
      remainingPublishedTax: tax.published,
      remainingQuantity: next.quantity,
    },
    taxableSupplyUnitId,
    taxCorrectionDelta: signedTaxMonetaryAmountFromMinorUnits(
      taxMonetaryAmountMinorUnits(tax.published) - taxMonetaryAmountMinorUnits(previous.remainingPublishedTax),
    ),
    taxRoundingAdjustment: tax.adjustment,
  });
};

const byUnitId = Order.mapInput(
  Order.String,
  ({ taxableSupplyUnitId }: TaxCorrectionUnitRequest) => taxableSupplyUnitId,
);

/**
 * Calculates the next Tax Correction Delta of a supported return/correction from the Authoritative Original Accepted
 * Record and each unit's Accepted Cumulative Correction State only. Per unit, the new cumulative published Tax is
 * ROUND_HALF_UP of the new exact remaining basis at the original rate, and the delta is that minus the previous
 * Accepted published Tax, so partial corrections never drift and full exhaustion of the original basis leaves exactly
 * 0.00 CZK. Units are calculated independently: no remainder or balancing amount crosses units. Pure and
 * order-independent; it consumes no Accepted state (#948 F17-F24, #946 F16, F19, #907 F186-F192).
 */
export const calculateTaxCorrectionDelta = (request: TaxCorrectionRequest): TaxCorrectionOutcome => {
  const calculations = pipe(
    Arr.sort(request.units, byUnitId),
    Arr.map((unit) => calculateUnit(request.acceptedTaxTerms, unit)),
  );
  const issues = Arr.getFailures(calculations);
  const unresolved = issues.filter(isUnresolvedUnit);
  const outOfBounds = issues.filter(isOutOfBoundsUnit);
  const { decision, result } = request.acceptedTaxTerms.finalTax;
  return Result.match(Result.all(calculations), {
    onFailure: (): TaxCorrectionOutcome =>
      Arr.isReadonlyArrayNonEmpty(unresolved)
        ? { _tag: TAX_HISTORICAL_INPUT_UNRESOLVED, units: unresolved }
        : { _tag: 'TAX_CORRECTION_OUT_OF_BOUNDS', units: outOfBounds },
    onSuccess: (units): TaxCorrectionOutcome => ({
      _tag: 'TAX_CORRECTION_DELTA',
      correctionEventRef: request.correctionEventRef,
      correctionReason: request.correctionReason,
      correctionTaxDelta: signedTaxMonetaryAmountFromMinorUnits(
        units.reduce((total, unit) => total + signedTaxMonetaryAmountMinorUnits(unit.taxCorrectionDelta), 0n),
      ),
      currency: result.currency,
      originalRecord: request.acceptedTaxTerms.authoritativeRecord,
      originalTaxDecisionId: decision.decisionId,
      taxRoundingPolicy: result.taxRoundingPolicy,
      units,
    }),
  });
};
