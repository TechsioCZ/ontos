import { Effect, Schema } from 'effect';

import { PricingCurrencyCodeSchema } from '../apis/current-supported-currencies.ts';

export const PRICING_EXACT_DECIMAL_PRECISION = 76;
export const PRICING_EXACT_DECIMAL_SCALE = 18;
export const PRICING_SOURCE_AMOUNT_PRECISION = 38;
export const PRICING_SOURCE_AMOUNT_SCALE = 9;
export const PRICING_SOURCE_AMOUNT_INTEGER_DIGITS = PRICING_SOURCE_AMOUNT_PRECISION - PRICING_SOURCE_AMOUNT_SCALE;
export const PRICING_EXACT_DECIMAL_INTEGER_DIGITS = PRICING_EXACT_DECIMAL_PRECISION - PRICING_EXACT_DECIMAL_SCALE;

export const PRICING_ARITHMETIC_PROFILE_VERSION = 'pricing-arithmetic-v1' as const;
export const PRICING_ALLOCATION_PROFILE_VERSION = 'pricing-allocation-v1' as const;
export const PRICING_CZK_PUBLICATION_PROFILE_VERSION = 'pricing-czk-publication-v1' as const;

const canonicalDecimalPattern = /^-?(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/u;

interface DecimalParts {
  readonly coefficient: bigint;
  readonly scale: number;
}

export const PricingDecimalOperationSchema = Schema.Literals(['ADD', 'SUBTRACT', 'MULTIPLY']);
export type PricingDecimalOperation = typeof PricingDecimalOperationSchema.Type;

const partsFromCanonical = (value: string): DecimalParts => {
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [integer = '0', fraction = ''] = unsigned.split('.');
  const coefficient = BigInt(`${integer}${fraction}`);
  return { coefficient: negative ? -coefficient : coefficient, scale: fraction.length };
};

const normalizeParts = ({ coefficient, scale }: DecimalParts): DecimalParts => {
  if (coefficient === 0n) {
    return { coefficient: 0n, scale: 0 };
  }
  let normalizedCoefficient = coefficient;
  let normalizedScale = scale;
  while (normalizedScale > 0 && normalizedCoefficient % 10n === 0n) {
    normalizedCoefficient /= 10n;
    normalizedScale -= 1;
  }
  return { coefficient: normalizedCoefficient, scale: normalizedScale };
};

const formatParts = (parts: DecimalParts): string => {
  const { coefficient, scale } = normalizeParts(parts);
  if (scale === 0) {
    return coefficient.toString();
  }
  const negative = coefficient < 0n;
  const digits = (negative ? -coefficient : coefficient).toString().padStart(scale + 1, '0');
  const splitAt = digits.length - scale;
  return `${negative ? '-' : ''}${digits.slice(0, splitAt)}.${digits.slice(splitAt)}`;
};

const decimalScale = (value: string): number => value.split('.')[1]?.length ?? 0;
const integerDigits = (value: string): number => {
  const unsigned = value.startsWith('-') ? value.slice(1) : value;
  return unsigned.split('.')[0]?.length ?? 1;
};

const exactDecimalBounds = Schema.makeFilter((value: string) => {
  if (!canonicalDecimalPattern.test(value) || value === '-0') {
    return 'Pricing exact decimal must use canonical base-10 notation';
  }
  if (decimalScale(value) > PRICING_EXACT_DECIMAL_SCALE) {
    return `Pricing exact decimal scale must not exceed ${PRICING_EXACT_DECIMAL_SCALE}`;
  }
  return integerDigits(value) <= PRICING_EXACT_DECIMAL_INTEGER_DIGITS
    ? undefined
    : `Pricing exact decimal integer digits must not exceed ${PRICING_EXACT_DECIMAL_INTEGER_DIGITS}`;
});

export const PricingExactDecimalSchema = Schema.String.check(exactDecimalBounds);
export type PricingExactDecimal = typeof PricingExactDecimalSchema.Type;

export const PricingExactNonNegativeDecimalSchema = PricingExactDecimalSchema.check(
  Schema.makeFilter((value) => (value.startsWith('-') ? 'Pricing exact decimal must be non-negative' : undefined)),
);
export type PricingExactNonNegativeDecimal = typeof PricingExactNonNegativeDecimalSchema.Type;

export const PricingExactPositiveDecimalSchema = PricingExactNonNegativeDecimalSchema.check(
  Schema.makeFilter((value) => (value === '0' ? 'Pricing exact decimal must be positive' : undefined)),
);
export type PricingExactPositiveDecimal = typeof PricingExactPositiveDecimalSchema.Type;

export const PricingExactNonPositiveDecimalSchema = PricingExactDecimalSchema.check(
  Schema.makeFilter((value) =>
    value.startsWith('-') || value === '0' ? undefined : 'Pricing exact decimal must be non-positive',
  ),
);
export type PricingExactNonPositiveDecimal = typeof PricingExactNonPositiveDecimalSchema.Type;

export const PricingExactMoneySchema = Schema.Struct({
  amount: PricingExactDecimalSchema,
  currencyCode: PricingCurrencyCodeSchema,
});
export type PricingExactMoney = typeof PricingExactMoneySchema.Type;

export const PricingArithmeticProfileSchema = Schema.Struct({
  acceptedSourceAmountPrecision: Schema.Literal(PRICING_SOURCE_AMOUNT_PRECISION),
  acceptedSourceAmountScale: Schema.Literal(PRICING_SOURCE_AMOUNT_SCALE),
  maximumIntegerDigits: Schema.Literal(PRICING_EXACT_DECIMAL_INTEGER_DIGITS),
  maximumPrecision: Schema.Literal(PRICING_EXACT_DECIMAL_PRECISION),
  maximumScale: Schema.Literal(PRICING_EXACT_DECIMAL_SCALE),
  maximumSourceAmountIntegerDigits: Schema.Literal(PRICING_SOURCE_AMOUNT_INTEGER_DIGITS),
  profileKind: Schema.Literal('ARITHMETIC'),
  profileVersion: Schema.Literal(PRICING_ARITHMETIC_PROFILE_VERSION),
});
export type PricingArithmeticProfile = typeof PricingArithmeticProfileSchema.Type;
export const PRICING_ARITHMETIC_PROFILE: PricingArithmeticProfile = {
  acceptedSourceAmountPrecision: PRICING_SOURCE_AMOUNT_PRECISION,
  acceptedSourceAmountScale: PRICING_SOURCE_AMOUNT_SCALE,
  maximumIntegerDigits: PRICING_EXACT_DECIMAL_INTEGER_DIGITS,
  maximumPrecision: PRICING_EXACT_DECIMAL_PRECISION,
  maximumScale: PRICING_EXACT_DECIMAL_SCALE,
  maximumSourceAmountIntegerDigits: PRICING_SOURCE_AMOUNT_INTEGER_DIGITS,
  profileKind: 'ARITHMETIC',
  profileVersion: PRICING_ARITHMETIC_PROFILE_VERSION,
};

export const PricingAllocationProfileSchema = Schema.Struct({
  maximumIntegerDigits: Schema.Literal(PRICING_EXACT_DECIMAL_INTEGER_DIGITS),
  maximumPrecision: Schema.Literal(PRICING_EXACT_DECIMAL_PRECISION),
  maximumScale: Schema.Literal(PRICING_EXACT_DECIMAL_SCALE),
  profileKind: Schema.Literal('ALLOCATION'),
  profileVersion: Schema.Literal(PRICING_ALLOCATION_PROFILE_VERSION),
  remainderRule: Schema.Literal('LARGEST_FRACTION_THEN_STABLE_OCCURRENCE_ID_ASC'),
});
export type PricingAllocationProfile = typeof PricingAllocationProfileSchema.Type;
export const PRICING_ALLOCATION_PROFILE: PricingAllocationProfile = {
  maximumIntegerDigits: PRICING_EXACT_DECIMAL_INTEGER_DIGITS,
  maximumPrecision: PRICING_EXACT_DECIMAL_PRECISION,
  maximumScale: PRICING_EXACT_DECIMAL_SCALE,
  profileKind: 'ALLOCATION',
  profileVersion: PRICING_ALLOCATION_PROFILE_VERSION,
  remainderRule: 'LARGEST_FRACTION_THEN_STABLE_OCCURRENCE_ID_ASC',
};

export const PricingCzkPublicationProfileSchema = Schema.Struct({
  currencyCode: Schema.Literal('CZK'),
  profileKind: Schema.Literal('PUBLICATION'),
  profileVersion: Schema.Literal(PRICING_CZK_PUBLICATION_PROFILE_VERSION),
  publishedScale: Schema.Literal(2),
  quantum: Schema.Literal('0.01'),
  roundingMode: Schema.Literal('HALF_UP'),
});
export type PricingCzkPublicationProfile = typeof PricingCzkPublicationProfileSchema.Type;
export const PRICING_CZK_PUBLICATION_PROFILE: PricingCzkPublicationProfile = {
  currencyCode: 'CZK',
  profileKind: 'PUBLICATION',
  profileVersion: PRICING_CZK_PUBLICATION_PROFILE_VERSION,
  publishedScale: 2,
  quantum: '0.01',
  roundingMode: 'HALF_UP',
};

const failureInput = Schema.String.check(Schema.isMaxLength(160));
const nonNegativeInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export class PricingDecimalFormatFailure extends Schema.TaggedError<PricingDecimalFormatFailure>()(
  'PricingDecimalFormatFailure',
  {
    input: failureInput,
    reason: Schema.Literal('NON_CANONICAL_BASE_10'),
  },
) {}

export class PricingDecimalSignFailure extends Schema.TaggedError<PricingDecimalSignFailure>()(
  'PricingDecimalSignFailure',
  {
    actual: PricingExactDecimalSchema,
    requiredSign: Schema.Literals(['NON_NEGATIVE', 'POSITIVE', 'NON_POSITIVE']),
  },
) {}

export class PricingDecimalScaleFailure extends Schema.TaggedError<PricingDecimalScaleFailure>()(
  'PricingDecimalScaleFailure',
  {
    actualScale: nonNegativeInteger,
    input: failureInput,
    maximumScale: nonNegativeInteger,
    profileVersion: Schema.String,
  },
) {}

export class PricingDecimalRangeFailure extends Schema.TaggedError<PricingDecimalRangeFailure>()(
  'PricingDecimalRangeFailure',
  {
    actualIntegerDigits: nonNegativeInteger,
    input: failureInput,
    maximumIntegerDigits: nonNegativeInteger,
    profileVersion: Schema.String,
  },
) {}

export class PricingDecimalOverflowFailure extends Schema.TaggedError<PricingDecimalOverflowFailure>()(
  'PricingDecimalOverflowFailure',
  {
    left: PricingExactDecimalSchema,
    limitKind: Schema.Literals(['INTEGER_DIGITS', 'SCALE']),
    operation: PricingDecimalOperationSchema,
    profileVersion: Schema.String,
    right: PricingExactDecimalSchema,
  },
) {}

export class PricingCurrencyMismatchFailure extends Schema.TaggedError<PricingCurrencyMismatchFailure>()(
  'PricingCurrencyMismatchFailure',
  {
    leftCurrencyCode: PricingCurrencyCodeSchema,
    rightCurrencyCode: PricingCurrencyCodeSchema,
  },
) {}

export class PricingUnsupportedProfileFailure extends Schema.TaggedError<PricingUnsupportedProfileFailure>()(
  'PricingUnsupportedProfileFailure',
  {
    profileKind: Schema.Literals(['ARITHMETIC', 'ALLOCATION', 'PUBLICATION']),
    requestedProfileVersion: Schema.String,
  },
) {}

export type PricingDecimalParseFailure =
  | PricingDecimalFormatFailure
  | PricingDecimalRangeFailure
  | PricingDecimalScaleFailure
  | PricingUnsupportedProfileFailure;

export type PricingDecimalArithmeticFailure = PricingDecimalOverflowFailure | PricingDecimalParseFailure;

export const resolvePricingArithmeticProfile = (
  profileVersion: string,
): Effect.Effect<PricingArithmeticProfile, PricingUnsupportedProfileFailure> => {
  if (profileVersion === PRICING_ARITHMETIC_PROFILE_VERSION) {
    return Effect.succeed(PRICING_ARITHMETIC_PROFILE);
  }
  return Effect.fail(
    new PricingUnsupportedProfileFailure({ profileKind: 'ARITHMETIC', requestedProfileVersion: profileVersion }),
  );
};

export const resolvePricingAllocationProfile = (
  profileVersion: string,
): Effect.Effect<PricingAllocationProfile, PricingUnsupportedProfileFailure> => {
  if (profileVersion === PRICING_ALLOCATION_PROFILE_VERSION) {
    return Effect.succeed(PRICING_ALLOCATION_PROFILE);
  }
  return Effect.fail(
    new PricingUnsupportedProfileFailure({ profileKind: 'ALLOCATION', requestedProfileVersion: profileVersion }),
  );
};

export const resolvePricingPublicationProfile = (
  profileVersion: string,
): Effect.Effect<PricingCzkPublicationProfile, PricingUnsupportedProfileFailure> => {
  if (profileVersion === PRICING_CZK_PUBLICATION_PROFILE_VERSION) {
    return Effect.succeed(PRICING_CZK_PUBLICATION_PROFILE);
  }
  return Effect.fail(
    new PricingUnsupportedProfileFailure({ profileKind: 'PUBLICATION', requestedProfileVersion: profileVersion }),
  );
};

export const parsePricingExactDecimal: (
  input: string,
  profileVersion?: string,
) => Effect.Effect<PricingExactDecimal, PricingDecimalParseFailure> = Effect.fn('ExactDecimal.parse')(
  function* parsePricingExactDecimalProgram(
    input: string,
    profileVersion: string = PRICING_ARITHMETIC_PROFILE_VERSION,
  ) {
    const profile = yield* resolvePricingArithmeticProfile(profileVersion);
    if (input.length > 160 || !canonicalDecimalPattern.test(input) || input === '-0') {
      return yield* new PricingDecimalFormatFailure({
        input: input.slice(0, 160),
        reason: 'NON_CANONICAL_BASE_10',
      });
    }
    const scale = decimalScale(input);
    if (scale > profile.maximumScale) {
      return yield* new PricingDecimalScaleFailure({
        actualScale: scale,
        input,
        maximumScale: profile.maximumScale,
        profileVersion,
      });
    }
    const digits = integerDigits(input);
    if (digits > profile.maximumIntegerDigits) {
      return yield* new PricingDecimalRangeFailure({
        actualIntegerDigits: digits,
        input,
        maximumIntegerDigits: profile.maximumIntegerDigits,
        profileVersion,
      });
    }
    return input;
  },
);

export const formatPricingExactDecimal = (value: PricingExactDecimal): string => value;

const alignedCoefficient = (parts: DecimalParts, scale: number): bigint =>
  parts.coefficient * 10n ** BigInt(scale - parts.scale);

export const comparePricingExactDecimals = (left: PricingExactDecimal, right: PricingExactDecimal): -1 | 0 | 1 => {
  const leftParts = partsFromCanonical(left);
  const rightParts = partsFromCanonical(right);
  const scale = Math.max(leftParts.scale, rightParts.scale);
  const alignedLeft = alignedCoefficient(leftParts, scale);
  const alignedRight = alignedCoefficient(rightParts, scale);
  if (alignedLeft < alignedRight) {
    return -1;
  }
  return alignedLeft > alignedRight ? 1 : 0;
};

export const ensurePricingDecimalSign = (
  value: PricingExactDecimal,
  requiredSign: 'NON_NEGATIVE' | 'POSITIVE' | 'NON_POSITIVE',
): Effect.Effect<PricingExactDecimal, PricingDecimalSignFailure> => {
  const comparison = comparePricingExactDecimals(value, '0');
  let valid = comparison <= 0;
  if (requiredSign === 'NON_NEGATIVE') {
    valid = comparison >= 0;
  } else if (requiredSign === 'POSITIVE') {
    valid = comparison > 0;
  }
  return valid ? Effect.succeed(value) : Effect.fail(new PricingDecimalSignFailure({ actual: value, requiredSign }));
};

const checkedOperationResult = (
  left: PricingExactDecimal,
  right: PricingExactDecimal,
  operation: PricingDecimalOperation,
  parts: DecimalParts,
  profile: PricingArithmeticProfile,
): Effect.Effect<PricingExactDecimal, PricingDecimalOverflowFailure> => {
  const formatted = formatParts(parts);
  if (decimalScale(formatted) > profile.maximumScale) {
    return Effect.fail(
      new PricingDecimalOverflowFailure({
        left,
        limitKind: 'SCALE',
        operation,
        profileVersion: profile.profileVersion,
        right,
      }),
    );
  }
  return integerDigits(formatted) > profile.maximumIntegerDigits
    ? Effect.fail(
        new PricingDecimalOverflowFailure({
          left,
          limitKind: 'INTEGER_DIGITS',
          operation,
          profileVersion: profile.profileVersion,
          right,
        }),
      )
    : Effect.succeed(formatted);
};

const binaryDecimalOperation: (
  left: string,
  right: string,
  operation: PricingDecimalOperation,
  profileVersion: string,
) => Effect.Effect<PricingExactDecimal, PricingDecimalArithmeticFailure> = Effect.fn('ExactDecimal.binaryOperation')(
  function* binaryDecimalOperationProgram(
    left: string,
    right: string,
    operation: PricingDecimalOperation,
    profileVersion: string,
  ) {
    const [profile, parsedLeft, parsedRight] = yield* Effect.all(
      [
        resolvePricingArithmeticProfile(profileVersion),
        parsePricingExactDecimal(left, profileVersion),
        parsePricingExactDecimal(right, profileVersion),
      ],
      { concurrency: 3 },
    );
    const leftParts = partsFromCanonical(parsedLeft);
    const rightParts = partsFromCanonical(parsedRight);
    if (operation === 'MULTIPLY') {
      return yield* checkedOperationResult(
        parsedLeft,
        parsedRight,
        operation,
        {
          coefficient: leftParts.coefficient * rightParts.coefficient,
          scale: leftParts.scale + rightParts.scale,
        },
        profile,
      );
    }
    const scale = Math.max(leftParts.scale, rightParts.scale);
    const leftCoefficient = alignedCoefficient(leftParts, scale);
    const rightCoefficient = alignedCoefficient(rightParts, scale);
    return yield* checkedOperationResult(
      parsedLeft,
      parsedRight,
      operation,
      {
        coefficient: operation === 'ADD' ? leftCoefficient + rightCoefficient : leftCoefficient - rightCoefficient,
        scale,
      },
      profile,
    );
  },
);

export const addPricingExactDecimals = (
  left: string,
  right: string,
  profileVersion: string = PRICING_ARITHMETIC_PROFILE_VERSION,
): Effect.Effect<PricingExactDecimal, PricingDecimalArithmeticFailure> =>
  binaryDecimalOperation(left, right, 'ADD', profileVersion);

export const subtractPricingExactDecimals = (
  left: string,
  right: string,
  profileVersion: string = PRICING_ARITHMETIC_PROFILE_VERSION,
): Effect.Effect<PricingExactDecimal, PricingDecimalArithmeticFailure> =>
  binaryDecimalOperation(left, right, 'SUBTRACT', profileVersion);

export const multiplyPricingExactDecimals = (
  left: string,
  right: string,
  profileVersion: string = PRICING_ARITHMETIC_PROFILE_VERSION,
): Effect.Effect<PricingExactDecimal, PricingDecimalArithmeticFailure> =>
  binaryDecimalOperation(left, right, 'MULTIPLY', profileVersion);

export const ensurePricingMoneyCurrencyCompatibility = (
  left: PricingExactMoney,
  right: PricingExactMoney,
): Effect.Effect<PricingExactMoney['currencyCode'], PricingCurrencyMismatchFailure> =>
  left.currencyCode === right.currencyCode
    ? Effect.succeed(left.currencyCode)
    : Effect.fail(
        new PricingCurrencyMismatchFailure({
          leftCurrencyCode: left.currencyCode,
          rightCurrencyCode: right.currencyCode,
        }),
      );
