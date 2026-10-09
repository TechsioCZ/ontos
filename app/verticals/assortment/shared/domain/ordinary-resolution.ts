import { DateTime, Option, Schema } from 'effect';

import {
  AssortmentCandidateSchema,
  AssortmentCatalogSelectionSchema,
  AssortmentCommercialScopeSchema,
  AssortmentConfigurationConflictError,
  AssortmentDecisionPurposeSchema,
  AssortmentDecisionSubjectSchema,
  AssortmentFactCurrentnessEvidenceSchema,
  AssortmentMissingConfigurationError,
  AssortmentSetCompletenessEvidenceSchema,
  AssortmentTenantIdSchema,
  AssortmentTrustedCommerceContextSchema,
  CatalogProductRefSchema,
} from './decision-contracts.ts';
import type {
  AssortmentCandidate,
  AssortmentCatalogSelection,
  AssortmentCommercialScope,
  AssortmentDecisionPurpose,
  AssortmentDecisionSubject,
  AssortmentFactCurrentnessEvidence,
  AssortmentEvidenceReference,
  AssortmentPurchasingSubject,
  AssortmentTrustedCommerceContext,
} from './decision-contracts.ts';
import {
  AssortmentCategoryClassificationSchema,
  AssortmentCommerceMembershipPredicate,
  AssortmentCommerceMembershipScopeTokenJsonSchema,
  AssortmentCustomerGroupMembershipSetSchema,
} from './ports/owner-evidence.ts';
import type { AssortmentCategoryClassification, AssortmentCustomerGroupMembershipSet } from './ports/owner-evidence.ts';

const InstantSchema = Schema.DateTimeUtcFromString;
const OrdinaryCompletenessPredicate =
  'all current Candidate-producing bindings and immutable revisions for this exact decision';
const OrdinaryCompletenessScope = 'commerce.assortment.ordinary-candidates';
const CategoryCompletenessPredicate = 'all current Catalog classifications and ancestry for the exact product';
const CategoryCompletenessScope = 'catalog.category-classification';
const MembershipCompletenessPredicate = 'all current customer-group memberships';
const MembershipCompletenessScope = 'customer-context.memberships';

type ResourceRefLike = Readonly<{
  readonly moduleId: string;
  readonly resourceId: string;
  readonly resourceType: string;
  readonly tenantId: string;
}>;

const OrdinaryTargetSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('PRODUCT'), productRef: CatalogProductRefSchema }),
  Schema.Struct({ kind: Schema.Literal('CATALOG_SELECTION'), selection: AssortmentCatalogSelectionSchema }),
]);
type OrdinaryTarget = typeof OrdinaryTargetSchema.Type;

const OrdinaryCompletenessScopeSchema = Schema.Struct({
  commercialScope: AssortmentCommercialScopeSchema,
  decisionPurpose: AssortmentDecisionPurposeSchema,
  kind: Schema.Literal('ORDINARY_CANDIDATES'),
  operationTime: InstantSchema,
  subject: AssortmentDecisionSubjectSchema,
  target: OrdinaryTargetSchema,
  tenantId: AssortmentTenantIdSchema,
});

/** A typed proof that the supplied Candidate-producing state is complete for this exact decision. */
export const AssortmentOrdinaryCompletenessEvidenceSchema = Schema.Struct({
  evidence: AssortmentSetCompletenessEvidenceSchema,
  scope: OrdinaryCompletenessScopeSchema,
});

export const AssortmentOrdinaryResolutionInputSchema = Schema.Struct({
  candidates: Schema.Array(AssortmentCandidateSchema),
  categoryClassification: Schema.optionalKey(AssortmentCategoryClassificationSchema),
  completeness: AssortmentOrdinaryCompletenessEvidenceSchema,
  decisionPurpose: AssortmentDecisionPurposeSchema,
  factCurrentness: Schema.Array(AssortmentFactCurrentnessEvidenceSchema),
  memberships: Schema.optionalKey(AssortmentCustomerGroupMembershipSetSchema),
  subject: AssortmentDecisionSubjectSchema,
  target: OrdinaryTargetSchema,
  tenantId: AssortmentTenantIdSchema,
  trustedContext: AssortmentTrustedCommerceContextSchema,
});
export type AssortmentOrdinaryResolutionInput = typeof AssortmentOrdinaryResolutionInputSchema.Type;

const AssortmentOrdinaryResolutionIndeterminateSchema = Schema.Struct({
  kind: Schema.Literal('INDETERMINATE'),
  reason: Schema.Literals([
    'CANDIDATE_SET_INCOMPLETE',
    'CATEGORY_SET_INCOMPLETE',
    'CROSS_TENANT_INPUT',
    'FACT_CURRENTNESS_UNCERTAIN',
    'INVALID_ORDINARY_INPUT',
    'MEMBERSHIP_SET_INCOMPLETE',
    'PURPOSE_TARGET_MISMATCH',
  ]),
});
export type AssortmentOrdinaryResolutionIndeterminate = typeof AssortmentOrdinaryResolutionIndeterminateSchema.Type;

export const AssortmentOrdinaryResolutionEvidenceSchema = Schema.Struct({
  candidates: Schema.Array(AssortmentCandidateSchema),
  completeness: AssortmentSetCompletenessEvidenceSchema,
  factCurrentness: Schema.Array(AssortmentFactCurrentnessEvidenceSchema),
  maximalCandidates: Schema.Array(AssortmentCandidateSchema),
});
export type AssortmentOrdinaryResolutionEvidence = typeof AssortmentOrdinaryResolutionEvidenceSchema.Type;

const AssortmentOrdinaryResolutionResolvedSchema = Schema.Struct({
  evidence: AssortmentOrdinaryResolutionEvidenceSchema,
  kind: Schema.Literal('RESOLVED'),
  outcome: Schema.Literals(['ELIGIBLE', 'INELIGIBLE']),
});
const AssortmentOrdinaryResolutionConflictSchema = Schema.Struct({
  evidence: AssortmentOrdinaryResolutionEvidenceSchema,
  failure: AssortmentConfigurationConflictError,
  kind: Schema.Literal('CONFIGURATION_CONFLICT'),
});
const AssortmentOrdinaryResolutionMissingSchema = Schema.Struct({
  evidence: AssortmentOrdinaryResolutionEvidenceSchema,
  failure: AssortmentMissingConfigurationError,
  kind: Schema.Literal('MISSING_CONFIGURATION'),
});

export const AssortmentOrdinaryResolutionSchema = Schema.Union([
  AssortmentOrdinaryResolutionResolvedSchema,
  AssortmentOrdinaryResolutionConflictSchema,
  AssortmentOrdinaryResolutionMissingSchema,
  AssortmentOrdinaryResolutionIndeterminateSchema,
]);
export type AssortmentOrdinaryResolution = typeof AssortmentOrdinaryResolutionSchema.Type;

const refEquals = (left: ResourceRefLike, right: ResourceRefLike): boolean =>
  left.moduleId === right.moduleId &&
  left.resourceId === right.resourceId &&
  left.resourceType === right.resourceType &&
  left.tenantId === right.tenantId;

const subjectRef = (subject: AssortmentPurchasingSubject): ResourceRefLike =>
  subject.kind === 'RETAIL_CUSTOMER_PROFILE' ? subject.profileRef : subject.counterpartyRef;

const targetProductRef = (target: OrdinaryTarget): ResourceRefLike =>
  target.kind === 'PRODUCT' ? target.productRef : target.selection.productRef;

const targetSelection = (target: OrdinaryTarget): AssortmentCatalogSelection | undefined =>
  target.kind === 'CATALOG_SELECTION' ? target.selection : undefined;

const targetReferences = (target: OrdinaryTarget): readonly ResourceRefLike[] => {
  const selection = targetSelection(target);
  return [
    targetProductRef(target),
    ...(selection === undefined ? [] : [selection.variantRef]),
    ...(selection?.packageOption === undefined ? [] : [selection.packageOption.packageOptionRef]),
    ...(selection?.packageOption === undefined ? [] : [selection.packageOption.contentRevision.sourceRef]),
    ...(selection?.configuration.kind === 'CONFIGURED' ? [selection.configuration.definitionRevision.sourceRef] : []),
    ...(selection?.variantKind === 'SET' ? [selection.setCompositionRevision.sourceRef] : []),
  ];
};

const contextReferences = (context: AssortmentTrustedCommerceContext): readonly ResourceRefLike[] => [
  context.channelRef,
  context.sellingLegalEntityRef,
  ...(context.commerceMarketRef === undefined ? [] : [context.commerceMarketRef]),
  ...(context.storefrontRef === undefined ? [] : [context.storefrontRef]),
];

const selectorReferences = (candidate: AssortmentCandidate): readonly ResourceRefLike[] => {
  const { selector } = candidate;
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

const candidateReferences = (candidate: AssortmentCandidate): readonly ResourceRefLike[] => [
  candidate.bindingRef,
  candidate.ruleRevision.sourceRef,
  candidate.commercialScope.channelRef,
  candidate.commercialScope.sellingLegalEntityRef,
  ...(candidate.commercialScope.commerceMarketRef === undefined ? [] : [candidate.commercialScope.commerceMarketRef]),
  ...(candidate.commercialScope.storefrontRef === undefined ? [] : [candidate.commercialScope.storefrontRef]),
  ...(candidate.audience.kind === 'COMMERCE_CUSTOMER_GROUP' ? [candidate.audience.groupRef] : []),
  ...(candidate.audience.kind === 'SUBJECT' ? [subjectRef(candidate.audience.subject)] : []),
  ...selectorReferences(candidate),
  ...(candidate.stableRuleRef === undefined ? [] : [candidate.stableRuleRef]),
];

const completenessReferences = (input: AssortmentOrdinaryResolutionInput): readonly ResourceRefLike[] => [
  input.completeness.scope.commercialScope.channelRef,
  input.completeness.scope.commercialScope.sellingLegalEntityRef,
  ...(input.completeness.scope.commercialScope.commerceMarketRef === undefined
    ? []
    : [input.completeness.scope.commercialScope.commerceMarketRef]),
  ...(input.completeness.scope.commercialScope.storefrontRef === undefined
    ? []
    : [input.completeness.scope.commercialScope.storefrontRef]),
  input.completeness.evidence.proof.evidenceRef,
  ...(input.completeness.evidence.proof.sourceRevision === undefined
    ? []
    : [input.completeness.evidence.proof.sourceRevision.sourceRef]),
];

const subjectRefFromDecisionSubject = (subject: AssortmentDecisionSubject): ResourceRefLike => {
  if (subject.kind === 'GUEST_PURCHASE_CONTEXT') {
    return subject.guestEvidence.evidenceRef;
  }
  return subjectRef(subject.subject);
};

const allInputReferences = (input: AssortmentOrdinaryResolutionInput): readonly ResourceRefLike[] => [
  ...contextReferences(input.trustedContext),
  subjectRefFromDecisionSubject(input.subject),
  ...targetReferences(input.target),
  ...completenessReferences(input),
  ...input.candidates.flatMap(candidateReferences),
  ...input.factCurrentness.flatMap((currentness) => [
    currentness.factRef,
    currentness.proof.evidenceRef,
    ...(currentness.proof.sourceRevision === undefined ? [] : [currentness.proof.sourceRevision.sourceRef]),
  ]),
  ...(input.categoryClassification === undefined
    ? []
    : [
        input.categoryClassification.productRef,
        ...input.categoryClassification.classifications,
        ...input.categoryClassification.ancestries.flatMap((ancestry) => [ancestry.categoryRef, ...ancestry.ancestors]),
        input.categoryClassification.completeness.proof.evidenceRef,
        ...(input.categoryClassification.completeness.proof.sourceRevision === undefined
          ? []
          : [input.categoryClassification.completeness.proof.sourceRevision.sourceRef]),
        ...input.categoryClassification.currentness.flatMap((currentness) => [
          currentness.factRef,
          currentness.proof.evidenceRef,
          ...(currentness.proof.sourceRevision === undefined ? [] : [currentness.proof.sourceRevision.sourceRef]),
        ]),
      ]),
  ...(input.memberships === undefined
    ? []
    : [
        input.memberships.profileRef,
        ...input.memberships.items.flatMap((membership) => [
          membership.groupRef,
          membership.membershipRef,
          membership.profileRef,
        ]),
        input.memberships.completeness.proof.evidenceRef,
        ...(input.memberships.completeness.proof.sourceRevision === undefined
          ? []
          : [input.memberships.completeness.proof.sourceRevision.sourceRef]),
      ]),
];

const hasOneTenant = (tenantId: string, references: readonly ResourceRefLike[]): boolean =>
  references.every((reference) => reference.tenantId === tenantId);

const scopesEqual = (left: AssortmentCommercialScope, right: AssortmentCommercialScope): boolean =>
  refEquals(left.channelRef, right.channelRef) &&
  refEquals(left.sellingLegalEntityRef, right.sellingLegalEntityRef) &&
  (left.commerceMarketRef === undefined
    ? right.commerceMarketRef === undefined
    : right.commerceMarketRef !== undefined && refEquals(left.commerceMarketRef, right.commerceMarketRef)) &&
  (left.storefrontRef === undefined
    ? right.storefrontRef === undefined
    : right.storefrontRef !== undefined && refEquals(left.storefrontRef, right.storefrontRef));

const scopeApplies = (scope: AssortmentCommercialScope, context: AssortmentTrustedCommerceContext): boolean =>
  refEquals(scope.channelRef, context.channelRef) &&
  refEquals(scope.sellingLegalEntityRef, context.sellingLegalEntityRef) &&
  (scope.commerceMarketRef === undefined ||
    (context.commerceMarketRef !== undefined && refEquals(scope.commerceMarketRef, context.commerceMarketRef))) &&
  (scope.storefrontRef === undefined ||
    (context.storefrontRef !== undefined && refEquals(scope.storefrontRef, context.storefrontRef)));

const scopeIsStrictlyNarrower = (narrower: AssortmentCommercialScope, broader: AssortmentCommercialScope): boolean => {
  if (
    !refEquals(narrower.channelRef, broader.channelRef) ||
    !refEquals(narrower.sellingLegalEntityRef, broader.sellingLegalEntityRef)
  ) {
    return false;
  }
  const compatible =
    (broader.commerceMarketRef === undefined ||
      (narrower.commerceMarketRef !== undefined && refEquals(narrower.commerceMarketRef, broader.commerceMarketRef))) &&
    (broader.storefrontRef === undefined ||
      (narrower.storefrontRef !== undefined && refEquals(narrower.storefrontRef, broader.storefrontRef)));
  const addsMarket = broader.commerceMarketRef === undefined && narrower.commerceMarketRef !== undefined;
  const addsStorefront = broader.storefrontRef === undefined && narrower.storefrontRef !== undefined;
  return compatible && (addsMarket || addsStorefront);
};

const catalogSelectorMatches = (
  selector: AssortmentCandidate['selector'],
  target: OrdinaryTarget,
  categoryClassification: AssortmentCategoryClassification | undefined,
): boolean => {
  if (selector.kind === 'ALL') {
    return true;
  }
  if (selector.kind === 'PRODUCT') {
    return refEquals(selector.productRef, targetProductRef(target));
  }
  if (selector.kind === 'CATEGORY') {
    if (categoryClassification === undefined) {
      return false;
    }
    const categories = [
      ...categoryClassification.classifications,
      ...categoryClassification.ancestries.flatMap((ancestry) => [ancestry.categoryRef, ...ancestry.ancestors]),
    ];
    return categories.some((category) => refEquals(category, selector.categoryRef));
  }
  const selection = targetSelection(target);
  if (selection === undefined) {
    return false;
  }
  if (selector.kind === 'VARIANT') {
    return refEquals(selector.variantRef, selection.variantRef);
  }
  return (
    selection.packageOption !== undefined &&
    refEquals(selector.packageOptionRef, selection.packageOption.packageOptionRef)
  );
};

const membershipCompletenessMatches = (
  memberships: AssortmentCustomerGroupMembershipSet,
  sellingLegalEntityId: string,
): boolean => {
  if (memberships.completeness.predicate === MembershipCompletenessPredicate) {
    return memberships.completeness.scope === MembershipCompletenessScope;
  }
  if (memberships.completeness.predicate !== AssortmentCommerceMembershipPredicate) {
    return false;
  }
  const token = Schema.decodeOption(AssortmentCommerceMembershipScopeTokenJsonSchema, {
    onExcessProperty: 'error',
  })(memberships.completeness.scope);
  return (
    Option.isSome(token) &&
    token.value.legalEntityId === sellingLegalEntityId &&
    token.value.proof.itemCount === memberships.items.length &&
    memberships.items.every((membership) => membership.state === 'VALID') &&
    new Set(memberships.items.map((membership) => membership.membershipRef.resourceId)).size ===
      memberships.items.length &&
    refEquals(memberships.completeness.proof.evidenceRef, memberships.profileRef)
  );
};

const groupMembershipsAreComplete = (
  memberships: AssortmentCustomerGroupMembershipSet | undefined,
  subject: AssortmentDecisionSubject,
  operationTime: DateTime.Utc,
  sellingLegalEntityId: string,
): boolean => {
  if (
    memberships === undefined ||
    subject.kind !== 'IDENTIFIED' ||
    subject.subject.kind !== 'RETAIL_CUSTOMER_PROFILE'
  ) {
    return false;
  }
  return (
    memberships.completeness.state === 'COMPLETE' &&
    membershipCompletenessMatches(memberships, sellingLegalEntityId) &&
    memberships.completeness.proof.ownerModuleId === memberships.profileRef.moduleId &&
    refEquals(memberships.profileRef, subject.subject.profileRef) &&
    DateTime.toEpochMillis(memberships.asOf) === DateTime.toEpochMillis(operationTime)
  );
};

const audienceMatches = (
  audience: AssortmentCandidate['audience'],
  input: AssortmentOrdinaryResolutionInput,
  memberships: AssortmentCustomerGroupMembershipSet | undefined,
): boolean => {
  if (audience.kind === 'SHARED') {
    return true;
  }
  if (input.subject.kind !== 'IDENTIFIED') {
    return false;
  }
  if (audience.kind === 'SUBJECT') {
    return refEquals(subjectRef(audience.subject), subjectRef(input.subject.subject));
  }
  if (
    !groupMembershipsAreComplete(
      memberships,
      input.subject,
      input.trustedContext.operationTime,
      input.trustedContext.sellingLegalEntityRef.resourceId,
    )
  ) {
    return false;
  }
  if (memberships === undefined) {
    return false;
  }
  return memberships.items.some(
    (membership) =>
      membership.state === 'VALID' &&
      membership.groupRef.resourceId === audience.groupRef.resourceId &&
      membership.groupRef.resourceType === audience.groupRef.resourceType &&
      membership.effectiveFrom <= input.trustedContext.operationTime &&
      (membership.effectiveTo === null || input.trustedContext.operationTime < membership.effectiveTo),
  );
};

const audienceCanBeApplicable = (
  audience: AssortmentCandidate['audience'],
  input: AssortmentOrdinaryResolutionInput,
): boolean => {
  if (audience.kind === 'SHARED') {
    return true;
  }
  if (input.subject.kind !== 'IDENTIFIED') {
    return false;
  }
  if (audience.kind === 'SUBJECT') {
    return refEquals(subjectRef(audience.subject), subjectRef(input.subject.subject));
  }
  return input.subject.subject.kind === 'RETAIL_CUSTOMER_PROFILE';
};

const currentnessCovers = (
  factCurrentness: readonly AssortmentFactCurrentnessEvidence[],
  factRef: ResourceRefLike,
): boolean => factCurrentness.some((evidence) => evidence.state === 'CURRENT' && refEquals(evidence.factRef, factRef));

const candidateFactsCurrent = (
  candidate: AssortmentCandidate,
  factCurrentness: readonly AssortmentFactCurrentnessEvidence[],
): boolean =>
  currentnessCovers(factCurrentness, candidate.bindingRef) &&
  currentnessCovers(factCurrentness, candidate.ruleRevision.sourceRef);

const categoryEvidenceIsComplete = (
  classification: AssortmentCategoryClassification | undefined,
  target: OrdinaryTarget,
  tenantId: string,
): boolean =>
  classification !== undefined &&
  classification.completeness.state === 'COMPLETE' &&
  classification.completeness.predicate === CategoryCompletenessPredicate &&
  classification.completeness.scope === CategoryCompletenessScope &&
  classification.completeness.proof.ownerModuleId === classification.productRef.moduleId &&
  refEquals(classification.productRef, targetProductRef(target)) &&
  classification.productRef.tenantId === tenantId &&
  classification.currentness.every((evidence) => evidence.state === 'CURRENT');

const AxisComparisonSchema = Schema.Literals(['LESS', 'EQUAL', 'GREATER', 'INCOMPARABLE']);
type AxisComparison = typeof AxisComparisonSchema.Type;

const catalogRank = (kind: AssortmentCandidate['selector']['kind']): number => {
  if (kind === 'ALL') {
    return 0;
  }
  if (kind === 'CATEGORY') {
    return 1;
  }
  if (kind === 'PRODUCT') {
    return 2;
  }
  if (kind === 'VARIANT') {
    return 3;
  }
  return 4;
};

const categoryIsDescendant = (
  descendant: ResourceRefLike,
  ancestor: ResourceRefLike,
  classification: AssortmentCategoryClassification,
): boolean =>
  classification.ancestries.some(
    (ancestry) =>
      refEquals(ancestry.categoryRef, descendant) && ancestry.ancestors.some((item) => refEquals(item, ancestor)),
  );

const compareCatalog = (
  left: AssortmentCandidate,
  right: AssortmentCandidate,
  classification: AssortmentCategoryClassification | undefined,
): AxisComparison => {
  const leftKind = left.selector.kind;
  const rightKind = right.selector.kind;
  if (leftKind !== rightKind) {
    return catalogRank(leftKind) < catalogRank(rightKind) ? 'LESS' : 'GREATER';
  }
  if (leftKind !== 'CATEGORY' || rightKind !== 'CATEGORY') {
    return 'EQUAL';
  }
  if (refEquals(left.selector.categoryRef, right.selector.categoryRef)) {
    return 'EQUAL';
  }
  if (classification === undefined) {
    return 'INCOMPARABLE';
  }
  if (categoryIsDescendant(left.selector.categoryRef, right.selector.categoryRef, classification)) {
    return 'GREATER';
  }
  if (categoryIsDescendant(right.selector.categoryRef, left.selector.categoryRef, classification)) {
    return 'LESS';
  }
  return 'INCOMPARABLE';
};

const compareScope = (left: AssortmentCandidate, right: AssortmentCandidate): AxisComparison => {
  if (scopesEqual(left.commercialScope, right.commercialScope)) {
    return 'EQUAL';
  }
  if (scopeIsStrictlyNarrower(left.commercialScope, right.commercialScope)) {
    return 'GREATER';
  }
  if (scopeIsStrictlyNarrower(right.commercialScope, left.commercialScope)) {
    return 'LESS';
  }
  return 'INCOMPARABLE';
};

const audienceRank = (audience: AssortmentCandidate['audience']['kind']): number => {
  if (audience === 'SHARED') {
    return 0;
  }
  if (audience === 'COMMERCE_CUSTOMER_GROUP') {
    return 1;
  }
  return 2;
};

const compareAudience = (left: AssortmentCandidate, right: AssortmentCandidate): AxisComparison => {
  const leftRank = audienceRank(left.audience.kind);
  const rightRank = audienceRank(right.audience.kind);
  if (leftRank === rightRank) {
    return 'EQUAL';
  }
  return leftRank < rightRank ? 'LESS' : 'GREATER';
};

const dominates = (
  left: AssortmentCandidate,
  right: AssortmentCandidate,
  classification: AssortmentCategoryClassification | undefined,
): boolean => {
  const catalogComparison = compareCatalog(left, right, classification);
  if (catalogComparison !== 'EQUAL') {
    return catalogComparison === 'GREATER';
  }
  const scopeComparison = compareScope(left, right);
  if (scopeComparison !== 'EQUAL') {
    return scopeComparison === 'GREATER';
  }
  return compareAudience(left, right) === 'GREATER';
};

const makeEvidence = (
  input: AssortmentOrdinaryResolutionInput,
  sets: {
    readonly candidates: readonly AssortmentCandidate[];
    readonly maximalCandidates: readonly AssortmentCandidate[];
  },
): AssortmentOrdinaryResolutionEvidence => ({
  candidates: sets.candidates,
  completeness: input.completeness.evidence,
  factCurrentness: input.factCurrentness,
  maximalCandidates: sets.maximalCandidates,
});

const indeterminate = (reason: AssortmentOrdinaryResolutionIndeterminate['reason']): AssortmentOrdinaryResolution => ({
  kind: 'INDETERMINATE',
  reason,
});

const purposeTargetMatches = (purpose: AssortmentDecisionPurpose, target: OrdinaryTarget): boolean =>
  purpose === 'VISIBILITY' ? target.kind === 'PRODUCT' : target.kind === 'CATALOG_SELECTION';

const revisionReferenceEquals = (
  left: { readonly ownerModuleId: string; readonly revision: string; readonly sourceRef: ResourceRefLike },
  right: { readonly ownerModuleId: string; readonly revision: string; readonly sourceRef: ResourceRefLike },
): boolean =>
  left.ownerModuleId === right.ownerModuleId &&
  left.revision === right.revision &&
  refEquals(left.sourceRef, right.sourceRef);

const selectionEquivalence = Schema.toEquivalence(AssortmentCatalogSelectionSchema);

const targetsEqual = (left: OrdinaryTarget, right: OrdinaryTarget): boolean => {
  if (left.kind !== right.kind) {
    return false;
  }
  return left.kind === 'PRODUCT'
    ? right.kind === 'PRODUCT' && refEquals(left.productRef, right.productRef)
    : right.kind === 'CATALOG_SELECTION' && selectionEquivalence(left.selection, right.selection);
};

const evidenceReferencesEqual = (left: AssortmentEvidenceReference, right: AssortmentEvidenceReference): boolean => {
  if (left.ownerModuleId !== right.ownerModuleId || !refEquals(left.evidenceRef, right.evidenceRef)) {
    return false;
  }
  if ((left.sourceRevision === undefined) !== (right.sourceRevision === undefined)) {
    return false;
  }
  if (left.sourceRevision === undefined || right.sourceRevision === undefined) {
    return true;
  }
  return revisionReferenceEquals(left.sourceRevision, right.sourceRevision);
};

const completenessIsForInput = (input: AssortmentOrdinaryResolutionInput): boolean => {
  const { evidence, scope } = input.completeness;
  const { proof } = evidence;
  const subjectMatches = (() => {
    if (scope.subject.kind !== input.subject.kind) {
      return false;
    }
    if (scope.subject.kind === 'GUEST_PURCHASE_CONTEXT') {
      return (
        input.subject.kind === 'GUEST_PURCHASE_CONTEXT' &&
        evidenceReferencesEqual(scope.subject.guestEvidence, input.subject.guestEvidence)
      );
    }
    return (
      input.subject.kind === 'IDENTIFIED' &&
      refEquals(subjectRef(scope.subject.subject), subjectRef(input.subject.subject))
    );
  })();
  return (
    scope.kind === 'ORDINARY_CANDIDATES' &&
    evidence.predicate === OrdinaryCompletenessPredicate &&
    evidence.scope === OrdinaryCompletenessScope &&
    scope.tenantId === input.tenantId &&
    scope.decisionPurpose === input.decisionPurpose &&
    subjectMatches &&
    scopesEqual(scope.commercialScope, input.trustedContext) &&
    targetsEqual(scope.target, input.target) &&
    DateTime.toEpochMillis(scope.operationTime) === DateTime.toEpochMillis(input.trustedContext.operationTime) &&
    proof.ownerModuleId === 'commerce.assortment' &&
    proof.evidenceRef.moduleId === 'commerce.assortment' &&
    proof.evidenceRef.tenantId === input.tenantId &&
    (proof.sourceRevision === undefined || proof.sourceRevision.sourceRef.tenantId === input.tenantId)
  );
};

/** Resolve a complete, already owner-assembled Current Candidate set without any technical tie-break. */
export const resolveAssortmentOrdinary = (input: AssortmentOrdinaryResolutionInput): AssortmentOrdinaryResolution => {
  if (!Schema.is(AssortmentOrdinaryResolutionInputSchema)(input)) {
    return indeterminate('INVALID_ORDINARY_INPUT');
  }
  if (input.completeness.evidence.state !== 'COMPLETE' || !completenessIsForInput(input)) {
    return indeterminate('CANDIDATE_SET_INCOMPLETE');
  }
  if (!purposeTargetMatches(input.decisionPurpose, input.target)) {
    return indeterminate('PURPOSE_TARGET_MISMATCH');
  }
  if (input.tenantId !== input.trustedContext.tenantId || !hasOneTenant(input.tenantId, allInputReferences(input))) {
    return indeterminate('CROSS_TENANT_INPUT');
  }

  const possibleCandidates = input.candidates.filter(
    (candidate) =>
      candidate.decisionPurpose === input.decisionPurpose &&
      scopeApplies(candidate.commercialScope, input.trustedContext) &&
      audienceCanBeApplicable(candidate.audience, input),
  );
  const groupCandidateExists = possibleCandidates.some(
    (candidate) => candidate.audience.kind === 'COMMERCE_CUSTOMER_GROUP',
  );
  if (
    groupCandidateExists &&
    !groupMembershipsAreComplete(
      input.memberships,
      input.subject,
      input.trustedContext.operationTime,
      input.trustedContext.sellingLegalEntityRef.resourceId,
    )
  ) {
    return indeterminate('MEMBERSHIP_SET_INCOMPLETE');
  }

  const categoryCandidateExists = possibleCandidates.some((candidate) => candidate.selector.kind === 'CATEGORY');
  if (
    categoryCandidateExists &&
    !categoryEvidenceIsComplete(input.categoryClassification, input.target, input.tenantId)
  ) {
    return indeterminate('CATEGORY_SET_INCOMPLETE');
  }
  const participatingCandidates = possibleCandidates.filter(
    (candidate) =>
      audienceMatches(candidate.audience, input, input.memberships) &&
      catalogSelectorMatches(candidate.selector, input.target, input.categoryClassification),
  );
  const evidence = makeEvidence(input, { candidates: participatingCandidates, maximalCandidates: [] });
  if (participatingCandidates.length === 0) {
    return {
      evidence,
      failure: new AssortmentMissingConfigurationError({
        code: 'MISSING_CONFIGURATION',
        safeReasonCode: 'MISSING_CONFIGURATION',
      }),
      kind: 'MISSING_CONFIGURATION',
    };
  }
  if (participatingCandidates.some((candidate) => !candidateFactsCurrent(candidate, input.factCurrentness))) {
    return indeterminate('FACT_CURRENTNESS_UNCERTAIN');
  }

  const maximalCandidates = participatingCandidates.filter(
    (candidate) =>
      !participatingCandidates.some(
        (other) => other !== candidate && dominates(other, candidate, input.categoryClassification),
      ),
  );
  const finalEvidence = makeEvidence(input, { candidates: participatingCandidates, maximalCandidates });
  const effects = new Set(maximalCandidates.map((candidate) => candidate.effect));
  if (effects.size > 1) {
    return {
      evidence: finalEvidence,
      failure: new AssortmentConfigurationConflictError({
        code: 'CONFIGURATION_CONFLICT',
        conflictKind: 'ORDINARY',
        safeReasonCode: 'CONFIGURATION_CONFLICT',
      }),
      kind: 'CONFIGURATION_CONFLICT',
    };
  }
  const [effect] = effects;
  return {
    evidence: finalEvidence,
    kind: 'RESOLVED',
    outcome: effect === 'ALLOW' ? 'ELIGIBLE' : 'INELIGIBLE',
  };
};
