import {
  PricingMaterialEvidenceAssemblyRequestSchema,
  PricingMaterialEvidenceConflictFailure,
  PricingMaterialEvidenceMissingFailure,
  PricingMaterialEvidenceReadySchema,
  PricingMaterialEvidenceUnverifiableFailure,
} from '@app/pricing-contracts/domain/material-evidence';
import type {
  PricingMaterialLineEvidence,
  PricingMaterialEvidenceAssemblyRequest,
  PricingMaterialEvidenceFailure,
  PricingMaterialEvidenceReady,
} from '@app/pricing-contracts/domain/material-evidence';
import type {
  PricingSourceEvidenceFamily,
  PricingSourceEvidenceResult,
  PricingSourceEvidenceVerifiedAbsent,
  PricingSourceEvidenceVerifiedPresent,
} from '@app/pricing-contracts/domain/source-revision-evidence';
import {
  PricingSourceEvidenceConflictSchema,
  PricingSourceEvidenceMissingSchema,
  PricingSourceEvidenceUnverifiableSchema,
  PricingSourceEvidenceVerifiedAbsentSchema,
  PricingSourceEvidenceVerifiedPresentSchema,
} from '@app/pricing-contracts/domain/source-revision-evidence';
import type { PricingInstantSchema } from '@app/pricing-contracts/domain/currency-support';
import {
  PRICING_ALLOCATION_CONTRACT_VERSION,
  PricingAllocationResultSchema,
} from '@app/pricing-contracts/domain/discount-fee-allocation';
import { PricingDecisionSchema } from '@app/pricing-contracts/pricing-decision';
import { unitPriceGroupAbsencePredicateRef } from './unit-price-material-evidence.service.ts';
import { DateTime, Effect, Option, Schema } from 'effect';

interface EvidenceContext {
  readonly candidateRef: string;
  readonly family: PricingSourceEvidenceFamily;
  readonly occurrenceId?: PricingMaterialLineEvidence['occurrenceId'];
}

interface PresentExpectation extends EvidenceContext {
  readonly expectedFactRefs?: readonly string[];
  readonly expectedFactRevisionPairs?: readonly {
    readonly factRef: string;
    readonly factRevisionRef: string;
  }[];
  readonly expectedObservedAt?: typeof PricingInstantSchema.Type;
  readonly expectedOwnerSetRevision?: string;
  readonly expectedPredicateRef?: string;
  readonly expectedRevisionRefs: readonly string[];
  readonly kind: 'PRESENT';
}

interface AbsentExpectation extends EvidenceContext {
  readonly expectedObservedAt?: typeof PricingInstantSchema.Type;
  readonly expectedOwnerSetRevision?: string;
  readonly expectedPredicateRef?: string;
  readonly kind: 'ABSENT';
}

type SourceExpectation = AbsentExpectation | PresentExpectation;

const stableUnique = (values: readonly string[]): readonly string[] => [...new Set(values)].toSorted();

const sameStringSet = (left: readonly string[], right: readonly string[]): boolean => {
  const normalizedLeft = stableUnique(left);
  const normalizedRight = stableUnique(right);
  return (
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((value, index) => normalizedRight[index] === value)
  );
};

const sameFactRevisionPairs = (
  actual: readonly { readonly factRef: string; readonly factRevisionRef: string }[],
  expected: readonly { readonly factRef: string; readonly factRevisionRef: string }[],
): boolean =>
  actual.length === expected.length &&
  expected.every(({ factRef, factRevisionRef }) =>
    actual.some((fact) => fact.factRef === factRef && fact.factRevisionRef === factRevisionRef),
  );

const sameAllocationResult = Schema.toEquivalence(PricingAllocationResultSchema);
const sameDecision = Schema.toEquivalence(PricingDecisionSchema);

const failureFields = (context: EvidenceContext, predicateRef: string | undefined, reason: string) => {
  const fields = { candidateRef: context.candidateRef, family: context.family, reason };
  if (context.occurrenceId === undefined) {
    return predicateRef === undefined ? fields : { ...fields, predicateRef };
  }
  return predicateRef === undefined
    ? { ...fields, occurrenceId: context.occurrenceId }
    : { ...fields, occurrenceId: context.occurrenceId, predicateRef };
};

const sourcePredicateRef = (source: PricingSourceEvidenceResult): string => source.request.ownerScope.predicateRef;

const sourceFailure = (
  source: PricingSourceEvidenceResult,
  context: EvidenceContext,
): PricingMaterialEvidenceFailure | undefined => {
  const predicateRef = sourcePredicateRef(source);
  if (Schema.is(PricingSourceEvidenceMissingSchema)(source)) {
    return new PricingMaterialEvidenceMissingFailure(
      failureFields(context, predicateRef, `Required owner evidence is missing: ${source.reason}`),
    );
  }
  if (Schema.is(PricingSourceEvidenceConflictSchema)(source)) {
    return new PricingMaterialEvidenceConflictFailure(
      failureFields(context, predicateRef, 'Owner reported competing Current facts for one exact material predicate'),
    );
  }
  return Schema.is(PricingSourceEvidenceUnverifiableSchema)(source)
    ? new PricingMaterialEvidenceUnverifiableFailure({
        ...failureFields(context, predicateRef, `Required owner evidence is unverifiable: ${source.reason}`),
        retryable: source.retryable,
      })
    : undefined;
};

const verifiedSourceIsFinallyCurrent = (
  source: PricingSourceEvidenceVerifiedAbsent | PricingSourceEvidenceVerifiedPresent,
  request: PricingMaterialEvidenceAssemblyRequest,
): boolean => {
  const { completeness } = source;
  const { temporal } = completeness;
  return (
    source.request.effectiveAt === request.commercialTotal.decision.operationTime &&
    source.request.requestedAt === request.requestedAt &&
    source.request.ownerScope.ownerModuleId === 'commerce.pricing' &&
    source.request.ownerScope.tenantId === request.commercialTotal.decision.tenantId &&
    source.request.currencyCode === request.commercialTotal.decision.currencyCode &&
    temporal.observedAt <= request.revalidatedAt &&
    (temporal.nextMaterialBoundary === undefined || request.revalidatedAt < temporal.nextMaterialBoundary)
  );
};

const sourceMismatchAxes = (
  source: PricingSourceEvidenceVerifiedAbsent | PricingSourceEvidenceVerifiedPresent,
  expectation: SourceExpectation,
  request: PricingMaterialEvidenceAssemblyRequest,
): readonly string[] => [
  ...(source.request.family === expectation.family && source.completeness.family === expectation.family
    ? []
    : ['family']),
  ...(source.request.effectiveAt === request.commercialTotal.decision.operationTime ? [] : ['effectiveAt']),
  ...(source.request.requestedAt === request.requestedAt ? [] : ['requestedAt']),
  ...(source.request.ownerScope.ownerModuleId === 'commerce.pricing' ? [] : ['owner']),
  ...(source.request.ownerScope.tenantId === request.commercialTotal.decision.tenantId ? [] : ['tenant']),
  ...(source.request.currencyCode === request.commercialTotal.decision.currencyCode ? [] : ['currency']),
  ...(source.completeness.temporal.observedAt <= request.revalidatedAt ? [] : ['observation']),
  ...(source.completeness.temporal.nextMaterialBoundary === undefined ||
  request.revalidatedAt < source.completeness.temporal.nextMaterialBoundary
    ? []
    : ['material-boundary']),
  ...(expectation.expectedPredicateRef === undefined ||
  source.completeness.ownerScope.predicateRef === expectation.expectedPredicateRef
    ? []
    : ['embedded-predicate']),
  ...(expectation.expectedOwnerSetRevision === undefined ||
  source.completeness.ownerSetRevisionRef === expectation.expectedOwnerSetRevision
    ? []
    : ['embedded-set-revision']),
  ...(expectation.expectedObservedAt === undefined ||
  source.completeness.temporal.observedAt === expectation.expectedObservedAt
    ? []
    : ['embedded-observation']),
];

const validateSource = (
  source: PricingSourceEvidenceResult,
  expectation: SourceExpectation,
  request: PricingMaterialEvidenceAssemblyRequest,
): PricingMaterialEvidenceFailure | undefined => {
  const knownFailure = sourceFailure(source, expectation);
  if (knownFailure !== undefined) {
    return knownFailure;
  }
  if (
    !Schema.is(PricingSourceEvidenceVerifiedPresentSchema)(source) &&
    !Schema.is(PricingSourceEvidenceVerifiedAbsentSchema)(source)
  ) {
    return new PricingMaterialEvidenceUnverifiableFailure({
      ...failureFields(expectation, sourcePredicateRef(source), 'Unsupported material-evidence outcome'),
      retryable: false,
    });
  }
  const {
    completeness: { ownerScope },
  } = source;
  const { predicateRef } = ownerScope;
  const mismatchAxes = sourceMismatchAxes(source, expectation, request);
  if (!verifiedSourceIsFinallyCurrent(source, request) || mismatchAxes.length > 0) {
    return new PricingMaterialEvidenceUnverifiableFailure({
      ...failureFields(
        expectation,
        predicateRef,
        `Material evidence does not bind the exact candidate and owner state (${mismatchAxes.join(', ')})`,
      ),
      retryable: false,
    });
  }
  if (expectation.kind === 'ABSENT') {
    return Schema.is(PricingSourceEvidenceVerifiedAbsentSchema)(source)
      ? undefined
      : new PricingMaterialEvidenceConflictFailure(
          failureFields(
            expectation,
            predicateRef,
            'A predicate required to be owner-proven absent contains Current facts',
          ),
        );
  }
  if (Schema.is(PricingSourceEvidenceVerifiedAbsentSchema)(source)) {
    return new PricingMaterialEvidenceMissingFailure(
      failureFields(expectation, predicateRef, 'A required material fact is owner-proven absent'),
    );
  }
  const actualRevisionRefs = source.currentFacts.map(({ factRevisionRef }) => factRevisionRef);
  const revisionsMatch = sameStringSet(actualRevisionRefs, expectation.expectedRevisionRefs);
  const factRefsMatch =
    expectation.expectedFactRefs === undefined ||
    sameStringSet(
      source.currentFacts.map(({ factRef }) => factRef),
      expectation.expectedFactRefs,
    );
  const factRevisionPairsMatch =
    expectation.expectedFactRevisionPairs === undefined ||
    sameFactRevisionPairs(source.currentFacts, expectation.expectedFactRevisionPairs);
  return revisionsMatch && factRefsMatch && factRevisionPairsMatch
    ? undefined
    : new PricingMaterialEvidenceUnverifiableFailure({
        ...failureFields(
          expectation,
          predicateRef,
          'Fact Currentness identities and revisions do not exactly equal the complete owner set used by calculation',
        ),
        retryable: false,
      });
};

const lengthDelimitedScopePart = (part: string): string => `${part.length}:${part}`;

const discountApplicabilityPredicateRef = (
  kind: 'variant-line' | 'whole-purchase',
  scopeParts: readonly string[],
): string => `pricing:discount-applicability:${kind}:v1:${scopeParts.map(lengthDelimitedScopePart).join('|')}`;

export const pricingLineDiscountApplicabilityPredicateRef = (
  commercialTotal: PricingMaterialEvidenceAssemblyRequest['commercialTotal'],
  line: PricingMaterialEvidenceAssemblyRequest['commercialTotal']['sourceEvidence']['preRound']['lines'][number],
): string => {
  const { decision } = commercialTotal;
  const { channelId, marketId, sellingLegalEntityId } = decision.commercialScope;
  const pricingLine = line.composition.unitPriceCalculation.input.line;
  const { productRef, variantRef } = pricingLine.catalog.selection;
  const { quantity, unitRef } = pricingLine.pricingBasis;
  return discountApplicabilityPredicateRef('variant-line', [
    commercialTotal.candidateRef,
    decision.tenantId,
    decision.currencyCode,
    channelId,
    marketId,
    sellingLegalEntityId,
    line.occurrenceId,
    productRef.resourceId,
    variantRef.resourceId,
    unitRef.resourceId,
    quantity,
  ]);
};

export const pricingWholePurchaseDiscountApplicabilityPredicateRef = (
  commercialTotal: PricingMaterialEvidenceAssemblyRequest['commercialTotal'],
): string => {
  const { decision } = commercialTotal;
  const { channelId, marketId, sellingLegalEntityId } = decision.commercialScope;
  return discountApplicabilityPredicateRef('whole-purchase', [
    commercialTotal.candidateRef,
    decision.tenantId,
    decision.currencyCode,
    decision.monetaryBoundary,
    channelId,
    marketId,
    sellingLegalEntityId,
    decision.purchasingContext.contextRef,
    decision.purchasingContext.contextRevision,
  ]);
};

const usedPriceFrom = (
  path: PricingMaterialEvidenceAssemblyRequest['commercialTotal']['sourceEvidence']['preRound']['lines'][number]['composition']['unitPriceCalculation']['input']['exactPrice']['path'],
) => ('usedPrice' in path ? path.usedPrice : undefined);

const validateCurrencySupport = (
  request: PricingMaterialEvidenceAssemblyRequest,
): PricingMaterialEvidenceFailure | undefined => {
  const [firstLine] = request.commercialTotal.sourceEvidence.preRound.lines;
  if (firstLine === undefined) {
    return new PricingMaterialEvidenceUnverifiableFailure({
      candidateRef: request.commercialTotal.candidateRef,
      family: 'CURRENCY_SUPPORT',
      reason: 'Commercial total contains no source line for Currency Support evidence',
      retryable: false,
    });
  }
  const { completenessEvidence, observedAt, supportRevisionRef, supportRootRef } =
    firstLine.composition.unitPriceCalculation.input.exactPrice.currencySupport;
  return validateSource(
    request.currencySupport,
    {
      candidateRef: request.commercialTotal.candidateRef,
      expectedFactRefs: [supportRootRef.resourceId],
      expectedObservedAt: observedAt,
      expectedOwnerSetRevision: supportRevisionRef.resourceId,
      expectedPredicateRef: completenessEvidence.scope.predicateRef,
      expectedRevisionRefs: [supportRevisionRef.resourceId],
      family: 'CURRENCY_SUPPORT',
      kind: 'PRESENT',
    },
    request,
  );
};

const validatePricePath = (
  request: PricingMaterialEvidenceAssemblyRequest,
  evidenceLine: PricingMaterialEvidenceAssemblyRequest['lines'][number],
  totalLine: PricingMaterialEvidenceAssemblyRequest['commercialTotal']['sourceEvidence']['preRound']['lines'][number],
): PricingMaterialEvidenceFailure | undefined => {
  const { path } = totalLine.composition.unitPriceCalculation.input.exactPrice;
  const usedPrice = usedPriceFrom(path);
  if (usedPrice === undefined) {
    return new PricingMaterialEvidenceUnverifiableFailure({
      candidateRef: request.commercialTotal.candidateRef,
      family: 'PRICE',
      occurrenceId: evidenceLine.occurrenceId,
      reason: 'Calculated line did not retain its exact used Price path',
      retryable: false,
    });
  }
  const usedPriceFailure = validateSource(
    evidenceLine.pricePath.usedPrice,
    {
      candidateRef: request.commercialTotal.candidateRef,
      expectedFactRefs: [usedPrice.priceRef.resourceId],
      expectedObservedAt: usedPrice.evidence.observedAt,
      expectedOwnerSetRevision: usedPrice.evidence.ownerRevision,
      expectedPredicateRef: unitPriceGroupAbsencePredicateRef(usedPrice.request),
      expectedRevisionRefs: [usedPrice.priceRevision.revisionId],
      family: 'PRICE',
      kind: 'PRESENT',
      occurrenceId: evidenceLine.occurrenceId,
    },
    request,
  );
  if (usedPriceFailure !== undefined) {
    return usedPriceFailure;
  }
  if (!('groupAbsence' in path)) {
    return evidenceLine.pricePath.assignedGroupAbsence === undefined
      ? undefined
      : new PricingMaterialEvidenceConflictFailure({
          candidateRef: request.commercialTotal.candidateRef,
          family: 'PRICE',
          occurrenceId: evidenceLine.occurrenceId,
          reason: 'Group-absence evidence is present on a Price path that did not use assigned-group fallback',
        });
  }
  if (evidenceLine.pricePath.assignedGroupAbsence === undefined) {
    return new PricingMaterialEvidenceMissingFailure({
      candidateRef: request.commercialTotal.candidateRef,
      family: 'PRICE',
      occurrenceId: evidenceLine.occurrenceId,
      reason: 'Assigned Group fallback requires exact Group Price absence proof',
    });
  }
  return validateSource(
    evidenceLine.pricePath.assignedGroupAbsence,
    {
      candidateRef: request.commercialTotal.candidateRef,
      expectedObservedAt: path.groupAbsence.evidence.observedAt,
      expectedOwnerSetRevision: path.groupAbsence.evidence.ownerRevision,
      expectedPredicateRef: unitPriceGroupAbsencePredicateRef(path.groupAbsence.request),
      family: 'PRICE',
      kind: 'ABSENT',
      occurrenceId: evidenceLine.occurrenceId,
    },
    request,
  );
};

const validateTierSet = (
  request: PricingMaterialEvidenceAssemblyRequest,
  evidenceLine: PricingMaterialEvidenceAssemblyRequest['lines'][number],
  totalLine: PricingMaterialEvidenceAssemblyRequest['commercialTotal']['sourceEvidence']['preRound']['lines'][number],
): PricingMaterialEvidenceFailure | undefined => {
  const { tierSet } = totalLine.composition.unitPriceCalculation.input.tierSelection.evidence.input;
  const revisions = tierSet.currentTiers.map(({ definition }) => definition.revision.revisionId);
  const common = {
    candidateRef: request.commercialTotal.candidateRef,
    expectedObservedAt: DateTime.formatIso(tierSet.completenessEvidence.observedAt),
    expectedOwnerSetRevision: tierSet.completenessEvidence.ownerRevision,
    expectedPredicateRef: tierSet.completenessEvidence.scope.predicateRef,
    family: 'QUANTITY_TIER' as const,
    occurrenceId: evidenceLine.occurrenceId,
  };
  return validateSource(
    evidenceLine.quantityTiers,
    revisions.length === 0
      ? { ...common, kind: 'ABSENT' }
      : { ...common, expectedRevisionRefs: revisions, kind: 'PRESENT' },
    request,
  );
};

type DiscountCurrentFact = PricingSourceEvidenceVerifiedPresent['currentFacts'][number];

type DiscountOwnerSetValidation =
  | { readonly currentFacts: readonly DiscountCurrentFact[]; readonly predicateRef: string }
  | { readonly failure: PricingMaterialEvidenceFailure };

const validateSelectedDiscountOwnerSet = (
  request: PricingMaterialEvidenceAssemblyRequest,
  sourceEvidence: PricingSourceEvidenceResult,
  context: EvidenceContext,
): DiscountOwnerSetValidation => {
  const failure = sourceFailure(sourceEvidence, context);
  if (failure !== undefined) {
    return { failure };
  }
  if (
    !Schema.is(PricingSourceEvidenceVerifiedPresentSchema)(sourceEvidence) &&
    !Schema.is(PricingSourceEvidenceVerifiedAbsentSchema)(sourceEvidence)
  ) {
    return {
      failure: new PricingMaterialEvidenceUnverifiableFailure({
        ...context,
        reason: 'Selected Discount owner Current-set proof is not verified',
        retryable: false,
      }),
    };
  }
  const currentFacts: readonly DiscountCurrentFact[] = Schema.is(PricingSourceEvidenceVerifiedPresentSchema)(
    sourceEvidence,
  )
    ? sourceEvidence.currentFacts
    : [];
  const sourceValidation = validateSource(
    sourceEvidence,
    currentFacts.length === 0
      ? {
          ...context,
          expectedObservedAt: sourceEvidence.completeness.temporal.observedAt,
          expectedOwnerSetRevision: sourceEvidence.completeness.ownerSetRevisionRef,
          expectedPredicateRef: sourceEvidence.completeness.ownerScope.predicateRef,
          kind: 'ABSENT',
        }
      : {
          ...context,
          expectedFactRefs: currentFacts.map(({ factRef }) => factRef),
          expectedFactRevisionPairs: currentFacts.map(({ factRef, factRevisionRef }) => ({
            factRef,
            factRevisionRef,
          })),
          expectedObservedAt: sourceEvidence.completeness.temporal.observedAt,
          expectedOwnerSetRevision: sourceEvidence.completeness.ownerSetRevisionRef,
          expectedPredicateRef: sourceEvidence.completeness.ownerScope.predicateRef,
          expectedRevisionRefs: currentFacts.map(({ factRevisionRef }) => factRevisionRef),
          kind: 'PRESENT',
        },
    request,
  );
  return sourceValidation === undefined
    ? { currentFacts, predicateRef: sourceEvidence.completeness.ownerScope.predicateRef }
    : { failure: sourceValidation };
};

const validateDiscountSet = (
  request: PricingMaterialEvidenceAssemblyRequest,
  evidenceLine: PricingMaterialEvidenceAssemblyRequest['lines'][number],
  totalLine: PricingMaterialEvidenceAssemblyRequest['commercialTotal']['sourceEvidence']['preRound']['lines'][number],
): PricingMaterialEvidenceFailure | undefined => {
  const contributionFacts = totalLine.composition.lineDiscountContributions.map(({ candidate }) => ({
    factRef: candidate.definition.discountId,
    factRevisionRef: candidate.definition.revision.revisionId,
  }));
  if (evidenceLine.lineDiscounts.kind === 'DISCOUNT_NOT_SELECTED_NO_ELIGIBLE_AUDIENCE') {
    return contributionFacts.length === 0
      ? undefined
      : new PricingMaterialEvidenceConflictFailure({
          candidateRef: request.commercialTotal.candidateRef,
          family: 'DISCOUNT',
          occurrenceId: evidenceLine.occurrenceId,
          reason: 'Discount non-selection cannot accompany a retained line Discount contribution',
        });
  }
  const { sourceEvidence } = evidenceLine.lineDiscounts;
  const context = {
    candidateRef: request.commercialTotal.candidateRef,
    family: 'DISCOUNT' as const,
    occurrenceId: evidenceLine.occurrenceId,
  };
  const validation = validateSelectedDiscountOwnerSet(request, sourceEvidence, context);
  if ('failure' in validation) {
    return validation.failure;
  }
  const { currentFacts, predicateRef } = validation;
  return contributionFacts.every(({ factRef, factRevisionRef }) =>
    currentFacts.some((fact) => fact.factRef === factRef && fact.factRevisionRef === factRevisionRef),
  )
    ? undefined
    : new PricingMaterialEvidenceUnverifiableFailure({
        ...context,
        predicateRef,
        reason: 'Applied line Discount is not a member of the exact owner Current set',
        retryable: false,
      });
};

const validateFeeSet = (
  request: PricingMaterialEvidenceAssemblyRequest,
  evidenceLine: PricingMaterialEvidenceAssemblyRequest['lines'][number],
  totalLine: PricingMaterialEvidenceAssemblyRequest['commercialTotal']['sourceEvidence']['preRound']['lines'][number],
): PricingMaterialEvidenceFailure | undefined => {
  const { feeSet } = totalLine.composition.feeCalculation.input;
  const revisions = feeSet.fees.map(({ definition }) => definition.revision.revisionId);
  const factRefs = feeSet.fees.map(({ definition }) => definition.feeRef.resourceId);
  const common = {
    candidateRef: request.commercialTotal.candidateRef,
    expectedObservedAt: feeSet.observedAt,
    expectedOwnerSetRevision: feeSet.completenessEvidence.ownerRevision,
    expectedPredicateRef: feeSet.completenessEvidence.scope.predicateRef,
    family: 'COMMERCIAL_FEE' as const,
    occurrenceId: evidenceLine.occurrenceId,
  };
  return validateSource(
    evidenceLine.commercialFees,
    revisions.length === 0
      ? { ...common, kind: 'ABSENT' }
      : { ...common, expectedFactRefs: factRefs, expectedRevisionRefs: revisions, kind: 'PRESENT' },
    request,
  );
};

const validateZeroFloor = (
  request: PricingMaterialEvidenceAssemblyRequest,
  evidenceLine: PricingMaterialEvidenceAssemblyRequest['lines'][number],
  totalLine: PricingMaterialEvidenceAssemblyRequest['commercialTotal']['sourceEvidence']['preRound']['lines'][number],
): PricingMaterialEvidenceFailure | undefined => {
  const floor = totalLine.floorEvaluation;
  if (floor.kind === 'NOT_REQUIRED') {
    return evidenceLine.zeroFloor === undefined
      ? undefined
      : new PricingMaterialEvidenceConflictFailure({
          candidateRef: request.commercialTotal.candidateRef,
          family: 'ZERO_FLOOR',
          occurrenceId: evidenceLine.occurrenceId,
          reason: 'ZERO_FLOOR evidence is not material for a non-negative raw line',
        });
  }
  if (evidenceLine.zeroFloor === undefined) {
    return new PricingMaterialEvidenceMissingFailure({
      candidateRef: request.commercialTotal.candidateRef,
      family: 'ZERO_FLOOR',
      occurrenceId: evidenceLine.occurrenceId,
      reason: 'A raw-negative line requires the exact Current ZERO_FLOOR authorization set',
    });
  }
  const { authorizationSet } = floor;
  const sourceFailureResult = validateSource(
    evidenceLine.zeroFloor,
    {
      candidateRef: request.commercialTotal.candidateRef,
      expectedFactRefs: authorizationSet.authorizations.map(({ authorizationRef }) => authorizationRef),
      expectedObservedAt: authorizationSet.currentness.observedAt,
      expectedOwnerSetRevision: authorizationSet.ownerRevision,
      expectedPredicateRef: authorizationSet.exactPredicateRef,
      expectedRevisionRefs: authorizationSet.authorizations.map(({ authorizationRevision }) => authorizationRevision),
      family: 'ZERO_FLOOR',
      kind: 'PRESENT',
      occurrenceId: evidenceLine.occurrenceId,
    },
    request,
  );
  if (sourceFailureResult !== undefined) {
    return sourceFailureResult;
  }
  if (!Schema.is(PricingSourceEvidenceVerifiedPresentSchema)(evidenceLine.zeroFloor)) {
    return new PricingMaterialEvidenceUnverifiableFailure({
      candidateRef: request.commercialTotal.candidateRef,
      family: 'ZERO_FLOOR',
      occurrenceId: evidenceLine.occurrenceId,
      reason: 'ZERO_FLOOR fact evidence did not preserve the applied authorization effectivity',
      retryable: false,
    });
  }
  const zeroFloorEvidence = evidenceLine.zeroFloor;
  const preservesEffectivity = authorizationSet.authorizations.every((authorization) =>
    zeroFloorEvidence.currentFacts.some(
      (fact) =>
        fact.factRef === authorization.authorizationRef &&
        fact.factRevisionRef === authorization.authorizationRevision &&
        fact.effectivePeriod.effectiveFrom === authorization.effectivePeriod.startsAt &&
        fact.effectivePeriod.effectiveTo === (authorization.effectivePeriod.endsAt ?? null),
    ),
  );
  return preservesEffectivity
    ? undefined
    : new PricingMaterialEvidenceUnverifiableFailure({
        candidateRef: request.commercialTotal.candidateRef,
        family: 'ZERO_FLOOR',
        occurrenceId: evidenceLine.occurrenceId,
        reason: 'ZERO_FLOOR fact evidence did not preserve the applied authorization effectivity',
        retryable: false,
      });
};

const validateLines = (request: PricingMaterialEvidenceAssemblyRequest): PricingMaterialEvidenceFailure | undefined => {
  const totalLines = request.commercialTotal.sourceEvidence.preRound.lines;
  for (const [index, evidenceLine] of request.lines.entries()) {
    const totalLine = totalLines[index];
    if (totalLine === undefined || totalLine.occurrenceId !== evidenceLine.occurrenceId) {
      return new PricingMaterialEvidenceUnverifiableFailure({
        candidateRef: request.commercialTotal.candidateRef,
        occurrenceId: evidenceLine.occurrenceId,
        reason: 'Material-evidence line does not bind the exact ordered commercial-result occurrence',
        retryable: false,
      });
    }
    const failure =
      validatePricePath(request, evidenceLine, totalLine) ??
      validateTierSet(request, evidenceLine, totalLine) ??
      validateDiscountSet(request, evidenceLine, totalLine) ??
      validateFeeSet(request, evidenceLine, totalLine) ??
      validateZeroFloor(request, evidenceLine, totalLine);
    if (failure !== undefined) {
      return failure;
    }
  }
  return undefined;
};

type SelectedWholePurchaseDiscount = Extract<
  PricingMaterialEvidenceAssemblyRequest['wholePurchase']['contractualDiscounts'],
  { readonly kind: 'DISCOUNT_SELECTED' }
>;

const validateSelectedWholePurchase = (
  request: PricingMaterialEvidenceAssemblyRequest,
  contractualDiscounts: SelectedWholePurchaseDiscount,
): PricingMaterialEvidenceFailure | undefined => {
  const { allocationAssessment } = request.wholePurchase;
  const revisionRef = allocationAssessment?.request.source.revisionRef;
  const factRef = allocationAssessment?.request.source.logicalFactRef;
  const retained = request.commercialTotal.sourceEvidence.preRound.rawComposition.wholePurchaseAllocationEvidence;
  const { sourceEvidence } = contractualDiscounts;
  const context = { candidateRef: request.commercialTotal.candidateRef, family: 'DISCOUNT' as const };
  const validation = validateSelectedDiscountOwnerSet(request, sourceEvidence, context);
  if ('failure' in validation) {
    return validation.failure;
  }
  const { currentFacts, predicateRef } = validation;
  if (
    revisionRef !== undefined &&
    factRef !== undefined &&
    !currentFacts.some((fact) => fact.factRef === factRef && fact.factRevisionRef === revisionRef)
  ) {
    return new PricingMaterialEvidenceUnverifiableFailure({
      ...context,
      predicateRef,
      reason: 'Allocated whole-purchase Discount is not a member of the exact owner Current set',
      retryable: false,
    });
  }
  if (
    allocationAssessment?.outcome === 'ALLOCATION_APPLIED' ||
    allocationAssessment?.outcome === 'ALLOCATION_NOT_APPLICABLE'
  ) {
    const sameRetainedAssessment = retained !== undefined && sameAllocationResult(allocationAssessment, retained);
    return sameRetainedAssessment
      ? undefined
      : new PricingMaterialEvidenceUnverifiableFailure({
          candidateRef: request.commercialTotal.candidateRef,
          family: 'DISCOUNT',
          reason: 'Whole-purchase allocation assessment does not equal the evidence retained by the commercial result',
          retryable: false,
        });
  }
  return retained === undefined
    ? undefined
    : new PricingMaterialEvidenceConflictFailure({
        candidateRef: request.commercialTotal.candidateRef,
        family: 'DISCOUNT',
        reason: 'Commercial result retained a whole-purchase allocation without its exact assessment proof',
      });
};

const validateWholePurchase = (
  request: PricingMaterialEvidenceAssemblyRequest,
): PricingMaterialEvidenceFailure | undefined => {
  const { allocationAssessment, contractualDiscounts } = request.wholePurchase;
  if (allocationAssessment?.outcome === 'ALLOCATION_FAILED') {
    return new PricingMaterialEvidenceUnverifiableFailure({
      candidateRef: request.commercialTotal.candidateRef,
      family: 'DISCOUNT',
      reason: `Whole-purchase allocation evidence is not publishable: ${allocationAssessment.reason}`,
      retryable: false,
    });
  }
  if (
    allocationAssessment !== undefined &&
    !sameDecision(allocationAssessment.request.decision, request.commercialTotal.decision)
  ) {
    return new PricingMaterialEvidenceUnverifiableFailure({
      candidateRef: request.commercialTotal.candidateRef,
      family: 'DISCOUNT',
      reason: 'Whole-purchase allocation proof does not bind the exact Pricing Decision',
      retryable: false,
    });
  }
  const retained = request.commercialTotal.sourceEvidence.preRound.rawComposition.wholePurchaseAllocationEvidence;
  if (contractualDiscounts.kind === 'DISCOUNT_NOT_SELECTED_NO_ELIGIBLE_AUDIENCE') {
    return allocationAssessment === undefined && retained === undefined
      ? undefined
      : new PricingMaterialEvidenceConflictFailure({
          candidateRef: request.commercialTotal.candidateRef,
          family: 'DISCOUNT',
          reason: 'Discount non-selection cannot accompany retained whole-purchase Discount material',
        });
  }
  if (contractualDiscounts.kind === 'DISCOUNT_NOT_SELECTED_SCOPE_INELIGIBLE') {
    return allocationAssessment === undefined && retained === undefined
      ? undefined
      : new PricingMaterialEvidenceConflictFailure({
          candidateRef: request.commercialTotal.candidateRef,
          family: 'DISCOUNT',
          reason: 'Price Group whole-purchase scope ineligibility cannot accompany retained allocation material',
        });
  }
  return validateSelectedWholePurchase(request, contractualDiscounts);
};

const calculationVersions = (request: PricingMaterialEvidenceAssemblyRequest) =>
  request.commercialTotal.calculationVersions;

/**
 * Final #786 Pricing-owned material gate. It assembles no new business facts: every accepted proof
 * is cross-bound to the exact #779/#780 source chain and finally validated before its next boundary.
 */
export const assemblePricingMaterialEvidence = Effect.fn('PricingMaterialEvidence.assemble')(
  function* assemblePricingMaterialEvidenceProgram(
    input: PricingMaterialEvidenceAssemblyRequest,
  ): Effect.fn.Return<PricingMaterialEvidenceReady, PricingMaterialEvidenceFailure> {
    const decoded = Schema.decodeOption(PricingMaterialEvidenceAssemblyRequestSchema, {
      onExcessProperty: 'error',
    })(input);
    if (Option.isNone(decoded)) {
      return yield* new PricingMaterialEvidenceUnverifiableFailure({
        candidateRef: input.commercialTotal.candidateRef,
        reason: 'Material-evidence request failed closed schema validation',
        retryable: false,
      });
    }
    const request = decoded.value;
    const failure = validateCurrencySupport(request) ?? validateLines(request) ?? validateWholePurchase(request);
    if (failure !== undefined) {
      return yield* failure;
    }
    const versions = calculationVersions(request);
    if (
      versions.arithmeticProfileVersions.length !== 1 ||
      versions.publicationProfileVersions.length !== 1 ||
      versions.allocationContractVersions.some((version) => version !== PRICING_ALLOCATION_CONTRACT_VERSION)
    ) {
      return yield* new PricingMaterialEvidenceUnverifiableFailure({
        candidateRef: request.commercialTotal.candidateRef,
        reason: 'Calculation, allocation, or publication versions are incomplete or internally inconsistent',
        retryable: false,
      });
    }
    const ready: PricingMaterialEvidenceReady = {
      calculationVersions: versions,
      candidateRef: request.commercialTotal.candidateRef,
      externalOwnerEvidence: request.externalOwnerEvidence,
      outcome: 'PRICING_MATERIAL_EVIDENCE_READY',
      sourceEvidence: request,
      validatedAt: request.revalidatedAt,
    };
    const validatedReady = Schema.decodeOption(PricingMaterialEvidenceReadySchema, {
      onExcessProperty: 'error',
    })(ready);
    if (Option.isNone(validatedReady)) {
      return yield* new PricingMaterialEvidenceUnverifiableFailure({
        candidateRef: request.commercialTotal.candidateRef,
        reason: 'Material evidence could not preserve the exact candidate and source chain',
        retryable: false,
      });
    }
    return validatedReady.value;
  },
);
