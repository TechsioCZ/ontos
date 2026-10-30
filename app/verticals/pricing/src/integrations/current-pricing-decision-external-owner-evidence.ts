import {
  CatalogQuantityBasisSchema,
  CatalogQuantityHandoffReadySchema,
} from '@app/catalog/domain/catalog-quantity-handoff';
import { CatalogResourceRefSchema } from '@app/catalog/domain/catalog-revision-reference';
import { CatalogSelectionBasisListSchema } from '@app/catalog/domain/catalog-selection-evidence';
import type { PricingPurchaseContextVerificationEvidence } from '@app/commerce-customer-context/api/pricing-purchase-context-verification';
import { PricingPurchaseContextVerificationEvidenceSchema } from '@app/commerce-customer-context/api/pricing-purchase-context-verification';
import type { CurrentPricingDecisionRequest } from '@app/pricing-contracts/current-pricing-decision';
import { PricingSetBackedMaterialEvidenceFenceSourceSchema } from '@app/pricing-contracts/domain/material-evidence';
import type { PricingEvaluationAttempt } from '@app/pricing-contracts/domain/material-change';
import { PricingPromotionApplicationSchema } from '@app/pricing-contracts/domain/promotion-composition';
import {
  PricingDecisionSchema,
  PricingLineSchema,
  PricingCatalogSelectionSchema,
} from '@app/pricing-contracts/pricing-decision';
import { PricingSourceEvidenceResultSchema } from '@app/pricing-contracts/domain/source-revision-evidence';
import { DateTime, Effect, Option, Schema } from 'effect';

import type {
  PricingCatalogSelectionEvidenceValidationInput,
  PricingMarketEvidenceValidationInput,
  PricingPriceGroupEvidenceValidationInput,
  PricingPromotionEvidenceValidationInput,
  PricingRetainedCatalogOwnerEvidenceInput,
  PricingRetainedExternalOwnerEvidenceInput,
  PricingExternalOwnerEvidenceValidationService,
} from '../services/external-owner-evidence-validation.service.ts';
import type { PricingOrdinaryCurrentExternalOwnerEvidenceInput } from '../services/ordinary-current-pricing-publication.service.ts';
import type {
  CurrentPricingDecisionExternalOwnerEvidencePort,
  CurrentPricingDecisionExternalOwnerEvidenceSnapshot,
} from '../services/current-pricing-decision-whole-evaluation.service.ts';
import { CurrentPricingDecisionOwnerReadFailure } from '../services/current-pricing-decision-whole-evaluation.service.ts';

export type CurrentPricingDecisionExternalOwnerEvidenceLoadInput = Parameters<
  CurrentPricingDecisionExternalOwnerEvidencePort['loadFresh']
>[0];
type PricingMaterialEvidenceFenceSource = CurrentPricingDecisionExternalOwnerEvidenceSnapshot['fenceSources'][number];
type PricingSetBackedMaterialEvidenceFenceSource = typeof PricingSetBackedMaterialEvidenceFenceSourceSchema.Type;

export interface CurrentPricingDecisionExternalOwnerEvidenceReadContext extends CurrentPricingDecisionExternalOwnerEvidenceLoadInput {
  /** The exact purchase instant at which every owner must evaluate its facts. */
  readonly effectiveAt: CurrentPricingDecisionRequest['decision']['operationTime'];
  /** The start of the one coherent owner-read snapshot. */
  readonly requestedAt: PricingEvaluationAttempt['snapshot']['requestedAt'];
}

export interface CurrentPricingDecisionCatalogEvidenceMember {
  readonly fenceSource: PricingSetBackedMaterialEvidenceFenceSource;
  readonly occurrenceId: CurrentPricingDecisionRequest['decision']['lines'][number]['occurrenceId'];
  readonly publication: PricingCatalogSelectionEvidenceValidationInput;
}

export interface CurrentPricingDecisionCatalogEvidenceRead {
  readonly equivalenceFenceSources: readonly PricingSetBackedMaterialEvidenceFenceSource[];
  readonly members: readonly CurrentPricingDecisionCatalogEvidenceMember[];
}

export interface CurrentPricingDecisionMarketEvidenceRead {
  readonly fenceSource: PricingSetBackedMaterialEvidenceFenceSource;
  readonly publication: PricingMarketEvidenceValidationInput;
}

export interface CurrentPricingDecisionCustomerContextEvidenceRead {
  readonly fenceSources: readonly PricingMaterialEvidenceFenceSource[];
  readonly priceGroupPublication?: PricingPriceGroupEvidenceValidationInput;
  readonly subjectEvidence: PricingPurchaseContextVerificationEvidence;
}

export type CurrentPricingDecisionPromotionEvidenceRead =
  | { readonly kind: 'PROMOTION_NOT_SELECTED' }
  | {
      readonly fenceSource: PricingSetBackedMaterialEvidenceFenceSource;
      readonly kind: 'PROMOTION_SELECTED';
      readonly publication: PricingPromotionEvidenceValidationInput;
    };

export interface CurrentPricingDecisionExternalOwnerEvidenceDependencies {
  readonly catalog: {
    readonly loadFresh: (
      context: CurrentPricingDecisionExternalOwnerEvidenceReadContext,
    ) => Effect.Effect<CurrentPricingDecisionCatalogEvidenceRead, CurrentPricingDecisionOwnerReadFailure>;
  };
  readonly customerContext: {
    readonly loadFresh: (
      context: CurrentPricingDecisionExternalOwnerEvidenceReadContext,
    ) => Effect.Effect<CurrentPricingDecisionCustomerContextEvidenceRead, CurrentPricingDecisionOwnerReadFailure>;
  };
  readonly market: {
    readonly loadFresh: (
      context: CurrentPricingDecisionExternalOwnerEvidenceReadContext,
    ) => Effect.Effect<CurrentPricingDecisionMarketEvidenceRead, CurrentPricingDecisionOwnerReadFailure>;
  };
  readonly promotion: {
    readonly loadFresh: (
      context: CurrentPricingDecisionExternalOwnerEvidenceReadContext,
    ) => Effect.Effect<CurrentPricingDecisionPromotionEvidenceRead, CurrentPricingDecisionOwnerReadFailure>;
  };
  readonly validation: PricingExternalOwnerEvidenceValidationService;
}

const sameCatalogHandoff = Schema.toEquivalence(CatalogQuantityHandoffReadySchema);
const sameCatalogSelection = Schema.toEquivalence(PricingCatalogSelectionSchema);
type CatalogMaterialHandoff = typeof CatalogQuantityHandoffReadySchema.Type;
const sameCatalogMaterialQuantityBasis = Schema.toEquivalence(CatalogQuantityBasisSchema);
const sameCatalogMaterialSelectionBasis = Schema.toEquivalence(CatalogSelectionBasisListSchema);
const sameCatalogMaterialResourceRef = Schema.toEquivalence(CatalogResourceRefSchema);
const catalogMaterialResourceRefKey = (resourceRef: {
  readonly moduleId: string;
  readonly resourceId: string;
  readonly resourceType: string;
  readonly tenantId: string;
}): string => [resourceRef.moduleId, resourceRef.resourceType, resourceRef.resourceId, resourceRef.tenantId].join('|');
const catalogMaterialRevisionKey = (revision: {
  readonly resourceRef: Parameters<typeof catalogMaterialResourceRefKey>[0];
  readonly revision: number;
  readonly revisionId?: string;
}): string =>
  `${catalogMaterialResourceRefKey(revision.resourceRef)}|${revision.revision}|${revision.revisionId ?? ''}`;
const catalogMaterialPackageContentKey = (handoff: CatalogMaterialHandoff): string => {
  const content = handoff.packageContent;
  return content === undefined
    ? 'none'
    : `${content.amount}|${catalogMaterialResourceRefKey(content.unitRef)}|${content.path.map(catalogMaterialRevisionKey).join('/')}`;
};
const catalogMaterialPackageRevisionKey = (handoff: CatalogMaterialHandoff): string => {
  const revision = handoff.packageRevision;
  if (revision === undefined) {
    return 'none';
  }
  return [
    catalogMaterialRevisionKey(revision.reference),
    revision.amount,
    catalogMaterialResourceRefKey(revision.unitRef),
    catalogMaterialResourceRefKey(revision.form.productRef),
    catalogMaterialResourceRefKey(revision.form.variantRef),
    revision.configurationKey ?? '',
    revision.setComposition === undefined ? '' : catalogMaterialRevisionKey(revision.setComposition),
    revision.lower === undefined
      ? ''
      : `${revision.lower.count}:${catalogMaterialRevisionKey(revision.lower.revision)}`,
  ].join('|');
};
const catalogMaterialSameOwnerMetadata = (supplied: CatalogMaterialHandoff, current: CatalogMaterialHandoff): boolean =>
  supplied.completeness.ownerRevision === supplied.ownerRevision &&
  current.completeness.ownerRevision === current.ownerRevision &&
  supplied.completeness.scope.kind === current.completeness.scope.kind &&
  supplied.completeness.scope.predicateRef === current.completeness.scope.predicateRef;

const sameCatalogMaterialQuantity = (supplied: CatalogMaterialHandoff, current: CatalogMaterialHandoff): boolean =>
  supplied.quantity.requested === current.quantity.requested &&
  supplied.quantity.resulting === current.quantity.resulting &&
  supplied.quantity.changed === current.quantity.changed &&
  supplied.quantity.notice === current.quantity.notice &&
  supplied.quantity.rounding === current.quantity.rounding &&
  supplied.quantity.step === current.quantity.step &&
  supplied.quantity.targetId === current.quantity.targetId &&
  supplied.quantity.unitId === current.quantity.unitId &&
  supplied.quantity.unitRuleRevision === current.quantity.unitRuleRevision;

const sameCatalogHandoffMeaning = (supplied: CatalogMaterialHandoff, current: CatalogMaterialHandoff): boolean =>
  sameCatalogHandoff(supplied, current) ||
  (supplied.evidence.assessedAt <= current.evidence.assessedAt &&
    current.evidence.assessedAt === current.completeness.observedAt &&
    current.completeness.scope.kind === 'EXACT_PREDICATE' &&
    current.completeness.nextApplicabilityBoundary === current.evidence.validUntil &&
    (current.evidence.validUntil === undefined || current.evidence.assessedAt < current.evidence.validUntil) &&
    sameCatalogSelection(supplied.selection, current.selection) &&
    sameCatalogSelection(supplied.evidence.selection, current.evidence.selection) &&
    catalogMaterialSameOwnerMetadata(supplied, current) &&
    supplied.equivalentSelectionKey === current.equivalentSelectionKey &&
    supplied.hierarchyRevision === current.hierarchyRevision &&
    supplied.divisible === current.divisible &&
    sameCatalogMaterialQuantity(supplied, current) &&
    sameCatalogMaterialResourceRef(supplied.unitRef, current.unitRef) &&
    sameCatalogMaterialQuantityBasis(supplied.quantityBasis, current.quantityBasis) &&
    sameCatalogMaterialSelectionBasis(supplied.evidence.basis, current.evidence.basis) &&
    catalogMaterialPackageContentKey(supplied) === catalogMaterialPackageContentKey(current) &&
    catalogMaterialPackageRevisionKey(supplied) === catalogMaterialPackageRevisionKey(current));

const sameDecision = Schema.toEquivalence(PricingDecisionSchema);
const sameLine = Schema.toEquivalence(PricingLineSchema);
const samePurchaseContextEvidence = Schema.toEquivalence(PricingPurchaseContextVerificationEvidenceSchema);
const samePromotionApplication = Schema.toEquivalence(PricingPromotionApplicationSchema);
const sameSourceEvidence = Schema.toEquivalence(PricingSourceEvidenceResultSchema);
const CATALOG_OWNER = 'commerce.catalog';
const CUSTOMER_CONTEXT_OWNER = 'commerce.customer-context';
const MARKET_OWNER = 'commerce.market-catalog';
const PROMOTION_OWNER = 'commerce.promotion';
const EXTERNAL_OWNERS = [CATALOG_OWNER, MARKET_OWNER, CUSTOMER_CONTEXT_OWNER, PROMOTION_OWNER] as const;

const failed = (ownerRefs: readonly string[], reason: string, cause?: unknown) => {
  const failure = new CurrentPricingDecisionOwnerReadFailure({ kind: 'UNVERIFIABLE', ownerRefs, reason });
  return cause === undefined ? failure : Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
};

const sourceBindsAttempt = (
  source: PricingSetBackedMaterialEvidenceFenceSource,
  context: CurrentPricingDecisionExternalOwnerEvidenceReadContext,
  validatedAt: string,
): boolean => {
  const { sourceEvidence } = source;
  const { temporal } = sourceEvidence.completeness;
  return (
    sourceEvidence.request.effectiveAt === context.effectiveAt &&
    sourceEvidence.request.requestedAt === context.requestedAt &&
    sourceEvidence.request.ownerScope.tenantId === context.request.decision.tenantId &&
    temporal.observedAt <= validatedAt &&
    (temporal.nextMaterialBoundary === undefined || validatedAt < temporal.nextMaterialBoundary)
  );
};

const sourceIs = (
  source: PricingMaterialEvidenceFenceSource,
  context: CurrentPricingDecisionExternalOwnerEvidenceReadContext,
  validatedAt: string,
  ownerModuleId: string,
  materialKind: PricingMaterialEvidenceFenceSource['verificationMaterial']['kind'],
): boolean => {
  if (!Schema.is(PricingSetBackedMaterialEvidenceFenceSourceSchema)(source)) {
    return false;
  }
  return (
    source.sourceEvidence.request.ownerScope.ownerModuleId === ownerModuleId &&
    source.verificationMaterial.kind === materialKind &&
    sourceBindsAttempt(source, context, validatedAt)
  );
};

const validateAttempt = (
  context: CurrentPricingDecisionExternalOwnerEvidenceReadContext,
): CurrentPricingDecisionOwnerReadFailure | undefined => {
  const { attempt, commercialTotal, request } = context;
  if (
    attempt.candidateRef !== commercialTotal.candidateRef ||
    attempt.snapshot.candidateRef !== commercialTotal.candidateRef ||
    !sameDecision(attempt.snapshot.decision, request.decision) ||
    !sameDecision(commercialTotal.decision, request.decision) ||
    context.effectiveAt !== request.decision.operationTime ||
    context.requestedAt !== attempt.snapshot.requestedAt
  ) {
    return failed(EXTERNAL_OWNERS, 'External owner evidence request does not bind the exact coherent Pricing attempt');
  }
  return undefined;
};

const validateCatalog = (
  read: CurrentPricingDecisionCatalogEvidenceRead,
  context: CurrentPricingDecisionExternalOwnerEvidenceReadContext,
  validatedAt: string,
): CurrentPricingDecisionOwnerReadFailure | undefined => {
  const expectedLines = context.request.decision.lines;
  if (read.members.length !== expectedLines.length) {
    return failed([CATALOG_OWNER], 'Catalog owner read did not return exactly one ordered member per Pricing line');
  }
  for (const [index, member] of read.members.entries()) {
    const line = expectedLines[index];
    if (
      line === undefined ||
      member.occurrenceId !== line.occurrenceId ||
      member.publication.expectedEffectiveAt !== context.effectiveAt ||
      member.publication.requestedAt !== context.requestedAt ||
      !sameSourceEvidence(member.publication.sourceEvidence, member.fenceSource.sourceEvidence) ||
      !sourceIs(member.fenceSource, context, validatedAt, CATALOG_OWNER, 'CATALOG_LINE_AUTHORITY') ||
      member.fenceSource.verificationMaterial.kind !== 'CATALOG_LINE_AUTHORITY' ||
      !sameLine(member.fenceSource.verificationMaterial.line, line)
    ) {
      return failed(
        [CATALOG_OWNER],
        `Catalog owner evidence does not bind ordered Pricing line ${line?.occurrenceId ?? String(index)}`,
      );
    }
  }
  if (read.equivalenceFenceSources.length !== expectedLines.length) {
    return failed([CATALOG_OWNER], 'Catalog requires one ordered singleton equivalence proof per original occurrence');
  }
  for (const [index, source] of read.equivalenceFenceSources.entries()) {
    const line = expectedLines[index];
    if (
      line === undefined ||
      !sourceIs(source, context, validatedAt, CATALOG_OWNER, 'CATALOG_EQUIVALENCE_AUTHORITY') ||
      source.verificationMaterial.kind !== 'CATALOG_EQUIVALENCE_AUTHORITY'
    ) {
      return failed([CATALOG_OWNER], 'Catalog equivalence proof is unavailable or does not bind this attempt');
    }
    const { request, response } = source.verificationMaterial;
    const [member] = request.members;
    const { selection } = line.catalog;
    const lineAuthority = read.members[index]?.fenceSource.verificationMaterial;
    if (lineAuthority?.kind !== 'CATALOG_LINE_AUTHORITY') {
      return failed([CATALOG_OWNER], 'Catalog singleton lacks its exact retained line authority');
    }
    const freshHandoff = lineAuthority.handoff;
    const freshAt = freshHandoff.evidence.assessedAt;
    if (
      request.effectiveAt !== context.effectiveAt ||
      request.members.length !== 1 ||
      member?.occurrenceId !== line.occurrenceId ||
      !sameCatalogHandoff(member.handoff, line.catalog) ||
      !sameCatalogSelection(request.anchorSelection, selection) ||
      response.outcome !== 'CATALOG_EQUIVALENCE_CONFIRMED' ||
      response.evidence.members.length !== 1 ||
      response.evidence.members[0]?.occurrenceId !== line.occurrenceId ||
      !sameCatalogSelection(response.evidence.anchorSelection, selection) ||
      response.evidence.members.some((responseMember) => !sameCatalogSelection(responseMember.selection, selection)) ||
      response.assessments.length !== 2 ||
      response.assessments[0]?.role !== 'ANCHOR' ||
      !sameCatalogSelection(response.assessments[0].handoff.selection, selection) ||
      response.assessments[1]?.role !== 'MEMBER' ||
      response.assessments[1].occurrenceId !== line.occurrenceId ||
      !sameCatalogHandoffMeaning(line.catalog, freshHandoff) ||
      context.requestedAt > freshAt ||
      freshAt > validatedAt ||
      !sameCatalogHandoff(response.assessments[1].handoff, freshHandoff) ||
      !sameCatalogHandoff(lineAuthority.compatibilityRequest.handoff, freshHandoff) ||
      lineAuthority.compatibilityRequest.effectiveAt !== freshAt
    ) {
      return failed([CATALOG_OWNER], 'Catalog equivalence proof did not preserve its exact ordered Pricing occurrence');
    }
  }
  return undefined;
};

const validateMarket = (
  read: CurrentPricingDecisionMarketEvidenceRead,
  context: CurrentPricingDecisionExternalOwnerEvidenceReadContext,
  validatedAt: string,
): CurrentPricingDecisionOwnerReadFailure | undefined => {
  if (
    read.publication.expectedEffectiveAt !== context.effectiveAt ||
    read.publication.requestedAt !== context.requestedAt ||
    !sameSourceEvidence(read.publication.sourceEvidence, read.fenceSource.sourceEvidence) ||
    !sourceIs(read.fenceSource, context, validatedAt, MARKET_OWNER, 'MARKET_CONTEXT_AUTHORITY')
  ) {
    return failed([MARKET_OWNER], 'Market owner proof does not bind the exact Pricing attempt');
  }
  return undefined;
};

const validateCustomerContext = (
  read: CurrentPricingDecisionCustomerContextEvidenceRead,
  context: CurrentPricingDecisionExternalOwnerEvidenceReadContext,
  validatedAt: string,
): CurrentPricingDecisionOwnerReadFailure | undefined => {
  const { currentness } = read.subjectEvidence;
  const purchaseSources = read.fenceSources.filter(
    ({ verificationMaterial }) => verificationMaterial.kind === 'CUSTOMER_CONTEXT_PURCHASE_AUTHORITY',
  );
  const groupSources = read.fenceSources.filter(
    (source): source is PricingSetBackedMaterialEvidenceFenceSource =>
      'sourceEvidence' in source && source.verificationMaterial.kind === 'CUSTOMER_CONTEXT_GROUP_AUTHORITY',
  );
  const [purchaseSource] = purchaseSources;
  const purchaseEvidence =
    purchaseSource?.verificationMaterial.kind === 'CUSTOMER_CONTEXT_PURCHASE_AUTHORITY'
      ? Schema.decodeUnknownOption(PricingPurchaseContextVerificationEvidenceSchema)(
          purchaseSource.verificationMaterial.evidence,
        )
      : Option.none();
  const subjectIsProfile = context.request.subject.kind === 'PROFILE';
  if (
    !samePurchaseContextEvidence(read.subjectEvidence, context.purchaseContextEvidence) ||
    currentness.evaluatedAt !== context.effectiveAt ||
    currentness.observedAt > validatedAt ||
    (currentness.validTo !== null && validatedAt >= currentness.validTo) ||
    purchaseSources.length !== 1 ||
    Option.isNone(purchaseEvidence) ||
    !samePurchaseContextEvidence(purchaseEvidence.value, read.subjectEvidence) ||
    groupSources.length !== (subjectIsProfile ? 1 : 0) ||
    read.fenceSources.length !== purchaseSources.length + groupSources.length ||
    (subjectIsProfile && read.priceGroupPublication === undefined) ||
    (!subjectIsProfile && read.priceGroupPublication !== undefined) ||
    (read.priceGroupPublication !== undefined &&
      (read.priceGroupPublication.expectedEffectiveAt !== context.effectiveAt ||
        read.priceGroupPublication.requestedAt !== context.requestedAt)) ||
    groupSources.some(
      (source) =>
        !sourceIs(source, context, validatedAt, CUSTOMER_CONTEXT_OWNER, 'CUSTOMER_CONTEXT_GROUP_AUTHORITY') ||
        read.priceGroupPublication === undefined ||
        !('sourceEvidence' in source) ||
        !sameSourceEvidence(read.priceGroupPublication.sourceEvidence, source.sourceEvidence),
    )
  ) {
    return failed(
      [CUSTOMER_CONTEXT_OWNER],
      'Customer Context subject or Price Group proof does not bind the exact Pricing attempt',
    );
  }
  return undefined;
};

const validatePromotion = (
  read: CurrentPricingDecisionPromotionEvidenceRead,
  context: CurrentPricingDecisionExternalOwnerEvidenceReadContext,
  validatedAt: string,
): CurrentPricingDecisionOwnerReadFailure | undefined => {
  const selected = context.commercialTotal.sourceEvidence.preRound.rawComposition.promotionComposition;
  if (selected.kind !== read.kind) {
    return failed(
      [PROMOTION_OWNER],
      'Promotion owner proof class differs from the Promotion contribution used by Pricing',
    );
  }
  if (read.kind === 'PROMOTION_NOT_SELECTED') {
    return undefined;
  }
  if (
    read.publication.requestedAt !== context.requestedAt ||
    !sameSourceEvidence(read.publication.sourceEvidence, read.fenceSource.sourceEvidence) ||
    !sourceIs(read.fenceSource, context, validatedAt, PROMOTION_OWNER, 'PROMOTION_APPLICABILITY_AUTHORITY') ||
    read.fenceSource.verificationMaterial.kind !== 'PROMOTION_APPLICABILITY_AUTHORITY' ||
    selected.kind !== 'PROMOTION_SELECTED' ||
    !samePromotionApplication(read.fenceSource.verificationMaterial.application, selected.composition.promotion)
  ) {
    return failed([PROMOTION_OWNER], 'Promotion owner proof does not bind the exact selected contribution');
  }
  return undefined;
};

/**
 * Aggregates one fresh cross-owner snapshot. Each owner read remains injectable so production
 * composition can install only published generated clients; the aggregate never fabricates an
 * absence or a not-selected Promotion result when an owner read fails.
 */
export const makeCurrentPricingDecisionExternalOwnerEvidencePort = (
  dependencies: CurrentPricingDecisionExternalOwnerEvidenceDependencies,
): CurrentPricingDecisionExternalOwnerEvidencePort => ({
  loadFresh: Effect.fn('CurrentPricingDecisionExternalOwnerEvidencePort.loadFresh')(function* loadFresh(input) {
    const context: CurrentPricingDecisionExternalOwnerEvidenceReadContext = {
      ...input,
      effectiveAt: input.request.decision.operationTime,
      requestedAt: input.attempt.snapshot.requestedAt,
    };
    const attemptFailure = validateAttempt(context);
    if (attemptFailure !== undefined) {
      return yield* attemptFailure;
    }

    const reads = yield* Effect.all(
      {
        catalog: dependencies.catalog.loadFresh(context),
        customerContext: dependencies.customerContext.loadFresh(context),
        market: dependencies.market.loadFresh(context),
        promotion: dependencies.promotion.loadFresh(context),
      },
      { concurrency: 4 },
    );

    // The input attempt is still a draft. Finalize its completion boundary only after every
    // owner read has returned, at one real clock instant retained for all downstream consumers.
    const validatedAt = DateTime.formatIso(yield* DateTime.now);

    const readFailure =
      validateCatalog(reads.catalog, context, validatedAt) ??
      validateMarket(reads.market, context, validatedAt) ??
      validateCustomerContext(reads.customerContext, context, validatedAt) ??
      validatePromotion(reads.promotion, context, validatedAt);
    if (readFailure !== undefined) {
      return yield* readFailure;
    }

    const { validation } = dependencies;
    const accepted = yield* Effect.all(
      {
        catalog: Effect.forEach(
          reads.catalog.members,
          ({ publication }) => validation.validateCatalogSelection(publication),
          { concurrency: 8 },
        ),
        market: validation.validateMarket(reads.market.publication),
        priceGroup:
          reads.customerContext.priceGroupPublication === undefined
            ? Effect.void
            : validation.validatePriceGroupAssignment(reads.customerContext.priceGroupPublication),
        promotion:
          reads.promotion.kind === 'PROMOTION_SELECTED'
            ? validation
                .validatePromotion(reads.promotion.publication)
                .pipe(Effect.map((evidence) => ({ evidence, kind: 'PROMOTION_SELECTED' as const })))
            : Effect.succeed({ kind: 'PROMOTION_NOT_SELECTED' as const }),
      },
      { concurrency: 4 },
    ).pipe(
      Effect.mapError((cause) =>
        failed(EXTERNAL_OWNERS, 'External owner evidence did not pass lossless Pricing validation', cause),
      ),
    );

    const firstCatalogPublication = reads.catalog.members[0]?.publication;
    if (firstCatalogPublication === undefined) {
      return yield* failed([CATALOG_OWNER], 'Catalog owner evidence cannot be empty');
    }
    const catalogPublication: readonly [
      PricingCatalogSelectionEvidenceValidationInput,
      ...PricingCatalogSelectionEvidenceValidationInput[],
    ] = [firstCatalogPublication, ...reads.catalog.members.slice(1).map(({ publication }) => publication)];
    const publicationBase: Omit<PricingOrdinaryCurrentExternalOwnerEvidenceInput, 'priceGroup'> = {
      catalog: catalogPublication,
      market: reads.market.publication,
      promotion:
        reads.promotion.kind === 'PROMOTION_SELECTED'
          ? { kind: 'PROMOTION_SELECTED', validation: reads.promotion.publication }
          : { kind: 'PROMOTION_NOT_SELECTED' },
      subject: input.request.subject,
    };
    const publication: PricingOrdinaryCurrentExternalOwnerEvidenceInput =
      reads.customerContext.priceGroupPublication === undefined
        ? publicationBase
        : { ...publicationBase, priceGroup: reads.customerContext.priceGroupPublication };
    const retainedCatalog: PricingRetainedCatalogOwnerEvidenceInput[] = [];
    for (const [index, member] of reads.catalog.members.entries()) {
      const acceptedMember = accepted.catalog[index];
      if (acceptedMember === undefined) {
        return yield* failed(
          [CATALOG_OWNER],
          `Validated Catalog evidence is missing ordered member ${member.occurrenceId}`,
        );
      }
      retainedCatalog.push({ occurrenceId: member.occurrenceId, validation: acceptedMember });
    }
    const retainedBase: Omit<PricingRetainedExternalOwnerEvidenceInput, 'priceGroupAssignment'> = {
      candidateRef: input.commercialTotal.candidateRef,
      catalogSelections: retainedCatalog,
      decision: input.request.decision,
      market: accepted.market,
      promotion:
        accepted.promotion.kind === 'PROMOTION_SELECTED'
          ? { kind: 'PROMOTION_SELECTED', validation: accepted.promotion.evidence }
          : { kind: 'PROMOTION_NOT_SELECTED' },
      requestedAt: context.requestedAt,
      subject: input.request.subject,
      validatedAt,
    };
    const retainedInput =
      accepted.priceGroup === undefined ? retainedBase : { ...retainedBase, priceGroupAssignment: accepted.priceGroup };
    const retained = yield* validation
      .retainValidatedOwnerEvidence(retainedInput)
      .pipe(
        Effect.mapError((cause) =>
          failed(
            EXTERNAL_OWNERS,
            'External owner evidence was not Current through the completed Pricing attempt',
            cause,
          ),
        ),
      );

    const fenceSources = [
      ...reads.catalog.members.map(({ fenceSource }) => fenceSource),
      ...reads.catalog.equivalenceFenceSources,
      reads.market.fenceSource,
      ...reads.customerContext.fenceSources,
      ...(reads.promotion.kind === 'PROMOTION_SELECTED' ? [reads.promotion.fenceSource] : []),
    ];
    return {
      fenceSources,
      publication,
      retained,
    } satisfies CurrentPricingDecisionExternalOwnerEvidenceSnapshot;
  }),
});
