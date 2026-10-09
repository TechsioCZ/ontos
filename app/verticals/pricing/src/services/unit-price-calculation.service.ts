import { PRICING_ARITHMETIC_PROFILE_VERSION } from '@app/pricing-contracts/domain/exact-decimal';
import type {
  PricingUnitPriceCalculationAttempt,
  PricingUnitPriceCalculationFailure,
  PricingUnitPriceCalculationSuccess,
  PricingUnitPriceMoney,
} from '@app/pricing-contracts/domain/unit-price-calculation';
import {
  PricingUnitPriceCalculationSuccessSchema,
  PricingUnitPriceCurrencyFailure,
  PricingUnitPriceInvalidFailure,
  PricingUnitPricePrecisionFailure,
} from '@app/pricing-contracts/domain/unit-price-calculation';
import { Effect, Match, Schema } from 'effect';

import { executePricingExactMoneyOperation } from './exact-decimal-profile.service.ts';
import { validateUnitPriceMaterialEvidence } from './unit-price-material-evidence.service.ts';

const encodeSuccess = Schema.encodeEffect(PricingUnitPriceCalculationSuccessSchema);

/** Exact arithmetic seam; it deliberately does not apply publication rounding. */
const calculateExactBaseLineValue = (input: {
  readonly lineQuantity: string;
  readonly unitPrice: PricingUnitPriceMoney;
}) =>
  executePricingExactMoneyOperation({
    currencyCode: input.unitPrice.currencyCode,
    operation: 'MULTIPLY_AMOUNT_BY_QUANTITY',
    profileVersion: PRICING_ARITHMETIC_PROFILE_VERSION,
    quantity: input.lineQuantity,
    sourceAmount: input.unitPrice,
  });

/**
 * Composes already-resolved owner facts into one exact pre-Tax Unit Price and Base Line Value.
 * Price resolution, Tier selection, Quantity conversion, contributions, and publication rounding
 * remain outside this arithmetic boundary.
 */
export const calculatePricingUnitPrice = Effect.fn('UnitPriceCalculationService.calculate')(
  function* calculatePricingUnitPriceProgram(
    attempt: PricingUnitPriceCalculationAttempt,
  ): Effect.fn.Return<PricingUnitPriceCalculationSuccess, PricingUnitPriceCalculationFailure> {
    const input = yield* validateUnitPriceMaterialEvidence(attempt);
    const unitPrice = input.tierSelection.resultingUnitPrice;
    const baseLineValue = yield* calculateExactBaseLineValue({
      lineQuantity: input.lineQuantity.quantity,
      unitPrice,
    }).pipe(
      Effect.mapError((cause) =>
        Match.value(cause).pipe(
          Match.tag(
            'PricingCurrencyMismatchFailure',
            (currencyCause) =>
              new PricingUnitPriceCurrencyFailure({
                cause: currencyCause,
                occurrenceId: attempt.line.occurrenceId,
              }),
          ),
          Match.orElse(
            (precisionCause) =>
              new PricingUnitPricePrecisionFailure({
                cause: precisionCause,
                occurrenceId: attempt.line.occurrenceId,
              }),
          ),
        ),
      ),
    );

    const result = {
      _tag: 'UNIT_PRICE_CALCULATED',
      arithmeticProfileVersion: PRICING_ARITHMETIC_PROFILE_VERSION,
      baseLineValue,
      input,
      monetaryBoundary: 'PRE_TAX',
      resultingQuantity: input.quantityBasis.resultingPurchaseQuantity,
      unitPrice,
    } satisfies PricingUnitPriceCalculationSuccess;
    yield* encodeSuccess(result).pipe(
      Effect.catchTag('SchemaError', () =>
        Effect.fail(
          new PricingUnitPriceInvalidFailure({
            occurrenceId: attempt.line.occurrenceId,
            reason: 'LINE_BINDING_INVALID',
          }),
        ),
      ),
    );
    return result;
  },
);
