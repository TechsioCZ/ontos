import { Array as Arr, Match, Option, Order, Result, Schema, pipe } from 'effect';

import {
  AcceptedTaxTermsSchema,
  AuthoritativeOriginalAcceptedRecordSchema,
  OrderLineageSchema,
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
import type { TaxExactRational } from './tax-exact-rational.ts';
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
export type TaxCorrectionFacts = typeof TaxCorrectionFactsSchema.Type;

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

const UnresolvedUnitSchema = Schema.Struct({
  reason: TaxHistoricalInputUnresolvedReasonSchema,
  taxableSupplyUnitId: TaxableSupplyUnitIdSchema,
});
type UnresolvedUnit = typeof UnresolvedUnitSchema.Type;
const isUnresolvedUnit = Schema.is(UnresolvedUnitSchema);

const OutOfBoundsUnitSchema = Schema.Struct({
  reason: Schema.Literals(['EXCEEDS_REMAINING_QUANTITY', 'EXCEEDS_REMAINING_BASIS_COMPONENT']),
  taxableSupplyUnitId: TaxableSupplyUnitIdSchema,
});
type OutOfBoundsUnit = typeof OutOfBoundsUnitSchema.Type;
const isOutOfBoundsUnit = Schema.is(OutOfBoundsUnitSchema);

/**
 * Explicit unresolved historical input (#947 F13, #948 F7, PO default D4): the Authoritative Original Accepted Record
 * handed over is incomplete or ambiguous as a whole, or named units cannot be established from it. No Tax amount,
 * guessed zero or Current-source fallback.
 */
export const TaxCorrectionHistoricalInputUnresolvedSchema = Schema.TaggedStruct(TAX_HISTORICAL_INPUT_UNRESOLVED, {
  unresolved: Schema.Union([
    Schema.TaggedStruct('ORIGINAL_RECORD_INCOMPLETE', {}),
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

const isNonNegative = Schema.is(NonNegativeTaxExactRationalSchema);

const exactValueOf = (amount: TaxMonetaryAmount): TaxExactRational =>
  taxExactRationalFromMinorUnits(taxMonetaryAmountMinorUnits(amount), CZK_MINOR_UNITS_PER_MAJOR_UNIT);

const isAtMost = (value: TaxExactRational, limit: TaxExactRational) =>
  isNonNegativeTaxExactRational(subtractTaxExactRationals(limit, value));

const isZero = (value: TaxExactRational) => value.numerator === '0';

/**
 * Published Tax of a remaining basis at the original rate and the original single per-unit boundary; the basis is the
 * exact sum of its components, never rounded before this boundary (#948 F18, F21; #935 F12-F22).
 */
const publishedTaxOf = (baseline: OriginalUnitBaseline, line: TaxExactRational, shipping: TaxExactRational) => {
  const exact = NonNegativeTaxExactRationalSchema.make(
    multiplyTaxExactRationals(addTaxExactRationals(line, shipping), baseline.rate),
  );
  const published = publishedTaxAmountRoundedHalfUp(exact);
  return { adjustment: subtractTaxExactRationals(exactValueOf(published), exact), exact, published };
};

/** The original record is the initial Accepted state of every unit (#948 F19). */
const initialState = (baseline: OriginalUnitBaseline): CumulativeUnitTaxState => ({
  remainingLineBasis: baseline.originalLineBasis,
  remainingPublishedTax: baseline.originalPublishedTax,
  remainingQuantity: NonNegativeTaxExactRationalSchema.make(baseline.originalQuantity),
  remainingShippingBasis: baseline.originalShippingBasis,
});

const previousStateOf = (baseline: OriginalUnitBaseline, expected: AcceptedCumulativeCorrectionState) =>
  Match.value(expected).pipe(
    Match.tagsExhaustive({
      ACCEPTED: ({ state }) => state,
      NO_ACCEPTED_CORRECTION: () => initialState(baseline),
    }),
  );

/**
 * An Accepted state can only have followed from the original record by this arithmetic: each remaining quantity and
 * basis component within the original, no goods value left once no quantity is left, and published at the original
 * rate and boundary. Anything else is an unresolved historical input for Billing to recover, not a state TAX repairs
 * (#947 F13-F14, #948 F7).
 */
const followsFromOriginalRecord = (baseline: OriginalUnitBaseline, state: CumulativeUnitTaxState) =>
  isAtMost(state.remainingQuantity, baseline.originalQuantity) &&
  isAtMost(state.remainingLineBasis, baseline.originalLineBasis) &&
  isAtMost(state.remainingShippingBasis, baseline.originalShippingBasis) &&
  (!isZero(state.remainingQuantity) || isZero(state.remainingLineBasis)) &&
  publishedTaxOf(baseline, state.remainingLineBasis, state.remainingShippingBasis).published.amount ===
    state.remainingPublishedTax.amount;

/**
 * Next remaining quantity and basis components. A quantity reduction removes the same share of the remaining Line
 * Commercial Value as of the remaining quantity, so earlier value corrections are respected and returning the last
 * quantity leaves no goods value; an allocated Shipping share changes only through an explicit value reduction of
 * that component, so arithmetic never invents a Shipping refund. A value reduction moves exactly the named component
 * (#948 F8, F10-F11, F22, F25).
 */
const nextRemaining = (
  previous: CumulativeUnitTaxState,
  change: TaxCorrectionChange,
): Result.Result<{ line: TaxExactRational; quantity: TaxExactRational; shipping: TaxExactRational }, 'QUANTITY'> =>
  Match.value(change).pipe(
    Match.tagsExhaustive({
      QUANTITY: ({ quantityDelta }) => {
        const quantity = addTaxExactRationals(previous.remainingQuantity, quantityDelta);
        return isNonNegativeTaxExactRational(quantity)
          ? Result.fromOption(
              divideTaxExactRationals(quantity, previous.remainingQuantity),
              () => 'QUANTITY' as const,
            ).pipe(
              Result.map((share) => ({
                line: multiplyTaxExactRationals(previous.remainingLineBasis, share),
                quantity,
                shipping: previous.remainingShippingBasis,
              })),
            )
          : Result.fail('QUANTITY' as const);
      },
      VALUE: ({ basisComponent, valueDelta }) =>
        Result.succeed({
          line:
            basisComponent === 'LINE_COMMERCIAL_VALUE'
              ? addTaxExactRationals(previous.remainingLineBasis, valueDelta)
              : previous.remainingLineBasis,
          quantity: previous.remainingQuantity,
          shipping:
            basisComponent === 'SHIPPING_ALLOCATION'
              ? addTaxExactRationals(previous.remainingShippingBasis, valueDelta)
              : previous.remainingShippingBasis,
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
  const next = nextRemaining(previous, request.change);
  if (Result.isFailure(next) || !isNonNegative(next.success.quantity)) {
    return Result.fail({ reason: 'EXCEEDS_REMAINING_QUANTITY', taxableSupplyUnitId });
  }
  const { line, quantity, shipping } = next.success;
  if (!isNonNegative(quantity) || !isNonNegative(line) || !isNonNegative(shipping)) {
    return Result.fail({ reason: 'EXCEEDS_REMAINING_BASIS_COMPONENT', taxableSupplyUnitId });
  }
  const tax = publishedTaxOf(baseline, line, shipping);
  return Result.succeed({
    exactTaxContribution: tax.exact,
    expectedPreviousState: request.expectedPreviousState,
    previous,
    proposedNext: {
      remainingLineBasis: line,
      remainingPublishedTax: tax.published,
      remainingQuantity: quantity,
      remainingShippingBasis: shipping,
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
        ? { _tag: TAX_HISTORICAL_INPUT_UNRESOLVED, unresolved: { _tag: 'UNITS', units: unresolved } }
        : { _tag: 'TAX_CORRECTION_OUT_OF_BOUNDS', units: outOfBounds },
    onSuccess: (units): TaxCorrectionOutcome => ({
      _tag: 'TAX_CORRECTION_DELTA',
      correctionEventRef: request.correctionEventRef,
      correctionReason: request.correctionReason,
      correctionTaxDelta: signedTaxMonetaryAmountFromMinorUnits(
        units.reduce((total, unit) => total + signedTaxMonetaryAmountMinorUnits(unit.taxCorrectionDelta), 0n),
      ),
      currency: result.currency,
      originalOrderLineage: request.acceptedTaxTerms.orderLineage,
      originalRecord: request.acceptedTaxTerms.authoritativeRecord,
      originalTaxDecisionId: decision.decisionId,
      taxRoundingPolicy: result.taxRoundingPolicy,
      units,
    }),
  });
};
