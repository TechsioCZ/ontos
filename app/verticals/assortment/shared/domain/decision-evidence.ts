import { DateTime, Effect, Predicate, Schema } from 'effect';

import {
  AssortmentCatalogSelectionSchema,
  AssortmentDecisionEvidenceSchema,
  AssortmentDecisionRequestSchema,
  AssortmentDecisionSubjectSchema,
  AssortmentPurchaseRequestSchema,
  AssortmentRevisionReferenceSchema,
  AssortmentSetCompletenessEvidenceSchema,
  AssortmentSetPurchaseCompositionSchema,
  AssortmentTrustedCommerceContextSchema,
  AssortmentVisibilityRequestSchema,
  composeAssortmentPurchaseOutcome,
} from './decision-contracts.ts';
import type {
  AssortmentCandidate,
  AssortmentCatalogSelection,
  AssortmentClosedBoundary,
  AssortmentCommercialScope,
  AssortmentDecisionEvidence,
  AssortmentDecisionRequest,
  AssortmentGovernedDecision,
  AssortmentPurchasingSubject,
  AssortmentPurchaseRequest,
} from './decision-contracts.ts';
import { AssortmentSetPurchaseCompositionResolutionSchema } from './set-purchase-composition.ts';
import type {
  AssortmentEvaluatedConstituent,
  AssortmentSetPurchaseCompositionResolution,
} from './set-purchase-composition.ts';

const SuccessfulDecisionSchema = Schema.Struct({
  evidence: AssortmentDecisionEvidenceSchema,
  outcome: Schema.Literals(['ELIGIBLE', 'INELIGIBLE']),
});

const SuccessfulAttemptInputSchema = Schema.Struct({
  decision: SuccessfulDecisionSchema,
  request: AssortmentDecisionRequestSchema,
  setResolution: Schema.optionalKey(AssortmentSetPurchaseCompositionResolutionSchema),
});
const SuccessfulAttemptInputTypeSchema = Schema.toType(SuccessfulAttemptInputSchema);

export const AssortmentSuccessfulAttemptDecisionEvidenceSchema = SuccessfulAttemptInputSchema;
export type AssortmentSuccessfulAttemptDecisionEvidence = typeof SuccessfulAttemptInputSchema.Type;

export class AssortmentDecisionEvidenceConstructionError extends Schema.TaggedError<AssortmentDecisionEvidenceConstructionError>()(
  'AssortmentDecisionEvidenceConstructionError',
  {
    code: Schema.Literal('INVALID_DECISION_EVIDENCE'),
    reason: Schema.String,
  },
) {}

interface ResourceRefLike {
  readonly moduleId: string;
  readonly resourceId: string;
  readonly resourceType: string;
  readonly tenantId: string;
}

const resourceRefEquals = (left: ResourceRefLike, right: ResourceRefLike): boolean =>
  left.moduleId === right.moduleId &&
  left.resourceId === right.resourceId &&
  left.resourceType === right.resourceType &&
  left.tenantId === right.tenantId;

const selectionEquivalence = Schema.toEquivalence(AssortmentCatalogSelectionSchema);
const subjectEquivalence = Schema.toEquivalence(AssortmentDecisionSubjectSchema);
const contextEquivalence = Schema.toEquivalence(AssortmentTrustedCommerceContextSchema);
const compositionEquivalence = Schema.toEquivalence(AssortmentSetPurchaseCompositionSchema);
const decisionEvidenceEquivalence = Schema.toEquivalence(AssortmentDecisionEvidenceSchema);
const revisionEquivalence = Schema.toEquivalence(AssortmentRevisionReferenceSchema);
const completenessEquivalence = Schema.toEquivalence(AssortmentSetCompletenessEvidenceSchema);

const sourceReference = (reference: {
  readonly evidenceRef: ResourceRefLike;
  readonly sourceRevision?: { readonly sourceRef: ResourceRefLike };
}): readonly ResourceRefLike[] => [
  reference.evidenceRef,
  ...(reference.sourceRevision === undefined ? [] : [reference.sourceRevision.sourceRef]),
];

const selectionReferences = (selection: AssortmentCatalogSelection): readonly ResourceRefLike[] => [
  selection.productRef,
  selection.variantRef,
  ...(selection.configuration.kind === 'CONFIGURED' ? [selection.configuration.definitionRevision.sourceRef] : []),
  ...(selection.packageOption === undefined
    ? []
    : [selection.packageOption.packageOptionRef, selection.packageOption.contentRevision.sourceRef]),
  ...(selection.variantKind === 'SET' ? [selection.setCompositionRevision.sourceRef] : []),
];

const selectorReferences = (selector: AssortmentCandidate['selector']): readonly ResourceRefLike[] => {
  if (selector.kind === 'ALL') {
    return [];
  }
  if (selector.kind === 'CATEGORY') {
    return [selector.categoryRef];
  }
  if (selector.kind === 'PRODUCT') {
    return [selector.productRef];
  }
  if (selector.kind === 'VARIANT') {
    return [selector.variantRef];
  }
  return [selector.packageOptionRef];
};

const commercialScopeReferences = (scope: AssortmentCommercialScope): readonly ResourceRefLike[] => [
  scope.channelRef,
  scope.sellingLegalEntityRef,
  ...(scope.commerceMarketRef === undefined ? [] : [scope.commerceMarketRef]),
  ...(scope.storefrontRef === undefined ? [] : [scope.storefrontRef]),
];

const subjectReferences = (
  subject: AssortmentDecisionEvidence['subject'] | AssortmentPurchasingSubject,
): readonly ResourceRefLike[] => {
  if (subject.kind === 'GUEST_PURCHASE_CONTEXT') {
    return sourceReference(subject.guestEvidence);
  }
  if (subject.kind === 'IDENTIFIED') {
    return subjectReferences(subject.subject);
  }
  return [subject.kind === 'RETAIL_CUSTOMER_PROFILE' ? subject.profileRef : subject.counterpartyRef];
};

const audienceReferences = (candidate: AssortmentCandidate): readonly ResourceRefLike[] => {
  if (candidate.audience.kind === 'COMMERCE_CUSTOMER_GROUP') {
    return [candidate.audience.groupRef];
  }
  if (candidate.audience.kind === 'SUBJECT') {
    return [
      candidate.audience.subject.kind === 'RETAIL_CUSTOMER_PROFILE'
        ? candidate.audience.subject.profileRef
        : candidate.audience.subject.counterpartyRef,
    ];
  }
  return [];
};

const candidateReferences = (candidate: AssortmentCandidate): readonly ResourceRefLike[] => [
  candidate.bindingRef,
  candidate.ruleRevision.sourceRef,
  ...commercialScopeReferences(candidate.commercialScope),
  ...audienceReferences(candidate),
  ...selectorReferences(candidate.selector),
  ...(candidate.stableRuleRef === undefined ? [] : [candidate.stableRuleRef]),
];

const boundaryReferences = (evidence: AssortmentDecisionEvidence): readonly ResourceRefLike[] => {
  const { boundaryPath } = evidence;
  if (boundaryPath === undefined) {
    return [];
  }
  let boundaries: readonly AssortmentClosedBoundary[];
  if (boundaryPath.kind === 'UNIQUE_MAXIMAL_BOUNDARY') {
    boundaries = [boundaryPath.boundary];
  } else if (boundaryPath.kind === 'BOUNDARY_CONFIGURATION_CONFLICT') {
    const { boundaries: conflictBoundaries } = boundaryPath;
    boundaries = conflictBoundaries;
  } else {
    boundaries = [];
  }
  return boundaries.flatMap((boundary) => [
    boundary.boundaryRef,
    ...commercialScopeReferences(boundary.commercialScope),
    ...subjectReferences(boundary.subject),
    ...boundary.admissionSet.flatMap(selectorReferences),
  ]);
};

const evidenceReferences = (evidence: AssortmentDecisionEvidence): readonly ResourceRefLike[] => [
  ...commercialScopeReferences(evidence.trustedContext),
  ...subjectReferences(evidence.subject),
  ...(evidence.target.kind === 'PRODUCT'
    ? [evidence.target.productRef]
    : selectionReferences(evidence.target.selection)),
  ...evidence.factCurrentness.flatMap((currentness) => [currentness.factRef, ...sourceReference(currentness.proof)]),
  ...evidence.setCompleteness.flatMap((completeness) => sourceReference(completeness.proof)),
  ...(evidence.candidates ?? []).flatMap(candidateReferences),
  ...boundaryReferences(evidence),
];

const resolutionReferences = (
  resolution: AssortmentSetPurchaseCompositionResolution | undefined,
): readonly ResourceRefLike[] => {
  if (resolution === undefined || !('evidence' in resolution)) {
    return [];
  }
  return [
    ...resolution.evidence.composition.requiredComponents.flatMap((component) =>
      selectionReferences(component.catalogSelection),
    ),
    ...sourceReference(resolution.evidence.compositionSource.source),
    ...resolution.evidence.evaluated.flatMap((item) =>
      item.decision.evidence === undefined ? [] : evidenceReferences(item.decision.evidence),
    ),
  ];
};

const sameTenant = (tenantId: string, references: readonly ResourceRefLike[]): boolean =>
  references.every((reference) => reference.tenantId === tenantId);

const scopeApplies = (
  scope: AssortmentCommercialScope,
  context: AssortmentDecisionEvidence['trustedContext'],
): boolean =>
  resourceRefEquals(scope.channelRef, context.channelRef) &&
  resourceRefEquals(scope.sellingLegalEntityRef, context.sellingLegalEntityRef) &&
  (scope.commerceMarketRef === undefined ||
    (context.commerceMarketRef !== undefined &&
      resourceRefEquals(scope.commerceMarketRef, context.commerceMarketRef))) &&
  (scope.storefrontRef === undefined ||
    (context.storefrontRef !== undefined && resourceRefEquals(scope.storefrontRef, context.storefrontRef)));

const selectorMatches = (candidate: AssortmentCandidate, evidence: AssortmentDecisionEvidence): boolean => {
  const { target } = evidence;
  if (candidate.selector.kind === 'ALL' || candidate.selector.kind === 'CATEGORY') {
    return true;
  }
  if (candidate.selector.kind === 'PRODUCT') {
    return target.kind === 'PRODUCT'
      ? resourceRefEquals(candidate.selector.productRef, target.productRef)
      : resourceRefEquals(candidate.selector.productRef, target.selection.productRef);
  }
  if (target.kind !== 'CATALOG_SELECTION') {
    return false;
  }
  if (candidate.selector.kind === 'VARIANT') {
    return resourceRefEquals(candidate.selector.variantRef, target.selection.variantRef);
  }
  return (
    target.selection.packageOption !== undefined &&
    resourceRefEquals(candidate.selector.packageOptionRef, target.selection.packageOption.packageOptionRef)
  );
};

const candidateFactsAreCurrent = (candidate: AssortmentCandidate, evidence: AssortmentDecisionEvidence): boolean =>
  [candidate.bindingRef, candidate.ruleRevision.sourceRef].every((factRef) =>
    evidence.factCurrentness.some(
      (currentness) => currentness.state === 'CURRENT' && resourceRefEquals(currentness.factRef, factRef),
    ),
  );

const boundaryCompletenessIsRetained = (evidence: AssortmentDecisionEvidence): boolean => {
  const { boundaryPath } = evidence;
  if (boundaryPath === undefined) {
    return true;
  }
  return evidence.setCompleteness.some((item) => completenessEquivalence(item, boundaryPath.completeness));
};

const candidatePathIsValid = (evidence: AssortmentDecisionEvidence): boolean => {
  const boundary = evidence.boundaryPath;
  if (boundary?.kind === 'BOUNDARY_CONFIGURATION_CONFLICT') {
    return false;
  }
  if (boundary?.kind === 'UNIQUE_MAXIMAL_BOUNDARY' && !boundary.admitted) {
    return evidence.candidates === undefined;
  }
  if (evidence.candidates === undefined || evidence.candidates.length === 0) {
    return false;
  }
  const candidateMeanings = new Set<string>();
  for (const candidate of evidence.candidates) {
    const meaning = [
      candidate.bindingRef.resourceId,
      candidate.ruleRevision.sourceRef.resourceId,
      candidate.decisionPurpose,
      candidate.effect,
    ].join('|');
    if (candidateMeanings.has(meaning)) {
      return false;
    }
    candidateMeanings.add(meaning);
    const expectedPurpose = evidence.target.kind === 'PRODUCT' ? 'VISIBILITY' : 'PURCHASE';
    if (
      candidate.decisionPurpose !== expectedPurpose ||
      !scopeApplies(candidate.commercialScope, evidence.trustedContext) ||
      !selectorMatches(candidate, evidence) ||
      !candidateFactsAreCurrent(candidate, evidence)
    ) {
      return false;
    }
  }
  return evidence.factCurrentness.length > 0;
};

const proofSetIsComplete = (evidence: AssortmentDecisionEvidence): boolean =>
  evidence.setCompleteness.length > 0 &&
  evidence.setCompleteness.every((proof) => proof.state === 'COMPLETE') &&
  evidence.factCurrentness.every((fact) => fact.state === 'CURRENT');

export const assortmentDecisionMatchesRequest = (
  request: AssortmentDecisionRequest,
  decision: AssortmentGovernedDecision,
): boolean => {
  if (decision.evidence === undefined) {
    return false;
  }
  const { evidence } = decision;
  const targetMatches =
    request.decisionPurpose === 'VISIBILITY'
      ? evidence.target.kind === 'PRODUCT' && resourceRefEquals(evidence.target.productRef, request.productRef)
      : evidence.target.kind === 'CATALOG_SELECTION' &&
        selectionEquivalence(evidence.target.selection, request.constituent.catalogSelection);
  return (
    targetMatches &&
    subjectEquivalence(evidence.subject, request.subject) &&
    contextEquivalence(evidence.trustedContext, request.trustedContext) &&
    DateTime.toEpochMillis(evidence.operationTime) === DateTime.toEpochMillis(request.trustedContext.operationTime)
  );
};

const constituentProofMatchesRequest = (
  request: AssortmentPurchaseRequest,
  item: AssortmentEvaluatedConstituent,
  outcome: 'ELIGIBLE' | 'INELIGIBLE',
): boolean => {
  const { evidence } = item.decision;
  const constituentRequest: AssortmentPurchaseRequest = {
    constituent: item.constituent,
    decisionPurpose: 'PURCHASE',
    subject: request.subject,
    trustedContext: request.trustedContext,
  };
  if (item.decision.outcome === 'INDETERMINATE') {
    return (
      outcome === 'INELIGIBLE' &&
      (evidence === undefined || assortmentDecisionMatchesRequest(constituentRequest, item.decision))
    );
  }
  return (
    assortmentDecisionMatchesRequest(constituentRequest, item.decision) &&
    evidence !== undefined &&
    proofSetIsComplete(evidence) &&
    boundaryCompletenessIsRetained(evidence) &&
    candidatePathIsValid(evidence)
  );
};

const sameConstituent = (
  left: AssortmentEvaluatedConstituent['constituent'],
  right: AssortmentEvaluatedConstituent['constituent'],
): boolean => left.role === right.role && selectionEquivalence(left.catalogSelection, right.catalogSelection);

const summaryRetainsRootEvidence = (
  summary: AssortmentDecisionEvidence,
  rootEvidence: AssortmentDecisionEvidence | undefined,
): boolean =>
  rootEvidence === undefined
    ? summary.candidates === undefined &&
      summary.boundaryPath === undefined &&
      summary.factCurrentness.length === 0 &&
      summary.setCompleteness.length === 0
    : decisionEvidenceEquivalence(summary, rootEvidence);

const setResolutionMatchesRequest = (
  request: AssortmentPurchaseRequest,
  resolution: AssortmentSetPurchaseCompositionResolution,
  decision: typeof SuccessfulDecisionSchema.Type,
): boolean => {
  const { outcome } = decision;
  if (request.constituent.catalogSelection.variantKind !== 'SET' || request.setComposition === undefined) {
    return false;
  }
  if (resolution.kind === 'INDETERMINATE' || resolution.kind !== outcome) {
    return false;
  }
  const { compositionSource } = resolution.evidence;
  const revision = request.setComposition.setCompositionRevision;
  if (
    !compositionEquivalence(resolution.evidence.composition, request.setComposition) ||
    !compositionEquivalence(compositionSource.composition, request.setComposition) ||
    compositionSource.source.ownerModuleId !== revision.ownerModuleId ||
    compositionSource.source.evidenceRef.moduleId !== revision.sourceRef.moduleId ||
    compositionSource.source.sourceRevision === undefined ||
    !revisionEquivalence(compositionSource.source.sourceRevision, revision)
  ) {
    return false;
  }
  const { requiredComponents } = request.setComposition;
  const expected = [request.constituent, ...requiredComponents];
  const { evaluated } = resolution.evidence;
  const evaluatedRoot = evaluated.find(
    (item) =>
      item.constituent.role === 'TOP_LEVEL' &&
      selectionEquivalence(item.constituent.catalogSelection, request.constituent.catalogSelection),
  );
  const rootEvidence = evaluatedRoot?.decision.evidence;
  // Retain an actual root path, or only summary identity when it was unknown
  // without evidence or never evaluated. Do not invent a successful root path.
  if (!summaryRetainsRootEvidence(decision.evidence, rootEvidence)) {
    return false;
  }

  if (
    !evaluated.every(
      (item, index) =>
        expected.some((candidate) => sameConstituent(candidate, item.constituent)) &&
        !evaluated.slice(0, index).some((other) => sameConstituent(other.constituent, item.constituent)) &&
        constituentProofMatchesRequest(request, item, outcome),
    )
  ) {
    return false;
  }
  return (
    evaluated.length > 0 &&
    composeAssortmentPurchaseOutcome(
      evaluated.map((item) => ({
        constituent: item.constituent,
        outcome: item.decision.outcome,
      })),
    ) === outcome &&
    (outcome === 'ELIGIBLE'
      ? evaluated.length === expected.length
      : evaluated.some((item) => item.decision.outcome === 'INELIGIBLE'))
  );
};

const deeplyFreeze = <Value extends object>(value: Value): void => {
  if (Object.isFrozen(value)) {
    return;
  }
  for (const nested of Object.values(value)) {
    if (Predicate.isObjectOrArray(nested)) {
      deeplyFreeze(nested);
    }
  }
  Object.freeze(value);
};

const invalid = (reason: string): Effect.Effect<never, AssortmentDecisionEvidenceConstructionError> =>
  Effect.fail(
    new AssortmentDecisionEvidenceConstructionError({
      code: 'INVALID_DECISION_EVIDENCE',
      reason,
    }),
  );

/** Build immutable owner-local evidence for one fully successful authoritative attempt. */
export const constructAssortmentSuccessfulAttemptEvidence = Effect.fn(
  'AssortmentDecisionEvidence.constructSuccessfulAttempt',
)(function* constructSuccessfulAttempt(
  input: AssortmentSuccessfulAttemptDecisionEvidence,
): Effect.fn.Return<AssortmentSuccessfulAttemptDecisionEvidence, AssortmentDecisionEvidenceConstructionError> {
  if (!Schema.is(SuccessfulAttemptInputTypeSchema)(input)) {
    return yield* invalid('successful-attempt evidence input is not schema-valid');
  }
  const { decision, request } = input;
  if (!assortmentDecisionMatchesRequest(request, decision)) {
    return yield* invalid('decision evidence does not match the exact request');
  }
  const references = [...evidenceReferences(decision.evidence), ...resolutionReferences(input.setResolution)];
  if (!sameTenant(request.trustedContext.tenantId, references)) {
    return yield* invalid('decision evidence contains a cross-tenant reference');
  }
  // A composed deny is proved by its known constituent, even if the root was
  // unknown or was never evaluated. Each known path is validated below.
  if (input.setResolution === undefined) {
    if (!proofSetIsComplete(decision.evidence) || !boundaryCompletenessIsRetained(decision.evidence)) {
      return yield* invalid('successful decision is missing current fact or complete set proof evidence');
    }
    if (!candidatePathIsValid(decision.evidence)) {
      return yield* invalid('ordinary Candidate evidence is not an exact applicable Current path');
    }
  }
  if (request.decisionPurpose === 'VISIBILITY') {
    if (input.setResolution !== undefined || !Schema.is(AssortmentVisibilityRequestSchema)(request)) {
      return yield* invalid('VISIBILITY evidence cannot carry Set composition');
    }
  } else {
    if (!Schema.is(AssortmentPurchaseRequestSchema)(request)) {
      return yield* invalid('PURCHASE evidence request is invalid');
    }
    const isSet = request.constituent.catalogSelection.variantKind === 'SET';
    if (isSet !== (input.setResolution !== undefined)) {
      return yield* invalid('Set PURCHASE evidence must carry exactly one pinned composition resolution');
    }
    if (
      isSet &&
      input.setResolution !== undefined &&
      !setResolutionMatchesRequest(request, input.setResolution, decision)
    ) {
      return yield* invalid('Set evidence does not contain the exact pinned and evaluated constituents');
    }
  }
  deeplyFreeze(input);
  return input;
});
