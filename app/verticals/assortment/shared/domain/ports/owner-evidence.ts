import { EffectiveCustomerGroupMembershipSetV1ResponseSchema } from '@app/commerce-customer-context/api/effective-customer-group-membership-set-v1';
import { Context, Effect, Layer, Schema } from 'effect';

import {
  AssortmentCatalogSelectionSchema,
  AssortmentDecisionSubjectSchema,
  AssortmentEvidenceReferenceSchema,
  AssortmentFactCurrentnessEvidenceSchema,
  AssortmentOwnerResourceRefSchema,
  AssortmentTenantIdSchema,
  AssortmentSetCompletenessEvidenceSchema,
  AssortmentSetPurchaseCompositionSchema,
  AssortmentDependencyFailureError,
} from '../decision-contracts.ts';
import type {
  AssortmentDecisionSubject,
  AssortmentGuestPurchaseContext,
  AssortmentOwnerModuleId,
  AssortmentTrustedCommerceContext,
} from '../decision-contracts.ts';

const NonEmptyTextSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(500));

/** Retains the native owner witness in the existing completeness scope field. */
export const AssortmentCommerceMembershipPredicate =
  'commerce.customer-context.customer-group-memberships.effective.v1';
export const AssortmentCommerceMembershipScopeTokenSchema = Schema.Struct({
  legalEntityId: EffectiveCustomerGroupMembershipSetV1ResponseSchema.fields.legalEntityId,
  proof: EffectiveCustomerGroupMembershipSetV1ResponseSchema.fields.proof,
  version: Schema.Literal(1),
});
export const AssortmentCommerceMembershipScopeTokenJsonSchema = Schema.fromJsonString(
  AssortmentCommerceMembershipScopeTokenSchema,
);

const TenantIdSchema = AssortmentTenantIdSchema;
const CustomerContextModuleId = 'commerce.customer-context';
const InstantSchema = Schema.DateTimeUtcFromString;
const NullableInstantSchema = Schema.Union([Schema.Null, InstantSchema]);
const CommerceCustomerProfileRefSchema = AssortmentOwnerResourceRefSchema.check(
  Schema.makeFilter((reference) =>
    reference.moduleId === CustomerContextModuleId &&
    (reference.resourceType === `${CustomerContextModuleId}.retail-customer-profile` ||
      reference.resourceType === `${CustomerContextModuleId}.counterparty-purchasing-profile`)
      ? undefined
      : 'reference must be a Commerce Customer Profile',
  ),
);

const sameTenant = (tenantId: string, references: readonly { readonly tenantId: string }[]): boolean =>
  references.every((reference) => reference.tenantId === tenantId);

const tenantMismatch = (message: string) => message;

const AssortmentOwnerFailureSchema = Schema.Union([AssortmentDependencyFailureError]);
export type AssortmentOwnerFailure = typeof AssortmentOwnerFailureSchema.Type;

export const AssortmentTrustedCommerceContextRequestSchema = Schema.Struct({
  trustedContextRef: AssortmentOwnerResourceRefSchema,
});
export type AssortmentTrustedCommerceContextRequest = typeof AssortmentTrustedCommerceContextRequestSchema.Type;

export const AssortmentGuestPurchaseContextRequestSchema = Schema.Struct({
  guestEvidence: AssortmentEvidenceReferenceSchema,
  tenantId: TenantIdSchema,
}).check(
  Schema.makeFilter((request) =>
    request.guestEvidence.evidenceRef.tenantId === request.tenantId
      ? undefined
      : tenantMismatch('Guest context evidence must belong to the requested tenant'),
  ),
);
export type AssortmentGuestPurchaseContextRequest = typeof AssortmentGuestPurchaseContextRequestSchema.Type;

export const AssortmentSubjectResolutionRequestSchema = Schema.Struct({
  subject: AssortmentDecisionSubjectSchema,
  tenantId: TenantIdSchema,
}).check(
  Schema.makeFilter((request) => {
    let subjectReference;
    if (request.subject.kind === 'GUEST_PURCHASE_CONTEXT') {
      subjectReference = request.subject.guestEvidence.evidenceRef;
    } else if (request.subject.subject.kind === 'RETAIL_CUSTOMER_PROFILE') {
      subjectReference = request.subject.subject.profileRef;
    } else {
      subjectReference = request.subject.subject.counterpartyRef;
    }
    return subjectReference.tenantId === request.tenantId
      ? undefined
      : tenantMismatch('subject references must belong to the requested tenant');
  }),
);
export type AssortmentSubjectResolutionRequest = typeof AssortmentSubjectResolutionRequestSchema.Type;

export const AssortmentCustomerGroupMembershipSchema = Schema.Struct({
  effectiveFrom: InstantSchema,
  effectiveTo: NullableInstantSchema,
  groupRef: AssortmentOwnerResourceRefSchema.check(
    Schema.makeFilter((reference) =>
      reference.moduleId === CustomerContextModuleId &&
      reference.resourceType === `${CustomerContextModuleId}.customer-group`
        ? undefined
        : 'membership group must be a Commerce Customer Group reference',
    ),
  ),
  membershipRef: AssortmentOwnerResourceRefSchema.check(
    Schema.makeFilter((reference) =>
      reference.moduleId === CustomerContextModuleId &&
      reference.resourceType === `${CustomerContextModuleId}.customer-group-membership`
        ? undefined
        : 'membershipRef must be a Commerce Customer Group Membership reference',
    ),
  ),
  profileRef: CommerceCustomerProfileRefSchema,
  revision: NonEmptyTextSchema,
  state: Schema.Literals(['VALID', 'CANCELLED']),
}).check(
  Schema.makeFilter((membership) =>
    membership.effectiveTo === null || membership.effectiveTo > membership.effectiveFrom
      ? undefined
      : [{ issue: 'membership effectiveTo must be later than effectiveFrom', path: ['effectiveTo'] }],
  ),
);
export type AssortmentCustomerGroupMembership = typeof AssortmentCustomerGroupMembershipSchema.Type;

export const AssortmentCustomerGroupMembershipSetSchema = Schema.Struct({
  asOf: InstantSchema,
  completeness: AssortmentSetCompletenessEvidenceSchema,
  items: Schema.Array(AssortmentCustomerGroupMembershipSchema),
  profileRef: AssortmentOwnerResourceRefSchema,
}).check(
  Schema.makeFilter((set) => {
    const issues: Schema.FilterIssue[] = [];
    for (const item of set.items) {
      if (
        item.profileRef.resourceId !== set.profileRef.resourceId ||
        item.profileRef.resourceType !== set.profileRef.resourceType
      ) {
        issues.push({ issue: 'Membership profile must match the requested profile', path: ['items'] });
      }
      if (
        item.state === 'VALID' &&
        (item.effectiveFrom > set.asOf || (item.effectiveTo !== null && set.asOf >= item.effectiveTo))
      ) {
        issues.push({ issue: 'VALID membership must contain asOf in its half-open effective period', path: ['items'] });
      }
    }
    const references = [
      set.profileRef,
      ...set.items.flatMap((item) => [item.groupRef, item.membershipRef, item.profileRef]),
      set.completeness.proof.evidenceRef,
      ...(set.completeness.proof.sourceRevision === undefined ? [] : [set.completeness.proof.sourceRevision.sourceRef]),
    ];
    if (!sameTenant(set.profileRef.tenantId, references)) {
      issues.push({ issue: tenantMismatch('Customer Group Membership evidence must share one tenant'), path: [] });
    }
    return issues;
  }),
);
export type AssortmentCustomerGroupMembershipSet = typeof AssortmentCustomerGroupMembershipSetSchema.Type;

export const AssortmentCustomerGroupMembershipRequestSchema = Schema.Struct({
  asOf: InstantSchema,
  profileRef: CommerceCustomerProfileRefSchema,
  tenantId: TenantIdSchema,
}).check(
  Schema.makeFilter((request) =>
    request.profileRef.tenantId === request.tenantId
      ? undefined
      : tenantMismatch('Customer Group Membership profile must belong to the requested tenant'),
  ),
);
export type AssortmentCustomerGroupMembershipRequest = typeof AssortmentCustomerGroupMembershipRequestSchema.Type;

export const AssortmentCatalogSelectionRequestSchema = Schema.Struct({
  selection: AssortmentCatalogSelectionSchema,
  tenantId: TenantIdSchema,
}).check(
  Schema.makeFilter((request) =>
    request.selection.productRef.tenantId === request.tenantId
      ? undefined
      : tenantMismatch('Catalog Selection must belong to the requested tenant'),
  ),
);
export type AssortmentCatalogSelectionRequest = typeof AssortmentCatalogSelectionRequestSchema.Type;

export const AssortmentCatalogSelectionResolutionSchema = Schema.Struct({
  selection: AssortmentCatalogSelectionSchema,
  source: AssortmentEvidenceReferenceSchema,
}).check(
  Schema.makeFilter((resolution) =>
    resolution.selection.productRef.tenantId === resolution.source.evidenceRef.tenantId
      ? undefined
      : tenantMismatch('Catalog Selection resolution evidence must share one tenant'),
  ),
);
export type AssortmentCatalogSelectionResolution = typeof AssortmentCatalogSelectionResolutionSchema.Type;

export const AssortmentSetCompositionRequestSchema = Schema.Struct({
  selection: AssortmentCatalogSelectionSchema,
  tenantId: TenantIdSchema,
}).check(
  Schema.makeFilter((request) =>
    request.selection.variantKind === 'SET' && request.selection.productRef.tenantId === request.tenantId
      ? undefined
      : tenantMismatch('Set Composition requests require one tenant-scoped SET selection'),
  ),
);
export type AssortmentSetCompositionRequest = typeof AssortmentSetCompositionRequestSchema.Type;

export const AssortmentSetCompositionResolutionSchema = Schema.Struct({
  composition: AssortmentSetPurchaseCompositionSchema,
  source: AssortmentEvidenceReferenceSchema,
}).check(
  Schema.makeFilter((resolution) =>
    resolution.composition.setCompositionRevision.sourceRef.tenantId === resolution.source.evidenceRef.tenantId
      ? undefined
      : tenantMismatch('Set Composition resolution evidence must share one tenant'),
  ),
);
export type AssortmentSetCompositionResolution = typeof AssortmentSetCompositionResolutionSchema.Type;

export const AssortmentCategoryAncestrySchema = Schema.Struct({
  ancestors: Schema.Array(AssortmentOwnerResourceRefSchema),
  categoryRef: AssortmentOwnerResourceRefSchema,
});
export type AssortmentCategoryAncestry = typeof AssortmentCategoryAncestrySchema.Type;

export const AssortmentCategoryClassificationRequestSchema = Schema.Struct({
  productRef: AssortmentOwnerResourceRefSchema,
  tenantId: TenantIdSchema,
  trustedAt: InstantSchema,
}).check(
  Schema.makeFilter((request) =>
    request.productRef.tenantId === request.tenantId
      ? undefined
      : tenantMismatch('Category classification must belong to the requested tenant'),
  ),
);
export type AssortmentCategoryClassificationRequest = typeof AssortmentCategoryClassificationRequestSchema.Type;

export const AssortmentCategoryClassificationSchema = Schema.Struct({
  ancestries: Schema.Array(AssortmentCategoryAncestrySchema),
  classifications: Schema.Array(AssortmentOwnerResourceRefSchema),
  completeness: AssortmentSetCompletenessEvidenceSchema,
  currentness: Schema.Array(AssortmentFactCurrentnessEvidenceSchema),
  productRef: AssortmentOwnerResourceRefSchema,
}).check(
  Schema.makeFilter((classification) => {
    const references = [
      classification.productRef,
      ...classification.classifications,
      ...classification.ancestries.flatMap((ancestry) => [ancestry.categoryRef, ...ancestry.ancestors]),
      ...classification.currentness.flatMap((evidence) => [
        evidence.factRef,
        evidence.proof.evidenceRef,
        ...(evidence.proof.sourceRevision === undefined ? [] : [evidence.proof.sourceRevision.sourceRef]),
      ]),
      classification.completeness.proof.evidenceRef,
      ...(classification.completeness.proof.sourceRevision === undefined
        ? []
        : [classification.completeness.proof.sourceRevision.sourceRef]),
    ];
    return sameTenant(classification.productRef.tenantId, references)
      ? undefined
      : tenantMismatch('Category classification evidence must share one tenant');
  }),
);
export type AssortmentCategoryClassification = typeof AssortmentCategoryClassificationSchema.Type;

export const AssortmentFactCurrentnessRequestSchema = Schema.Struct({
  factRef: AssortmentOwnerResourceRefSchema,
  observedAt: InstantSchema,
  tenantId: TenantIdSchema,
}).check(
  Schema.makeFilter((request) =>
    request.factRef.tenantId === request.tenantId
      ? undefined
      : tenantMismatch('Fact Currentness must belong to the requested tenant'),
  ),
);
export type AssortmentFactCurrentnessRequest = typeof AssortmentFactCurrentnessRequestSchema.Type;

export const AssortmentFactCurrentnessResultSchema = Schema.Struct({
  evidence: AssortmentFactCurrentnessEvidenceSchema,
  observedAt: InstantSchema,
}).check(
  Schema.makeFilter((result) =>
    result.evidence.factRef.tenantId === result.evidence.proof.evidenceRef.tenantId
      ? undefined
      : tenantMismatch('Fact Currentness evidence must share one tenant'),
  ),
);
export type AssortmentFactCurrentnessResult = typeof AssortmentFactCurrentnessResultSchema.Type;

export const AssortmentSetCompletenessRequestSchema = Schema.Struct({
  asOf: InstantSchema,
  predicate: NonEmptyTextSchema,
  scope: NonEmptyTextSchema,
  scopeRef: AssortmentOwnerResourceRefSchema,
  tenantId: TenantIdSchema,
}).check(
  Schema.makeFilter((request) =>
    request.scopeRef.tenantId === request.tenantId
      ? undefined
      : tenantMismatch('Set completeness scope must belong to the requested tenant'),
  ),
);
export type AssortmentSetCompletenessRequest = typeof AssortmentSetCompletenessRequestSchema.Type;

export const AssortmentSetCompletenessResultSchema = Schema.Struct({
  evidence: AssortmentSetCompletenessEvidenceSchema,
}).check(
  Schema.makeFilter((result) => {
    const references = [
      result.evidence.proof.evidenceRef,
      ...(result.evidence.proof.sourceRevision === undefined ? [] : [result.evidence.proof.sourceRevision.sourceRef]),
    ];
    return sameTenant(result.evidence.proof.evidenceRef.tenantId, references)
      ? undefined
      : tenantMismatch('Set completeness evidence must share one tenant');
  }),
);
export type AssortmentSetCompletenessResult = typeof AssortmentSetCompletenessResultSchema.Type;

export interface AssortmentOwnerEvidencePort {
  readonly resolveCatalogSelection: (
    request: AssortmentCatalogSelectionRequest,
  ) => Effect.Effect<AssortmentCatalogSelectionResolution, AssortmentOwnerFailure>;
  readonly resolveCategoryClassification: (
    request: AssortmentCategoryClassificationRequest,
  ) => Effect.Effect<AssortmentCategoryClassification, AssortmentOwnerFailure>;
  readonly resolveCustomerGroupMemberships: (
    request: AssortmentCustomerGroupMembershipRequest,
  ) => Effect.Effect<AssortmentCustomerGroupMembershipSet, AssortmentOwnerFailure>;
  readonly resolveGuestPurchaseContext: (
    request: AssortmentGuestPurchaseContextRequest,
  ) => Effect.Effect<AssortmentGuestPurchaseContext, AssortmentOwnerFailure>;
  readonly resolveSetComposition: (
    request: AssortmentSetCompositionRequest,
  ) => Effect.Effect<AssortmentSetCompositionResolution, AssortmentOwnerFailure>;
  readonly resolveSubject: (
    request: AssortmentSubjectResolutionRequest,
  ) => Effect.Effect<AssortmentDecisionSubject, AssortmentOwnerFailure>;
  readonly resolveTrustedCommerceContext: (
    request: AssortmentTrustedCommerceContextRequest,
  ) => Effect.Effect<AssortmentTrustedCommerceContext, AssortmentOwnerFailure>;
  readonly verifyFactCurrentness: (
    request: AssortmentFactCurrentnessRequest,
  ) => Effect.Effect<AssortmentFactCurrentnessResult, AssortmentOwnerFailure>;
  readonly verifySetCompleteness: (
    request: AssortmentSetCompletenessRequest,
  ) => Effect.Effect<AssortmentSetCompletenessResult, AssortmentOwnerFailure>;
}

export class AssortmentOwnerEvidence extends Context.Service<AssortmentOwnerEvidence, AssortmentOwnerEvidencePort>()(
  '@app/assortment/shared/domain/ports/owner-evidence/AssortmentOwnerEvidence',
) {}

const unavailable = (ownerModuleId: AssortmentOwnerModuleId, capability: string) =>
  Effect.fail(
    new AssortmentDependencyFailureError({
      code: 'DEPENDENCY_FAILURE',
      ownerModuleId,
      retryable: true,
      safeReasonCode: 'DEPENDENCY_UNAVAILABLE',
    }),
  ).pipe(Effect.annotateLogs({ capability }));

const subjectOwnerModuleId = (subject: AssortmentDecisionSubject) => {
  if (subject.kind === 'GUEST_PURCHASE_CONTEXT') {
    return subject.guestEvidence.evidenceRef.moduleId;
  }
  if (subject.subject.kind === 'RETAIL_CUSTOMER_PROFILE') {
    return subject.subject.profileRef.moduleId;
  }
  return subject.subject.counterpartyRef.moduleId;
};

export const makeUnavailableAssortmentOwnerEvidencePort = (): AssortmentOwnerEvidencePort => ({
  resolveCatalogSelection: (request) => unavailable(request.selection.productRef.moduleId, 'catalog.selection'),
  resolveCategoryClassification: (request) =>
    unavailable(request.productRef.moduleId, 'catalog.category-classification'),
  resolveCustomerGroupMemberships: (request) => unavailable(request.profileRef.moduleId, 'customer.group-memberships'),
  resolveGuestPurchaseContext: (request) =>
    unavailable(request.guestEvidence.evidenceRef.moduleId, 'commerce.guest-context'),
  resolveSetComposition: (request) => unavailable(request.selection.productRef.moduleId, 'catalog.set-composition'),
  resolveSubject: (request) => unavailable(subjectOwnerModuleId(request.subject), 'commerce.subject'),
  resolveTrustedCommerceContext: (request) =>
    unavailable(request.trustedContextRef.moduleId, 'commerce.trusted-context'),
  verifyFactCurrentness: (request) => unavailable(request.factRef.moduleId, 'owner.fact-currentness'),
  verifySetCompleteness: (request) => unavailable(request.scopeRef.moduleId, 'owner.set-completeness'),
});

export const AssortmentOwnerEvidenceUnavailableLive = Layer.succeed(
  AssortmentOwnerEvidence,
  makeUnavailableAssortmentOwnerEvidencePort(),
);
