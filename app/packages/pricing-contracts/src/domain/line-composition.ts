import { OwnerVerifiableSetCompletenessEvidenceSchema } from '@app/shared-contracts';
import { Schema } from 'effect';

import {
  PricingCurrencyCodeSchema,
  PricingInstantSchema,
  PricingTenantIdSchema,
} from '../apis/current-supported-currencies.ts';
import { PricingCommercialFeeCalculationResultSchema } from './commercial-fee.ts';
import type { PricingCommercialFeeCalculationResult } from './commercial-fee.ts';
import {
  PricingDiscountCompositionReadySchema,
  PricingDiscountLineContributionSchema,
} from './discount-composition.ts';
import type { PricingDiscountCompositionReady, PricingDiscountLineContribution } from './discount-composition.ts';
import {
  PricingAllocationAppliedSchema,
  PricingAllocationLineSchema,
  PricingAllocationNotApplicableSchema,
} from './discount-fee-allocation.ts';
import type {
  PricingAllocationApplied,
  PricingAllocationLine,
  PricingAllocationNotApplicable,
} from './discount-fee-allocation.ts';
import { PricingExactMoneySchema, PricingExactNonNegativeDecimalSchema } from './exact-decimal.ts';
import { PricingCommercialScopeSchema } from './pricing-commercial-scope.ts';
import {
  PricingCatalogSelectionSchema,
  PricingDecisionSchema,
  PricingLineSchema,
  PricingPurchaseDemandOccurrenceIdSchema,
  PricingStrictlyNegativeDecimalSchema,
  PricingUnitBasisSchema,
} from './pricing-decision.ts';
import type { PricingDecision, PricingLine } from './pricing-decision.ts';
import {
  PricingPromotionCompositionReadySchema,
  PricingPromotionMerchandiseAllocationSchema,
} from './promotion-composition.ts';
import type { PricingPromotionMerchandiseAllocation } from './promotion-composition.ts';
import { PricingUnitPriceCalculationSuccessSchema } from './unit-price-calculation.ts';
import type { PricingUnitPriceCalculationSuccess } from './unit-price-calculation.ts';

const stableReference = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300), Schema.isTrimmed());
const boundedReason = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000), Schema.isTrimmed());
const completenessEvidence = Schema.toEncoded(OwnerVerifiableSetCompletenessEvidenceSchema);

export const [PricingAppliedCommercialFeeCalculationSchema] = PricingCommercialFeeCalculationResultSchema.members;
export type PricingAppliedCommercialFeeCalculation = typeof PricingAppliedCommercialFeeCalculationSchema.Type;

/**
 * Promotion participates only when this Pricing attempt explicitly selected an owner result.
 * NOT_SELECTED makes no claim about Promotion applicability or deployment and carries no
 * fabricated zero-contribution evidence.
 */
export const PricingPromotionCompositionSelectionSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('PROMOTION_NOT_SELECTED') }),
  Schema.Struct({
    composition: Schema.toType(PricingPromotionCompositionReadySchema),
    kind: Schema.Literal('PROMOTION_SELECTED'),
  }),
]);
export type PricingPromotionCompositionSelection = typeof PricingPromotionCompositionSelectionSchema.Type;

export interface PricingLineCompositionRequest {
  readonly candidateRef: string;
  readonly decision: PricingDecision;
  readonly discountComposition: PricingDiscountCompositionReady;
  readonly feeResults: readonly PricingCommercialFeeCalculationResult[];
  readonly promotionComposition: PricingPromotionCompositionSelection;
  readonly unitPrices: readonly PricingUnitPriceCalculationSuccess[];
  readonly wholePurchaseAllocation?: PricingAllocationApplied | PricingAllocationNotApplicable;
}

export const PricingLineCompositionRequestSchema: Schema.Codec<PricingLineCompositionRequest, unknown> = Schema.Struct({
  candidateRef: stableReference,
  decision: Schema.toType(PricingDecisionSchema),
  discountComposition: Schema.toType(PricingDiscountCompositionReadySchema),
  feeResults: Schema.Array(Schema.toType(PricingCommercialFeeCalculationResultSchema)).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(500),
  ),
  promotionComposition: Schema.toType(PricingPromotionCompositionSelectionSchema),
  unitPrices: Schema.Array(Schema.toType(PricingUnitPriceCalculationSuccessSchema)).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(500),
  ),
  wholePurchaseAllocation: Schema.optionalKey(
    Schema.Union([Schema.toType(PricingAllocationAppliedSchema), Schema.toType(PricingAllocationNotApplicableSchema)]),
  ),
});

export interface PricingRawCompositionLine {
  readonly feeCalculation: PricingAppliedCommercialFeeCalculation;
  readonly line: PricingLine;
  readonly lineDiscountContributions: readonly PricingDiscountLineContribution[];
  readonly negativeOrigin: 'LINE_NATIVE_COMPOSITION' | 'NONE';
  readonly occurrenceId: string;
  readonly prePromotionValue: { readonly amount: string; readonly currencyCode: string };
  readonly promotionAllocation?: PricingPromotionMerchandiseAllocation;
  readonly promotionOwnerDecisionRevision?: string;
  readonly rawPostCompositionValue: { readonly amount: string; readonly currencyCode: string };
  readonly unitPriceCalculation: PricingUnitPriceCalculationSuccess;
  readonly wholePurchaseAllocation?: PricingAllocationLine;
  readonly wholePurchaseAllocationRevisionRef?: string;
}

export const PricingRawCompositionLineSchema: Schema.Codec<PricingRawCompositionLine, unknown> = Schema.Struct({
  feeCalculation: Schema.toType(PricingAppliedCommercialFeeCalculationSchema),
  line: Schema.toType(PricingLineSchema),
  lineDiscountContributions: Schema.Array(Schema.toType(PricingDiscountLineContributionSchema)).check(
    Schema.isMaxLength(500),
  ),
  negativeOrigin: Schema.Literals(['NONE', 'LINE_NATIVE_COMPOSITION']),
  occurrenceId: PricingPurchaseDemandOccurrenceIdSchema,
  prePromotionValue: PricingExactMoneySchema,
  promotionAllocation: Schema.optionalKey(Schema.toType(PricingPromotionMerchandiseAllocationSchema)),
  promotionOwnerDecisionRevision: Schema.optionalKey(stableReference),
  rawPostCompositionValue: PricingExactMoneySchema,
  unitPriceCalculation: Schema.toType(PricingUnitPriceCalculationSuccessSchema),
  wholePurchaseAllocation: Schema.optionalKey(Schema.toType(PricingAllocationLineSchema)),
  wholePurchaseAllocationRevisionRef: Schema.optionalKey(stableReference),
});
export const PricingLineComposedLineSchema: typeof PricingRawCompositionLineSchema =
  PricingRawCompositionLineSchema.annotate({ identifier: 'PricingLineComposedLine' });
export type PricingLineComposedLine = PricingRawCompositionLine;

export interface PricingRawCompositionReady {
  readonly candidateRef: string;
  readonly decision: PricingDecision;
  readonly lines: readonly PricingRawCompositionLine[];
  readonly outcome: 'RAW_COMPOSITION_READY';
  readonly promotionComposition: PricingPromotionCompositionSelection;
  readonly wholePurchaseAllocationEvidence?: PricingAllocationApplied | PricingAllocationNotApplicable;
}

export const PricingRawCompositionReadySchema: Schema.Codec<PricingRawCompositionReady, unknown> = Schema.Struct({
  candidateRef: stableReference,
  decision: Schema.toType(PricingDecisionSchema),
  lines: Schema.Array(PricingRawCompositionLineSchema).check(Schema.isMinLength(1), Schema.isMaxLength(500)),
  outcome: Schema.Literal('RAW_COMPOSITION_READY'),
  promotionComposition: Schema.toType(PricingPromotionCompositionSelectionSchema),
  wholePurchaseAllocationEvidence: Schema.optionalKey(
    Schema.Union([Schema.toType(PricingAllocationAppliedSchema), Schema.toType(PricingAllocationNotApplicableSchema)]),
  ),
});
export const PricingLineCompositionReadySchema: typeof PricingRawCompositionReadySchema =
  PricingRawCompositionReadySchema.annotate({ identifier: 'PricingLineCompositionReady' });
export type PricingLineCompositionReady = PricingRawCompositionReady;

export const PricingLineCompositionFailureReasonSchema = Schema.Literals([
  'INPUT_INVALID',
  'EVIDENCE_UNVERIFIABLE',
  'UPSTREAM_NOT_READY',
  'ALLOCATION_INDUCED_NEGATIVE',
]);
export type PricingLineCompositionFailureReason = typeof PricingLineCompositionFailureReasonSchema.Type;

export const PricingRawCompositionFailedSchema = Schema.Struct({
  candidateRef: stableReference,
  failure: Schema.Struct({
    reason: boundedReason,
    retryable: Schema.Boolean,
    type: PricingLineCompositionFailureReasonSchema,
  }),
  outcome: Schema.Literal('RAW_COMPOSITION_FAILED'),
});
export type PricingRawCompositionFailed = typeof PricingRawCompositionFailedSchema.Type;
export const PricingLineCompositionFailedSchema: typeof PricingRawCompositionFailedSchema =
  PricingRawCompositionFailedSchema.annotate({ identifier: 'PricingLineCompositionFailed' });
export type PricingLineCompositionFailed = PricingRawCompositionFailed;

export const PricingRawCompositionResultSchema: Schema.Union<
  readonly [typeof PricingRawCompositionReadySchema, typeof PricingRawCompositionFailedSchema]
> = Schema.Union([PricingRawCompositionReadySchema, PricingRawCompositionFailedSchema]);
export type PricingRawCompositionResult = typeof PricingRawCompositionResultSchema.Type;
export const PricingLineCompositionResultSchema: typeof PricingRawCompositionResultSchema =
  PricingRawCompositionResultSchema.annotate({ identifier: 'PricingLineCompositionResult' });
export type PricingLineCompositionResult = PricingRawCompositionResult;

export const PricingZeroFloorAuthorizationSchema = Schema.Struct({
  authorizationRef: stableReference,
  authorizationRevision: stableReference,
  businessScope: Schema.Struct({
    catalogSelection: PricingCatalogSelectionSchema,
    commercialScope: PricingCommercialScopeSchema,
    pricingBasis: PricingUnitBasisSchema,
    tenantId: PricingTenantIdSchema,
  }),
  coveredMeaning: Schema.Struct({
    audienceRefs: Schema.Array(stableReference).check(Schema.isMaxLength(500)),
    materialRevisionRefs: Schema.Array(stableReference).check(Schema.isMinLength(1), Schema.isMaxLength(1000)),
  }),
  currencyCode: PricingCurrencyCodeSchema,
  economicCoverage: Schema.Struct({
    maximumFloorAdjustment: PricingExactNonNegativeDecimalSchema,
    minimumRawAmount: PricingStrictlyNegativeDecimalSchema,
  }),
  effectivePeriod: Schema.Struct({
    endsAt: Schema.optionalKey(PricingInstantSchema),
    startsAt: PricingInstantSchema,
  }),
  governanceEvidence: Schema.Struct({
    approvalEvidenceRef: stableReference,
    approvedByPrincipalRef: stableReference,
    reason: boundedReason,
  }),
});
export type PricingZeroFloorAuthorization = typeof PricingZeroFloorAuthorizationSchema.Type;
const sameZeroFloorAuthorization = Schema.toEquivalence(PricingZeroFloorAuthorizationSchema);

export const PricingZeroFloorAuthorizationQuerySchema = Schema.Struct({
  audienceRefs: Schema.Array(stableReference).check(Schema.isMaxLength(500)),
  catalogSelection: PricingCatalogSelectionSchema,
  commercialScope: PricingCommercialScopeSchema,
  currencyCode: PricingCurrencyCodeSchema,
  effectiveAt: PricingInstantSchema,
  exactPredicateRef: stableReference,
  materialRevisionRefs: Schema.Array(stableReference).check(Schema.isMinLength(1), Schema.isMaxLength(1000)),
  pricingBasis: PricingUnitBasisSchema,
  tenantId: PricingTenantIdSchema,
});
export type PricingZeroFloorAuthorizationQuery = typeof PricingZeroFloorAuthorizationQuerySchema.Type;

export const PricingZeroFloorCurrentAuthorizationSetSchema = Schema.Struct({
  authorizations: Schema.Array(PricingZeroFloorAuthorizationSchema).check(Schema.isMaxLength(500)),
  completenessEvidence,
  currentness: Schema.Struct({
    evaluatedAt: PricingInstantSchema,
    observedAt: PricingInstantSchema,
    revalidatedAt: PricingInstantSchema,
    status: Schema.Literal('CURRENT'),
  }),
  exactPredicateRef: stableReference,
  ownerRevision: stableReference,
  query: PricingZeroFloorAuthorizationQuerySchema,
}).check(
  Schema.makeFilter(({ completenessEvidence: evidence, currentness, exactPredicateRef, ownerRevision, query }) => {
    if (
      query.exactPredicateRef !== exactPredicateRef ||
      evidence.ownerRevision !== ownerRevision ||
      evidence.scope.kind !== 'EXACT_PREDICATE' ||
      evidence.scope.predicateRef !== exactPredicateRef ||
      evidence.observedAt !== currentness.observedAt
    ) {
      return 'ZERO_FLOOR Current set must bind its exact structured query, owner Revision, and completeness predicate';
    }
    return currentness.evaluatedAt === query.effectiveAt &&
      currentness.evaluatedAt <= currentness.observedAt &&
      currentness.observedAt <= currentness.revalidatedAt
      ? undefined
      : 'ZERO_FLOOR Current-set timestamps must preserve evaluation, observation, and revalidation order';
  }),
);
export type PricingZeroFloorCurrentAuthorizationSet = typeof PricingZeroFloorCurrentAuthorizationSetSchema.Type;

export const PricingZeroFloorAuthorizationSetFailureSchema = Schema.Struct({
  failure: Schema.Struct({
    reason: boundedReason,
    type: Schema.Literals(['UNAVAILABLE', 'UNVERIFIABLE']),
  }),
  outcome: Schema.Literal('ZERO_FLOOR_AUTHORIZATION_SET_FAILED'),
});
export type PricingZeroFloorAuthorizationSetFailure = typeof PricingZeroFloorAuthorizationSetFailureSchema.Type;

export const PricingZeroFloorAuthorizationSetSchema = Schema.Union([
  PricingZeroFloorCurrentAuthorizationSetSchema,
  PricingZeroFloorAuthorizationSetFailureSchema,
]);
export type PricingZeroFloorAuthorizationSet = typeof PricingZeroFloorAuthorizationSetSchema.Type;

export const PricingZeroFloorEvaluationRequestSchema = Schema.Struct({
  authorizationSet: PricingZeroFloorAuthorizationSetSchema,
  composedLine: PricingLineComposedLineSchema,
  composition: PricingRawCompositionReadySchema,
});
export type PricingZeroFloorEvaluationRequest = typeof PricingZeroFloorEvaluationRequestSchema.Type;

export const PricingZeroFloorNotRequiredSchema = Schema.Struct({
  floorAdjustment: Schema.Struct({ amount: Schema.Literal('0'), currencyCode: PricingCurrencyCodeSchema }),
  kind: Schema.Literal('NOT_REQUIRED'),
  nonNegativePreRoundValue: Schema.Struct({
    amount: PricingExactNonNegativeDecimalSchema,
    currencyCode: PricingCurrencyCodeSchema,
  }),
  rawPostCompositionValue: PricingExactMoneySchema,
});
export type PricingZeroFloorNotRequired = typeof PricingZeroFloorNotRequiredSchema.Type;

export const PricingZeroFloorAppliedSchema = Schema.Struct({
  authorization: PricingZeroFloorAuthorizationSchema,
  authorizationSet: PricingZeroFloorCurrentAuthorizationSetSchema,
  floorAdjustment: Schema.Struct({
    amount: PricingExactNonNegativeDecimalSchema,
    currencyCode: PricingCurrencyCodeSchema,
  }),
  kind: Schema.Literal('AUTHORIZED_ZERO_FLOOR'),
  nonNegativePreRoundValue: Schema.Struct({ amount: Schema.Literal('0'), currencyCode: PricingCurrencyCodeSchema }),
  rawPostCompositionValue: Schema.Struct({
    amount: PricingStrictlyNegativeDecimalSchema,
    currencyCode: PricingCurrencyCodeSchema,
  }),
}).check(
  Schema.makeFilter(({ authorization, authorizationSet }) =>
    authorizationSet.authorizations.some((candidate) => sameZeroFloorAuthorization(candidate, authorization))
      ? undefined
      : 'Applied ZERO_FLOOR authorization must be retained in its exact validated Current set',
  ),
);
export type PricingZeroFloorApplied = typeof PricingZeroFloorAppliedSchema.Type;

export const PricingZeroFloorFailureReasonSchema = Schema.Literals([
  'ALLOCATION_INDUCED_NEGATIVE',
  'AUTHORIZATION_ABSENT',
  'AUTHORIZATION_CONFLICT',
  'AUTHORIZATION_UNAVAILABLE',
  'AUTHORIZATION_UNVERIFIABLE',
  'SCOPE_MISMATCH',
  'EFFECTIVE_PERIOD_MISMATCH',
  'CURRENCY_MISMATCH',
  'ECONOMIC_COVERAGE_EXCEEDED',
]);
export type PricingZeroFloorFailureReason = typeof PricingZeroFloorFailureReasonSchema.Type;

export const PricingZeroFloorFailedSchema = Schema.Struct({
  kind: Schema.Literal('ZERO_FLOOR_FAILED'),
  occurrenceId: PricingPurchaseDemandOccurrenceIdSchema,
  reason: boundedReason,
  reasonCode: PricingZeroFloorFailureReasonSchema,
  retryable: Schema.Boolean,
});
export type PricingZeroFloorFailed = typeof PricingZeroFloorFailedSchema.Type;

export const PricingZeroFloorEvaluationResultSchema = Schema.Union([
  PricingZeroFloorNotRequiredSchema,
  PricingZeroFloorAppliedSchema,
  PricingZeroFloorFailedSchema,
]);
export type PricingZeroFloorEvaluationResult = typeof PricingZeroFloorEvaluationResultSchema.Type;

export const PricingFinalPreRoundLineSchema = Schema.Struct({
  composition: PricingLineComposedLineSchema,
  floorEvaluation: Schema.Union([PricingZeroFloorNotRequiredSchema, PricingZeroFloorAppliedSchema]),
  nonNegativePreRoundValue: Schema.Struct({
    amount: PricingExactNonNegativeDecimalSchema,
    currencyCode: PricingCurrencyCodeSchema,
  }),
  occurrenceId: PricingPurchaseDemandOccurrenceIdSchema,
});
export type PricingFinalPreRoundLine = typeof PricingFinalPreRoundLineSchema.Type;

export const PricingFinalPreRoundReadySchema = Schema.Struct({
  decision: PricingDecisionSchema,
  lines: Schema.Array(PricingFinalPreRoundLineSchema).check(Schema.isMinLength(1), Schema.isMaxLength(500)),
  outcome: Schema.Literal('PRE_ROUND_LINE_VALUES_READY'),
  rawComposition: PricingRawCompositionReadySchema,
});
export type PricingFinalPreRoundReady = typeof PricingFinalPreRoundReadySchema.Type;

export const PricingFinalPreRoundResultSchema = Schema.Union([
  PricingFinalPreRoundReadySchema,
  PricingLineCompositionFailedSchema,
  PricingZeroFloorFailedSchema,
]);
export type PricingFinalPreRoundResult = typeof PricingFinalPreRoundResultSchema.Type;
