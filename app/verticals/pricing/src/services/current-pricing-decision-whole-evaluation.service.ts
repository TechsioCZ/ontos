import type { CurrentPricingDecisionRequest } from '@app/pricing-contracts/current-pricing-decision';
import type {
  PricingCommercialFeeCalculationInput,
  PricingCommercialFeeCalculationResult,
} from '@app/pricing-contracts/domain/commercial-fee';
import type { PricingCommercialTotalReady } from '@app/pricing-contracts/domain/commercial-total';
import type {
  PricingDiscountCompositionRequest,
  PricingDiscountCompositionReady,
  PricingDiscountCompositionResult,
} from '@app/pricing-contracts/domain/discount-composition';
import type { PricingContractualDiscountCurrentSet } from '@app/pricing-contracts/domain/contractual-discount-set';
import type {
  PricingExactPriceOwnerReadReceipt,
  PricingMaterialEvidenceFenceSource,
  PricingMaterialEvidenceAssemblyRequest,
  PricingMaterialEvidenceReady,
  PricingOwnerFactProof,
  PricingRetainedExternalOwnerEvidence,
} from '@app/pricing-contracts/domain/material-evidence';
import type { PricingEvaluationAttempt } from '@app/pricing-contracts/domain/material-change';
import {
  PricingEvaluationAttemptSchema,
  PricingMaterialChangeReasonSchema,
  PricingMaterialSnapshotIdSchema,
} from '@app/pricing-contracts/domain/material-change';
import { PricingInstantSchema } from '@app/pricing-contracts/domain/currency-support';
import type {
  PricingLineCompositionRequest,
  PricingPromotionCompositionSelection,
  PricingRawCompositionReady,
  PricingZeroFloorAuthorizationSet,
} from '@app/pricing-contracts/domain/line-composition';
import type { PriceGroupFallbackResolutionInput } from '@app/pricing-contracts/domain/price-group-fallback';
import { PriceDefinitionSchema, PriceIdentityKeySchema } from '@app/pricing-contracts/domain/price-definition';
import { PricingCommercialScopeSchema } from '@app/pricing-contracts/domain/pricing-commercial-scope';
import { PriceRefSchema } from '@app/pricing-contracts/resources/price';
import type {
  ExactPriceResolution,
  ExactPriceResolutionInput,
} from '@app/pricing-contracts/domain/exact-price-resolution';
import {
  ExactPriceFoundResolutionSchema,
  ExactPriceResolutionInputSchema,
  ExactPriceResolutionSchema,
} from '@app/pricing-contracts/domain/exact-price-resolution';
import type { PricingUnitPriceCalculationSuccess } from '@app/pricing-contracts/domain/unit-price-calculation';
import type { PricingQuantityBasisAssessment } from '@app/pricing-contracts/domain/quantity-unit-package-basis';
import type {
  QuantityTierNormalizedQuantity,
  QuantityTierSelectionResult,
} from '@app/pricing-contracts/domain/quantity-tier';
import type { PricingDecisionOutcome, PricingPriceResolved } from '@app/pricing-contracts/pricing-decision';
import {
  PricingCatalogQuantityHandoffSchema,
  PricingCatalogSelectionSchema,
  PricingDecisionOutcomeSchema,
  PricingDecisionSchema,
  PricingLineSchema,
  PricingUnitBasisSchema,
} from '@app/pricing-contracts/pricing-decision';
import { Context, DateTime, Effect, Match, Option, Schema } from 'effect';

import type {
  InterpretPricingDiscountApplicabilityInput,
  PricingDiscountApplicability,
} from './discount-applicability.service.ts';
import { interpretPricingDiscountApplicability } from './discount-applicability.service.ts';
import { composePricingDiscounts } from './discount-composition.service.ts';
import type {
  PricingDiscountFeeAllocationCompositionInput,
  PricingDiscountFeeAllocationCompositionReady,
} from './discount-fee-allocation-composition.service.ts';
import { composePricingDiscountFeeAllocations } from './discount-fee-allocation-composition.service.ts';
import type {
  CurrentPricingDecisionRequiredOwnerRefs,
  CurrentPricingDecisionTrustedScope,
  CurrentPricingDecisionWholeAttempt,
  CurrentPricingDecisionWholeEvaluationPort,
} from './current-pricing-decision-evaluation.service.ts';
import type { ExactPriceResolutionTrustedContext } from './exact-price-resolution.service.ts';
import { calculatePricingCommercialFees } from './commercial-fee-calculation.service.ts';
import { calculatePricingCommercialTotals } from './commercial-totals.service.ts';
import { evaluatePricingLineValues } from './line-value-calculation.service.ts';
import { composePricingRawLines } from './line-value-composition.service.ts';
import { publishPricingLineValues } from './line-value-publication.service.ts';
import type { CurrentPricingDecisionSubjectAuthorityEvidence } from './current-pricing-decision-subject-authority.service.ts';
import type { CommercialFeeSetAuthority } from './commercial-fee-persistence.service.ts';
import type { QuantityTierSetAuthority } from './quantity-tier-persistence.service.ts';
import type { ZeroFloorAuthorizationSetAuthority } from './zero-floor-authorization-persistence.service.ts';
import { assemblePricingMaterialEvidence } from './material-evidence-assembly.service.ts';
import type { PricingOrdinaryCurrentExternalOwnerEvidenceInput } from './ordinary-current-pricing-publication.service.ts';
import { publishPricingPromotionCurrentEvaluation } from './promotion-composition-result.service.ts';
import type {
  PricingPromotionCurrentEvaluationService,
  PricingPromotionFreshAttemptSource,
} from './promotion-current-evaluation.service.ts';
import { PricingPromotionUnavailable } from './pricing-promotion-unavailable.ts';
import type { QuantityTierSelectionRequest } from './quantity-tier-selection.service.ts';
import { selectQuantityTier } from './quantity-tier-selection.service.ts';
import { calculatePricingUnitPrice } from './unit-price-calculation.service.ts';

type FailedPricingDecisionOutcome = Exclude<
  PricingDecisionOutcome,
  { readonly outcome: 'NO_APPLICABLE_PRICE' | 'PRICE_RESOLVED' }
>;

export class CurrentPricingDecisionOwnerReadFailure extends Schema.TaggedError<CurrentPricingDecisionOwnerReadFailure>()(
  'CurrentPricingDecisionOwnerReadFailure',
  {
    kind: Schema.Literals([
      'CONFIGURATION',
      'CONFLICT',
      'STALE',
      'UNAVAILABLE',
      'UNSUPPORTED_CURRENCY',
      'UNVERIFIABLE',
    ]),
    materialChangeReasons: Schema.optionalKey(
      Schema.Array(PricingMaterialChangeReasonSchema).check(Schema.isMinLength(1)),
    ),
    ownerRefs: Schema.Array(Schema.String).check(Schema.isMinLength(1)),
    previousSnapshotId: Schema.optionalKey(PricingMaterialSnapshotIdSchema),
    reason: Schema.String,
    staleEvidence: Schema.optionalKey(
      Schema.Struct({
        assessedAt: PricingInstantSchema,
        invalidatedAt: PricingInstantSchema,
        invalidatedRevision: Schema.String.check(Schema.isMinLength(1)),
      }),
    ),
  },
) {}

export interface CurrentPricingDecisionExactPriceLineInput {
  readonly exactPrice: ExactPriceResolution;
  readonly exactPriceInput: ExactPriceResolutionInput;
  readonly exactPriceTrustedContext: ExactPriceResolutionTrustedContext;
  readonly line: CurrentPricingDecisionRequest['decision']['lines'][number];
  readonly lineQuantity?: QuantityTierNormalizedQuantity;
  /** One receipt for every exact owner lookup in path order, including proven assigned-group absence. */
  readonly priceCandidateSetAuthorities: readonly PricingExactPriceOwnerReadReceipt[];
  /** Deferred until exact Price succeeds; absence paths must not fabricate a Price-backed basis. */
  readonly quantityBasis?: PricingQuantityBasisAssessment;
}

export interface CurrentPricingDecisionAttemptSourceResult {
  readonly attempt: PricingEvaluationAttempt;
  readonly exactPriceLines: readonly [
    CurrentPricingDecisionExactPriceLineInput,
    ...CurrentPricingDecisionExactPriceLineInput[],
  ];
  readonly requiredOwnerRefs: CurrentPricingDecisionRequiredOwnerRefs;
}

/**
 * Opens one fresh owner snapshot for the whole candidate. Implementations must reread every line;
 * a second ordinal cannot patch or reuse any part of the first result.
 */
export interface CurrentPricingDecisionAttemptSourcePort {
  readonly loadFresh: (
    request: CurrentPricingDecisionRequest,
    trustedScope: CurrentPricingDecisionTrustedScope,
    ordinal: 1 | 2,
  ) => Effect.Effect<CurrentPricingDecisionAttemptSourceResult, CurrentPricingDecisionOwnerReadFailure>;
}

export class CurrentPricingDecisionAttemptSource extends Context.Service<
  CurrentPricingDecisionAttemptSource,
  CurrentPricingDecisionAttemptSourcePort
>()('@app/pricing/services/current-pricing-decision-whole-evaluation.service/CurrentPricingDecisionAttemptSource') {}

/** Tier reads accept the owner-issued Current-set authority; absence is never inferred from `[]`. */
export interface CurrentPricingDecisionTierSetReaderPort {
  readonly loadCurrent: (
    request: CurrentPricingDecisionRequest,
    attempt: PricingEvaluationAttempt,
    line: CurrentPricingDecisionExactPriceLineInput,
    exactPrice: ExactPriceResolution,
    aggregationGroup: readonly {
      readonly exactPrice: ExactPriceResolution;
      readonly line: CurrentPricingDecisionExactPriceLineInput;
    }[],
  ) => Effect.Effect<CurrentPricingDecisionTierSetRead, CurrentPricingDecisionOwnerReadFailure>;
}

export interface CurrentPricingDecisionTierSetRead {
  readonly authority: QuantityTierSetAuthority;
  readonly request: QuantityTierSelectionRequest;
}

export class CurrentPricingDecisionTierSetReader extends Context.Service<
  CurrentPricingDecisionTierSetReader,
  CurrentPricingDecisionTierSetReaderPort
>()('@app/pricing/services/current-pricing-decision-whole-evaluation.service/CurrentPricingDecisionTierSetReader') {}

export interface CurrentPricingDecisionFeeSetReaderPort {
  readonly loadCurrent: (
    request: CurrentPricingDecisionRequest,
    attempt: PricingEvaluationAttempt,
    unitPrice: PricingUnitPriceCalculationSuccess,
  ) => Effect.Effect<CurrentPricingDecisionFeeSetRead, CurrentPricingDecisionOwnerReadFailure>;
}

export interface CurrentPricingDecisionFeeSetRead {
  readonly authority: CommercialFeeSetAuthority;
  readonly factProofs: readonly PricingOwnerFactProof[];
  readonly input: PricingCommercialFeeCalculationInput;
}

export class CurrentPricingDecisionFeeSetReader extends Context.Service<
  CurrentPricingDecisionFeeSetReader,
  CurrentPricingDecisionFeeSetReaderPort
>()('@app/pricing/services/current-pricing-decision-whole-evaluation.service/CurrentPricingDecisionFeeSetReader') {}

/** Retains the exact owner-issued sets alongside the derived applicability interpretation inputs. */
export interface CurrentPricingDecisionDiscountSetRead {
  readonly applicabilityInputs: readonly InterpretPricingDiscountApplicabilityInput[];
  readonly currentSets: readonly PricingContractualDiscountCurrentSet[];
}

export interface CurrentPricingDecisionDiscountSetReaderPort {
  readonly loadCurrent: (input: {
    readonly attempt: PricingEvaluationAttempt;
    readonly feeResults: readonly PricingCommercialFeeCalculationResult[];
    readonly request: CurrentPricingDecisionRequest;
    readonly unitPrices: readonly PricingUnitPriceCalculationSuccess[];
  }) => Effect.Effect<CurrentPricingDecisionDiscountSetRead, CurrentPricingDecisionOwnerReadFailure>;
}

export class CurrentPricingDecisionDiscountSetReader extends Context.Service<
  CurrentPricingDecisionDiscountSetReader,
  CurrentPricingDecisionDiscountSetReaderPort
>()(
  '@app/pricing/services/current-pricing-decision-whole-evaluation.service/CurrentPricingDecisionDiscountSetReader',
) {}

export interface CurrentPricingDecisionZeroFloorSetReaderPort {
  readonly loadCurrent: (
    request: CurrentPricingDecisionRequest,
    attempt: PricingEvaluationAttempt,
    composition: PricingRawCompositionReady,
  ) => Effect.Effect<readonly CurrentPricingDecisionZeroFloorSetRead[], CurrentPricingDecisionOwnerReadFailure>;
}

export interface CurrentPricingDecisionZeroFloorSetRead {
  readonly authority: ZeroFloorAuthorizationSetAuthority;
  readonly authorizationSet: PricingZeroFloorAuthorizationSet;
  readonly factProofs: readonly PricingOwnerFactProof[];
  readonly occurrenceId: string;
}

export class CurrentPricingDecisionZeroFloorSetReader extends Context.Service<
  CurrentPricingDecisionZeroFloorSetReader,
  CurrentPricingDecisionZeroFloorSetReaderPort
>()(
  '@app/pricing/services/current-pricing-decision-whole-evaluation.service/CurrentPricingDecisionZeroFloorSetReader',
) {}

/** One fresh cross-owner read retained once for material assembly, publication, and the final fence. */
export interface CurrentPricingDecisionExternalOwnerEvidenceSnapshot {
  readonly fenceSources: readonly PricingMaterialEvidenceFenceSource[];
  readonly publication: PricingOrdinaryCurrentExternalOwnerEvidenceInput;
  readonly retained: PricingRetainedExternalOwnerEvidence;
}

export interface CurrentPricingDecisionExternalOwnerEvidencePort {
  readonly loadFresh: (input: {
    readonly attempt: PricingEvaluationAttempt;
    readonly commercialTotal: PricingCommercialTotalReady;
    readonly purchaseContextEvidence: CurrentPricingDecisionSubjectAuthorityEvidence;
    readonly request: CurrentPricingDecisionRequest;
  }) => Effect.Effect<CurrentPricingDecisionExternalOwnerEvidenceSnapshot, CurrentPricingDecisionOwnerReadFailure>;
}

export class CurrentPricingDecisionExternalOwnerEvidence extends Context.Service<
  CurrentPricingDecisionExternalOwnerEvidence,
  CurrentPricingDecisionExternalOwnerEvidencePort
>()(
  '@app/pricing/services/current-pricing-decision-whole-evaluation.service/CurrentPricingDecisionExternalOwnerEvidence',
) {}

/**
 * Promotion participates only when an upstream application has selected a material contribution.
 * `PROMOTION_NOT_SELECTED` describes this Pricing request; it makes no claim about Promotion
 * deployment, campaign applicability, or a zero-valued contribution.
 */
export type CurrentPricingDecisionPromotionRequirement =
  | { readonly kind: 'PROMOTION_NOT_SELECTED' }
  | {
      readonly kind: 'PROMOTION_SELECTED';
      readonly source: PricingPromotionFreshAttemptSource;
    };

export interface CurrentPricingDecisionWholeCompositionPort {
  readonly buildAllocationInput: (input: {
    readonly applicability: readonly PricingDiscountApplicability[];
    readonly attempt: PricingEvaluationAttempt;
    readonly discountComposition: PricingDiscountCompositionReady;
    readonly feeResults: readonly PricingCommercialFeeCalculationResult[];
    readonly request: CurrentPricingDecisionRequest;
    readonly unitPrices: readonly PricingUnitPriceCalculationSuccess[];
  }) => Effect.Effect<PricingDiscountFeeAllocationCompositionInput, CurrentPricingDecisionOwnerReadFailure>;
  readonly buildDiscountCompositionRequest: (input: {
    readonly applicability: readonly PricingDiscountApplicability[];
    readonly attempt: PricingEvaluationAttempt;
    readonly feeResults: readonly PricingCommercialFeeCalculationResult[];
    readonly request: CurrentPricingDecisionRequest;
    readonly unitPrices: readonly PricingUnitPriceCalculationSuccess[];
  }) => Effect.Effect<PricingDiscountCompositionRequest, CurrentPricingDecisionOwnerReadFailure>;
  readonly buildLineCompositionRequest: (input: {
    readonly allocation: PricingDiscountFeeAllocationCompositionReady;
    readonly attempt: PricingEvaluationAttempt;
    readonly discountComposition: Extract<
      PricingDiscountCompositionResult,
      { readonly outcome: 'DISCOUNT_COMPOSITION_READY' }
    >;
    readonly feeResults: readonly PricingCommercialFeeCalculationResult[];
    readonly promotionSelection: PricingPromotionCompositionSelection;
    readonly request: CurrentPricingDecisionRequest;
    readonly unitPrices: readonly PricingUnitPriceCalculationSuccess[];
  }) => Effect.Effect<PricingLineCompositionRequest, CurrentPricingDecisionOwnerReadFailure>;
  readonly buildMaterialEvidenceRequest: (input: {
    readonly attempt: PricingEvaluationAttempt;
    readonly commercialTotal: PricingCommercialTotalReady;
    readonly discountApplicabilityInputs: readonly InterpretPricingDiscountApplicabilityInput[];
    readonly discountCurrentSets: readonly PricingContractualDiscountCurrentSet[];
    readonly externalOwnerEvidence: CurrentPricingDecisionExternalOwnerEvidenceSnapshot;
    readonly feeSetReads: readonly CurrentPricingDecisionFeeSetRead[];
    readonly priceCandidateSetReceipts: readonly (readonly PricingExactPriceOwnerReadReceipt[])[];
    readonly purchaseContextEvidence: CurrentPricingDecisionSubjectAuthorityEvidence;
    readonly request: CurrentPricingDecisionRequest;
    readonly tierSetReads: readonly CurrentPricingDecisionTierSetRead[];
    readonly zeroFloorSetReads: readonly CurrentPricingDecisionZeroFloorSetRead[];
  }) => Effect.Effect<PricingMaterialEvidenceAssemblyRequest, CurrentPricingDecisionOwnerReadFailure>;
  readonly buildNoApplicablePrice: (input: {
    readonly attempt: PricingEvaluationAttempt;
    readonly exactPriceLines: readonly CurrentPricingDecisionExactPriceLineInput[];
    readonly request: CurrentPricingDecisionRequest;
  }) => Effect.Effect<Exclude<PricingDecisionOutcome, PricingPriceResolved>, CurrentPricingDecisionOwnerReadFailure>;
  readonly buildPublicationInput: (input: {
    readonly attempt: PricingEvaluationAttempt;
    readonly commercialTotal: PricingCommercialTotalReady;
    readonly externalOwnerEvidence: CurrentPricingDecisionExternalOwnerEvidenceSnapshot;
    readonly materialEvidence: PricingMaterialEvidenceReady;
    readonly purchaseContextEvidence: CurrentPricingDecisionSubjectAuthorityEvidence;
    readonly request: CurrentPricingDecisionRequest;
  }) => Effect.Effect<PricingOrdinaryCurrentExternalOwnerEvidenceInput, CurrentPricingDecisionOwnerReadFailure>;
  readonly resolvePromotionRequirement: (input: {
    readonly allocation: PricingDiscountFeeAllocationCompositionReady;
    readonly attempt: PricingEvaluationAttempt;
    readonly request: CurrentPricingDecisionRequest;
  }) => Effect.Effect<CurrentPricingDecisionPromotionRequirement, CurrentPricingDecisionOwnerReadFailure>;
}

export class CurrentPricingDecisionWholeComposition extends Context.Service<
  CurrentPricingDecisionWholeComposition,
  CurrentPricingDecisionWholeCompositionPort
>()('@app/pricing/services/current-pricing-decision-whole-evaluation.service/CurrentPricingDecisionWholeComposition') {}

const candidate = (request: CurrentPricingDecisionRequest, attempt: PricingEvaluationAttempt) => ({
  candidateRef: attempt.candidateRef,
  occurrenceIds: request.decision.lines.map(({ occurrenceId }) => occurrenceId),
});

const failureOutcome = (
  request: CurrentPricingDecisionRequest,
  attempt: PricingEvaluationAttempt,
  failure: CurrentPricingDecisionOwnerReadFailure,
): FailedPricingDecisionOutcome => {
  const identity = candidate(request, attempt);
  if (failure.kind === 'UNSUPPORTED_CURRENCY') {
    return {
      candidate: identity,
      outcome: 'PRICING_CONFIGURATION_ERROR',
      reasonCode: 'UNSUPPORTED_CURRENCY',
      retryable: false,
    };
  }
  if (failure.kind === 'CONFIGURATION') {
    return {
      candidate: identity,
      outcome: 'PRICING_CONFIGURATION_ERROR',
      reasonCode: 'INVALID_CANONICAL_CONFIGURATION',
      retryable: false,
    };
  }
  if (failure.kind === 'CONFLICT') {
    const [first, second] = failure.ownerRefs;
    if (first === undefined || second === undefined) {
      return {
        candidate: identity,
        inabilityEvidence: { attempts: attempt.attemptOrdinal, requiredOwnerRefs: failure.ownerRefs },
        outcome: 'PRICING_INDETERMINATE',
        reasonCode: 'CURRENTNESS_UNVERIFIABLE',
        retryable: true,
      };
    }
    return {
      candidate: identity,
      currentTruthRefs: [first, second],
      outcome: 'PRICING_CONFLICT',
      reasonCode: 'CANONICAL_STATE_CONFLICT',
      retryable: false,
    };
  }
  if (failure.kind === 'STALE') {
    if (
      failure.staleEvidence === undefined ||
      failure.previousSnapshotId === undefined ||
      failure.materialChangeReasons === undefined ||
      failure.staleEvidence.invalidatedAt <= failure.staleEvidence.assessedAt
    ) {
      return {
        candidate: identity,
        inabilityEvidence: { attempts: attempt.attemptOrdinal, requiredOwnerRefs: failure.ownerRefs },
        outcome: 'PRICING_INDETERMINATE',
        reasonCode: 'CURRENTNESS_UNVERIFIABLE',
        retryable: true,
      };
    }
    return {
      candidate: identity,
      outcome: 'PRICING_STALE',
      reasonCode: 'MATERIAL_INPUT_CHANGED',
      retryable: true,
      staleEvidence: failure.staleEvidence,
    };
  }
  return {
    candidate: identity,
    inabilityEvidence: { attempts: attempt.attemptOrdinal, requiredOwnerRefs: failure.ownerRefs },
    outcome: 'PRICING_INDETERMINATE',
    reasonCode: failure.kind === 'UNAVAILABLE' ? 'OWNER_STATE_UNAVAILABLE' : 'CURRENTNESS_UNVERIFIABLE',
    retryable: true,
  };
};

const wholeForFailure = (
  request: CurrentPricingDecisionRequest,
  attempt: PricingEvaluationAttempt,
  requiredOwnerRefs: CurrentPricingDecisionRequiredOwnerRefs,
  failure: CurrentPricingDecisionOwnerReadFailure,
): CurrentPricingDecisionWholeAttempt => {
  const outcome = failureOutcome(request, attempt, failure);
  if (outcome.outcome === 'PRICING_STALE') {
    if (failure.previousSnapshotId === undefined || failure.materialChangeReasons === undefined) {
      return {
        attempt: { attempt, kind: 'INDETERMINATE_OR_UNVERIFIABLE', reason: failure.reason },
        outcome: failureOutcome(
          request,
          attempt,
          new CurrentPricingDecisionOwnerReadFailure({
            kind: 'UNVERIFIABLE',
            ownerRefs: failure.ownerRefs,
            reason: failure.reason,
          }),
        ),
        requiredOwnerRefs,
      };
    }
    return {
      attempt: {
        attempt,
        classification: {
          _tag: 'MATERIAL_CHANGED',
          currentSnapshotId: attempt.snapshot.snapshotId,
          previousSnapshotId: failure.previousSnapshotId,
          reasons: failure.materialChangeReasons,
        },
        kind: 'KNOWN_STALE_OR_MATERIAL_CHANGED',
      },
      outcome,
      requiredOwnerRefs,
    };
  }
  if (outcome.outcome === 'PRICING_INDETERMINATE') {
    return {
      attempt: { attempt, kind: 'INDETERMINATE_OR_UNVERIFIABLE', reason: failure.reason },
      outcome,
      requiredOwnerRefs,
    };
  }
  return {
    attempt: { attempt, kind: 'KNOWN_INVALID_OR_CONFLICT', reason: failure.reason },
    outcome,
    requiredOwnerRefs,
  };
};

const sourceFailure = (
  kind: CurrentPricingDecisionOwnerReadFailure['kind'],
  ownerRefs: CurrentPricingDecisionRequiredOwnerRefs,
  reason: string,
) => new CurrentPricingDecisionOwnerReadFailure({ kind, ownerRefs, reason });

const malformed = (ownerRefs: CurrentPricingDecisionRequiredOwnerRefs, reason: string, cause?: unknown) => {
  const result = sourceFailure('UNVERIFIABLE', ownerRefs, reason);
  return cause === undefined ? result : Object.defineProperty(result, 'cause', { configurable: true, value: cause });
};

const sameCatalogHandoff = Schema.toEquivalence(PricingCatalogQuantityHandoffSchema);
const sameCatalogSelection = Schema.toEquivalence(PricingCatalogSelectionSchema);
const sameCommercialScope = Schema.toEquivalence(PricingCommercialScopeSchema);
const sameLine = Schema.toEquivalence(PricingLineSchema);
const samePriceDefinition = Schema.toEquivalence(PriceDefinitionSchema);
const samePriceIdentity = Schema.toEquivalence(PriceIdentityKeySchema);
const samePriceRef = Schema.toEquivalence(PriceRefSchema);
const sameUnitBasis = Schema.toEquivalence(PricingUnitBasisSchema);
const sameExactPriceResolutionInput = Schema.toEquivalence(ExactPriceResolutionInputSchema);

const resolutionBasis = (input: PriceGroupFallbackResolutionInput) =>
  Match.value(input).pipe(
    Match.tag('GUEST', ({ basis }) => basis),
    Match.orElse(({ interpretation }) => interpretation.basis),
  );

const groupPathBindsSubject = (
  input: PriceGroupFallbackResolutionInput,
  request: CurrentPricingDecisionRequest,
): boolean =>
  Match.value(input).pipe(
    Match.tag('GUEST', () => request.subject.kind === 'GUEST'),
    Match.orElse(() => request.subject.kind === 'PROFILE'),
  );

const sourceLineBindsRequest = (
  source: CurrentPricingDecisionExactPriceLineInput,
  expectedLine: CurrentPricingDecisionRequest['decision']['lines'][number],
  request: CurrentPricingDecisionRequest,
): boolean => {
  const { decision } = request;
  const { resolutionInput } = source.exactPriceInput;
  const basis = resolutionBasis(resolutionInput);
  const trustedOperationAt = DateTime.formatIso(source.exactPriceTrustedContext.trustedOperationAt);
  return (
    sameExactPriceResolutionInput(source.exactPriceInput, {
      currencySupport: source.exactPrice.currencySupport,
      resolutionInput: source.exactPrice.path.resolutionInput,
    }) &&
    sameLine(source.line, expectedLine) &&
    source.line.occurrenceId === expectedLine.occurrenceId &&
    sameCatalogSelection(basis.catalogSelection, expectedLine.catalog.selection) &&
    sameCommercialScope(basis.commercialScope, decision.commercialScope) &&
    basis.currencyCode === decision.currencyCode &&
    sameUnitBasis(basis.unitBasis, expectedLine.pricingBasis) &&
    resolutionInput.effectiveAt === decision.operationTime &&
    groupPathBindsSubject(resolutionInput, request) &&
    source.exactPriceInput.currencySupport.tenantId === decision.tenantId &&
    source.exactPriceInput.currencySupport.effectiveAt === decision.operationTime &&
    source.exactPriceInput.currencySupport.supportedCurrencies.includes(decision.currencyCode) &&
    source.exactPriceTrustedContext.tenantId === decision.tenantId &&
    source.exactPriceTrustedContext.legalEntityId === decision.commercialScope.sellingLegalEntityId &&
    trustedOperationAt === decision.operationTime
  );
};

const sourceLinesBindRequest = (
  sourceLines: CurrentPricingDecisionAttemptSourceResult['exactPriceLines'],
  request: CurrentPricingDecisionRequest,
): boolean =>
  sourceLines.length === request.decision.lines.length &&
  sourceLines.every((source, index) => {
    const expectedLine = request.decision.lines[index];
    return expectedLine !== undefined && sourceLineBindsRequest(source, expectedLine, request);
  });

type ResolvedCurrentPricingDecisionExactPriceLineInput = Omit<
  CurrentPricingDecisionExactPriceLineInput,
  'quantityBasis'
> & {
  readonly quantityBasis: PricingQuantityBasisAssessment;
};

const resolvedLineForPrice = (
  source: CurrentPricingDecisionExactPriceLineInput,
  exactPrice: typeof ExactPriceFoundResolutionSchema.Type,
  expectedLine: CurrentPricingDecisionRequest['decision']['lines'][number],
  request: CurrentPricingDecisionRequest,
): ResolvedCurrentPricingDecisionExactPriceLineInput | undefined => {
  const { quantityBasis } = source;
  const usedPrice = Match.value(exactPrice.path).pipe(
    Match.tag('GROUP_PRICE', ({ usedPrice: price }) => Option.some(price)),
    Match.tag('NO_GROUP_AFTER_PROVEN_GROUP_ABSENCE', ({ usedPrice: price }) => Option.some(price)),
    Match.tag('NO_GROUP_GUEST', ({ usedPrice: price }) => Option.some(price)),
    Match.tag('NO_GROUP_NONE', ({ usedPrice: price }) => Option.some(price)),
    Match.orElse(() => Option.none()),
  );
  if (quantityBasis === undefined || Option.isNone(usedPrice)) {
    return undefined;
  }
  const quantityAttempt = quantityBasis.attempt;
  const selectedPrice = usedPrice.value;
  const selectedDefinition = {
    identityKey: selectedPrice.request.exactKey,
    priceRef: selectedPrice.priceRef,
    revision: selectedPrice.priceRevision,
  };
  return quantityAttempt.effectiveAt === request.decision.operationTime &&
    quantityAttempt.occurrenceId === expectedLine.occurrenceId &&
    sameCatalogHandoff(quantityAttempt.catalog, expectedLine.catalog) &&
    samePriceIdentity(quantityAttempt.price.identityKey, selectedPrice.request.exactKey) &&
    samePriceRef(quantityAttempt.price.priceRef, selectedPrice.priceRef) &&
    samePriceDefinition(quantityAttempt.price, selectedDefinition)
    ? { ...source, quantityBasis }
    : undefined;
};

/**
 * An unavailable snapshot authority still closes one bounded attempt. The snapshot contains only
 * explicit UNVERIFIABLE evidence; it never invents a fact, an absence proof, or an owner Revision.
 */
const unavailableAttempt = Effect.fn('CurrentPricingDecisionWholeEvaluation.unavailableAttempt')(
  function* unavailableAttemptProgram(
    request: CurrentPricingDecisionRequest,
    ordinal: 1 | 2,
    ownerRefs: CurrentPricingDecisionRequiredOwnerRefs,
  ): Effect.fn.Return<PricingEvaluationAttempt> {
    const recordedAt = DateTime.formatIso(yield* DateTime.now);
    const candidateRef = [
      'pricing-current',
      request.decision.tenantId,
      request.decision.purchasingContext.contextRef,
      request.decision.purchasingContext.contextRevision,
    ].join(':');
    const runId = `${candidateRef}:run`;
    const attemptId = `${runId}:attempt:${ordinal}`;
    const snapshotId = `${attemptId}:snapshot`;
    const [ownerRef] = ownerRefs;
    return yield* Schema.decodeEffect(PricingEvaluationAttemptSchema, { onExcessProperty: 'error' })({
      attemptId,
      attemptOrdinal: ordinal,
      candidateRef,
      completedAt: recordedAt,
      maxAttempts: 2,
      runId,
      snapshot: {
        attemptId,
        calculationVersions: {
          allocationContractVersions: [],
          arithmeticProfileVersions: ['pricing-current-unavailable:v1'],
          publicationProfileVersions: ['pricing-current-unavailable:v1'],
        },
        candidateRef,
        capturedAt: recordedAt,
        decision: request.decision,
        materialBindings: [
          {
            bindingRef: 'pricing-current-decision:whole-attempt-source',
            kind: 'WHOLE_PURCHASE_BASIS_OR_ALLOCATION',
            meaningRef: `unverifiable:${ordinal}`,
            sourceEvidence: {
              _tag: 'UNVERIFIABLE',
              observedAt: recordedAt,
              reason: 'OWNER_UNAVAILABLE',
              request: {
                currencyCode: request.decision.currencyCode,
                effectiveAt: request.decision.operationTime,
                family: 'COMMERCIAL_CONTEXT',
                ownerScope: {
                  ownerModuleId: 'commerce.pricing',
                  ownerRootRef: ownerRef,
                  predicateRef: 'pricing-current-decision:whole-candidate',
                  tenantId: request.decision.tenantId,
                },
                requestedAt: recordedAt,
              },
              retryable: true,
            },
          },
        ],
        requestedAt: recordedAt,
        snapshotId,
      },
      startedAt: recordedAt,
    }).pipe(Effect.orDie);
  },
);

const terminalOutcomeBindsAttempt = (
  outcome: Exclude<PricingDecisionOutcome, PricingPriceResolved>,
  request: CurrentPricingDecisionRequest,
  attempt: PricingEvaluationAttempt,
): boolean => {
  if (outcome.outcome === 'NO_APPLICABLE_PRICE') {
    return Schema.toEquivalence(PricingDecisionSchema)(outcome.decision, request.decision);
  }
  return (
    outcome.candidate.candidateRef === attempt.candidateRef &&
    outcome.candidate.occurrenceIds.length === request.decision.lines.length &&
    outcome.candidate.occurrenceIds.every(
      (occurrenceId, index) => occurrenceId === request.decision.lines[index]?.occurrenceId,
    )
  );
};

const wholeForTerminalOutcome = (
  outcome: Exclude<PricingDecisionOutcome, PricingPriceResolved>,
  request: CurrentPricingDecisionRequest,
  attempt: PricingEvaluationAttempt,
  requiredOwnerRefs: CurrentPricingDecisionRequiredOwnerRefs,
): CurrentPricingDecisionWholeAttempt => {
  if (outcome.outcome === 'NO_APPLICABLE_PRICE') {
    return {
      attempt: {
        attempt,
        kind: 'READY_FOR_FINAL_PUBLICATION',
        publicationRequest: { kind: 'NO_APPLICABLE_PRICE', outcome },
      },
      outcome,
      requiredOwnerRefs,
    };
  }
  if (outcome.outcome === 'PRICING_CONFIGURATION_ERROR' || outcome.outcome === 'PRICING_CONFLICT') {
    return {
      attempt: { attempt, kind: 'KNOWN_INVALID_OR_CONFLICT', reason: outcome.reasonCode },
      outcome,
      requiredOwnerRefs,
    };
  }
  if (outcome.outcome === 'PRICING_INDETERMINATE') {
    return {
      attempt: { attempt, kind: 'INDETERMINATE_OR_UNVERIFIABLE', reason: outcome.reasonCode },
      outcome,
      requiredOwnerRefs,
    };
  }
  const unverifiable = failureOutcome(
    request,
    attempt,
    new CurrentPricingDecisionOwnerReadFailure({
      kind: 'UNVERIFIABLE',
      ownerRefs: requiredOwnerRefs,
      reason: 'Stale outcome lacked its exact before/after material snapshot classification',
    }),
  );
  return {
    attempt: {
      attempt,
      kind: 'INDETERMINATE_OR_UNVERIFIABLE',
      reason: 'Stale outcome lacked its exact before/after material snapshot classification',
    },
    outcome: unverifiable,
    requiredOwnerRefs,
  };
};

const effectEither = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.match({
      onFailure: (failure) => ({ failed: true as const, failure }),
      onSuccess: (success) => ({ failed: false as const, success }),
    }),
  );

const finalizeAttemptAt = (
  attempt: PricingEvaluationAttempt,
  completedAt: string,
  requiredOwnerRefs: CurrentPricingDecisionRequiredOwnerRefs,
) =>
  Schema.decodeEffect(PricingEvaluationAttemptSchema, { onExcessProperty: 'error' })({
    ...attempt,
    completedAt,
    snapshot: {
      ...attempt.snapshot,
      capturedAt: completedAt,
    },
  }).pipe(
    Effect.mapError((cause) =>
      malformed(requiredOwnerRefs, 'Whole attempt could not finalize at the real owner validation boundary', cause),
    ),
  );

const laterInstant = (left: string, right: string) =>
  DateTime.toEpochMillis(DateTime.makeUnsafe(right)) > DateTime.toEpochMillis(DateTime.makeUnsafe(left)) ? right : left;

const exactPriceObservationBoundary = (
  exactPriceLines: CurrentPricingDecisionAttemptSourceResult['exactPriceLines'],
): string => {
  let latest = exactPriceLines[0].exactPrice.currencySupport.observedAt;
  for (const line of exactPriceLines) {
    latest = laterInstant(latest, line.exactPrice.currencySupport.observedAt);
    for (const receipt of line.priceCandidateSetAuthorities) {
      latest = laterInstant(latest, receipt.authority.observedAt);
    }
  }
  return latest;
};

const evaluateWholeAttempt = Effect.fn('CurrentPricingDecisionWholeEvaluation.loadFresh')(
  function* evaluateWholeAttemptProgram(
    dependencies: {
      readonly attemptSource: CurrentPricingDecisionAttemptSourcePort;
      readonly composition: CurrentPricingDecisionWholeCompositionPort;
      readonly discountReader: CurrentPricingDecisionDiscountSetReaderPort;
      readonly externalOwnerEvidence: CurrentPricingDecisionExternalOwnerEvidencePort;
      readonly feeReader: CurrentPricingDecisionFeeSetReaderPort;
      readonly floorReader: CurrentPricingDecisionZeroFloorSetReaderPort;
      readonly promotionEvaluation: PricingPromotionCurrentEvaluationService;
      readonly tierReader: CurrentPricingDecisionTierSetReaderPort;
    },
    request: CurrentPricingDecisionRequest,
    trustedScope: CurrentPricingDecisionTrustedScope,
    ordinal: 1 | 2,
  ): Effect.fn.Return<CurrentPricingDecisionWholeAttempt> {
    const opened = yield* effectEither(dependencies.attemptSource.loadFresh(request, trustedScope, ordinal));
    if (opened.failed) {
      const [ownerRef, ...remainingOwnerRefs] = opened.failure.ownerRefs;
      if (ownerRef === undefined) {
        return yield* Effect.die('Owner-read failure omitted its required owner reference');
      }
      const requiredOwnerRefs: CurrentPricingDecisionRequiredOwnerRefs = [ownerRef, ...remainingOwnerRefs];
      const attempt = yield* unavailableAttempt(request, ordinal, requiredOwnerRefs);
      return wholeForFailure(request, attempt, requiredOwnerRefs, opened.failure);
    }
    const { attempt: draftAttempt, exactPriceLines, requiredOwnerRefs } = opened.success;
    // This owner-read draft is finalized only after every internal and external read has returned.
    let attempt = draftAttempt;
    const closeFailure = (failure: CurrentPricingDecisionOwnerReadFailure) =>
      Effect.succeed(wholeForFailure(request, attempt, requiredOwnerRefs, failure));
    if (
      attempt.attemptOrdinal !== ordinal ||
      !Schema.toEquivalence(PricingDecisionSchema)(attempt.snapshot.decision, request.decision) ||
      !sourceLinesBindRequest(exactPriceLines, request)
    ) {
      return yield* closeFailure(
        malformed(requiredOwnerRefs, 'Fresh attempt does not preserve the exact ordered request candidate'),
      );
    }
    if (request.decision.currencyCode !== 'CZK') {
      return yield* closeFailure(
        sourceFailure(
          'UNSUPPORTED_CURRENCY',
          requiredOwnerRefs,
          'The generalized Pricing contract accepts this currency, but the Launch calculation profile is CZK-only',
        ),
      );
    }

    const retainedExactPrices = Schema.decodeOption(Schema.Array(ExactPriceResolutionSchema), {
      onExcessProperty: 'error',
    })(exactPriceLines.map(({ exactPrice }) => exactPrice));
    if (Option.isNone(retainedExactPrices)) {
      return yield* closeFailure(
        malformed(requiredOwnerRefs, 'Fresh attempt retained a malformed exact Price outcome'),
      );
    }
    const exactPrices = retainedExactPrices.value;
    const foundPrices = Schema.decodeUnknownOption(Schema.Array(ExactPriceFoundResolutionSchema), {
      onExcessProperty: 'error',
    })(exactPrices);
    if (Option.isNone(foundPrices)) {
      const completedAttempt = yield* finalizeAttemptAt(
        attempt,
        exactPriceObservationBoundary(exactPriceLines),
        requiredOwnerRefs,
      ).pipe(effectEither);
      if (completedAttempt.failed) {
        return yield* closeFailure(completedAttempt.failure);
      }
      attempt = completedAttempt.success;
      const noPrice = yield* dependencies.composition
        .buildNoApplicablePrice({ attempt, exactPriceLines, request })
        .pipe(effectEither);
      if (noPrice.failed) {
        return yield* closeFailure(noPrice.failure);
      }
      const decoded = Schema.decodeOption(PricingDecisionOutcomeSchema, { onExcessProperty: 'error' })(noPrice.success);
      if (
        Option.isNone(decoded) ||
        decoded.value.outcome === 'PRICE_RESOLVED' ||
        !terminalOutcomeBindsAttempt(decoded.value, request, attempt)
      ) {
        return yield* closeFailure(
          malformed(requiredOwnerRefs, 'Terminal Price-path owner evidence failed the canonical outcome'),
        );
      }
      return wholeForTerminalOutcome(decoded.value, request, attempt, requiredOwnerRefs);
    }

    const exactFoundPrices = foundPrices.value;
    const priceAuthoritiesBindFoundPaths = exactFoundPrices.every((exactPrice, index) => {
      const source = exactPriceLines[index];
      if (source === undefined) {
        return false;
      }
      const expectedAuthorityCount = Match.value(exactPrice.path).pipe(
        Match.tag('NO_GROUP_AFTER_PROVEN_GROUP_ABSENCE', () => 2),
        Match.orElse(() => 1),
      );
      return source.priceCandidateSetAuthorities.length === expectedAuthorityCount;
    });
    if (!priceAuthoritiesBindFoundPaths) {
      return yield* closeFailure(
        malformed(requiredOwnerRefs, 'Resolved Price path lost an exact owner candidate-set authority receipt'),
      );
    }
    const resolvedLines = yield* Effect.forEach(
      exactPriceLines,
      (line, index) => {
        const exactPrice = exactFoundPrices[index];
        const expectedLine = request.decision.lines[index];
        const resolvedLine =
          exactPrice === undefined || expectedLine === undefined
            ? undefined
            : resolvedLineForPrice(line, exactPrice, expectedLine, request);
        return resolvedLine === undefined
          ? Effect.fail(
              malformed(
                requiredOwnerRefs,
                'Resolved Price lost its exact scheduled Price, Quantity, Unit, or occurrence binding',
              ),
            )
          : Effect.succeed(resolvedLine);
      },
      { concurrency: 16 },
    ).pipe(effectEither);
    if (resolvedLines.failed) {
      return yield* closeFailure(resolvedLines.failure);
    }
    const readyExactPriceLines = resolvedLines.success;
    const sameFoundPrice = Schema.toEquivalence(ExactPriceFoundResolutionSchema);
    const tierRequests = yield* Effect.forEach(
      readyExactPriceLines,
      (line, index) => {
        const exactPrice = exactFoundPrices[index];
        const aggregationGroup =
          exactPrice === undefined
            ? []
            : readyExactPriceLines.flatMap((candidateLine, candidateIndex) => {
                const candidatePrice = exactFoundPrices[candidateIndex];
                return candidatePrice !== undefined && sameFoundPrice(candidatePrice, exactPrice)
                  ? [{ exactPrice: candidatePrice, line: candidateLine }]
                  : [];
              });
        return exactPrice === undefined
          ? Effect.fail(malformed(requiredOwnerRefs, 'Exact Price result lost an original stable line'))
          : dependencies.tierReader.loadCurrent(request, attempt, line, exactPrice, aggregationGroup);
      },
      { concurrency: 16 },
    ).pipe(effectEither);
    if (tierRequests.failed) {
      return yield* closeFailure(tierRequests.failure);
    }
    const tierSelections: readonly QuantityTierSelectionResult[] = yield* Effect.forEach(
      tierRequests.success,
      ({ request: tierRequest }) => selectQuantityTier(tierRequest),
      { concurrency: 16 },
    );
    const unitPrices = yield* Effect.forEach(
      readyExactPriceLines,
      (line, index) => {
        const exactPrice = exactFoundPrices[index];
        const tierSelection = tierSelections[index];
        return exactPrice === undefined || tierSelection === undefined
          ? Effect.die('Tier selection lost an original stable line')
          : calculatePricingUnitPrice(
              line.lineQuantity === undefined
                ? {
                    exactPrice,
                    line: line.line,
                    quantityBasis: line.quantityBasis,
                    tierSelection,
                  }
                : {
                    exactPrice,
                    line: line.line,
                    lineQuantity: line.lineQuantity,
                    quantityBasis: line.quantityBasis,
                    tierSelection,
                  },
            );
      },
      { concurrency: 16 },
    ).pipe(effectEither);
    if (unitPrices.failed) {
      return yield* closeFailure(
        malformed(requiredOwnerRefs, 'Unit Price could not bind exact Price, Quantity, and Tier evidence'),
      );
    }
    const readyUnitPrices = unitPrices.success;

    const feeInputs = yield* Effect.forEach(
      readyUnitPrices,
      (unitPrice) => dependencies.feeReader.loadCurrent(request, attempt, unitPrice),
      { concurrency: 16 },
    ).pipe(effectEither);
    if (feeInputs.failed) {
      return yield* closeFailure(feeInputs.failure);
    }
    const feeResults = yield* Effect.forEach(feeInputs.success, ({ input }) => calculatePricingCommercialFees(input), {
      concurrency: 16,
    }).pipe(effectEither);
    if (feeResults.failed) {
      return yield* closeFailure(malformed(requiredOwnerRefs, 'Commercial Fee calculation rejected owner inputs'));
    }
    if (feeResults.success.some(({ outcome }) => outcome !== 'COMMERCIAL_FEES_APPLIED')) {
      return yield* closeFailure(malformed(requiredOwnerRefs, 'Commercial Fee Current set was not usable'));
    }

    const discountSetRead = yield* dependencies.discountReader
      .loadCurrent({ attempt, feeResults: feeResults.success, request, unitPrices: readyUnitPrices })
      .pipe(effectEither);
    if (discountSetRead.failed) {
      return yield* closeFailure(discountSetRead.failure);
    }
    const applicability = yield* Effect.forEach(
      discountSetRead.success.applicabilityInputs,
      interpretPricingDiscountApplicability,
      { concurrency: 16 },
    ).pipe(effectEither);
    if (applicability.failed) {
      return yield* closeFailure(malformed(requiredOwnerRefs, 'Discount applicability evidence was invalid'));
    }
    const discountRequest = yield* dependencies.composition
      .buildDiscountCompositionRequest({
        applicability: applicability.success,
        attempt,
        feeResults: feeResults.success,
        request,
        unitPrices: readyUnitPrices,
      })
      .pipe(effectEither);
    if (discountRequest.failed) {
      return yield* closeFailure(discountRequest.failure);
    }
    const discounts = yield* composePricingDiscounts(discountRequest.success).pipe(effectEither);
    if (discounts.failed || discounts.success.outcome !== 'DISCOUNT_COMPOSITION_READY') {
      return yield* closeFailure(malformed(requiredOwnerRefs, 'Discount composition was not canonically ready'));
    }
    const discountComposition = discounts.success;

    const allocationInput = yield* dependencies.composition
      .buildAllocationInput({
        applicability: applicability.success,
        attempt,
        discountComposition,
        feeResults: feeResults.success,
        request,
        unitPrices: readyUnitPrices,
      })
      .pipe(effectEither);
    if (allocationInput.failed) {
      return yield* closeFailure(allocationInput.failure);
    }
    const allocation = yield* composePricingDiscountFeeAllocations(allocationInput.success).pipe(effectEither);
    if (allocation.failed || allocation.success.outcome !== 'ALLOCATION_COMPOSITION_READY') {
      return yield* closeFailure(malformed(requiredOwnerRefs, 'Discount/Fee allocation was not canonically ready'));
    }

    const promotionRequirement = yield* dependencies.composition
      .resolvePromotionRequirement({ allocation: allocation.success, attempt, request })
      .pipe(effectEither);
    if (promotionRequirement.failed) {
      return yield* closeFailure(promotionRequirement.failure);
    }
    let promotionSelection: PricingPromotionCompositionSelection;
    if (promotionRequirement.success.kind === 'PROMOTION_NOT_SELECTED') {
      promotionSelection = promotionRequirement.success;
    } else {
      const promotionEvaluation = yield* dependencies.promotionEvaluation
        .evaluate(promotionRequirement.success.source)
        .pipe(effectEither);
      if (promotionEvaluation.failed) {
        return yield* closeFailure(
          sourceFailure(
            Schema.is(PricingPromotionUnavailable)(promotionEvaluation.failure) ? 'UNAVAILABLE' : 'UNVERIFIABLE',
            requiredOwnerRefs,
            promotionEvaluation.failure.reason,
          ),
        );
      }
      const promotion = yield* publishPricingPromotionCurrentEvaluation(promotionEvaluation.success).pipe(effectEither);
      if (promotion.failed) {
        return yield* closeFailure(malformed(requiredOwnerRefs, promotion.failure.reason));
      }
      promotionSelection = { composition: promotion.success, kind: 'PROMOTION_SELECTED' };
    }

    const lineComposition = yield* dependencies.composition
      .buildLineCompositionRequest({
        allocation: allocation.success,
        attempt,
        discountComposition,
        feeResults: feeResults.success,
        promotionSelection,
        request,
        unitPrices: readyUnitPrices,
      })
      .pipe(effectEither);
    if (lineComposition.failed) {
      return yield* closeFailure(lineComposition.failure);
    }
    const rawComposition = yield* composePricingRawLines(lineComposition.success);
    if (rawComposition.outcome !== 'RAW_COMPOSITION_READY') {
      return yield* closeFailure(malformed(requiredOwnerRefs, rawComposition.failure.reason));
    }
    const floorSet = yield* dependencies.floorReader.loadCurrent(request, attempt, rawComposition).pipe(effectEither);
    if (floorSet.failed) {
      return yield* closeFailure(floorSet.failure);
    }
    const preRound = yield* evaluatePricingLineValues({
      authorizationSets: floorSet.success.map(({ authorizationSet, occurrenceId }) => ({
        authorizationSet,
        occurrenceId,
      })),
      composition: rawComposition,
    });
    if (!('outcome' in preRound) || preRound.outcome !== 'PRE_ROUND_LINE_VALUES_READY') {
      return yield* closeFailure(malformed(requiredOwnerRefs, 'Raw/pre-round line evaluation refused publication'));
    }
    const linePublication = yield* publishPricingLineValues({
      candidateRef: attempt.candidateRef,
      decision: request.decision,
      preRound,
      publicationProfileVersion: 'pricing-czk-publication:v1',
    });
    if (linePublication.outcome !== 'LINE_VALUES_PUBLISHED') {
      return yield* closeFailure(malformed(requiredOwnerRefs, linePublication.failure.message));
    }
    const commercialTotal = yield* calculatePricingCommercialTotals({
      candidateRef: attempt.candidateRef,
      decision: request.decision,
      preRound,
      publishedLines: linePublication.publishedLines,
    });
    if (commercialTotal.outcome !== 'COMMERCIAL_TOTAL_READY') {
      return yield* closeFailure(malformed(requiredOwnerRefs, commercialTotal.failure.message));
    }
    const externalOwnerEvidence = yield* dependencies.externalOwnerEvidence
      .loadFresh({
        attempt,
        commercialTotal,
        purchaseContextEvidence: trustedScope.purchaseContextEvidence,
        request,
      })
      .pipe(effectEither);
    if (externalOwnerEvidence.failed) {
      return yield* closeFailure(externalOwnerEvidence.failure);
    }
    const completedAttempt = yield* finalizeAttemptAt(
      attempt,
      externalOwnerEvidence.success.retained.validatedAt,
      requiredOwnerRefs,
    ).pipe(effectEither);
    if (completedAttempt.failed) {
      return yield* closeFailure(completedAttempt.failure);
    }
    attempt = completedAttempt.success;
    const evidenceRequest = yield* dependencies.composition
      .buildMaterialEvidenceRequest({
        attempt,
        commercialTotal,
        discountApplicabilityInputs: discountSetRead.success.applicabilityInputs,
        discountCurrentSets: discountSetRead.success.currentSets,
        externalOwnerEvidence: externalOwnerEvidence.success,
        feeSetReads: feeInputs.success,
        priceCandidateSetReceipts: exactPriceLines.map(
          ({ priceCandidateSetAuthorities }) => priceCandidateSetAuthorities,
        ),
        purchaseContextEvidence: trustedScope.purchaseContextEvidence,
        request,
        tierSetReads: tierRequests.success,
        zeroFloorSetReads: floorSet.success,
      })
      .pipe(effectEither);
    if (evidenceRequest.failed) {
      return yield* closeFailure(evidenceRequest.failure);
    }
    const materialEvidence = yield* assemblePricingMaterialEvidence(evidenceRequest.success).pipe(effectEither);
    if (materialEvidence.failed) {
      return yield* closeFailure(malformed(requiredOwnerRefs, materialEvidence.failure.reason));
    }
    const publicationInput = yield* dependencies.composition
      .buildPublicationInput({
        attempt,
        commercialTotal,
        externalOwnerEvidence: externalOwnerEvidence.success,
        materialEvidence: materialEvidence.success,
        purchaseContextEvidence: trustedScope.purchaseContextEvidence,
        request,
      })
      .pipe(effectEither);
    if (publicationInput.failed) {
      return yield* closeFailure(publicationInput.failure);
    }
    const publicationRequest = {
      commercialTotal,
      kind: 'PRICE_RESOLVED' as const,
      materialEvidence: materialEvidence.success,
      ordinaryPublicationRequest: {
        externalOwnerEvidence: publicationInput.success,
        materialEvidence: evidenceRequest.success,
      },
    };
    return {
      attempt: {
        attempt,
        kind: 'READY_FOR_FINAL_PUBLICATION',
        publicationRequest,
      },
      outcome: { decision: request.decision, outcome: 'PRICE_RESOLVED' },
      requiredOwnerRefs,
    };
  },
);

export const makeCurrentPricingDecisionWholeEvaluationService = (dependencies: {
  readonly attemptSource: CurrentPricingDecisionAttemptSourcePort;
  readonly composition: CurrentPricingDecisionWholeCompositionPort;
  readonly discountReader: CurrentPricingDecisionDiscountSetReaderPort;
  readonly externalOwnerEvidence: CurrentPricingDecisionExternalOwnerEvidencePort;
  readonly feeReader: CurrentPricingDecisionFeeSetReaderPort;
  readonly floorReader: CurrentPricingDecisionZeroFloorSetReaderPort;
  readonly promotionEvaluation: PricingPromotionCurrentEvaluationService;
  readonly tierReader: CurrentPricingDecisionTierSetReaderPort;
}): CurrentPricingDecisionWholeEvaluationPort => ({
  loadFresh: (request, trustedScope, ordinal) => evaluateWholeAttempt(dependencies, request, trustedScope, ordinal),
});
