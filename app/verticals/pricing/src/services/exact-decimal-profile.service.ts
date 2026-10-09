import {
  PRICING_ARITHMETIC_PROFILE_VERSION,
  PricingCurrencyMismatchFailure,
  PricingDecimalRangeFailure,
  PricingDecimalScaleFailure,
  addPricingExactDecimals,
  ensurePricingMoneyCurrencyCompatibility,
  multiplyPricingExactDecimals,
  parsePricingExactDecimal,
  resolvePricingAllocationProfile,
  resolvePricingArithmeticProfile,
  resolvePricingPublicationProfile,
  subtractPricingExactDecimals,
} from '@app/pricing-contracts/domain/exact-decimal';
import type {
  PricingAllocationProfile,
  PricingArithmeticProfile,
  PricingCzkPublicationProfile,
  PricingExactDecimal,
  PricingExactMoney,
} from '@app/pricing-contracts/domain/exact-decimal';
import { Effect } from 'effect';

export interface PricingArithmeticContextInput {
  readonly currencyCode: PricingExactMoney['currencyCode'];
  readonly intermediateAmounts: readonly PricingExactMoney[];
  readonly profileVersions: {
    readonly allocation: string;
    readonly arithmetic: string;
    readonly publication: string;
  };
  readonly quantities: readonly string[];
  readonly sourceAmounts: readonly PricingExactMoney[];
}

export interface PricingArithmeticContextReady {
  readonly currencyCode: PricingExactMoney['currencyCode'];
  readonly intermediateAmounts: readonly PricingExactMoney[];
  readonly outcome: 'ARITHMETIC_CONTEXT_READY';
  readonly profiles: {
    readonly allocation: PricingAllocationProfile;
    readonly arithmetic: PricingArithmeticProfile;
    readonly publication: PricingCzkPublicationProfile;
  };
  readonly quantities: readonly PricingExactDecimal[];
  readonly sourceAmounts: readonly PricingExactMoney[];
}

export type PricingExactMoneyOperationInput =
  | {
      readonly currencyCode: PricingExactMoney['currencyCode'];
      readonly left: PricingExactMoney;
      readonly operation: 'ADD' | 'SUBTRACT';
      readonly profileVersion?: string;
      readonly right: PricingExactMoney;
    }
  | {
      readonly currencyCode: PricingExactMoney['currencyCode'];
      readonly operation: 'MULTIPLY_AMOUNT_BY_QUANTITY';
      readonly profileVersion?: string;
      readonly quantity: string;
      readonly sourceAmount: PricingExactMoney;
    };

const decimalScale = (value: string): number => value.split('.')[1]?.length ?? 0;
const decimalIntegerDigits = (value: string): number => {
  const unsigned = value.startsWith('-') ? value.slice(1) : value;
  return unsigned.split('.')[0]?.length ?? 1;
};

const parseAtBounds = Effect.fn('ExactDecimalProfileService.parseAtBounds')(function* parseAtBounds(
  input: string,
  maximumScale: number,
  maximumIntegerDigits: number,
  profileVersion: string,
) {
  const value = yield* parsePricingExactDecimal(input, profileVersion);
  const actualScale = decimalScale(value);
  if (actualScale > maximumScale) {
    return yield* new PricingDecimalScaleFailure({
      actualScale,
      input: value,
      maximumScale,
      profileVersion,
    });
  }
  const actualIntegerDigits = decimalIntegerDigits(value);
  if (actualIntegerDigits > maximumIntegerDigits) {
    return yield* new PricingDecimalRangeFailure({
      actualIntegerDigits,
      input: value,
      maximumIntegerDigits,
      profileVersion,
    });
  }
  return value;
});

const validateMoneyEffect = Effect.fn('ExactDecimalProfileService.validateMoney')(function* validateMoney(
  input: PricingExactMoney,
  currencyCode: PricingExactMoney['currencyCode'],
  maximumScale: number,
  maximumIntegerDigits: number,
  profileVersion: string,
) {
  yield* ensurePricingMoneyCurrencyCompatibility({ amount: '0', currencyCode }, input);
  const amount = yield* parseAtBounds(input.amount, maximumScale, maximumIntegerDigits, profileVersion);
  return { amount, currencyCode: input.currencyCode } satisfies PricingExactMoney;
});

const validateAll = <A, E>(values: readonly A[], validate: (value: A) => Effect.Effect<A, E>) =>
  Effect.forEach(values, validate, { concurrency: 16 });

/**
 * Resolves one explicit arithmetic/allocation/publication profile set and validates every
 * currency-bearing contributor before calculation. It does not activate currencies, convert
 * amounts, quantize intermediates, or perform the final publication rounding owned by #781.
 */
export const validatePricingArithmeticContext = Effect.fn(
  'ExactDecimalProfileService.validatePricingArithmeticContext',
)(function* validatePricingArithmeticContext(input: PricingArithmeticContextInput) {
  const { allocation, arithmetic, publication } = yield* Effect.all(
    {
      allocation: resolvePricingAllocationProfile(input.profileVersions.allocation),
      arithmetic: resolvePricingArithmeticProfile(input.profileVersions.arithmetic),
      publication: resolvePricingPublicationProfile(input.profileVersions.publication),
    },
    { concurrency: 3 },
  );

  if (publication.currencyCode !== input.currencyCode) {
    return yield* new PricingCurrencyMismatchFailure({
      leftCurrencyCode: input.currencyCode,
      rightCurrencyCode: publication.currencyCode,
    });
  }

  const sourceAmounts = yield* validateAll(input.sourceAmounts, (money) =>
    validateMoneyEffect(
      money,
      input.currencyCode,
      arithmetic.acceptedSourceAmountScale,
      arithmetic.maximumSourceAmountIntegerDigits,
      arithmetic.profileVersion,
    ),
  );
  const quantities = yield* validateAll(input.quantities, (quantity) =>
    parseAtBounds(
      quantity,
      arithmetic.acceptedSourceAmountScale,
      arithmetic.maximumSourceAmountIntegerDigits,
      arithmetic.profileVersion,
    ),
  );
  const intermediateAmounts = yield* validateAll(input.intermediateAmounts, (money) =>
    validateMoneyEffect(
      money,
      input.currencyCode,
      arithmetic.maximumScale,
      arithmetic.maximumIntegerDigits,
      arithmetic.profileVersion,
    ),
  );

  return {
    currencyCode: input.currencyCode,
    intermediateAmounts,
    outcome: 'ARITHMETIC_CONTEXT_READY',
    profiles: { allocation, arithmetic, publication },
    quantities,
    sourceAmounts,
  } satisfies PricingArithmeticContextReady;
});

/** Exact, bounded arithmetic only. Price/Tier selection and line-value semantics belong to later issues. */
export const executePricingExactMoneyOperation = Effect.fn(
  'ExactDecimalProfileService.executePricingExactMoneyOperation',
)(function* executePricingExactMoneyOperation(input: PricingExactMoneyOperationInput) {
  const profileVersion = input.profileVersion ?? PRICING_ARITHMETIC_PROFILE_VERSION;
  const profile = yield* resolvePricingArithmeticProfile(profileVersion);

  if (input.operation === 'MULTIPLY_AMOUNT_BY_QUANTITY') {
    const sourceAmount = yield* validateMoneyEffect(
      input.sourceAmount,
      input.currencyCode,
      profile.acceptedSourceAmountScale,
      profile.maximumSourceAmountIntegerDigits,
      profile.profileVersion,
    );
    const quantity = yield* parseAtBounds(
      input.quantity,
      profile.acceptedSourceAmountScale,
      profile.maximumSourceAmountIntegerDigits,
      profile.profileVersion,
    );
    const amount = yield* multiplyPricingExactDecimals(sourceAmount.amount, quantity, profile.profileVersion);
    return { amount, currencyCode: input.currencyCode } satisfies PricingExactMoney;
  }

  const left = yield* validateMoneyEffect(
    input.left,
    input.currencyCode,
    profile.maximumScale,
    profile.maximumIntegerDigits,
    profile.profileVersion,
  );
  const right = yield* validateMoneyEffect(
    input.right,
    input.currencyCode,
    profile.maximumScale,
    profile.maximumIntegerDigits,
    profile.profileVersion,
  );
  const operation =
    input.operation === 'ADD'
      ? addPricingExactDecimals(left.amount, right.amount, profile.profileVersion)
      : subtractPricingExactDecimals(left.amount, right.amount, profile.profileVersion);
  const amount = yield* operation;
  return { amount, currencyCode: input.currencyCode } satisfies PricingExactMoney;
});
