import { Array as Arr, Match, Option, Order, Result, Schema, pipe } from 'effect';

import { originalUnitBaseline } from './accepted-tax-terms.ts';
import type { AcceptedTaxTerms, OriginalUnitBaseline } from './accepted-tax-terms.ts';
import {
  NonNegativeTaxExactRationalSchema,
  addTaxExactRationals,
  divideTaxExactRationals,
  isNonNegativeTaxExactRational,
  multiplyTaxExactRationals,
  subtractTaxExactRationals,
  taxExactRationalFromMinorUnits,
} from '../../shared/domain/tax-kernel/tax-exact-rational.ts';
import type { TaxExactRational } from '../../shared/domain/tax-kernel/tax-exact-rational.ts';
import { amountInBasis, exactTaxOfAmounts } from './tax-rounding.ts';
import { TAX_HISTORICAL_INPUT_UNRESOLVED } from '../../shared/domain/tax-kernel/tax-historical-input-outcome.ts';
import {
  CZK_MINOR_UNITS_PER_MAJOR_UNIT,
  publishedTaxAmountRoundedHalfUp,
  signedTaxMonetaryAmountFromMinorUnits,
  signedTaxMonetaryAmountMinorUnits,
  taxMonetaryAmountMinorUnits,
} from '../../shared/domain/tax-kernel/tax-monetary-amount.ts';
import type { TaxMonetaryAmount } from '../../shared/domain/tax-kernel/tax-monetary-amount.ts';
import {
  correctionComponentOf,
  isOutOfBoundsUnit,
  isUnresolvedUnit,
} from '../../shared/domain/tax-kernel/tax-correction-delta.ts';
import type {
  AcceptedCumulativeCorrectionState,
  CumulativeUnitTaxState,
  OutOfBoundsUnit,
  TaxCorrectionChange,
  TaxCorrectionOutcome,
  TaxCorrectionRequest,
  TaxCorrectionUnitDelta,
  TaxCorrectionUnitRequest,
  UnresolvedUnit,
} from '../../shared/domain/tax-kernel/tax-correction-delta.ts';

export {
  CumulativeUnitTaxStateSchema,
  OriginalRecordUnavailableSchema,
  TaxCorrectionDeltaSchema,
  TaxCorrectionHistoricalInputUnresolvedSchema,
  TaxCorrectionOutOfBoundsSchema,
  TaxCorrectionRequestSchema,
} from '../../shared/domain/tax-kernel/tax-correction-delta.ts';
export type {
  AcceptedCumulativeCorrectionState,
  TaxCorrectionChange,
  TaxCorrectionDelta,
  TaxCorrectionOutcome,
  TaxCorrectionRequest,
  TaxCorrectionUnitRequest,
} from '../../shared/domain/tax-kernel/tax-correction-delta.ts';

const isNonNegative = Schema.is(NonNegativeTaxExactRationalSchema);

const exactValueOf = (amount: TaxMonetaryAmount): TaxExactRational =>
  taxExactRationalFromMinorUnits(taxMonetaryAmountMinorUnits(amount), CZK_MINOR_UNITS_PER_MAJOR_UNIT);

const isAtMost = (value: TaxExactRational, limit: TaxExactRational) =>
  isNonNegativeTaxExactRational(subtractTaxExactRationals(limit, value));

/**
 * Published Tax of a remaining basis at the original unit's own treatment and the original single per-unit
 * boundary: the sum, never rounded before this boundary, of the exact § 37 písm. b) VAT of the remaining Line
 * Commercial Value at its own recorded amount basis and of the remaining Shipping share, always GROSS
 * (#948 F18, F21; #935 F12-F22; PO decision D3 on #907). Corrections use the same `exactTaxOfAmounts` as the
 * original sale, so any later change to exact VAT arithmetic reaches corrections automatically (Unit 12 B1).
 */
const publishedTaxOf = (baseline: OriginalUnitBaseline, line: TaxExactRational, shipping: TaxExactRational) => {
  const exact = exactTaxOfAmounts(
    [
      { amount: NonNegativeTaxExactRationalSchema.make(line), amountBasis: baseline.lineAmountBasis },
      { amount: NonNegativeTaxExactRationalSchema.make(shipping), amountBasis: 'GROSS' },
    ],
    baseline.treatment,
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
 * An Accepted state can only have followed from the original record by this arithmetic: remaining quantity and
 * Shipping share within the original, the remaining Line Commercial Value at most the original value per remaining
 * quantity (quantity reductions keep it pro rata, value reductions only lower it, so no goods value is left once no
 * quantity is left), and published at the original rate and boundary. Anything else is an unresolved historical input for Billing to recover, not a state TAX repairs
 * (#947 F13-F14, #948 F7).
 */
const followsFromOriginalRecord = (baseline: OriginalUnitBaseline, state: CumulativeUnitTaxState) =>
  isAtMost(state.remainingQuantity, baseline.originalQuantity) &&
  isAtMost(
    multiplyTaxExactRationals(state.remainingLineBasis, baseline.originalQuantity),
    multiplyTaxExactRationals(baseline.originalLineBasis, state.remainingQuantity),
  ) &&
  isAtMost(state.remainingShippingBasis, baseline.originalShippingBasis) &&
  publishedTaxOf(baseline, state.remainingLineBasis, state.remainingShippingBasis).published.amount ===
    state.remainingPublishedTax.amount;

/**
 * Next remaining goods component (quantity and Line Commercial Value) from at most one goods change. A quantity
 * reduction removes the same share of the remaining Line Commercial Value as of the remaining quantity, so earlier
 * value corrections are respected and returning the last quantity leaves no goods value. A Line Commercial Value
 * reduction converts its delta into the baseline's recorded line basis at the unit's own treatment before moving
 * that component, and never touches the quantity (F5; #948 F8, F10-F11, F22, F25).
 */
const nextGoods = (
  baseline: OriginalUnitBaseline,
  previous: CumulativeUnitTaxState,
  change: TaxCorrectionChange | undefined,
): Result.Result<{ line: TaxExactRational; quantity: TaxExactRational }, 'QUANTITY'> => {
  if (change === undefined) {
    return Result.succeed({ line: previous.remainingLineBasis, quantity: previous.remainingQuantity });
  }
  return Match.value(change).pipe(
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
              })),
            )
          : Result.fail('QUANTITY' as const);
      },
      VALUE: ({ amountBasis, valueDelta }) => {
        const delta = amountInBasis(valueDelta, amountBasis, baseline.lineAmountBasis, baseline.treatment);
        return Result.succeed({
          line: addTaxExactRationals(previous.remainingLineBasis, delta),
          quantity: previous.remainingQuantity,
        });
      },
    }),
  );
};

/**
 * Next remaining Shipping share from at most one explicit Shipping-value change, converted into the always-GROSS
 * recorded Shipping basis at the unit's own treatment (identity, since a Shipping change is always GROSS); a
 * quantity change never moves it, so arithmetic never invents a Shipping refund ("never 1/quantity", H5).
 */
const nextShipping = (
  baseline: OriginalUnitBaseline,
  previous: CumulativeUnitTaxState,
  change: TaxCorrectionChange | undefined,
): TaxExactRational =>
  change === undefined
    ? previous.remainingShippingBasis
    : Match.value(change).pipe(
        Match.tagsExhaustive({
          QUANTITY: () => previous.remainingShippingBasis,
          VALUE: ({ amountBasis, valueDelta }) =>
            addTaxExactRationals(
              previous.remainingShippingBasis,
              amountInBasis(valueDelta, amountBasis, 'GROSS', baseline.treatment),
            ),
        }),
      );

/**
 * Combines every failing basis component of a correction, so a unit may be reported with both an
 * `EXCEEDS_REMAINING_QUANTITY` and an `EXCEEDS_REMAINING_BASIS_COMPONENT` reason when a goods change and a Shipping
 * change each go out of bounds in the same correction (#948 F16, F24).
 */
const calculateUnit = (
  terms: AcceptedTaxTerms,
  request: TaxCorrectionUnitRequest,
): Result.Result<TaxCorrectionUnitDelta, UnresolvedUnit | readonly OutOfBoundsUnit[]> => {
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

  const goodsChange = Arr.findFirst(request.changes, (change) => correctionComponentOf(change) === 'GOODS');
  const shippingChange = Arr.findFirst(request.changes, (change) => correctionComponentOf(change) === 'SHIPPING');

  const goods = nextGoods(baseline, previous, Option.getOrUndefined(goodsChange));
  const shipping = nextShipping(baseline, previous, Option.getOrUndefined(shippingChange));

  const quantityOutOfBounds = Result.isFailure(goods);
  const lineOutOfBounds = Result.isSuccess(goods) && !isNonNegative(goods.success.line);
  const shippingOutOfBounds = !isNonNegative(shipping);

  const outOfBounds: OutOfBoundsUnit[] = [
    ...(quantityOutOfBounds ? [{ reason: 'EXCEEDS_REMAINING_QUANTITY' as const, taxableSupplyUnitId }] : []),
    ...(lineOutOfBounds || shippingOutOfBounds
      ? [{ reason: 'EXCEEDS_REMAINING_BASIS_COMPONENT' as const, taxableSupplyUnitId }]
      : []),
  ];
  if (Arr.isReadonlyArrayNonEmpty(outOfBounds)) {
    return Result.fail(
      Arr.sort(
        outOfBounds.filter(isOutOfBoundsUnit),
        Order.mapInput(Order.String, (unit: OutOfBoundsUnit) => unit.reason),
      ),
    );
  }

  const line = Result.isSuccess(goods) ? goods.success.line : previous.remainingLineBasis;
  const quantity = Result.isSuccess(goods) ? goods.success.quantity : previous.remainingQuantity;
  if (!isNonNegative(line) || !isNonNegative(quantity) || !isNonNegative(shipping)) {
    return Result.fail([{ reason: 'EXCEEDS_REMAINING_BASIS_COMPONENT', taxableSupplyUnitId }]);
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
    treatment: baseline.treatment,
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
  const outOfBounds = issues.flatMap((issue) => (isUnresolvedUnit(issue) ? [] : issue.filter(isOutOfBoundsUnit)));
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
