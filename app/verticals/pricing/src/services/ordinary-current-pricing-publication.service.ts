import { CatalogSelectionSchema } from '@app/catalog/domain/catalog-selection-evidence';
import type { PricingCurrencySubject } from '@app/pricing-contracts/current-supported-currencies';
import { PricingCurrencySubjectSchema } from '@app/pricing-contracts/current-supported-currencies';
import type { PricingCommercialTotalSafeProjection } from '@app/pricing-contracts/domain/commercial-total';
import {
  PricingMaterialEvidenceConflictFailure,
  PricingMaterialEvidenceMissingFailure,
} from '@app/pricing-contracts/domain/material-evidence';
import type { PricingMaterialEvidenceAssemblyRequest } from '@app/pricing-contracts/domain/material-evidence';
import { PricingCommercialScopeSchema } from '@app/pricing-contracts/domain/pricing-commercial-scope';
import { PricingSourceEvidenceResultSchema } from '@app/pricing-contracts/domain/source-revision-evidence';
import { PricingDecisionSchema } from '@app/pricing-contracts/pricing-decision';
import { Effect, Schema } from 'effect';

import type {
  PricingCatalogSelectionEvidenceValidationInput,
  PricingExternalOwnerEvidenceAccepted,
  PricingMarketEvidenceValidationInput,
  PricingPriceGroupEvidenceValidationInput,
  PricingPromotionEvidenceValidationInput,
} from './external-owner-evidence-validation.service.ts';
import { PricingExternalOwnerEvidenceValidation } from './external-owner-evidence-validation.service.ts';
import type {
  PricingMaterialEvidenceOwnerFenceEvidence,
  PricingMaterialEvidenceOwnerFinalFence,
  PricingMaterialEvidencePublicationAuthorization,
} from './material-evidence-final-validation.service.ts';
import {
  PricingMaterialEvidenceChangedAtFinalFence,
  finalizePricingMaterialEvidenceForPublication,
} from './material-evidence-final-validation.service.ts';
import type { PricingAuthorizedInternalEvidenceHandoff } from './source-evidence-projection.service.ts';
import {
  handoffPricingSourceEvidenceToAuthorizedInternalConsumer,
  projectPricingMaterialEvidenceForCustomer,
} from './source-evidence-projection.service.ts';

const stableReference = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000), Schema.isTrimmed());
const safeDetail = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000), Schema.isTrimmed());

export const PricingOrdinaryCurrentPublicationReasonSchema = Schema.Literals([
  'EXTERNAL_OWNER_EVIDENCE_CHANGED',
  'KNOWN_INVALID_OR_CONFLICT',
  'MATERIAL_EVIDENCE_CHANGED',
  'MATERIAL_EVIDENCE_UNVERIFIABLE',
  'OWNER_FINAL_FENCE_UNAVAILABLE',
  'PUBLICATION_PROJECTION_UNVERIFIABLE',
]);

/** Ordinary Current results never publish from a partial, mixed, or unverifiable owner snapshot. */
export class PricingOrdinaryCurrentPublicationIndeterminate extends Schema.TaggedError<PricingOrdinaryCurrentPublicationIndeterminate>()(
  'PricingOrdinaryCurrentPublicationIndeterminate',
  {
    candidateRef: stableReference,
    reasonCode: PricingOrdinaryCurrentPublicationReasonSchema,
    requiredOwnerRefs: Schema.Array(stableReference).check(Schema.isMinLength(1)),
    retryable: Schema.Literal(true),
    safeDetail,
  },
) {}

export interface PricingOrdinaryCurrentExternalOwnerEvidenceInput {
  readonly catalog: readonly [
    PricingCatalogSelectionEvidenceValidationInput,
    ...PricingCatalogSelectionEvidenceValidationInput[],
  ];
  readonly market: PricingMarketEvidenceValidationInput;
  readonly priceGroup?: PricingPriceGroupEvidenceValidationInput;
  readonly promotion:
    | { readonly kind: 'PROMOTION_NOT_SELECTED' }
    | { readonly kind: 'PROMOTION_SELECTED'; readonly validation: PricingPromotionEvidenceValidationInput };
  readonly subject: PricingCurrencySubject;
}

export interface PricingOrdinaryCurrentPublicationRequest {
  readonly externalOwnerEvidence: PricingOrdinaryCurrentExternalOwnerEvidenceInput;
  readonly materialEvidence: PricingMaterialEvidenceAssemblyRequest;
}

export interface PricingOrdinaryCurrentExternalOwnerEvidenceHandoff {
  readonly catalog: readonly PricingExternalOwnerEvidenceAccepted<
    PricingCatalogSelectionEvidenceValidationInput['assessment']
  >[];
  readonly market: PricingExternalOwnerEvidenceAccepted<PricingMarketEvidenceValidationInput['response']>;
  readonly priceGroup?: PricingExternalOwnerEvidenceAccepted<PricingPriceGroupEvidenceValidationInput['response']>;
  readonly promotion:
    | { readonly kind: 'PROMOTION_NOT_SELECTED' }
    | {
        readonly evidence: PricingExternalOwnerEvidenceAccepted<PricingPromotionEvidenceValidationInput['outcome']>;
        readonly kind: 'PROMOTION_SELECTED';
      };
  readonly subject: PricingCurrencySubject;
}

export interface PricingOrdinaryCurrentAuthorizedPublication {
  readonly externalOwnerEvidence: PricingOrdinaryCurrentExternalOwnerEvidenceHandoff;
  readonly finalFenceEvidence: PricingMaterialEvidenceOwnerFenceEvidence;
  readonly internalEvidence: PricingAuthorizedInternalEvidenceHandoff;
  readonly outcome: 'ORDINARY_CURRENT_PRICING_PUBLICATION_AUTHORIZED';
}

const sameCatalogSelection = Schema.toEquivalence(CatalogSelectionSchema);
const samePricingDecision = Schema.toEquivalence(PricingDecisionSchema);
const samePricingSubject = Schema.toEquivalence(PricingCurrencySubjectSchema);
const sameSourceEvidence = Schema.toEquivalence(PricingSourceEvidenceResultSchema);

const requiredOwnerRefs = (request: PricingOrdinaryCurrentPublicationRequest): readonly string[] => {
  const { promotion } = request.externalOwnerEvidence;
  return [
    ...request.externalOwnerEvidence.catalog.map(({ expectedOwnerRootRef }) => expectedOwnerRootRef),
    request.externalOwnerEvidence.market.expectedOwnerRootRef,
    ...(request.externalOwnerEvidence.priceGroup === undefined
      ? []
      : [request.externalOwnerEvidence.priceGroup.expectedOwnerRootRef]),
    ...(promotion.kind === 'PROMOTION_SELECTED' ? [promotion.validation.expectedOwnerRootRef] : []),
  ];
};

const indeterminate = (
  request: PricingOrdinaryCurrentPublicationRequest,
  reasonCode: typeof PricingOrdinaryCurrentPublicationReasonSchema.Type,
  safeFailureDetail: string,
  cause?: unknown,
): PricingOrdinaryCurrentPublicationIndeterminate => {
  const failure = new PricingOrdinaryCurrentPublicationIndeterminate({
    candidateRef: request.materialEvidence.commercialTotal.candidateRef,
    reasonCode,
    requiredOwnerRefs: requiredOwnerRefs(request),
    retryable: true,
    safeDetail: safeFailureDetail,
  });
  return cause === undefined ? failure : Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
};

const subjectAndPriceGroupBind = (
  external: PricingOrdinaryCurrentExternalOwnerEvidenceInput,
  retained: PricingMaterialEvidenceAssemblyRequest['externalOwnerEvidence'],
  decision: PricingMaterialEvidenceAssemblyRequest['commercialTotal']['decision'],
): boolean => {
  if (!samePricingSubject(external.subject, retained.subject)) {
    return false;
  }
  const { priceGroup } = external;
  const retainedPriceGroup = retained.priceGroupAssignment;
  if (external.subject.kind === 'GUEST') {
    return priceGroup === undefined && retainedPriceGroup === undefined;
  }
  return (
    priceGroup !== undefined &&
    retainedPriceGroup !== undefined &&
    priceGroup.expectedEffectiveAt === decision.operationTime &&
    priceGroup.expectedProfile.tenantId === decision.tenantId &&
    priceGroup.expectedProfile.resourceId === external.subject.profileRef.resourceId &&
    sameSourceEvidence(priceGroup.sourceEvidence, retainedPriceGroup)
  );
};

const evidenceInputBindsCommercialResult = (request: PricingOrdinaryCurrentPublicationRequest): boolean => {
  const { commercialTotal } = request.materialEvidence;
  const { decision } = commercialTotal;
  const external = request.externalOwnerEvidence;
  if (
    external.catalog.length !== decision.lines.length ||
    external.catalog.some(({ expectedEffectiveAt, expectedSelection, sourceEvidence }, index) => {
      const line = decision.lines[index];
      const retained = request.materialEvidence.externalOwnerEvidence.catalogSelections[index];
      return (
        line === undefined ||
        retained === undefined ||
        expectedEffectiveAt !== decision.operationTime ||
        !Schema.is(CatalogSelectionSchema)(expectedSelection) ||
        !sameCatalogSelection(expectedSelection, line.catalog.selection) ||
        !sameSourceEvidence(sourceEvidence, retained.sourceEvidence)
      );
    })
  ) {
    return false;
  }
  const { market } = external;
  if (
    market.tenantId !== decision.tenantId ||
    market.expectedEffectiveAt !== decision.operationTime ||
    !Schema.is(PricingCommercialScopeSchema)(market.expectedCommercialScope) ||
    !sameSourceEvidence(market.sourceEvidence, request.materialEvidence.externalOwnerEvidence.market)
  ) {
    return false;
  }
  const commercialScope = market.expectedCommercialScope;
  if (
    commercialScope.channelId !== decision.commercialScope.channelId ||
    commercialScope.marketId !== decision.commercialScope.marketId ||
    commercialScope.sellingLegalEntityId !== decision.commercialScope.sellingLegalEntityId
  ) {
    return false;
  }
  const retainedExternal = request.materialEvidence.externalOwnerEvidence;
  if (!subjectAndPriceGroupBind(external, retainedExternal, decision)) {
    return false;
  }
  const retainedPromotion = request.materialEvidence.externalOwnerEvidence.promotion;
  if (external.promotion.kind !== retainedPromotion.kind) {
    return false;
  }
  if (external.promotion.kind === 'PROMOTION_NOT_SELECTED') {
    return true;
  }
  if (retainedPromotion.kind !== 'PROMOTION_SELECTED') {
    return false;
  }
  const promotionRequest = external.promotion.validation.outcome.request;
  return (
    promotionRequest.candidate.candidateRef === commercialTotal.candidateRef &&
    samePricingDecision(promotionRequest.candidate.decision, decision) &&
    sameSourceEvidence(external.promotion.validation.sourceEvidence, retainedPromotion.sourceEvidence)
  );
};

const finalizationIndeterminate = (
  request: PricingOrdinaryCurrentPublicationRequest,
  cause: unknown,
): PricingOrdinaryCurrentPublicationIndeterminate => {
  if (Schema.is(PricingMaterialEvidenceChangedAtFinalFence)(cause)) {
    return indeterminate(
      request,
      'MATERIAL_EVIDENCE_CHANGED',
      'Material owner state changed after this coherent Pricing attempt was evaluated',
      cause,
    );
  }
  if (
    Schema.is(PricingMaterialEvidenceConflictFailure)(cause) ||
    Schema.is(PricingMaterialEvidenceMissingFailure)(cause)
  ) {
    return indeterminate(
      request,
      'KNOWN_INVALID_OR_CONFLICT',
      'The coherent Pricing attempt contains a known invalid or conflicting material state',
      cause,
    );
  }
  return indeterminate(
    request,
    'OWNER_FINAL_FENCE_UNAVAILABLE',
    'Required Pricing owner evidence could not be verified immediately before publication',
    cause,
  );
};

/**
 * Canonical ordinary-Current publication seam. External owner proofs are validated first, then the
 * owner-backed final fence is the final mutable-state operation. No old/new proof merge is allowed.
 */
export const authorizeOrdinaryCurrentPricingPublication = Effect.fn('OrdinaryCurrentPricingPublication.authorize')(
  function* authorizeOrdinaryCurrentPricingPublicationProgram(
    request: PricingOrdinaryCurrentPublicationRequest,
  ): Effect.fn.Return<
    PricingOrdinaryCurrentAuthorizedPublication,
    PricingOrdinaryCurrentPublicationIndeterminate,
    PricingExternalOwnerEvidenceValidation | PricingMaterialEvidenceOwnerFinalFence
  > {
    if (!evidenceInputBindsCommercialResult(request)) {
      return yield* indeterminate(
        request,
        'EXTERNAL_OWNER_EVIDENCE_CHANGED',
        'External owner evidence does not bind the exact ordinary Current Pricing candidate',
      );
    }

    const validation = yield* PricingExternalOwnerEvidenceValidation;
    const catalog = yield* Effect.forEach(
      request.externalOwnerEvidence.catalog,
      (input) => validation.validateCatalogSelection(input),
      { concurrency: 16 },
    ).pipe(
      Effect.mapError((cause) =>
        indeterminate(
          request,
          'EXTERNAL_OWNER_EVIDENCE_CHANGED',
          'Catalog evidence changed or could not be verified before publication',
          cause,
        ),
      ),
    );
    const market = yield* validation
      .validateMarket(request.externalOwnerEvidence.market)
      .pipe(
        Effect.mapError((cause) =>
          indeterminate(
            request,
            'EXTERNAL_OWNER_EVIDENCE_CHANGED',
            'Commerce Market evidence changed or could not be verified before publication',
            cause,
          ),
        ),
      );
    const priceGroupInput = request.externalOwnerEvidence.priceGroup;
    const priceGroup =
      priceGroupInput === undefined
        ? undefined
        : yield* validation
            .validatePriceGroupAssignment(priceGroupInput)
            .pipe(
              Effect.mapError((cause) =>
                indeterminate(
                  request,
                  'EXTERNAL_OWNER_EVIDENCE_CHANGED',
                  'Price Group evidence changed or could not be verified before publication',
                  cause,
                ),
              ),
            );
    const promotion =
      request.externalOwnerEvidence.promotion.kind === 'PROMOTION_NOT_SELECTED'
        ? ({ kind: 'PROMOTION_NOT_SELECTED' } as const)
        : ({
            evidence: yield* validation
              .validatePromotion(request.externalOwnerEvidence.promotion.validation)
              .pipe(
                Effect.mapError((cause) =>
                  indeterminate(
                    request,
                    'EXTERNAL_OWNER_EVIDENCE_CHANGED',
                    'Promotion evidence changed or could not be verified before publication',
                    cause,
                  ),
                ),
              ),
            kind: 'PROMOTION_SELECTED' as const,
          } as const);

    const authorization: PricingMaterialEvidencePublicationAuthorization =
      yield* finalizePricingMaterialEvidenceForPublication({ request: request.materialEvidence }).pipe(
        Effect.mapError((cause) => finalizationIndeterminate(request, cause)),
      );
    const internalEvidence = yield* handoffPricingSourceEvidenceToAuthorizedInternalConsumer(
      authorization.materialEvidence,
    ).pipe(
      Effect.mapError((cause) =>
        indeterminate(
          request,
          'MATERIAL_EVIDENCE_UNVERIFIABLE',
          'Validated Pricing evidence could not be retained for the authorized internal handoff',
          cause,
        ),
      ),
    );

    const externalOwnerEvidence: PricingOrdinaryCurrentExternalOwnerEvidenceHandoff =
      priceGroup === undefined
        ? { catalog, market, promotion, subject: request.externalOwnerEvidence.subject }
        : { catalog, market, priceGroup, promotion, subject: request.externalOwnerEvidence.subject };
    return {
      externalOwnerEvidence,
      finalFenceEvidence: authorization.finalFenceEvidence,
      internalEvidence,
      outcome: 'ORDINARY_CURRENT_PRICING_PUBLICATION_AUTHORIZED',
    };
  },
);

/** Customer publication exposes only the established #780 allowlist projection. */
export const publishOrdinaryCurrentPricingForCustomer = Effect.fn('OrdinaryCurrentPricingPublication.publishCustomer')(
  function* publishOrdinaryCurrentPricingForCustomerProgram(
    request: PricingOrdinaryCurrentPublicationRequest,
  ): Effect.fn.Return<
    PricingCommercialTotalSafeProjection,
    PricingOrdinaryCurrentPublicationIndeterminate,
    PricingExternalOwnerEvidenceValidation | PricingMaterialEvidenceOwnerFinalFence
  > {
    const authorization = yield* authorizeOrdinaryCurrentPricingPublication(request);
    return yield* projectPricingMaterialEvidenceForCustomer(authorization.internalEvidence.materialEvidence).pipe(
      Effect.mapError((cause) =>
        indeterminate(
          request,
          'PUBLICATION_PROJECTION_UNVERIFIABLE',
          'The ordinary Current Pricing result could not be projected through the customer allowlist',
          cause,
        ),
      ),
    );
  },
);
