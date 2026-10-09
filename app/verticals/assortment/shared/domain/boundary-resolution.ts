import { DateTime, Schema } from 'effect';

import {
  AssortmentCatalogSelectionSchema,
  AssortmentCommercialScopeSchema,
  AssortmentClosedBoundarySchema,
  AssortmentDecisionPurposeSchema,
  AssortmentPurchasingSubjectSchema,
  AssortmentSetCompletenessEvidenceSchema,
  AssortmentTenantIdSchema,
  AssortmentTrustedCommerceContextSchema,
  CatalogProductRefSchema,
} from './decision-contracts.ts';
import { AssortmentCategoryClassificationSchema } from './ports/owner-evidence.ts';
import type {
  AssortmentBoundaryPath,
  AssortmentCatalogSelection,
  AssortmentClosedBoundary,
  AssortmentCommercialScope,
  AssortmentOwnerResourceRef,
  AssortmentPurchasingSubject,
  AssortmentTrustedCommerceContext,
} from './decision-contracts.ts';
import type { AssortmentCategoryClassification } from './ports/owner-evidence.ts';

const InstantSchema = Schema.DateTimeUtcFromString;

const AssortmentBoundaryTargetSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('PRODUCT'),
    productRef: CatalogProductRefSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal('CATALOG_SELECTION'),
    selection: AssortmentCatalogSelectionSchema,
  }),
]);
type AssortmentBoundaryTarget = typeof AssortmentBoundaryTargetSchema.Type;

const AssortmentBoundaryCompletenessScopeSchema = Schema.Struct({
  commercialScope: AssortmentCommercialScopeSchema,
  decisionPurpose: AssortmentDecisionPurposeSchema,
  kind: Schema.Literal('APPLICABLE_CLOSED_BOUNDARIES'),
  operationTime: InstantSchema,
  subject: AssortmentPurchasingSubjectSchema,
  tenantId: AssortmentTenantIdSchema,
});

/** Completeness is typed to this exact Boundary predicate, not a generic query result. */
const AssortmentBoundaryCompletenessEvidenceSchema = Schema.Struct({
  evidence: AssortmentSetCompletenessEvidenceSchema,
  scope: AssortmentBoundaryCompletenessScopeSchema,
});

/**
 * The Boundary owner supplies a complete aggregate collection for this exact
 * decision predicate. The resolver never turns a partial query response into
 * a no-Boundary or unique-Boundary result.
 */
export const AssortmentBoundaryResolutionInputSchema = Schema.Struct({
  boundaries: Schema.Array(AssortmentClosedBoundarySchema),
  categoryClassification: Schema.optionalKey(AssortmentCategoryClassificationSchema),
  completeness: AssortmentBoundaryCompletenessEvidenceSchema,
  decisionPurpose: AssortmentDecisionPurposeSchema,
  subject: AssortmentPurchasingSubjectSchema,
  target: AssortmentBoundaryTargetSchema,
  tenantId: AssortmentTenantIdSchema,
  trustedContext: AssortmentTrustedCommerceContextSchema,
});
export type AssortmentBoundaryResolutionInput = typeof AssortmentBoundaryResolutionInputSchema.Type;

const AssortmentBoundaryResolutionIndeterminateSchema = Schema.Struct({
  kind: Schema.Literal('INDETERMINATE'),
  reason: Schema.Literals([
    'BOUNDARY_SET_INCOMPLETE',
    'CATEGORY_SET_INCOMPLETE',
    'CROSS_TENANT_INPUT',
    'INVALID_BOUNDARY_INPUT',
    'PURPOSE_TARGET_MISMATCH',
    'SUBJECT_NOT_IDENTIFIED',
  ]),
});
export type AssortmentBoundaryResolutionIndeterminate = typeof AssortmentBoundaryResolutionIndeterminateSchema.Type;

export type AssortmentBoundaryResolution = AssortmentBoundaryPath | AssortmentBoundaryResolutionIndeterminate;

const refEquals = (left: AssortmentOwnerResourceRef, right: AssortmentOwnerResourceRef): boolean =>
  left.moduleId === right.moduleId &&
  left.resourceId === right.resourceId &&
  left.resourceType === right.resourceType &&
  left.tenantId === right.tenantId;

const subjectRef = (subject: AssortmentPurchasingSubject): AssortmentOwnerResourceRef =>
  subject.kind === 'RETAIL_CUSTOMER_PROFILE' ? subject.profileRef : subject.counterpartyRef;

const boundarySubjectMatches = (boundary: AssortmentClosedBoundary, subject: AssortmentPurchasingSubject): boolean => {
  if (boundary.subject.kind !== subject.kind) {
    return false;
  }
  return refEquals(
    boundary.subject.kind === 'RETAIL_CUSTOMER_PROFILE'
      ? boundary.subject.profileRef
      : boundary.subject.counterpartyRef,
    subjectRef(subject),
  );
};

const boundaryIsEffective = (boundary: AssortmentClosedBoundary, operationTime: DateTime.Utc): boolean => {
  const operationMillis = DateTime.toEpochMillis(operationTime);
  const effectiveFromMillis = DateTime.toEpochMillis(boundary.effectiveFrom);
  const effectiveToMillis =
    boundary.effectiveTo === undefined ? undefined : DateTime.toEpochMillis(boundary.effectiveTo);
  return (
    Number.isFinite(operationMillis) &&
    Number.isFinite(effectiveFromMillis) &&
    effectiveFromMillis <= operationMillis &&
    (effectiveToMillis === undefined || (Number.isFinite(effectiveToMillis) && operationMillis < effectiveToMillis))
  );
};

const scopeRefMatches = (
  boundary: AssortmentClosedBoundary,
  trustedContext: AssortmentTrustedCommerceContext,
): boolean => {
  const boundaryScope = boundary.commercialScope;
  if (!refEquals(boundaryScope.channelRef, trustedContext.channelRef)) {
    return false;
  }
  if (!refEquals(boundaryScope.sellingLegalEntityRef, trustedContext.sellingLegalEntityRef)) {
    return false;
  }
  if (
    boundaryScope.commerceMarketRef !== undefined &&
    (trustedContext.commerceMarketRef === undefined ||
      !refEquals(boundaryScope.commerceMarketRef, trustedContext.commerceMarketRef))
  ) {
    return false;
  }
  if (
    boundaryScope.storefrontRef !== undefined &&
    (trustedContext.storefrontRef === undefined ||
      !refEquals(boundaryScope.storefrontRef, trustedContext.storefrontRef))
  ) {
    return false;
  }
  return true;
};

/** Whether `narrower` strictly specializes the same applicable commercial scope as `broader`. */
const scopeIsStrictlyNarrower = (narrower: AssortmentClosedBoundary, broader: AssortmentClosedBoundary): boolean => {
  const narrowScope = narrower.commercialScope;
  const broadScope = broader.commercialScope;
  if (
    !refEquals(narrowScope.channelRef, broadScope.channelRef) ||
    !refEquals(narrowScope.sellingLegalEntityRef, broadScope.sellingLegalEntityRef)
  ) {
    return false;
  }

  const marketNarrower =
    narrowScope.commerceMarketRef !== undefined &&
    (broadScope.commerceMarketRef === undefined ||
      refEquals(narrowScope.commerceMarketRef, broadScope.commerceMarketRef));
  const storefrontNarrower =
    narrowScope.storefrontRef !== undefined &&
    (broadScope.storefrontRef === undefined || refEquals(narrowScope.storefrontRef, broadScope.storefrontRef));
  const compatible =
    (broadScope.commerceMarketRef === undefined ||
      (narrowScope.commerceMarketRef !== undefined &&
        refEquals(narrowScope.commerceMarketRef, broadScope.commerceMarketRef))) &&
    (broadScope.storefrontRef === undefined ||
      (narrowScope.storefrontRef !== undefined && refEquals(narrowScope.storefrontRef, broadScope.storefrontRef)));
  const addsMarket = broadScope.commerceMarketRef === undefined && narrowScope.commerceMarketRef !== undefined;
  const addsStorefront = broadScope.storefrontRef === undefined && narrowScope.storefrontRef !== undefined;

  return compatible && (marketNarrower || storefrontNarrower) && (addsMarket || addsStorefront);
};

const targetProductRef = (target: AssortmentBoundaryTarget): AssortmentOwnerResourceRef =>
  target.kind === 'PRODUCT' ? target.productRef : target.selection.productRef;

const targetSelection = (target: AssortmentBoundaryTarget): AssortmentCatalogSelection | undefined =>
  target.kind === 'CATALOG_SELECTION' ? target.selection : undefined;

const admissionEntryMatches = (
  selector: AssortmentClosedBoundary['admissionSet'][number],
  target: AssortmentBoundaryTarget,
  categoryClassification: AssortmentCategoryClassification | undefined,
): boolean => {
  if (selector.kind === 'ALL') {
    return true;
  }
  const productRef = targetProductRef(target);
  if (selector.kind === 'PRODUCT') {
    return refEquals(selector.productRef, productRef);
  }
  if (selector.kind === 'CATEGORY') {
    if (categoryClassification === undefined) {
      return false;
    }
    const { ancestries, classifications } = categoryClassification;
    const categories = [
      ...classifications,
      ...ancestries.flatMap((ancestry) => [ancestry.categoryRef, ...ancestry.ancestors]),
    ];
    return categories.some((categoryRef) => refEquals(categoryRef, selector.categoryRef));
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

const boundaryRefs = (boundary: AssortmentClosedBoundary): readonly { readonly tenantId: string }[] => [
  boundary.boundaryRef,
  boundary.subject.kind === 'RETAIL_CUSTOMER_PROFILE' ? boundary.subject.profileRef : boundary.subject.counterpartyRef,
  boundary.commercialScope.channelRef,
  boundary.commercialScope.sellingLegalEntityRef,
  ...(boundary.commercialScope.commerceMarketRef === undefined ? [] : [boundary.commercialScope.commerceMarketRef]),
  ...(boundary.commercialScope.storefrontRef === undefined ? [] : [boundary.commercialScope.storefrontRef]),
  ...boundary.admissionSet.flatMap((selector) => {
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
  }),
];

const inputRefs = (input: AssortmentBoundaryResolutionInput): readonly { readonly tenantId: string }[] => {
  const selection = targetSelection(input.target);
  const completenessScope = input.completeness.scope;
  return [
    input.trustedContext.channelRef,
    input.trustedContext.sellingLegalEntityRef,
    ...(input.trustedContext.commerceMarketRef === undefined ? [] : [input.trustedContext.commerceMarketRef]),
    ...(input.trustedContext.storefrontRef === undefined ? [] : [input.trustedContext.storefrontRef]),
    completenessScope.commercialScope.channelRef,
    completenessScope.commercialScope.sellingLegalEntityRef,
    ...(completenessScope.commercialScope.commerceMarketRef === undefined
      ? []
      : [completenessScope.commercialScope.commerceMarketRef]),
    ...(completenessScope.commercialScope.storefrontRef === undefined
      ? []
      : [completenessScope.commercialScope.storefrontRef]),
    subjectRef(input.subject),
    targetProductRef(input.target),
    ...(selection === undefined ? [] : [selection.variantRef]),
    ...(selection?.packageOption === undefined ? [] : [selection.packageOption.packageOptionRef]),
    input.completeness.evidence.proof.evidenceRef,
    ...(input.completeness.evidence.proof.sourceRevision === undefined
      ? []
      : [input.completeness.evidence.proof.sourceRevision.sourceRef]),
    ...input.boundaries.flatMap(boundaryRefs),
  ];
};

const hasOneTenant = (tenantId: string, references: readonly { readonly tenantId: string }[]): boolean =>
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

const boundaryCompletenessIsForInput = (input: AssortmentBoundaryResolutionInput): boolean => {
  const { scope } = input.completeness;
  const { proof } = input.completeness.evidence;
  return (
    scope.kind === 'APPLICABLE_CLOSED_BOUNDARIES' &&
    scope.tenantId === input.tenantId &&
    scope.decisionPurpose === input.decisionPurpose &&
    scope.subject.kind === input.subject.kind &&
    refEquals(subjectRef(scope.subject), subjectRef(input.subject)) &&
    scopesEqual(scope.commercialScope, input.trustedContext) &&
    DateTime.toEpochMillis(scope.operationTime) === DateTime.toEpochMillis(input.trustedContext.operationTime) &&
    proof.ownerModuleId === 'commerce.assortment' &&
    proof.evidenceRef.moduleId === 'commerce.assortment' &&
    proof.evidenceRef.tenantId === input.tenantId &&
    (proof.sourceRevision === undefined || proof.sourceRevision.sourceRef.tenantId === input.tenantId)
  );
};

const categoryEvidenceIsForInput = (input: AssortmentBoundaryResolutionInput): boolean => {
  const { categoryClassification } = input;
  if (categoryClassification === undefined) {
    return false;
  }
  return (
    categoryClassification.completeness.state === 'COMPLETE' &&
    refEquals(categoryClassification.productRef, targetProductRef(input.target)) &&
    categoryClassification.productRef.tenantId === input.tenantId &&
    categoryClassification.currentness.every((evidence) => evidence.state === 'CURRENT')
  );
};

const hasCategoryAdmission = (boundary: AssortmentClosedBoundary): boolean =>
  boundary.admissionSet.some((selector) => selector.kind === 'CATEGORY');

const indeterminate = (reason: AssortmentBoundaryResolutionIndeterminate['reason']): AssortmentBoundaryResolution => ({
  kind: 'INDETERMINATE',
  reason,
});

/**
 * Selects and evaluates the Closed Boundary path for one identified subject.
 *
 * The input `boundaries` collection is intentionally required to carry a
 * COMPLETE owner proof. Scope comparison is a partial order: Market-only and
 * Storefront-only scopes are incomparable, and no identifier or array order is
 * consulted when maximal Boundaries tie.
 */
export const resolveAssortmentBoundary = (input: AssortmentBoundaryResolutionInput): AssortmentBoundaryResolution => {
  if (!Schema.is(AssortmentBoundaryResolutionInputSchema)(input)) {
    return indeterminate('INVALID_BOUNDARY_INPUT');
  }
  if (input.completeness.evidence.state !== 'COMPLETE' || !boundaryCompletenessIsForInput(input)) {
    return indeterminate('BOUNDARY_SET_INCOMPLETE');
  }
  if (input.subject.kind !== 'RETAIL_CUSTOMER_PROFILE' && input.subject.kind !== 'COUNTERPARTY') {
    return indeterminate('SUBJECT_NOT_IDENTIFIED');
  }
  if (
    (input.decisionPurpose === 'VISIBILITY' && input.target.kind !== 'PRODUCT') ||
    (input.decisionPurpose === 'PURCHASE' && input.target.kind !== 'CATALOG_SELECTION')
  ) {
    return indeterminate('PURPOSE_TARGET_MISMATCH');
  }
  if (input.tenantId !== input.trustedContext.tenantId || !hasOneTenant(input.tenantId, inputRefs(input))) {
    return indeterminate('CROSS_TENANT_INPUT');
  }

  const applicable = input.boundaries.filter(
    (boundary) =>
      boundary.decisionPurpose === input.decisionPurpose &&
      boundary.boundaryRef.tenantId === input.tenantId &&
      boundaryIsEffective(boundary, input.trustedContext.operationTime) &&
      boundarySubjectMatches(boundary, input.subject) &&
      scopeRefMatches(boundary, input.trustedContext),
  );
  if (applicable.length === 0) {
    return {
      completeness: input.completeness.evidence,
      kind: 'NO_APPLICABLE_BOUNDARY',
    };
  }

  const maximal = applicable.filter(
    (candidate) => !applicable.some((other) => other !== candidate && scopeIsStrictlyNarrower(other, candidate)),
  );
  if (maximal.length !== 1) {
    return {
      boundaries: maximal,
      completeness: input.completeness.evidence,
      kind: 'BOUNDARY_CONFIGURATION_CONFLICT',
    };
  }

  const [boundary] = maximal;
  if (boundary === undefined) {
    return indeterminate('INVALID_BOUNDARY_INPUT');
  }
  if (hasCategoryAdmission(boundary) && !categoryEvidenceIsForInput(input)) {
    return indeterminate('CATEGORY_SET_INCOMPLETE');
  }
  return {
    admitted: boundary.admissionSet.some((selector) =>
      admissionEntryMatches(selector, input.target, input.categoryClassification),
    ),
    boundary,
    completeness: input.completeness.evidence,
    kind: 'UNIQUE_MAXIMAL_BOUNDARY',
  };
};
