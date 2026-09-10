import { PrincipalRefSchema } from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import { Context, Effect, Match, Option, Schema } from 'effect';
import {
  EffectivePurchaseLimitPolicySchema,
  PurchaseLimitCounterpartyRefSchema,
  resolveEffectivePurchaseLimitPolicy,
} from './purchase-limit-policy.ts';
import type {
  PurchaseLimitDependencyUnavailable,
  ResolveEffectivePurchaseLimitPolicyInput,
} from './purchase-limit-policy.ts';
import {
  compareExactDecimals,
  ExactNonNegativeDecimalSchema,
  MonetaryAmountSchema,
  PurchaseValueSchema,
} from './purchase-limit.ts';
import type { PurchaseValue } from './purchase-limit.ts';
import { PurchaseLimitFx } from './purchase-limit-fx-port.ts';
import type { PurchaseLimitFxUnavailable } from './purchase-limit-fx-port.ts';

const RevisionSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300));
const PurchaseLimitFxRateSourceIdSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(300),
).pipe(Schema.brand('PurchaseLimitFxRateSourceId'));
export const PurchaseLimitUtcTimestampSchema = Schema.DateTimeUtcFromString;
export const PurchaseLimitSellingLegalEntityIdSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(300),
).pipe(Schema.brand('PurchaseLimitSellingLegalEntityId'));
export const PurchaseLimitStorefrontIdSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(300),
).pipe(Schema.brand('PurchaseLimitStorefrontId'));

export const PurchaseLimitSourceRevisionSchema = Schema.Struct({
  revision: RevisionSchema,
  source: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
});
export type PurchaseLimitSourceRevision = typeof PurchaseLimitSourceRevisionSchema.Type;

const PurchaseLimitSourceRevisionVectorBaseSchema = Schema.Array(
  PurchaseLimitSourceRevisionSchema,
).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(100),
  Schema.makeFilter((values) =>
    new Set(values.map(({ source }) => source)).size === values.length
      ? undefined
      : 'source revision vector must contain one revision per source',
  ),
);

const requiredRevisionSources = (required: readonly string[]) =>
  Schema.makeFilter<readonly PurchaseLimitSourceRevision[]>((values) => {
    const sources = new Set(values.map(({ source }) => source));
    const missing = required.filter((source) => !sources.has(source));
    return missing.length === 0
      ? undefined
      : `source revision vector is missing mandated Currentness sources: ${missing.join(', ')}`;
  });

export const PurchaseLimitExternalSourceRevisionVectorSchema =
  PurchaseLimitSourceRevisionVectorBaseSchema.check(
    requiredRevisionSources([
      'customer-commerce-policy',
      'purchase-proposal',
      'purchasing-profile',
      'storefront-context',
    ]),
  );
export type PurchaseLimitExternalSourceRevisionVector =
  typeof PurchaseLimitExternalSourceRevisionVectorSchema.Type;

export const PurchaseLimitSourceRevisionVectorSchema =
  PurchaseLimitSourceRevisionVectorBaseSchema.check(
    requiredRevisionSources([
      'counterparty-policy',
      'customer-commerce-policy',
      'principal-override',
      'purchase-proposal',
      'purchasing-profile',
      'storefront-context',
    ]),
  );
export type PurchaseLimitSourceRevisionVector = typeof PurchaseLimitSourceRevisionVectorSchema.Type;

const PurchaseLimitComparableValueEvidenceFields = {
  decidedAt: PurchaseLimitUtcTimestampSchema,
  decisionRef: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)),
  monetaryAmount: MonetaryAmountSchema,
  purpose: Schema.Literal('PURCHASE_LIMIT_COMPARISON'),
  roundingRuleRevision: RevisionSchema,
  sourcePurchaseValueRevision: RevisionSchema,
  sourceRevision: RevisionSchema,
};

export const PurchaseLimitComparableValueSchema = Schema.Union([
  Schema.Struct({
    ...PurchaseLimitComparableValueEvidenceFields,
    arithmeticVersion: RevisionSchema,
    contextRevision: RevisionSchema,
    direction: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
    maximumRateAgeSeconds: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
    normalizedRate: ExactNonNegativeDecimalSchema,
    observedAt: PurchaseLimitUtcTimestampSchema,
    policyRevision: RevisionSchema,
    quotedRate: ExactNonNegativeDecimalSchema,
    rateSourceId: PurchaseLimitFxRateSourceIdSchema,
    retrievedAt: PurchaseLimitUtcTimestampSchema,
    roundingIncrement: ExactNonNegativeDecimalSchema,
    roundingMode: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
    roundingRule: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
    source: Schema.Literal('comparable-value'),
    targetMinorUnits: Schema.Finite.check(
      Schema.isInt(),
      Schema.isBetween({ maximum: 18, minimum: 0 }),
    ),
    validFrom: PurchaseLimitUtcTimestampSchema,
    validTo: PurchaseLimitUtcTimestampSchema,
  }),
  Schema.Struct({
    ...PurchaseLimitComparableValueEvidenceFields,
    source: Schema.Literal('purchase-value'),
  }),
]);
export type PurchaseLimitComparableValue = typeof PurchaseLimitComparableValueSchema.Type;

export const PurchaseLimitEvaluationContextSchema = Schema.Struct({
  counterpartyRef: PurchaseLimitCounterpartyRefSchema,
  principalId: PrincipalRefSchema.fields.principalId,
  sellingLegalEntityId: PurchaseLimitSellingLegalEntityIdSchema,
  storefrontId: PurchaseLimitStorefrontIdSchema,
});
export type PurchaseLimitEvaluationContext = typeof PurchaseLimitEvaluationContextSchema.Type;

const EvaluationEvidenceFields = {
  currentSourceRevisions: PurchaseLimitSourceRevisionVectorSchema,
  decidedAt: PurchaseLimitUtcTimestampSchema,
  effectivePolicy: EffectivePurchaseLimitPolicySchema,
  evaluationContext: PurchaseLimitEvaluationContextSchema,
  purchaseValue: PurchaseValueSchema,
};

export const PurchaseLimitWithinLimitEvaluationSchema = Schema.TaggedStruct('WITHIN_LIMIT', {
  ...EvaluationEvidenceFields,
  comparableValue: Schema.Union([PurchaseLimitComparableValueSchema, Schema.Null]),
  comparedValue: Schema.Union([MonetaryAmountSchema, Schema.Null]),
});

export const PurchaseLimitApprovalRequiredEvaluationSchema = Schema.TaggedStruct(
  'APPROVAL_REQUIRED',
  {
    ...EvaluationEvidenceFields,
    comparableValue: Schema.Union([PurchaseLimitComparableValueSchema, Schema.Null]),
    comparedValue: MonetaryAmountSchema,
  },
);

export const PurchaseLimitEvaluationResultSchema = Schema.Union([
  PurchaseLimitWithinLimitEvaluationSchema,
  PurchaseLimitApprovalRequiredEvaluationSchema,
  Schema.TaggedStruct('NO_EFFECTIVE_POLICY', {
    currentSourceRevisions: PurchaseLimitSourceRevisionVectorSchema,
    decidedAt: PurchaseLimitUtcTimestampSchema,
    evaluationContext: PurchaseLimitEvaluationContextSchema,
    purchaseValue: PurchaseValueSchema,
  }),
  Schema.TaggedStruct('INCONSISTENT_POLICY', {
    currentSourceRevisions: PurchaseLimitSourceRevisionVectorSchema,
    decidedAt: PurchaseLimitUtcTimestampSchema,
    evaluationContext: PurchaseLimitEvaluationContextSchema,
    purchaseValue: PurchaseValueSchema,
    reasonCode: Schema.String,
  }),
  Schema.TaggedStruct('COMPARABLE_VALUE_REQUIRED', {
    currentSourceRevisions: PurchaseLimitSourceRevisionVectorSchema,
    decidedAt: PurchaseLimitUtcTimestampSchema,
    effectivePolicy: EffectivePurchaseLimitPolicySchema,
    evaluationContext: PurchaseLimitEvaluationContextSchema,
    limitCurrency: Schema.String,
    purchaseCurrency: Schema.String,
    purchaseValue: PurchaseValueSchema,
  }),
  Schema.TaggedStruct('STALE_INPUT', {
    currentSourceRevisions: PurchaseLimitSourceRevisionVectorSchema,
    decidedAt: PurchaseLimitUtcTimestampSchema,
    evaluationContext: PurchaseLimitEvaluationContextSchema,
    purchaseValue: PurchaseValueSchema,
    staleSources: Schema.Array(Schema.String),
  }),
]);
export type PurchaseLimitEvaluationResult = typeof PurchaseLimitEvaluationResultSchema.Type;

export interface PurchaseLimitEvaluationInput extends ResolveEffectivePurchaseLimitPolicyInput {
  readonly comparableValue?: PurchaseLimitComparableValue;
  readonly currentSourceRevisions: PurchaseLimitSourceRevisionVector;
  readonly decidedAt: typeof PurchaseLimitUtcTimestampSchema.Type;
  readonly expectedSourceRevisions: PurchaseLimitSourceRevisionVector;
  readonly purchaseValue: PurchaseValue;
  readonly sellingLegalEntityId: typeof PurchaseLimitSellingLegalEntityIdSchema.Type;
  readonly storefrontId: typeof PurchaseLimitStorefrontIdSchema.Type;
}

export const PurchaseLimitEvaluationQuerySchema = Schema.Struct({
  counterpartyRef: PurchaseLimitCounterpartyRefSchema,
  expectedSourceRevisions: PurchaseLimitSourceRevisionVectorSchema,
  purchaseValue: PurchaseValueSchema,
  storefrontId: PurchaseLimitStorefrontIdSchema,
});
export type PurchaseLimitEvaluationQuery = typeof PurchaseLimitEvaluationQuerySchema.Type;

const revisionMap = (vector: PurchaseLimitSourceRevisionVector) =>
  new Map(vector.map(({ revision, source }) => [source, revision]));

export const findStalePurchaseLimitSources = (
  expected: PurchaseLimitSourceRevisionVector,
  current: PurchaseLimitSourceRevisionVector,
): readonly string[] => {
  const currentBySource = revisionMap(current);
  const expectedBySource = revisionMap(expected);
  return [...new Set([...expectedBySource.keys(), ...currentBySource.keys()])]
    .filter(
      (source) =>
        // A first cross-currency evaluation resolves a comparable value after the caller's claim.
        // Once comparable-value evidence is supplied in the expected vector, its exact revision is
        // revalidated like every source.
        (source !== 'comparable-value' || expectedBySource.has(source)) &&
        expectedBySource.get(source) !== currentBySource.get(source),
    )
    .toSorted();
};

const evaluationContext = (input: PurchaseLimitEvaluationInput) => ({
  counterpartyRef: input.counterpartyRef,
  principalId: input.principalId,
  sellingLegalEntityId: input.sellingLegalEntityId,
  storefrontId: input.storefrontId,
});

const evaluateMonetaryPolicy = (
  input: PurchaseLimitEvaluationInput,
  effectivePolicy: typeof EffectivePurchaseLimitPolicySchema.Type,
  limit: typeof MonetaryAmountSchema.Type,
): PurchaseLimitEvaluationResult => {
  let comparedValue = input.purchaseValue.monetaryAmount;
  if (comparedValue.currency !== limit.currency) {
    const comparable = input.comparableValue;
    if (
      comparable === undefined ||
      comparable.purpose !== 'PURCHASE_LIMIT_COMPARISON' ||
      comparable.sourcePurchaseValueRevision !== input.purchaseValue.sourceRevision ||
      revisionMap(input.currentSourceRevisions).get(comparable.source) !==
        comparable.sourceRevision ||
      comparable.monetaryAmount.currency !== limit.currency
    ) {
      return {
        _tag: 'COMPARABLE_VALUE_REQUIRED',
        currentSourceRevisions: input.currentSourceRevisions,
        decidedAt: input.decidedAt,
        effectivePolicy,
        evaluationContext: evaluationContext(input),
        limitCurrency: limit.currency,
        purchaseCurrency: comparedValue.currency,
        purchaseValue: input.purchaseValue,
      };
    }
    comparedValue = comparable.monetaryAmount;
  }
  const evidence = {
    comparableValue: input.comparableValue ?? null,
    comparedValue,
    currentSourceRevisions: input.currentSourceRevisions,
    decidedAt: input.decidedAt,
    effectivePolicy,
    evaluationContext: evaluationContext(input),
    purchaseValue: input.purchaseValue,
  };
  return compareExactDecimals(comparedValue.amount, limit.amount) <= 0
    ? { _tag: 'WITHIN_LIMIT', ...evidence }
    : { _tag: 'APPROVAL_REQUIRED', ...evidence };
};

/** Pure deterministic comparison over facts already acquired from authoritative owners. */
export const evaluatePurchaseLimit = (
  input: PurchaseLimitEvaluationInput,
): PurchaseLimitEvaluationResult => {
  const staleSources = findStalePurchaseLimitSources(
    input.expectedSourceRevisions,
    input.currentSourceRevisions,
  );
  if (staleSources.length > 0) {
    return {
      _tag: 'STALE_INPUT',
      currentSourceRevisions: input.currentSourceRevisions,
      decidedAt: input.decidedAt,
      evaluationContext: {
        counterpartyRef: input.counterpartyRef,
        principalId: input.principalId,
        sellingLegalEntityId: input.sellingLegalEntityId,
        storefrontId: input.storefrontId,
      },
      purchaseValue: input.purchaseValue,
      staleSources,
    };
  }
  return Match.value(resolveEffectivePurchaseLimitPolicy(input)).pipe(
    Match.tag('NO_EFFECTIVE_POLICY', () => ({
      _tag: 'NO_EFFECTIVE_POLICY' as const,
      currentSourceRevisions: input.currentSourceRevisions,
      decidedAt: input.decidedAt,
      evaluationContext: evaluationContext(input),
      purchaseValue: input.purchaseValue,
    })),
    Match.tag('INCONSISTENT_POLICY', ({ reasonCode }) => ({
      _tag: 'INCONSISTENT_POLICY' as const,
      currentSourceRevisions: input.currentSourceRevisions,
      decidedAt: input.decidedAt,
      evaluationContext: evaluationContext(input),
      purchaseValue: input.purchaseValue,
      reasonCode,
    })),
    Match.tag('EFFECTIVE_POLICY', ({ effectivePolicy }) =>
      Match.value(effectivePolicy.policy).pipe(
        Match.tag('UNLIMITED', () => ({
          _tag: 'WITHIN_LIMIT' as const,
          comparableValue: null,
          comparedValue: null,
          currentSourceRevisions: input.currentSourceRevisions,
          decidedAt: input.decidedAt,
          effectivePolicy,
          evaluationContext: evaluationContext(input),
          purchaseValue: input.purchaseValue,
        })),
        Match.tag('MONETARY_LIMIT', ({ limit }) =>
          evaluateMonetaryPolicy(input, effectivePolicy, limit),
        ),
        Match.exhaustive,
      ),
    ),
    Match.exhaustive,
  );
};

export const resolveComparablePurchaseValue = (input: {
  readonly effectivePolicy: typeof EffectivePurchaseLimitPolicySchema.Type;
  readonly purchaseValue: PurchaseValue;
}): Effect.Effect<
  Option.Option<PurchaseLimitComparableValue>,
  PurchaseLimitFxUnavailable,
  PurchaseLimitFx
> =>
  Match.value(input.effectivePolicy.policy).pipe(
    Match.tag('UNLIMITED', () => Effect.succeed(Option.none<PurchaseLimitComparableValue>())),
    Match.tag('MONETARY_LIMIT', ({ limit }) =>
      limit.currency === input.purchaseValue.monetaryAmount.currency
        ? Effect.succeed(Option.none<PurchaseLimitComparableValue>())
        : PurchaseLimitFx.pipe(
            Effect.flatMap((fx) =>
              fx
                .comparableValue({
                  purchaseValue: input.purchaseValue,
                  targetCurrency: limit.currency,
                })
                .pipe(Effect.map(Option.some)),
            ),
          ),
    ),
    Match.exhaustive,
  );

export type PurchaseLimitEvaluationSourceService = Readonly<{
  /** Revalidates the request against Current owner facts and supplies trusted policy/comparable-value evidence. */
  loadCurrent: (input: {
    readonly principalId: string;
    readonly query: PurchaseLimitEvaluationQuery;
  }) => Effect.Effect<PurchaseLimitEvaluationInput, PurchaseLimitDependencyUnavailable>;
}>;

export interface PurchaseLimitEvaluationSourceFactoryContract {
  readonly make: <Transaction>(
    transaction: Transaction,
    scope: OperationalScope,
  ) => Effect.Effect<PurchaseLimitEvaluationSourceService, PurchaseLimitDependencyUnavailable>;
}

export class PurchaseLimitEvaluationSourceFactory extends Context.Service<
  PurchaseLimitEvaluationSourceFactory,
  PurchaseLimitEvaluationSourceFactoryContract
>()(
  '@app/commerce-customer-context/shared/domain/purchase-limit-evaluation/PurchaseLimitEvaluationSourceFactory',
) {}

export { PurchaseLimitFxUnavailableSchema } from './purchase-limit-fx-port.ts';
export type { PurchaseLimitFxPort, PurchaseLimitFxUnavailable } from './purchase-limit-fx-port.ts';
