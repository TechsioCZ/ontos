import type {
  PricingLineComposedLine,
  PricingZeroFloorAuthorization,
  PricingZeroFloorCurrentAuthorizationSet,
  PricingZeroFloorEvaluationRequest,
  PricingZeroFloorEvaluationResult,
  PricingZeroFloorFailed,
} from '@app/pricing-contracts/domain/line-composition';
import {
  PricingLineComposedLineSchema,
  PricingZeroFloorAuthorizationSchema,
} from '@app/pricing-contracts/domain/line-composition';
import { PricingCommercialScopeSchema } from '@app/pricing-contracts/domain/pricing-commercial-scope';
import { PricingCatalogSelectionSchema, PricingUnitBasisSchema } from '@app/pricing-contracts/pricing-decision';
import { Effect, Schema } from 'effect';

const sameCatalogSelection = Schema.toEquivalence(PricingCatalogSelectionSchema);
const sameCommercialScope = Schema.toEquivalence(PricingCommercialScopeSchema);
const sameComposedLine = Schema.toEquivalence(PricingLineComposedLineSchema);
const samePricingBasis = Schema.toEquivalence(PricingUnitBasisSchema);
const sameZeroFloorAuthorization = Schema.toEquivalence(PricingZeroFloorAuthorizationSchema);

interface DecimalParts {
  readonly coefficient: bigint;
  readonly scale: number;
}

const decimalParts = (value: string): DecimalParts => {
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [integer = '0', fraction = ''] = unsigned.split('.');
  const coefficient = BigInt(`${integer}${fraction}`);
  return { coefficient: negative ? -coefficient : coefficient, scale: fraction.length };
};

const compareDecimals = (left: string, right: string): -1 | 0 | 1 => {
  const leftParts = decimalParts(left);
  const rightParts = decimalParts(right);
  const scale = Math.max(leftParts.scale, rightParts.scale);
  const alignedLeft = leftParts.coefficient * 10n ** BigInt(scale - leftParts.scale);
  const alignedRight = rightParts.coefficient * 10n ** BigInt(scale - rightParts.scale);
  if (alignedLeft < alignedRight) {
    return -1;
  }
  return alignedLeft > alignedRight ? 1 : 0;
};

const stableSortedSet = (values: readonly string[]): readonly string[] => [...new Set(values)].toSorted();

const sameStringSet = (left: readonly string[], right: readonly string[]): boolean => {
  const normalizedLeft = stableSortedSet(left);
  const normalizedRight = stableSortedSet(right);
  return (
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((value, index) => value === normalizedRight[index])
  );
};

const failed = (
  composedLine: PricingLineComposedLine,
  reasonCode: PricingZeroFloorFailed['reasonCode'],
  reason: string,
  retryable = false,
): PricingZeroFloorFailed => ({
  kind: 'ZERO_FLOOR_FAILED',
  occurrenceId: composedLine.occurrenceId,
  reason,
  reasonCode,
  retryable,
});

const authorizationSetIsFreshAndComplete = (
  authorizationSet: PricingZeroFloorCurrentAuthorizationSet,
  evaluatedAt: string,
): boolean => {
  const { completenessEvidence, currentness } = authorizationSet;
  return (
    currentness.status === 'CURRENT' &&
    currentness.evaluatedAt === evaluatedAt &&
    currentness.observedAt <= currentness.revalidatedAt &&
    completenessEvidence.ownerRevision === authorizationSet.ownerRevision &&
    completenessEvidence.observedAt === currentness.observedAt &&
    completenessEvidence.scope.kind === 'EXACT_PREDICATE' &&
    completenessEvidence.scope.predicateRef === authorizationSet.exactPredicateRef &&
    (completenessEvidence.nextApplicabilityBoundary === undefined ||
      evaluatedAt < completenessEvidence.nextApplicabilityBoundary)
  );
};

const exactDecisionLine = (request: PricingZeroFloorEvaluationRequest) =>
  request.composition.decision.lines.find(({ occurrenceId }) => occurrenceId === request.composedLine.occurrenceId);

const composedLineBelongsToComposition = (request: PricingZeroFloorEvaluationRequest): boolean => {
  const matchingLines = request.composition.lines.filter(
    ({ occurrenceId }) => occurrenceId === request.composedLine.occurrenceId,
  );
  const [matchingLine] = matchingLines;
  return (
    matchingLines.length === 1 && matchingLine !== undefined && sameComposedLine(matchingLine, request.composedLine)
  );
};

const authorizationMatchesBusinessScope = (
  authorization: PricingZeroFloorAuthorization,
  request: PricingZeroFloorEvaluationRequest,
): boolean => {
  const line = exactDecisionLine(request);
  const { decision } = request.composition;
  return (
    line !== undefined &&
    authorization.businessScope.tenantId === decision.tenantId &&
    sameCatalogSelection(authorization.businessScope.catalogSelection, request.composedLine.line.catalog.selection) &&
    sameCommercialScope(authorization.businessScope.commercialScope, decision.commercialScope) &&
    samePricingBasis(authorization.businessScope.pricingBasis, line.pricingBasis)
  );
};

const authorizationIsEffective = (authorization: PricingZeroFloorAuthorization, effectiveAt: string): boolean =>
  authorization.effectivePeriod.startsAt <= effectiveAt &&
  (authorization.effectivePeriod.endsAt === undefined || effectiveAt < authorization.effectivePeriod.endsAt);

const expectedAudienceRefs = (request: PricingZeroFloorEvaluationRequest): readonly string[] => {
  const {
    composedLine: {
      unitPriceCalculation: {
        input: {
          exactPrice: { path },
        },
      },
    },
  } = request;
  const priceGroupRef =
    'discountAudience' in path && path.discountAudience.kind === 'PRICE_GROUP'
      ? path.discountAudience.priceGroupRef.resourceId
      : undefined;
  return stableSortedSet([
    request.composition.decision.purchasingContext.contextRef,
    request.composition.decision.purchasingContext.contextRevision,
    ...(priceGroupRef === undefined ? [] : [priceGroupRef]),
  ]);
};

const expectedMaterialRevisionRefs = (request: PricingZeroFloorEvaluationRequest): readonly string[] => {
  const unitPrice = request.composedLine.unitPriceCalculation;
  const { path } = unitPrice.input.exactPrice;
  if (!('usedPrice' in path)) {
    return [];
  }
  const tierDecision = unitPrice.input.tierSelection.evidence.decision;
  const tierRevision =
    unitPrice.input.tierSelection.outcome === 'QUANTITY_TIER_APPLIED' &&
    tierDecision.kind === 'HIGHEST_REACHED_THRESHOLD'
      ? tierDecision.winningTier.definition.revision.revisionId
      : undefined;
  return stableSortedSet([
    path.usedPrice.priceRevision.revisionId,
    ...(tierRevision === undefined ? [] : [tierRevision]),
    ...request.composedLine.feeCalculation.contributions.map(({ fee }) => fee.definition.revision.revisionId),
    ...request.composedLine.lineDiscountContributions.map(({ candidate }) => candidate.definition.revision.revisionId),
    ...(request.composedLine.wholePurchaseAllocationRevisionRef === undefined
      ? []
      : [request.composedLine.wholePurchaseAllocationRevisionRef]),
    ...(request.composedLine.promotionOwnerDecisionRevision === undefined
      ? []
      : [request.composedLine.promotionOwnerDecisionRevision]),
  ]);
};

const authorizationMatchesCoveredMeaning = (
  authorization: PricingZeroFloorAuthorization,
  request: PricingZeroFloorEvaluationRequest,
): boolean =>
  sameStringSet(authorization.coveredMeaning.audienceRefs, expectedAudienceRefs(request)) &&
  sameStringSet(authorization.coveredMeaning.materialRevisionRefs, expectedMaterialRevisionRefs(request));

const authorizationQueryMatchesEvaluation = (
  authorizationSet: PricingZeroFloorCurrentAuthorizationSet,
  request: PricingZeroFloorEvaluationRequest,
): boolean => {
  const { decision } = request.composition;
  const line = exactDecisionLine(request);
  const { query } = authorizationSet;
  return (
    line !== undefined &&
    query.tenantId === decision.tenantId &&
    query.effectiveAt === decision.operationTime &&
    query.currencyCode === decision.currencyCode &&
    query.exactPredicateRef === authorizationSet.exactPredicateRef &&
    sameCatalogSelection(query.catalogSelection, request.composedLine.line.catalog.selection) &&
    sameCommercialScope(query.commercialScope, decision.commercialScope) &&
    samePricingBasis(query.pricingBasis, line.pricingBasis) &&
    sameStringSet(query.audienceRefs, expectedAudienceRefs(request)) &&
    sameStringSet(query.materialRevisionRefs, expectedMaterialRevisionRefs(request))
  );
};

const authorizationIdentity = (authorization: PricingZeroFloorAuthorization): string =>
  `${authorization.authorizationRef}:${authorization.authorizationRevision}`;

const distinctAuthorizations = (
  authorizations: readonly PricingZeroFloorAuthorization[],
): readonly PricingZeroFloorAuthorization[] => {
  const byIdentity = new Map<string, PricingZeroFloorAuthorization>();
  for (const authorization of authorizations) {
    const identity = authorizationIdentity(authorization);
    const existing = byIdentity.get(identity);
    if (existing === undefined || !sameZeroFloorAuthorization(existing, authorization)) {
      byIdentity.set(existing === undefined ? identity : `${identity}:conflict`, authorization);
    }
  }
  return [...byIdentity.values()];
};

const economicCoverageMatches = (
  authorization: PricingZeroFloorAuthorization,
  rawAmount: string,
  floorAdjustment: string,
): boolean =>
  compareDecimals(rawAmount, authorization.economicCoverage.minimumRawAmount) >= 0 &&
  compareDecimals(floorAdjustment, authorization.economicCoverage.maximumFloorAdjustment) <= 0;

/**
 * Applies the governed non-negative guard before publication rounding. All business refusals are
 * explicit result values so callers cannot accidentally recover them as a zero-valued success.
 */
export const evaluateZeroFloorAuthorization = Effect.fn('PricingZeroFloor.evaluateAuthorization')(
  function* evaluateAuthorization(
    request: PricingZeroFloorEvaluationRequest,
  ): Effect.fn.Return<PricingZeroFloorEvaluationResult> {
    const { composedLine } = request;
    const { decision } = request.composition;
    const { rawPostCompositionValue } = composedLine;

    if (!composedLineBelongsToComposition(request)) {
      return failed(
        composedLine,
        'AUTHORIZATION_UNVERIFIABLE',
        'ZERO_FLOOR evaluation line must be one exact line from the preserved raw composition',
      );
    }

    if (rawPostCompositionValue.currencyCode !== decision.currencyCode) {
      return failed(composedLine, 'CURRENCY_MISMATCH', 'Raw line value must use the exact Decision currency');
    }

    if (compareDecimals(rawPostCompositionValue.amount, '0') >= 0) {
      return {
        floorAdjustment: { amount: '0', currencyCode: rawPostCompositionValue.currencyCode },
        kind: 'NOT_REQUIRED',
        nonNegativePreRoundValue: rawPostCompositionValue,
        rawPostCompositionValue,
      };
    }

    if (composedLine.negativeOrigin !== 'LINE_NATIVE_COMPOSITION') {
      return failed(
        composedLine,
        'ALLOCATION_INDUCED_NEGATIVE',
        'An allocation-induced negative is invalid composition and cannot be authorized by ZERO_FLOOR',
      );
    }

    const { authorizationSet } = request;
    if ('outcome' in authorizationSet) {
      return authorizationSet.failure.type === 'UNAVAILABLE'
        ? failed(composedLine, 'AUTHORIZATION_UNAVAILABLE', authorizationSet.failure.reason, true)
        : failed(composedLine, 'AUTHORIZATION_UNVERIFIABLE', authorizationSet.failure.reason, true);
    }

    if (!authorizationSetIsFreshAndComplete(authorizationSet, decision.operationTime)) {
      return failed(
        composedLine,
        'AUTHORIZATION_UNVERIFIABLE',
        'ZERO_FLOOR Current-set evidence is not fresh, complete, and bound to the exact predicate',
        true,
      );
    }

    if (!authorizationQueryMatchesEvaluation(authorizationSet, request)) {
      return failed(
        composedLine,
        'AUTHORIZATION_UNVERIFIABLE',
        'ZERO_FLOOR completeness query does not bind the exact candidate scope and material meaning',
        true,
      );
    }

    const { authorizations } = authorizationSet;
    if (authorizations.length === 0) {
      return failed(
        composedLine,
        'AUTHORIZATION_ABSENT',
        'The proven-complete Current ZERO_FLOOR set contains no authorization',
      );
    }

    const scopeMatches = authorizations.filter((authorization) =>
      authorizationMatchesBusinessScope(authorization, request),
    );
    if (scopeMatches.length === 0) {
      return failed(
        composedLine,
        'SCOPE_MISMATCH',
        'No Current ZERO_FLOOR authorization covers the exact business scope',
      );
    }

    const currencyMatches = scopeMatches.filter(({ currencyCode }) => currencyCode === decision.currencyCode);
    if (currencyMatches.length === 0) {
      return failed(composedLine, 'CURRENCY_MISMATCH', 'ZERO_FLOOR authorization uses a different native currency');
    }

    const meaningMatches = currencyMatches.filter((authorization) =>
      authorizationMatchesCoveredMeaning(authorization, request),
    );
    if (meaningMatches.length === 0) {
      return failed(
        composedLine,
        'SCOPE_MISMATCH',
        'ZERO_FLOOR authorization does not cover the exact audience and material fact revisions',
      );
    }

    const effectiveMatches = meaningMatches.filter((authorization) =>
      authorizationIsEffective(authorization, decision.operationTime),
    );
    if (effectiveMatches.length === 0) {
      return failed(
        composedLine,
        'EFFECTIVE_PERIOD_MISMATCH',
        'No matching ZERO_FLOOR authorization is effective at the Decision instant',
      );
    }

    const currentAuthorizations = distinctAuthorizations(effectiveMatches);
    if (currentAuthorizations.length !== 1) {
      return failed(
        composedLine,
        'AUTHORIZATION_CONFLICT',
        'Multiple overlapping ZERO_FLOOR authorizations cover the exact Current evaluation',
      );
    }

    const [authorization] = currentAuthorizations;
    if (authorization === undefined) {
      return failed(composedLine, 'AUTHORIZATION_ABSENT', 'No applicable ZERO_FLOOR authorization exists');
    }

    const floorAdjustment = rawPostCompositionValue.amount.slice(1);
    if (!economicCoverageMatches(authorization, rawPostCompositionValue.amount, floorAdjustment)) {
      return failed(
        composedLine,
        'ECONOMIC_COVERAGE_EXCEEDED',
        'Raw negative value exceeds the approved ZERO_FLOOR economic coverage',
      );
    }

    return yield* Effect.succeed({
      authorization,
      authorizationSet,
      floorAdjustment: { amount: floorAdjustment, currencyCode: rawPostCompositionValue.currencyCode },
      kind: 'AUTHORIZED_ZERO_FLOOR' as const,
      nonNegativePreRoundValue: { amount: '0' as const, currencyCode: rawPostCompositionValue.currencyCode },
      rawPostCompositionValue: {
        amount: rawPostCompositionValue.amount,
        currencyCode: rawPostCompositionValue.currencyCode,
      },
    });
  },
);
