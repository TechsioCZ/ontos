import type { CatalogSelectionAssessmentResult } from '@app/catalog/domain/catalog-selection-evidence';
import {
  CatalogSelectionAssessmentResultSchema,
  CatalogSelectionSchema,
} from '@app/catalog/domain/catalog-selection-evidence';
import type {
  PricingCurrentMarketEvidenceResponse,
  PricingMarketSourceReceipt,
} from '@app/commerce-market-catalog/api/pricing-current-market-evidence';
import { PricingCurrentMarketEvidenceResponseSchema } from '@app/commerce-market-catalog/api/pricing-current-market-evidence';
import type { PricingCurrencySubject } from '@app/pricing-contracts/current-supported-currencies';
import type {
  PriceGroupAssignmentProfile,
  PriceGroupAssignmentResolutionResponse,
} from '@app/pricing-contracts/domain/price-group-interpretation';
import {
  PriceGroupAssignmentProfileSchema,
  PriceGroupAssignmentResolutionResponseSchema,
} from '@app/pricing-contracts/domain/price-group-interpretation';
import type { PricingCommercialScope } from '@app/pricing-contracts/domain/pricing-commercial-scope';
import { PricingCommercialScopeSchema } from '@app/pricing-contracts/domain/pricing-commercial-scope';
import type {
  PricingRetainedCatalogOwnerEvidence,
  PricingRetainedExternalOwnerEvidence,
  PricingRetainedPromotionEvidence,
} from '@app/pricing-contracts/domain/material-evidence';
import { PricingRetainedExternalOwnerEvidenceSchema } from '@app/pricing-contracts/domain/material-evidence';
import type { PricingDecision } from '@app/pricing-contracts/pricing-decision';
import { PricingDecisionSchema } from '@app/pricing-contracts/pricing-decision';
import type {
  PricingSourceEvidenceRequest,
  PricingSourceEvidenceResult,
} from '@app/pricing-contracts/domain/source-revision-evidence';
import {
  PricingSourceEvidenceConflictSchema,
  PricingSourceEvidenceMissingSchema,
  PricingSourceEvidenceUnverifiableSchema,
  PricingSourceEvidenceVerifiedAbsentSchema,
  PricingSourceEvidenceVerifiedPresentSchema,
} from '@app/pricing-contracts/domain/source-revision-evidence';
import type { PromotionContributionOutcome } from '@app/pricing-contracts/domain/promotion-contribution';
import {
  PromotionContributionDecisionSchema,
  PromotionContributionOutcomeSchema,
} from '@app/pricing-contracts/domain/promotion-contribution';
import type {
  OwnerVerifiableSetCompletenessEvidence,
  OwnerVerifiableSetCompletenessEvidenceEncoded,
} from '@app/shared-contracts';
import { Context, DateTime, Effect, Layer, Match, Option, Schema } from 'effect';

const boundedReason = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000), Schema.isTrimmed());
const CATALOG_OWNER = 'commerce.catalog' as const;
const CUSTOMER_CONTEXT_OWNER = 'commerce.customer-context' as const;
const MARKET_CATALOG_OWNER = 'commerce.market-catalog' as const;
const PROMOTION_OWNER = 'commerce.promotion' as const;

export const PricingExternalOwnerSchema = Schema.Literals([
  CATALOG_OWNER,
  CUSTOMER_CONTEXT_OWNER,
  MARKET_CATALOG_OWNER,
  PROMOTION_OWNER,
]);
export type PricingExternalOwner = typeof PricingExternalOwnerSchema.Type;

export const PricingExternalOwnerEvidenceMismatchReasonSchema = Schema.Literals([
  'MALFORMED_OWNER_PAYLOAD',
  'MALFORMED_SOURCE_EVIDENCE',
  'OWNER_SCOPE_MISMATCH',
  'OUTCOME_PROOF_CLASS_MISMATCH',
  'OWNER_EVIDENCE_MISMATCH',
  'COMMERCIAL_SCOPE_MISMATCH',
  'CANDIDATE_CONTEXT_MISMATCH',
]);

export class PricingExternalOwnerEvidenceMismatch extends Schema.TaggedError<PricingExternalOwnerEvidenceMismatch>()(
  'PricingExternalOwnerEvidenceMismatch',
  {
    ownerModuleId: PricingExternalOwnerSchema,
    reason: PricingExternalOwnerEvidenceMismatchReasonSchema,
    safeDetail: boundedReason,
  },
) {}

export interface PricingExternalOwnerEvidenceExpectation {
  readonly expectedOwnerRootRef: string;
  readonly expectedPredicateRef: string;
  readonly requestedAt: PricingSourceEvidenceRequest['requestedAt'];
}

export interface PricingCatalogSelectionEvidenceValidationInput extends PricingExternalOwnerEvidenceExpectation {
  readonly assessment: CatalogSelectionAssessmentResult;
  readonly expectedEffectiveAt: PricingSourceEvidenceRequest['effectiveAt'];
  readonly expectedSelection: unknown;
  readonly sourceEvidence: PricingSourceEvidenceResult;
}

export interface PricingMarketEvidenceValidationInput extends PricingExternalOwnerEvidenceExpectation {
  readonly expectedCommercialScope: unknown;
  readonly expectedEffectiveAt: PricingSourceEvidenceRequest['effectiveAt'];
  readonly response: PricingCurrentMarketEvidenceResponse;
  readonly sourceEvidence: PricingSourceEvidenceResult;
  readonly tenantId: string;
}

export interface PricingPriceGroupEvidenceValidationInput extends PricingExternalOwnerEvidenceExpectation {
  readonly expectedEffectiveAt: PricingSourceEvidenceRequest['effectiveAt'];
  readonly expectedProfile: PriceGroupAssignmentProfile;
  readonly response?: PriceGroupAssignmentResolutionResponse;
  readonly sourceEvidence: PricingSourceEvidenceResult;
}

export interface PricingPromotionEvidenceValidationInput extends PricingExternalOwnerEvidenceExpectation {
  readonly outcome: PromotionContributionOutcome;
  readonly sourceEvidence: PricingSourceEvidenceResult;
}

export interface PricingExternalOwnerEvidenceAccepted<OwnerPayload> {
  /** The owner payload is retained exactly; it is never reduced to IDs, row counts, or a cache marker. */
  readonly ownerPayload: OwnerPayload;
  /** Both source proof classes and their owner-verifiable references are retained losslessly. */
  readonly sourceEvidence: PricingSourceEvidenceResult;
}

export interface PricingRetainedCatalogOwnerEvidenceInput {
  readonly occurrenceId: PricingRetainedCatalogOwnerEvidence['occurrenceId'];
  readonly validation: PricingExternalOwnerEvidenceAccepted<CatalogSelectionAssessmentResult>;
}

export type PricingRetainedPromotionEvidenceInput =
  | { readonly kind: 'PROMOTION_NOT_SELECTED' }
  | {
      readonly kind: 'PROMOTION_SELECTED';
      readonly validation: PricingExternalOwnerEvidenceAccepted<PromotionContributionOutcome>;
    };

export interface PricingRetainedExternalOwnerEvidenceInput {
  readonly candidateRef: string;
  readonly catalogSelections: readonly PricingRetainedCatalogOwnerEvidenceInput[];
  readonly decision: PricingDecision;
  readonly market: PricingExternalOwnerEvidenceAccepted<PricingCurrentMarketEvidenceResponse>;
  readonly priceGroupAssignment?: PricingExternalOwnerEvidenceAccepted<
    PriceGroupAssignmentResolutionResponse | undefined
  >;
  readonly promotion: PricingRetainedPromotionEvidenceInput;
  readonly requestedAt: PricingSourceEvidenceRequest['requestedAt'];
  readonly subject: PricingCurrencySubject;
  readonly validatedAt: PricingSourceEvidenceRequest['requestedAt'];
}

export interface PricingExternalOwnerEvidenceValidationService {
  readonly retainValidatedOwnerEvidence: (
    input: PricingRetainedExternalOwnerEvidenceInput,
  ) => Effect.Effect<PricingRetainedExternalOwnerEvidence, PricingExternalOwnerEvidenceMismatch>;
  readonly validateCatalogSelection: (
    input: PricingCatalogSelectionEvidenceValidationInput,
  ) => Effect.Effect<
    PricingExternalOwnerEvidenceAccepted<CatalogSelectionAssessmentResult>,
    PricingExternalOwnerEvidenceMismatch
  >;
  readonly validateMarket: (
    input: PricingMarketEvidenceValidationInput,
  ) => Effect.Effect<
    PricingExternalOwnerEvidenceAccepted<PricingCurrentMarketEvidenceResponse>,
    PricingExternalOwnerEvidenceMismatch
  >;
  readonly validatePriceGroupAssignment: (
    input: PricingPriceGroupEvidenceValidationInput,
  ) => Effect.Effect<
    PricingExternalOwnerEvidenceAccepted<PriceGroupAssignmentResolutionResponse | undefined>,
    PricingExternalOwnerEvidenceMismatch
  >;
  readonly validatePromotion: (
    input: PricingPromotionEvidenceValidationInput,
  ) => Effect.Effect<
    PricingExternalOwnerEvidenceAccepted<PromotionContributionOutcome>,
    PricingExternalOwnerEvidenceMismatch
  >;
}

export class PricingExternalOwnerEvidenceValidation extends Context.Service<
  PricingExternalOwnerEvidenceValidation,
  PricingExternalOwnerEvidenceValidationService
>()('@app/pricing/services/external-owner-evidence-validation.service/PricingExternalOwnerEvidenceValidation') {}

const sameSelection = Schema.toEquivalence(CatalogSelectionSchema);
const sameProfile = Schema.toEquivalence(PriceGroupAssignmentProfileSchema);
const sameDecision = Schema.toEquivalence(PricingDecisionSchema);

type Completeness = OwnerVerifiableSetCompletenessEvidence | OwnerVerifiableSetCompletenessEvidenceEncoded;

const instant = (value: string | DateTime.Utc): string =>
  Schema.is(Schema.String)(value) ? value : DateTime.formatIso(value);

const sameCompleteness = (left: Completeness, right: Completeness): boolean =>
  left.ownerRevision === right.ownerRevision &&
  instant(left.observedAt) === instant(right.observedAt) &&
  (left.nextApplicabilityBoundary === undefined ? undefined : instant(left.nextApplicabilityBoundary)) ===
    (right.nextApplicabilityBoundary === undefined ? undefined : instant(right.nextApplicabilityBoundary)) &&
  left.scope.kind === right.scope.kind &&
  left.scope.predicateRef === right.scope.predicateRef &&
  (left.scope.kind === 'EXACT_PREDICATE' ||
    (right.scope.kind === 'SAFELY_BROADER_SCOPE' && left.scope.declaredScopeRef === right.scope.declaredScopeRef));

const mismatch = (
  ownerModuleId: PricingExternalOwner,
  reason: typeof PricingExternalOwnerEvidenceMismatchReasonSchema.Type,
  safeDetail: string,
) => new PricingExternalOwnerEvidenceMismatch({ ownerModuleId, reason, safeDetail });

const decodeSourceEvidence = (
  ownerModuleId: PricingExternalOwner,
  sourceEvidence: PricingSourceEvidenceResult,
): Effect.Effect<PricingSourceEvidenceResult, PricingExternalOwnerEvidenceMismatch> =>
  Schema.is(PricingSourceEvidenceVerifiedPresentSchema)(sourceEvidence) ||
  Schema.is(PricingSourceEvidenceVerifiedAbsentSchema)(sourceEvidence) ||
  Schema.is(PricingSourceEvidenceConflictSchema)(sourceEvidence) ||
  Schema.is(PricingSourceEvidenceMissingSchema)(sourceEvidence) ||
  Schema.is(PricingSourceEvidenceUnverifiableSchema)(sourceEvidence)
    ? Effect.succeed(sourceEvidence)
    : Effect.fail(mismatch(ownerModuleId, 'MALFORMED_SOURCE_EVIDENCE', 'Owner source evidence is malformed'));

const validateScope = (
  sourceEvidence: PricingSourceEvidenceResult,
  ownerModuleId: PricingExternalOwner,
  family: 'COMMERCIAL_CONTEXT' | 'PROMOTION',
  tenantId: string,
  effectiveAt: PricingSourceEvidenceRequest['effectiveAt'],
  expectation: PricingExternalOwnerEvidenceExpectation,
): Effect.Effect<void, PricingExternalOwnerEvidenceMismatch> => {
  const { request } = sourceEvidence;
  return request.family === family &&
    request.ownerScope.ownerModuleId === ownerModuleId &&
    request.ownerScope.ownerRootRef === expectation.expectedOwnerRootRef &&
    request.ownerScope.predicateRef === expectation.expectedPredicateRef &&
    request.ownerScope.tenantId === tenantId &&
    request.effectiveAt === effectiveAt &&
    request.requestedAt === expectation.requestedAt
    ? Effect.void
    : Effect.fail(
        mismatch(ownerModuleId, 'OWNER_SCOPE_MISMATCH', 'Source evidence does not bind the exact owner request'),
      );
};

const ProofClassSchema = Schema.Literals(['ABSENT', 'CONFLICT', 'MISSING', 'PRESENT', 'UNVERIFIABLE']);
type ProofClass = typeof ProofClassSchema.Type;

const proofClass = (sourceEvidence: PricingSourceEvidenceResult): ProofClass =>
  Match.value(sourceEvidence).pipe(
    Match.tag('VERIFIED_PRESENT', () => 'PRESENT' as const),
    Match.tag('VERIFIED_ABSENT', () => 'ABSENT' as const),
    Match.tag('CONFLICT', () => 'CONFLICT' as const),
    Match.tag('MISSING', () => 'MISSING' as const),
    Match.tag('UNVERIFIABLE', () => 'UNVERIFIABLE' as const),
    Match.exhaustive,
  );

const requireProofClass = (
  ownerModuleId: PricingExternalOwner,
  sourceEvidence: PricingSourceEvidenceResult,
  expected: readonly ProofClass[],
): Effect.Effect<void, PricingExternalOwnerEvidenceMismatch> =>
  expected.includes(proofClass(sourceEvidence))
    ? Effect.void
    : Effect.fail(
        mismatch(
          ownerModuleId,
          'OUTCOME_PROOF_CLASS_MISMATCH',
          'Owner outcome and source-evidence proof class do not agree',
        ),
      );

const catalogExpectedProofClasses = (assessment: CatalogSelectionAssessmentResult): readonly ProofClass[] => {
  if ('status' in assessment) {
    return assessment.status === 'INDETERMINATE' ? ['UNVERIFIABLE'] : ['PRESENT'];
  }
  if (assessment.kind === 'NOT_FOUND') {
    return ['ABSENT'];
  }
  if (assessment.kind === 'CONFLICT') {
    return ['CONFLICT'];
  }
  return ['UNVERIFIABLE'];
};

const marketExpectedProofClasses = (response: PricingCurrentMarketEvidenceResponse): readonly ProofClass[] =>
  Match.value(response).pipe(
    Match.discriminator('outcome')('PRICING_MARKET_SOURCE_PRESENT', () => ['PRESENT'] as const),
    Match.discriminator('outcome')('PRICING_MARKET_SOURCE_ABSENT', () => ['ABSENT'] as const),
    Match.discriminator('outcome')('PRICING_MARKET_SOURCE_CONFLICT', () => ['CONFLICT'] as const),
    Match.discriminator('outcome')('PRICING_MARKET_SOURCE_MISSING', () => ['MISSING'] as const),
    Match.discriminator('outcome')('PRICING_MARKET_SOURCE_CHANGED', () => ['UNVERIFIABLE'] as const),
    Match.discriminator('outcome')('PRICING_MARKET_SOURCE_UNAVAILABLE', () => ['UNVERIFIABLE'] as const),
    Match.discriminator('outcome')('PRICING_MARKET_SOURCE_UNVERIFIABLE', () => ['UNVERIFIABLE'] as const),
    Match.exhaustive,
  );

const priceGroupExpectedProofClasses = (
  response: PriceGroupAssignmentResolutionResponse | undefined,
): readonly ProofClass[] => {
  if (response === undefined) {
    return ['MISSING', 'UNVERIFIABLE'];
  }
  return Match.value(response.resolution).pipe(
    Match.tag('NONE', () => ['ABSENT'] as const),
    Match.tag('INCONSISTENT', () => ['CONFLICT'] as const),
    Match.tag('ASSIGNED', () => ['PRESENT'] as const),
    Match.tag('BROKEN', () => ['PRESENT'] as const),
    Match.exhaustive,
  );
};

const promotionExpectedProofClasses = (outcome: PromotionContributionOutcome): readonly ProofClass[] =>
  Match.value(outcome).pipe(
    Match.tag('PROMOTION_CONTRIBUTION_APPLIED', () => ['PRESENT'] as const),
    Match.tag('PROMOTION_CONTRIBUTION_PARKED_NON_POSITIVE_BASIS', () => ['PRESENT'] as const),
    Match.tag('PROMOTION_CONTRIBUTION_NOT_APPLICABLE', () => ['ABSENT'] as const),
    Match.tag('PROMOTION_CONTRIBUTION_CONFLICT', () => ['CONFLICT'] as const),
    Match.tag('PROMOTION_CONTRIBUTION_UNAVAILABLE', () => ['UNVERIFIABLE'] as const),
    Match.tag('PROMOTION_CONTRIBUTION_UNVERIFIABLE', () => ['UNVERIFIABLE'] as const),
    Match.tag('PROMOTION_CONTRIBUTION_INVALID', () => ['MISSING'] as const),
    Match.exhaustive,
  );

const accepted = <OwnerPayload>(
  ownerPayload: OwnerPayload,
  sourceEvidence: PricingSourceEvidenceResult,
): PricingExternalOwnerEvidenceAccepted<OwnerPayload> => ({ ownerPayload, sourceEvidence });

const catalogAssessmentSelection = (assessment: CatalogSelectionAssessmentResult) => {
  if ('status' in assessment) {
    return Option.some(assessment.selection);
  }
  if ('requested' in assessment) {
    return Option.some(assessment.requested);
  }
  return Option.none();
};

const evidenceCompleteness = (sourceEvidence: PricingSourceEvidenceResult): Option.Option<Completeness> =>
  Schema.is(PricingSourceEvidenceVerifiedPresentSchema)(sourceEvidence) ||
  Schema.is(PricingSourceEvidenceVerifiedAbsentSchema)(sourceEvidence)
    ? Option.some(sourceEvidence.completeness.completenessEvidence)
    : Option.none();

type PresentMarketResponse = Extract<
  PricingCurrentMarketEvidenceResponse,
  { readonly outcome: 'PRICING_MARKET_SOURCE_PRESENT' }
>;

const presentMarketResponse = (response: PricingCurrentMarketEvidenceResponse): Option.Option<PresentMarketResponse> =>
  Match.value(response).pipe(
    Match.discriminator('outcome')('PRICING_MARKET_SOURCE_PRESENT', (present): Option.Option<PresentMarketResponse> =>
      Option.some(present),
    ),
    Match.orElse((): Option.Option<PresentMarketResponse> => Option.none()),
  );

const optionalInstant = (value: string | DateTime.Utc | undefined): string | undefined =>
  value === undefined ? undefined : instant(value);
const nullableInstant = (value: string | null): string | undefined => optionalInstant(value ?? undefined);

const marketReceiptMatchesSourceEvidence = (
  receipt: PricingMarketSourceReceipt,
  sourceEvidence: PricingSourceEvidenceResult,
): boolean => {
  if (
    !Schema.is(PricingSourceEvidenceVerifiedPresentSchema)(sourceEvidence) &&
    !Schema.is(PricingSourceEvidenceVerifiedAbsentSchema)(sourceEvidence)
  ) {
    return false;
  }
  const { authority } = receipt;
  const { completeness } = sourceEvidence;
  if (
    authority.ownerRootRef !== completeness.ownerScope.ownerRootRef ||
    authority.ownerSetRevisionRef !== completeness.ownerSetRevisionRef ||
    authority.predicateRef !== completeness.ownerScope.predicateRef ||
    authority.verificationRef !== completeness.verification.verificationRef ||
    instant(authority.observedAt) !== completeness.temporal.observedAt ||
    optionalInstant(authority.nextApplicabilityBoundary) !== completeness.temporal.nextMaterialBoundary
  ) {
    return false;
  }
  if (Schema.is(PricingSourceEvidenceVerifiedAbsentSchema)(sourceEvidence)) {
    return receipt.state === 'ABSENT' && receipt.currentFacts.length === 0;
  }
  if (receipt.state !== 'PRESENT' || sourceEvidence.currentFacts.length !== 1) {
    return false;
  }
  const [receiptFact] = receipt.currentFacts;
  const [sourceFact] = sourceEvidence.currentFacts;
  return (
    receiptFact !== undefined &&
    sourceFact !== undefined &&
    receiptFact.factRef === sourceFact.factRef &&
    receiptFact.factRevisionRef === sourceFact.factRevisionRef &&
    receiptFact.verificationRef === sourceFact.verification.verificationRef &&
    instant(receiptFact.effectivePeriod.startsAt) === sourceFact.effectivePeriod.effectiveFrom &&
    optionalInstant(receiptFact.effectivePeriod.endsAt) === nullableInstant(sourceFact.effectivePeriod.effectiveTo)
  );
};

const sourceObservedAt = (sourceEvidence: PricingSourceEvidenceResult): string =>
  Schema.is(PricingSourceEvidenceVerifiedPresentSchema)(sourceEvidence) ||
  Schema.is(PricingSourceEvidenceVerifiedAbsentSchema)(sourceEvidence) ||
  Schema.is(PricingSourceEvidenceConflictSchema)(sourceEvidence)
    ? sourceEvidence.completeness.temporal.observedAt
    : sourceEvidence.observedAt;

const marketRequestBindsScope = (
  request: PricingCurrentMarketEvidenceResponse['request'],
  scope: PricingCommercialScope,
  tenantId: string,
  expectedEffectiveAt: string,
  requestedAt: string,
): boolean =>
  request.commercialScope.channel === scope.channelId &&
  request.commercialScope.marketRef.resourceId === scope.marketId &&
  request.commercialScope.sellingLegalEntityRef.resourceId === scope.sellingLegalEntityId &&
  request.commercialScope.marketRef.tenantId === tenantId &&
  request.commercialScope.sellingLegalEntityRef.tenantId === tenantId &&
  instant(request.effectiveAt) === expectedEffectiveAt &&
  instant(request.requestedAt) === requestedAt;

const marketResponseProofMatches = (
  response: PricingCurrentMarketEvidenceResponse,
  evidence: PricingSourceEvidenceResult,
  requestedAt: string,
): boolean => {
  const receiptMatches = (receipt: PricingMarketSourceReceipt) =>
    instant(receipt.authority.observedAt) >= requestedAt && marketReceiptMatchesSourceEvidence(receipt, evidence);
  const observationMatches = (observedAt: DateTime.Utc) => instant(observedAt) === sourceObservedAt(evidence);
  return Match.value(response).pipe(
    Match.discriminator('outcome')('PRICING_MARKET_SOURCE_PRESENT', ({ receipt }) => receiptMatches(receipt)),
    Match.discriminator('outcome')('PRICING_MARKET_SOURCE_ABSENT', ({ receipt }) => receiptMatches(receipt)),
    Match.discriminator('outcome')('PRICING_MARKET_SOURCE_CONFLICT', ({ observedAt }) =>
      observationMatches(observedAt),
    ),
    Match.discriminator('outcome')('PRICING_MARKET_SOURCE_MISSING', ({ observedAt }) => observationMatches(observedAt)),
    Match.discriminator('outcome')('PRICING_MARKET_SOURCE_CHANGED', ({ observedAt }) => observationMatches(observedAt)),
    Match.discriminator('outcome')('PRICING_MARKET_SOURCE_UNVERIFIABLE', ({ observedAt }) =>
      observationMatches(observedAt),
    ),
    Match.discriminator('outcome')('PRICING_MARKET_SOURCE_UNAVAILABLE', () => true),
    Match.exhaustive,
  );
};

const presentMarketBindsScope = (
  response: PresentMarketResponse,
  scope: PricingCommercialScope,
  tenantId: string,
): boolean => {
  const { market, receipt, request } = response;
  const [fact] = receipt.currentFacts;
  const effectiveAt = DateTime.toEpochMillis(request.effectiveAt);
  return (
    market.marketRef.resourceId === scope.marketId &&
    market.sellingLegalEntityRef.resourceId === scope.sellingLegalEntityId &&
    market.marketRef.tenantId === tenantId &&
    market.sellingLegalEntityRef.tenantId === tenantId &&
    market.channels.includes(scope.channelId) &&
    market.lifecycle === 'ACTIVE' &&
    fact !== undefined &&
    fact.factRef === market.marketRef.resourceId &&
    instant(fact.effectivePeriod.startsAt) === instant(market.effectivePeriod.startsAt) &&
    optionalInstant(fact.effectivePeriod.endsAt) === optionalInstant(market.effectivePeriod.endsAt) &&
    DateTime.toEpochMillis(market.effectivePeriod.startsAt) <= effectiveAt &&
    (market.effectivePeriod.endsAt === undefined || effectiveAt < DateTime.toEpochMillis(market.effectivePeriod.endsAt))
  );
};

const marketResponseBindsDecision = (
  response: PricingCurrentMarketEvidenceResponse,
  decision: PricingDecision,
  requestedAt: string,
): boolean => {
  const present = presentMarketResponse(response);
  return (
    Option.isSome(present) &&
    marketRequestBindsScope(
      present.value.request,
      decision.commercialScope,
      decision.tenantId,
      decision.operationTime,
      requestedAt,
    ) &&
    presentMarketBindsScope(present.value, decision.commercialScope, decision.tenantId)
  );
};

export const makePricingExternalOwnerEvidenceValidationService = (): PricingExternalOwnerEvidenceValidationService => ({
  retainValidatedOwnerEvidence: Effect.fn('PricingExternalOwnerEvidenceValidation.retainValidatedOwnerEvidence')(
    function* retainValidatedOwnerEvidence(input) {
      const owner = PROMOTION_OWNER;
      if (!Schema.is(PricingDecisionSchema)(input.decision)) {
        return yield* mismatch(owner, 'MALFORMED_OWNER_PAYLOAD', 'Pricing candidate decision is malformed');
      }
      const expectedLines = input.decision.lines;
      if (
        input.catalogSelections.length !== expectedLines.length ||
        !input.catalogSelections.every(({ occurrenceId, validation }, index) => {
          const expectedLine = expectedLines[index];
          if (expectedLine === undefined || expectedLine.occurrenceId !== occurrenceId) {
            return false;
          }
          const selection = catalogAssessmentSelection(validation.ownerPayload);
          return Option.isSome(selection) && sameSelection(selection.value, expectedLine.catalog.selection);
        })
      ) {
        return yield* mismatch(
          CATALOG_OWNER,
          'CANDIDATE_CONTEXT_MISMATCH',
          'Catalog owner proofs do not bind the exact ordered Pricing candidate',
        );
      }
      const presentMarket = presentMarketResponse(input.market.ownerPayload);
      if (Option.isNone(presentMarket)) {
        return yield* mismatch(
          MARKET_CATALOG_OWNER,
          'OUTCOME_PROOF_CLASS_MISMATCH',
          'A material evidence result requires a present Current Market owner proof',
        );
      }
      if (!marketResponseBindsDecision(presentMarket.value, input.decision, input.requestedAt)) {
        return yield* mismatch(
          MARKET_CATALOG_OWNER,
          'CANDIDATE_CONTEXT_MISMATCH',
          'Market owner proof does not bind the Pricing candidate commercial context',
        );
      }
      const groupResponse = input.priceGroupAssignment?.ownerPayload;
      if (
        groupResponse !== undefined &&
        (groupResponse.profile.tenantId !== input.decision.tenantId ||
          groupResponse.effectiveAt !== input.decision.operationTime)
      ) {
        return yield* mismatch(
          CUSTOMER_CONTEXT_OWNER,
          'CANDIDATE_CONTEXT_MISMATCH',
          'Price Group owner proof does not bind the Pricing candidate context',
        );
      }
      if (input.promotion.kind === 'PROMOTION_SELECTED') {
        const promotionRequest = input.promotion.validation.ownerPayload.request;
        if (
          promotionRequest.candidate.candidateRef !== input.candidateRef ||
          !sameDecision(promotionRequest.candidate.decision, input.decision)
        ) {
          return yield* mismatch(
            owner,
            'CANDIDATE_CONTEXT_MISMATCH',
            'Promotion owner proof does not bind the exact Pricing candidate',
          );
        }
      }
      const promotion: PricingRetainedPromotionEvidence =
        input.promotion.kind === 'PROMOTION_SELECTED'
          ? { kind: 'PROMOTION_SELECTED', sourceEvidence: input.promotion.validation.sourceEvidence }
          : { kind: 'PROMOTION_NOT_SELECTED' };
      const retainedBase = {
        candidateRef: input.candidateRef,
        catalogSelections: input.catalogSelections.map(({ occurrenceId, validation }) => ({
          occurrenceId,
          sourceEvidence: validation.sourceEvidence,
        })),
        decision: input.decision,
        market: input.market.sourceEvidence,
        promotion,
        requestedAt: input.requestedAt,
        subject: input.subject,
        validatedAt: input.validatedAt,
      };
      const retained: PricingRetainedExternalOwnerEvidence =
        input.priceGroupAssignment === undefined
          ? retainedBase
          : { ...retainedBase, priceGroupAssignment: input.priceGroupAssignment.sourceEvidence };
      if (!Schema.is(PricingRetainedExternalOwnerEvidenceSchema)(retained)) {
        return yield* mismatch(
          owner,
          'OWNER_EVIDENCE_MISMATCH',
          'External owner proofs are not Current and complete at final validation',
        );
      }
      return retained;
    },
  ),

  validateCatalogSelection: Effect.fn('PricingExternalOwnerEvidenceValidation.validateCatalogSelection')(
    function* validateCatalogSelection(input) {
      const owner = CATALOG_OWNER;
      if (!Schema.is(CatalogSelectionAssessmentResultSchema)(input.assessment)) {
        return yield* mismatch(owner, 'MALFORMED_OWNER_PAYLOAD', 'Catalog assessment is malformed');
      }
      const expectedSelection = Schema.decodeUnknownOption(CatalogSelectionSchema, { onExcessProperty: 'error' })(
        input.expectedSelection,
      );
      if (Option.isNone(expectedSelection)) {
        return yield* mismatch(owner, 'MALFORMED_OWNER_PAYLOAD', 'Expected Catalog selection is malformed');
      }
      const evidence = yield* decodeSourceEvidence(owner, input.sourceEvidence);
      const { assessment } = input;
      const selection = catalogAssessmentSelection(assessment);
      yield* validateScope(
        evidence,
        owner,
        'COMMERCIAL_CONTEXT',
        expectedSelection.value.productRef.tenantId,
        input.expectedEffectiveAt,
        input,
      );
      if (Option.isNone(selection) && !['UNVERIFIABLE', 'CONFLICT'].includes(proofClass(evidence))) {
        return yield* mismatch(owner, 'OWNER_EVIDENCE_MISMATCH', 'Catalog failure lacks exact selection evidence');
      }
      if (Option.isSome(selection) && !sameSelection(selection.value, expectedSelection.value)) {
        return yield* mismatch(owner, 'OWNER_SCOPE_MISMATCH', 'Catalog evidence does not bind the exact selection');
      }
      yield* requireProofClass(owner, evidence, catalogExpectedProofClasses(assessment));
      return accepted(input.assessment, evidence);
    },
  ),

  validateMarket: Effect.fn('PricingExternalOwnerEvidenceValidation.validateMarket')(function* validateMarket(input) {
    const owner = MARKET_CATALOG_OWNER;
    if (!Schema.is(PricingCurrentMarketEvidenceResponseSchema)(input.response)) {
      return yield* mismatch(
        owner,
        'MALFORMED_OWNER_PAYLOAD',
        'Commerce Market Current-evidence response is malformed',
      );
    }
    const expectedCommercialScope = Schema.decodeUnknownOption(PricingCommercialScopeSchema, {
      onExcessProperty: 'error',
    })(input.expectedCommercialScope);
    if (Option.isNone(expectedCommercialScope)) {
      return yield* mismatch(
        owner,
        'COMMERCIAL_SCOPE_MISMATCH',
        'Expected commercial scope must contain only Selling Legal Entity, Channel, and Market',
      );
    }
    const evidence = yield* decodeSourceEvidence(owner, input.sourceEvidence);
    yield* validateScope(evidence, owner, 'COMMERCIAL_CONTEXT', input.tenantId, input.expectedEffectiveAt, input);
    yield* requireProofClass(owner, evidence, marketExpectedProofClasses(input.response));
    const scope: PricingCommercialScope = expectedCommercialScope.value;
    const ownerRequest = input.response.request;
    if (!marketRequestBindsScope(ownerRequest, scope, input.tenantId, input.expectedEffectiveAt, input.requestedAt)) {
      return yield* mismatch(
        owner,
        'COMMERCIAL_SCOPE_MISMATCH',
        'Market owner response does not bind the exact Tenant, SLE, Channel, Market, and time',
      );
    }
    if (!marketResponseProofMatches(input.response, evidence, input.requestedAt)) {
      return yield* mismatch(
        owner,
        'OWNER_EVIDENCE_MISMATCH',
        'Market owner receipt or observation does not match the exact Current source evidence',
      );
    }
    const present = presentMarketResponse(input.response);
    if (Option.isSome(present) && !presentMarketBindsScope(present.value, scope, input.tenantId)) {
      return yield* mismatch(
        owner,
        'COMMERCIAL_SCOPE_MISMATCH',
        'Current Market definition and owner receipt do not bind the exact active commercial scope',
      );
    }
    return accepted(input.response, evidence);
  }),

  validatePriceGroupAssignment: Effect.fn('PricingExternalOwnerEvidenceValidation.validatePriceGroupAssignment')(
    function* validatePriceGroupAssignment(input) {
      const owner = CUSTOMER_CONTEXT_OWNER;
      if (input.response !== undefined && !Schema.is(PriceGroupAssignmentResolutionResponseSchema)(input.response)) {
        return yield* mismatch(owner, 'MALFORMED_OWNER_PAYLOAD', 'Price Group assignment response is malformed');
      }
      if (!Schema.is(PriceGroupAssignmentProfileSchema)(input.expectedProfile)) {
        return yield* mismatch(owner, 'MALFORMED_OWNER_PAYLOAD', 'Price Group profile is malformed');
      }
      const evidence = yield* decodeSourceEvidence(owner, input.sourceEvidence);
      yield* validateScope(
        evidence,
        owner,
        'COMMERCIAL_CONTEXT',
        input.expectedProfile.tenantId,
        input.expectedEffectiveAt,
        input,
      );
      yield* requireProofClass(owner, evidence, priceGroupExpectedProofClasses(input.response));
      if (
        input.response !== undefined &&
        (!sameProfile(input.response.profile, input.expectedProfile) ||
          input.response.effectiveAt !== input.expectedEffectiveAt)
      ) {
        return yield* mismatch(
          owner,
          'OWNER_EVIDENCE_MISMATCH',
          'Group assignment proof does not bind profile and time',
        );
      }
      return accepted(input.response, evidence);
    },
  ),

  validatePromotion: Effect.fn('PricingExternalOwnerEvidenceValidation.validatePromotion')(
    function* validatePromotion(input) {
      const owner = PROMOTION_OWNER;
      if (!Schema.is(PromotionContributionOutcomeSchema)(input.outcome)) {
        return yield* mismatch(owner, 'MALFORMED_OWNER_PAYLOAD', 'Promotion contribution outcome is malformed');
      }
      const evidence = yield* decodeSourceEvidence(owner, input.sourceEvidence);
      const { operationTime: effectiveAt, tenantId } = input.outcome.request.candidate.decision;
      yield* validateScope(evidence, owner, 'PROMOTION', tenantId, effectiveAt, input);
      if (input.outcome.request.exactPredicateRef !== input.expectedPredicateRef) {
        return yield* mismatch(
          owner,
          'OWNER_SCOPE_MISMATCH',
          'Promotion outcome does not bind the requested predicate',
        );
      }
      yield* requireProofClass(owner, evidence, promotionExpectedProofClasses(input.outcome));
      const completeness = evidenceCompleteness(evidence);
      if (
        Schema.is(PromotionContributionDecisionSchema)(input.outcome) &&
        (Option.isNone(completeness) ||
          !sameCompleteness(input.outcome.ownerEvidence.completenessEvidence, completeness.value))
      ) {
        return yield* mismatch(
          owner,
          'OWNER_EVIDENCE_MISMATCH',
          'Promotion eligible-set evidence was not preserved losslessly',
        );
      }
      return accepted(input.outcome, evidence);
    },
  ),
});

export const pricingExternalOwnerEvidenceValidationService = Layer.succeed(
  PricingExternalOwnerEvidenceValidation,
  makePricingExternalOwnerEvidenceValidationService(),
);
