import { BigDecimal, Context, DateTime, Duration, Effect, Option, Schema } from 'effect';
import type { SchemaError } from 'effect';

export const FxCurrencyCodeSchema = Schema.String.check(Schema.isPattern(/^[A-Z]{3}$/u));
export type FxCurrencyCode = typeof FxCurrencyCodeSchema.Type;

export const ExactDecimalSchema = Schema.String.check(
  Schema.isPattern(/^-?(?:0|[1-9]\d{0,37})(?:\.\d{1,18})?$/u),
);
export type ExactDecimal = typeof ExactDecimalSchema.Type;

const PositiveExactDecimalSchema = ExactDecimalSchema.check(
  Schema.makeFilter((value) =>
    /^0(?:\.0+)?$/u.test(value) || value.startsWith('-')
      ? 'Expected a positive non-zero decimal'
      : undefined,
  ),
);

const StableReferenceSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300));
const identifier = (brand: string) =>
  StableReferenceSchema.pipe(Schema.brand(brand), Schema.decodeTo(Schema.String));
const ChannelIdSchema = identifier('FxChannelId');
const ContextRevisionSchema = identifier('FxContextRevision');
const MarketIdSchema = identifier('FxMarketId');
const PolicyRevisionSchema = identifier('FxPolicyRevision');
const ProviderCorrelationRefSchema = identifier('FxProviderCorrelationRef');
const RateSourceIdSchema = identifier('FxRateSourceId');
const SellingLegalEntityIdSchema = identifier('FxSellingLegalEntityId');
const StorefrontIdSchema = identifier('FxStorefrontId');
const TenantIdSchema = identifier('FxTenantId');
const FxInstantSchema = Schema.DateTimeUtcFromString;

export const COMMERCIAL_FX_ARITHMETIC_VERSION = 'commercial-fx-arithmetic.v1' as const;
export const FxArithmeticVersionSchema = Schema.Literal(COMMERCIAL_FX_ARITHMETIC_VERSION);
const RoundingRuleRevisionSchema = identifier('FxRoundingRuleRevision');
export const COMMERCIAL_FX_ROUNDING_RULE = 'QUANTIZE_TO_INCREMENT' as const;
export const FxRoundingRuleSchema = Schema.Literal(COMMERCIAL_FX_ROUNDING_RULE);

export const FxMonetaryAmountSchema = Schema.Struct({
  amount: ExactDecimalSchema,
  currencyCode: FxCurrencyCodeSchema,
});
export type FxMonetaryAmount = typeof FxMonetaryAmountSchema.Type;

export const CommercialFxPurposeSchema = Schema.Literals([
  'PRICING',
  'PURCHASE_LIMIT_COMPARISON',
  'PAYMENT',
  'DISPLAY',
]);
export type CommercialFxPurpose = typeof CommercialFxPurposeSchema.Type;

export const FxRoundingModeSchema = Schema.Literals([
  'ceil',
  'floor',
  'to-zero',
  'from-zero',
  'half-ceil',
  'half-floor',
  'half-to-zero',
  'half-from-zero',
  'half-even',
  'half-odd',
]);
export type FxRoundingMode = typeof FxRoundingModeSchema.Type;
const FxRateDirectionSchema = Schema.Literals(['SOURCE_TO_TARGET', 'TARGET_TO_SOURCE']);

export const isFxRoundingIncrementCompatible = (input: {
  readonly roundingIncrement: string;
  readonly targetMinorUnits: number;
}): boolean => {
  const fractionalDigits = input.roundingIncrement.split('.')[1]?.replace(/0+$/u, '').length ?? 0;
  return fractionalDigits <= input.targetMinorUnits;
};

export const CommercialFxConversionRequestSchema = Schema.Struct({
  contextRevision: ContextRevisionSchema,
  purchasingContext: Schema.Struct({
    channelId: ChannelIdSchema,
    marketId: MarketIdSchema,
    sellingLegalEntityId: SellingLegalEntityIdSchema,
    storefrontId: StorefrontIdSchema,
    tenantId: TenantIdSchema,
  }),
  purpose: CommercialFxPurposeSchema,
  requestedAt: FxInstantSchema,
  sourceAmount: FxMonetaryAmountSchema,
  targetCurrencyCode: FxCurrencyCodeSchema,
});
export type CommercialFxConversionRequest = typeof CommercialFxConversionRequestSchema.Type;

export const CommercialFxTrustedContextSchema = Schema.Struct({
  contextRevision: ContextRevisionSchema,
  observedAt: FxInstantSchema,
  purchasingContext: CommercialFxConversionRequestSchema.fields.purchasingContext,
});
export type CommercialFxTrustedContext = typeof CommercialFxTrustedContextSchema.Type;

const FxConversionPolicyContractSchema = Schema.Struct({
  arithmeticVersion: FxArithmeticVersionSchema,
  inverseRatePermitted: Schema.Boolean,
  maximumRateAgeSeconds: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  policyRevision: PolicyRevisionSchema,
  purpose: CommercialFxPurposeSchema,
  rateSourceId: RateSourceIdSchema,
  roundingIncrement: PositiveExactDecimalSchema,
  roundingMode: FxRoundingModeSchema,
  roundingRule: FxRoundingRuleSchema,
  roundingRuleRevision: RoundingRuleRevisionSchema,
  targetMinorUnits: Schema.Finite.check(
    Schema.isInt(),
    Schema.isBetween({ maximum: 18, minimum: 0 }),
  ),
});

export const FxConversionPolicySchema = FxConversionPolicyContractSchema.check(
  Schema.makeFilter((policy) =>
    isFxRoundingIncrementCompatible(policy)
      ? undefined
      : 'Rounding increment must be exactly representable at the target minor-unit scale',
  ),
);
export type FxConversionPolicy = typeof FxConversionPolicySchema.Type;

export const FxRateQuoteSchema = Schema.Struct({
  direction: FxRateDirectionSchema,
  observedAt: FxInstantSchema,
  providerCorrelationRef: ProviderCorrelationRefSchema,
  rate: PositiveExactDecimalSchema,
  rateSourceId: RateSourceIdSchema,
  retrievedAt: FxInstantSchema,
  sourceCurrencyCode: FxCurrencyCodeSchema,
  targetCurrencyCode: FxCurrencyCodeSchema,
  validFrom: FxInstantSchema,
  validTo: FxInstantSchema,
});
export type FxRateQuote = typeof FxRateQuoteSchema.Type;

const fxFailureFields = {
  reason: Schema.String,
} as const;

export const FxSourceNotConfigured = Schema.TaggedStruct(
  'FX_SOURCE_NOT_CONFIGURED',
  fxFailureFields,
);
export type FxSourceNotConfiguredError = typeof FxSourceNotConfigured.Type;
export const FxRateUnavailable = Schema.TaggedStruct('RATE_UNAVAILABLE', {
  reason: Schema.String,
  retryable: Schema.Literal(true),
});
export type FxRateUnavailableError = typeof FxRateUnavailable.Type;
export const FxRateExpiredOrStale = Schema.TaggedStruct('RATE_EXPIRED_OR_STALE', fxFailureFields);
export type FxRateExpiredOrStaleError = typeof FxRateExpiredOrStale.Type;
export const FxUnsupportedCurrencyPair = Schema.TaggedStruct(
  'UNSUPPORTED_CURRENCY_PAIR',
  fxFailureFields,
);
export type FxUnsupportedCurrencyPairError = typeof FxUnsupportedCurrencyPair.Type;
export const FxPurposeNotAllowed = Schema.TaggedStruct('PURPOSE_NOT_ALLOWED', fxFailureFields);
export type FxPurposeNotAllowedError = typeof FxPurposeNotAllowed.Type;
export const FxInconsistentRatePolicy = Schema.TaggedStruct(
  'INCONSISTENT_RATE_POLICY',
  fxFailureFields,
);
export type FxInconsistentRatePolicyError = typeof FxInconsistentRatePolicy.Type;
export const FxRoundingRuleMissing = Schema.TaggedStruct('ROUNDING_RULE_MISSING', fxFailureFields);
export type FxRoundingRuleMissingError = typeof FxRoundingRuleMissing.Type;
export const FxSourceResultIndeterminate = Schema.TaggedStruct('SOURCE_RESULT_INDETERMINATE', {
  reason: Schema.String,
  retryable: Schema.Literal(true),
});
export type FxSourceResultIndeterminateError = typeof FxSourceResultIndeterminate.Type;

export const CommercialFxConversionFailureSchema = Schema.Union([
  FxSourceNotConfigured,
  FxRateUnavailable,
  FxRateExpiredOrStale,
  FxUnsupportedCurrencyPair,
  FxPurposeNotAllowed,
  FxInconsistentRatePolicy,
  FxRoundingRuleMissing,
  FxSourceResultIndeterminate,
]);
export type CommercialFxConversionFailure = typeof CommercialFxConversionFailureSchema.Type;

export const SameCurrencyNoConversionSchema = Schema.TaggedStruct('SAME_CURRENCY_NO_CONVERSION', {
  arithmeticVersion: FxArithmeticVersionSchema,
  contextRevision: ContextRevisionSchema,
  decidedAt: FxInstantSchema,
  purpose: CommercialFxPurposeSchema,
  resultAmount: FxMonetaryAmountSchema,
  sourceAmount: FxMonetaryAmountSchema,
});
export type SameCurrencyNoConversion = typeof SameCurrencyNoConversionSchema.Type;

export const FxConversionResolvedSchema = Schema.TaggedStruct('FX_CONVERSION_RESOLVED', {
  arithmeticVersion: FxArithmeticVersionSchema,
  contextRevision: ContextRevisionSchema,
  decidedAt: FxInstantSchema,
  direction: FxRateDirectionSchema,
  maximumRateAgeSeconds: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  normalizedRate: PositiveExactDecimalSchema,
  observedAt: FxInstantSchema,
  policyRevision: PolicyRevisionSchema,
  providerCorrelationRef: ProviderCorrelationRefSchema,
  purpose: CommercialFxPurposeSchema,
  quotedRate: PositiveExactDecimalSchema,
  rateSourceId: RateSourceIdSchema,
  resultAmount: FxMonetaryAmountSchema,
  retrievedAt: FxInstantSchema,
  roundingIncrement: PositiveExactDecimalSchema,
  roundingMode: FxRoundingModeSchema,
  roundingRule: FxRoundingRuleSchema,
  roundingRuleRevision: RoundingRuleRevisionSchema,
  sourceAmount: FxMonetaryAmountSchema,
  targetMinorUnits: Schema.Finite.check(
    Schema.isInt(),
    Schema.isBetween({ maximum: 18, minimum: 0 }),
  ),
  validFrom: FxInstantSchema,
  validTo: FxInstantSchema,
});
export type FxConversionResolved = typeof FxConversionResolvedSchema.Type;

export const FxConversionRedactedSchema = Schema.TaggedStruct('FX_CONVERSION_REDACTED', {
  arithmeticVersion: FxArithmeticVersionSchema,
  contextRevision: ContextRevisionSchema,
  decidedAt: FxInstantSchema,
  policyRevision: PolicyRevisionSchema,
  purpose: CommercialFxPurposeSchema,
  resultAmount: FxMonetaryAmountSchema,
  roundingIncrement: PositiveExactDecimalSchema,
  roundingMode: FxRoundingModeSchema,
  roundingRule: FxRoundingRuleSchema,
  roundingRuleRevision: RoundingRuleRevisionSchema,
  sourceAmount: FxMonetaryAmountSchema,
  targetMinorUnits: Schema.Finite.check(
    Schema.isInt(),
    Schema.isBetween({ maximum: 18, minimum: 0 }),
  ),
});
export type FxConversionRedacted = typeof FxConversionRedactedSchema.Type;

export const CommercialFxConversionSuccessSchema = Schema.Union([
  SameCurrencyNoConversionSchema,
  FxConversionResolvedSchema,
  FxConversionRedactedSchema,
]);
export type CommercialFxConversionSuccess = typeof CommercialFxConversionSuccessSchema.Type;

export const CommercialFxConversionOutcomeSchema = Schema.Union([
  CommercialFxConversionSuccessSchema,
  CommercialFxConversionFailureSchema,
]);
export type CommercialFxConversionOutcome = typeof CommercialFxConversionOutcomeSchema.Type;

export interface CommercialFxContextPort {
  readonly resolveCurrent: (
    request: CommercialFxConversionRequest,
  ) => Effect.Effect<CommercialFxTrustedContext, FxSourceResultIndeterminateError>;
}

/** Deployment-owned authority for the Current Commerce Purchasing Context. */
export class CommercialFxCurrentContextPort extends Context.Service<
  CommercialFxCurrentContextPort,
  CommercialFxContextPort
>()('@app/commerce-fx/shared/domain/commercial-fx-conversion/CommercialFxCurrentContextPort') {}

// eslint-disable-next-line effect-native/require-context-service-for-service-interface -- This explicit owner-local adapter port is supplied by the governed Read factory, not injected globally. expires: 2027-09-09.
export interface CommercialFxPolicyPort {
  readonly resolve: (
    request: CommercialFxConversionRequest,
  ) => Effect.Effect<
    FxConversionPolicy,
    | FxSourceNotConfiguredError
    | FxPurposeNotAllowedError
    | FxInconsistentRatePolicyError
    | FxRateExpiredOrStaleError
    | FxRoundingRuleMissingError
    | FxSourceResultIndeterminateError
  >;
}

// eslint-disable-next-line effect-native/require-context-service-for-service-interface -- This explicit owner-local adapter port is supplied by the governed Read factory, not injected globally. expires: 2027-09-09.
export interface CommercialFxRatePort {
  readonly quote: (input: {
    readonly policy: FxConversionPolicy;
    readonly request: CommercialFxConversionRequest;
  }) => Effect.Effect<
    FxRateQuote,
    FxRateUnavailableError | FxUnsupportedCurrencyPairError | FxSourceResultIndeterminateError
  >;
}

export interface CommercialFxPorts {
  readonly context: CommercialFxContextPort;
  readonly policy: CommercialFxPolicyPort;
  readonly rate: CommercialFxRatePort;
}

const invalidSourceResult = (reason: string) =>
  FxSourceResultIndeterminate.make({ reason, retryable: true });

const invalidSourceResultFromCause = (reason: string, cause: SchemaError.SchemaError) => {
  const failure = invalidSourceResult(reason);
  Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  return failure;
};

const decodeTrustedContext = (value: CommercialFxTrustedContext) =>
  Schema.decodeUnknownEffect(Schema.toType(CommercialFxTrustedContextSchema))(value).pipe(
    Effect.mapError((cause) =>
      invalidSourceResultFromCause(
        'The FX context source returned an invalid trusted context',
        cause,
      ),
    ),
  );

const decodeConversionPolicy = (value: FxConversionPolicy) =>
  Schema.decodeUnknownEffect(Schema.toType(FxConversionPolicyContractSchema))(value).pipe(
    Effect.mapError((cause) =>
      invalidSourceResultFromCause('The FX policy source returned an invalid policy', cause),
    ),
  );

const decodeRateQuote = (value: FxRateQuote) =>
  Schema.decodeUnknownEffect(Schema.toType(FxRateQuoteSchema))(value).pipe(
    Effect.mapError((cause) =>
      invalidSourceResultFromCause('The FX rate source returned an invalid quote', cause),
    ),
  );

const parseDecimal = (value: string) => {
  const parsed = BigDecimal.fromString(value);
  return Option.isSome(parsed)
    ? Effect.succeed(parsed.value)
    : Effect.fail(invalidSourceResult('The FX source returned an invalid exact decimal'));
};

const samePurchasingContext = (
  claimed: CommercialFxConversionRequest['purchasingContext'],
  trusted: CommercialFxTrustedContext['purchasingContext'],
): boolean =>
  claimed.channelId === trusted.channelId &&
  claimed.marketId === trusted.marketId &&
  claimed.sellingLegalEntityId === trusted.sellingLegalEntityId &&
  claimed.storefrontId === trusted.storefrontId &&
  claimed.tenantId === trusted.tenantId;

const trustedFxRequest = (
  request: CommercialFxConversionRequest,
  trustedContext: CommercialFxTrustedContext,
): Effect.Effect<CommercialFxConversionRequest, FxSourceResultIndeterminateError> =>
  request.contextRevision !== trustedContext.contextRevision ||
  !samePurchasingContext(request.purchasingContext, trustedContext.purchasingContext)
    ? Effect.fail(
        invalidSourceResult(
          'The claimed FX purchasing context does not match the Current trusted context',
        ),
      )
    : Effect.succeed({
        ...request,
        contextRevision: trustedContext.contextRevision,
        purchasingContext: trustedContext.purchasingContext,
        requestedAt: trustedContext.observedAt,
      });

const validateFxQuote = (
  request: CommercialFxConversionRequest,
  policy: FxConversionPolicy,
  quote: FxRateQuote,
): Effect.Effect<
  FxRateQuote,
  FxInconsistentRatePolicyError | FxRateExpiredOrStaleError | FxSourceResultIndeterminateError
> => {
  if (quote.rateSourceId !== policy.rateSourceId) {
    return Effect.fail(
      invalidSourceResult('The FX quote came from a source other than the selected policy source'),
    );
  }
  if (
    quote.sourceCurrencyCode !== request.sourceAmount.currencyCode ||
    quote.targetCurrencyCode !== request.targetCurrencyCode
  ) {
    return Effect.fail(
      invalidSourceResult('The FX quote currency pair does not match the requested conversion'),
    );
  }
  if (quote.direction === 'TARGET_TO_SOURCE' && !policy.inverseRatePermitted) {
    return Effect.fail(
      FxInconsistentRatePolicy.make({
        reason: 'The selected FX policy does not permit inverse-rate derivation',
      }),
    );
  }
  if (
    !DateTime.isLessThanOrEqualTo(quote.observedAt, request.requestedAt) ||
    !DateTime.isLessThanOrEqualTo(quote.retrievedAt, request.requestedAt) ||
    !DateTime.isLessThanOrEqualTo(quote.observedAt, quote.retrievedAt) ||
    !DateTime.isLessThanOrEqualTo(quote.validFrom, request.requestedAt) ||
    !DateTime.isLessThan(request.requestedAt, quote.validTo) ||
    DateTime.toEpochMillis(request.requestedAt) - DateTime.toEpochMillis(quote.observedAt) >
      Duration.toMillis(Duration.seconds(policy.maximumRateAgeSeconds))
  ) {
    return Effect.fail(
      FxRateExpiredOrStale.make({
        reason: 'The FX quote is not Current at the trusted decision time',
      }),
    );
  }
  return Effect.succeed(quote);
};

export const convertCommercialFx = Effect.fn('CommercialFx.convert')(
  function* convertCommercialFxEffect(
    request: CommercialFxConversionRequest,
    ports: CommercialFxPorts,
  ) {
    const trustedContext = yield* ports.context
      .resolveCurrent(request)
      .pipe(Effect.flatMap(decodeTrustedContext));
    const trustedRequest = yield* trustedFxRequest(request, trustedContext);

    if (trustedRequest.sourceAmount.currencyCode === trustedRequest.targetCurrencyCode) {
      return {
        _tag: 'SAME_CURRENCY_NO_CONVERSION' as const,
        arithmeticVersion: COMMERCIAL_FX_ARITHMETIC_VERSION,
        contextRevision: trustedRequest.contextRevision,
        decidedAt: trustedRequest.requestedAt,
        purpose: trustedRequest.purpose,
        resultAmount: trustedRequest.sourceAmount,
        sourceAmount: trustedRequest.sourceAmount,
      };
    }

    const policy = yield* ports.policy
      .resolve(trustedRequest)
      .pipe(Effect.flatMap(decodeConversionPolicy));
    if (policy.purpose !== trustedRequest.purpose) {
      return yield* Effect.fail(
        FxInconsistentRatePolicy.make({
          reason: 'The selected FX policy does not match the requested conversion purpose',
        }),
      );
    }
    if (!isFxRoundingIncrementCompatible(policy)) {
      return yield* Effect.fail(
        FxRoundingRuleMissing.make({
          reason: 'The selected rounding increment exceeds the target minor-unit scale',
        }),
      );
    }
    const quote = yield* ports.rate.quote({ policy, request: trustedRequest }).pipe(
      Effect.flatMap(decodeRateQuote),
      Effect.flatMap((candidate) => validateFxQuote(trustedRequest, policy, candidate)),
    );

    const [source, rate, roundingIncrement] = yield* Effect.all(
      [
        parseDecimal(trustedRequest.sourceAmount.amount),
        parseDecimal(quote.rate),
        parseDecimal(policy.roundingIncrement),
      ],
      { concurrency: 2 },
    );
    if (
      BigDecimal.isZero(rate) ||
      BigDecimal.isNegative(rate) ||
      BigDecimal.isZero(roundingIncrement) ||
      BigDecimal.isNegative(roundingIncrement)
    ) {
      return yield* Effect.fail(
        invalidSourceResult('The normalized FX rate must be positive and non-zero'),
      );
    }
    const unrounded =
      quote.direction === 'SOURCE_TO_TARGET'
        ? BigDecimal.multiply(source, rate)
        : yield* Option.match(BigDecimal.divide(source, rate), {
            onNone: () => Effect.fail(invalidSourceResult('The FX rate cannot be divided safely')),
            onSome: Effect.succeed,
          });
    const unroundedIncrementUnits = yield* Option.match(
      BigDecimal.divide(unrounded, roundingIncrement),
      {
        onNone: () =>
          Effect.fail(invalidSourceResult('The FX rounding increment cannot be applied safely')),
        onSome: Effect.succeed,
      },
    );
    const roundedIncrementUnits = BigDecimal.round(unroundedIncrementUnits, {
      mode: policy.roundingMode,
      scale: 0,
    });
    const rounded = BigDecimal.multiply(roundedIncrementUnits, roundingIncrement);
    const normalizedRate =
      quote.direction === 'SOURCE_TO_TARGET'
        ? rate
        : yield* Option.match(BigDecimal.divide(BigDecimal.make(1n, 0), rate), {
            onNone: () => Effect.fail(invalidSourceResult('The inverse FX rate is invalid')),
            onSome: Effect.succeed,
          });
    const normalizedRateText = BigDecimal.format(normalizedRate);
    if (!Schema.is(PositiveExactDecimalSchema)(normalizedRateText)) {
      return yield* Effect.fail(
        FxInconsistentRatePolicy.make({
          reason: 'Inverse-rate derivation exceeds the supported exact-decimal evidence precision',
        }),
      );
    }

    const result = {
      _tag: 'FX_CONVERSION_RESOLVED' as const,
      arithmeticVersion: policy.arithmeticVersion,
      contextRevision: trustedRequest.contextRevision,
      decidedAt: trustedRequest.requestedAt,
      direction: quote.direction,
      maximumRateAgeSeconds: policy.maximumRateAgeSeconds,
      normalizedRate: normalizedRateText,
      observedAt: quote.observedAt,
      policyRevision: policy.policyRevision,
      providerCorrelationRef: quote.providerCorrelationRef,
      purpose: trustedRequest.purpose,
      quotedRate: quote.rate,
      rateSourceId: quote.rateSourceId,
      resultAmount: {
        amount: BigDecimal.format(rounded),
        currencyCode: trustedRequest.targetCurrencyCode,
      },
      retrievedAt: quote.retrievedAt,
      roundingIncrement: policy.roundingIncrement,
      roundingMode: policy.roundingMode,
      roundingRule: policy.roundingRule,
      roundingRuleRevision: policy.roundingRuleRevision,
      sourceAmount: trustedRequest.sourceAmount,
      targetMinorUnits: policy.targetMinorUnits,
      validFrom: quote.validFrom,
      validTo: quote.validTo,
    };
    return Schema.is(FxConversionResolvedSchema)(result)
      ? result
      : yield* Effect.fail(
          FxInconsistentRatePolicy.make({
            reason: 'The converted amount exceeds the supported exact-decimal result contract',
          }),
        );
  },
);

export const fxFailureToOutcome = (
  failure: CommercialFxConversionFailure,
): CommercialFxConversionOutcome => failure;

export const commercialFxOutcome = (
  request: CommercialFxConversionRequest,
  ports: CommercialFxPorts,
): Effect.Effect<CommercialFxConversionOutcome> =>
  convertCommercialFx(request, ports).pipe(
    Effect.match({
      onFailure: fxFailureToOutcome,
      onSuccess: (success) => success,
    }),
  );

export const unavailableCommercialFxCurrentContextPort: CommercialFxContextPort = Object.freeze({
  resolveCurrent: () =>
    Effect.fail(
      FxSourceResultIndeterminate.make({
        reason: 'The Current trusted Commerce Purchasing Context is unavailable',
        retryable: true,
      }),
    ),
});

export const unconfiguredCommercialFxPorts: CommercialFxPorts = Object.freeze({
  context: unavailableCommercialFxCurrentContextPort,
  policy: {
    resolve: () =>
      Effect.fail(
        FxSourceNotConfigured.make({
          reason: 'No purpose-specific Commercial FX source is configured',
        }),
      ),
  },
  rate: {
    quote: () =>
      Effect.fail(
        FxRateUnavailable.make({
          reason: 'No Commercial FX provider is available',
          retryable: true,
        }),
      ),
  },
});
