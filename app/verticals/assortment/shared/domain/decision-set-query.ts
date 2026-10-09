import { DateTime, Schema } from 'effect';
import {
  AssortmentCatalogSelectionSchema,
  AssortmentClosedBoundarySchema,
  AssortmentCommercialScopeSchema,
  AssortmentDecisionPurposeSchema,
  AssortmentOwnerModuleIdSchema,
  AssortmentDecisionSubjectSchema,
  AssortmentOwnerResourceRefSchema,
  AssortmentPurchasingSubjectSchema,
  AssortmentSetCompletenessEvidenceSchema,
  AssortmentTenantIdSchema,
  AssortmentTrustedCommerceContextSchema,
  AssortmentCandidateSchema,
} from './decision-contracts.ts';

const LegalEntityIdSchema = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('LegalEntityId'));
const BoundaryTargetSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('PRODUCT'), productRef: AssortmentOwnerResourceRefSchema }),
  Schema.Struct({ kind: Schema.Literal('CATALOG_SELECTION'), selection: AssortmentCatalogSelectionSchema }),
]);
const OrdinaryTargetSchema = BoundaryTargetSchema;
const SharedScopeFields = {
  decisionPurpose: AssortmentDecisionPurposeSchema,
  legalEntityId: LegalEntityIdSchema,
  operationTime: Schema.DateTimeUtcFromString,
  tenantId: AssortmentTenantIdSchema,
  trustedContext: AssortmentTrustedCommerceContextSchema,
} as const;

const queryMatchesTrustedScope = (
  query: AssortmentApplicableBoundaryQueryV1 | AssortmentOrdinaryCandidateQueryV1,
): boolean => {
  const targetReferences: (typeof AssortmentOwnerResourceRefSchema.Type)[] = [];
  if (query.target.kind === 'PRODUCT') {
    targetReferences.push(query.target.productRef);
  } else {
    targetReferences.push(query.target.selection.productRef, query.target.selection.variantRef);
    if (query.kind === 'APPLICABLE_BOUNDARIES' && query.target.selection.packageOption !== undefined) {
      targetReferences.push(query.target.selection.packageOption.packageOptionRef);
    }
  }
  const subjectReferences: (typeof AssortmentOwnerResourceRefSchema.Type)[] = [];
  if (query.kind === 'APPLICABLE_BOUNDARIES') {
    subjectReferences.push(
      query.subject.kind === 'RETAIL_CUSTOMER_PROFILE' ? query.subject.profileRef : query.subject.counterpartyRef,
    );
  } else if (query.subject.kind === 'GUEST_PURCHASE_CONTEXT') {
    subjectReferences.push(query.subject.guestEvidence.evidenceRef);
  } else {
    subjectReferences.push(
      query.subject.subject.kind === 'RETAIL_CUSTOMER_PROFILE'
        ? query.subject.subject.profileRef
        : query.subject.subject.counterpartyRef,
    );
  }
  return (
    query.tenantId === query.trustedContext.tenantId &&
    String(query.legalEntityId) === String(query.trustedContext.sellingLegalEntityRef.resourceId) &&
    DateTime.toEpochMillis(query.operationTime) === DateTime.toEpochMillis(query.trustedContext.operationTime) &&
    [...targetReferences, ...subjectReferences].every((reference) => reference.tenantId === query.tenantId)
  );
};

export const AssortmentApplicableBoundaryQueryV1Schema = Schema.Struct({
  ...SharedScopeFields,
  kind: Schema.Literal('APPLICABLE_BOUNDARIES'),
  subject: AssortmentPurchasingSubjectSchema,
  target: BoundaryTargetSchema,
  version: Schema.Literal(1),
}).check(
  Schema.makeFilter((query) =>
    queryMatchesTrustedScope(query)
      ? undefined
      : 'Boundary query must exactly match trusted tenant, legal entity, operation time, and references',
  ),
);
export type AssortmentApplicableBoundaryQueryV1 = typeof AssortmentApplicableBoundaryQueryV1Schema.Type;

export const AssortmentOrdinaryCandidateQueryV1Schema = Schema.Struct({
  ...SharedScopeFields,
  kind: Schema.Literal('ORDINARY_CANDIDATES'),
  subject: AssortmentDecisionSubjectSchema,
  target: OrdinaryTargetSchema,
  version: Schema.Literal(1),
}).check(
  Schema.makeFilter((query) =>
    queryMatchesTrustedScope(query)
      ? undefined
      : 'Candidate query must exactly match trusted tenant, legal entity, operation time, and references',
  ),
);
export type AssortmentOrdinaryCandidateQueryV1 = typeof AssortmentOrdinaryCandidateQueryV1Schema.Type;

export const AssortmentDecisionSetQueryV1Schema = Schema.Union([
  AssortmentApplicableBoundaryQueryV1Schema,
  AssortmentOrdinaryCandidateQueryV1Schema,
]);
export type AssortmentDecisionSetQueryV1 = typeof AssortmentDecisionSetQueryV1Schema.Type;

const BoundaryCompletenessScopeSchema = Schema.Struct({
  commercialScope: AssortmentCommercialScopeSchema,
  decisionPurpose: AssortmentDecisionPurposeSchema,
  kind: Schema.Literal('APPLICABLE_CLOSED_BOUNDARIES'),
  operationTime: Schema.DateTimeUtcFromString,
  subject: AssortmentPurchasingSubjectSchema,
  tenantId: AssortmentTenantIdSchema,
});
const OrdinaryCompletenessScopeSchema = Schema.Struct({
  commercialScope: AssortmentCommercialScopeSchema,
  decisionPurpose: AssortmentDecisionPurposeSchema,
  kind: Schema.Literal('ORDINARY_CANDIDATES'),
  operationTime: Schema.DateTimeUtcFromString,
  subject: AssortmentDecisionSubjectSchema,
  target: OrdinaryTargetSchema,
  tenantId: AssortmentTenantIdSchema,
});
const CompleteBoundarySetV1Schema = Schema.Struct({
  boundaries: Schema.Array(AssortmentClosedBoundarySchema),
  completeness: Schema.Struct({
    evidence: AssortmentSetCompletenessEvidenceSchema,
    scope: BoundaryCompletenessScopeSchema,
  }),
  kind: Schema.Literal('COMPLETE_BOUNDARY_SET'),
  query: AssortmentApplicableBoundaryQueryV1Schema,
  version: Schema.Literal(1),
});
const CompleteOrdinaryCandidateSetV1Schema = Schema.Struct({
  candidates: Schema.Array(AssortmentCandidateSchema),
  completeness: Schema.Struct({
    evidence: AssortmentSetCompletenessEvidenceSchema,
    scope: OrdinaryCompletenessScopeSchema,
  }),
  factCurrentness: Schema.Array(
    Schema.Struct({
      factRef: AssortmentOwnerResourceRefSchema,
      proof: Schema.Struct({
        evidenceRef: AssortmentOwnerResourceRefSchema,
        ownerModuleId: AssortmentOwnerModuleIdSchema,
      }),
      state: Schema.Literal('CURRENT'),
    }),
  ),
  kind: Schema.Literal('COMPLETE_ORDINARY_CANDIDATE_SET'),
  query: AssortmentOrdinaryCandidateQueryV1Schema,
  version: Schema.Literal(1),
});

export const AssortmentCompleteDecisionSetV1Schema = Schema.Union([
  CompleteBoundarySetV1Schema,
  CompleteOrdinaryCandidateSetV1Schema,
]);

export const AssortmentVerifyDecisionSetV1RequestSchema = Schema.Struct({
  expectedProofRef: AssortmentOwnerResourceRefSchema,
  query: AssortmentDecisionSetQueryV1Schema,
  version: Schema.Literal(1),
});
export const AssortmentVerifyDecisionSetV1ResultSchema = Schema.Union([
  Schema.Struct({ state: Schema.Literal('CURRENT'), version: Schema.Literal(1) }),
  Schema.Struct({ state: Schema.Literal('STALE'), version: Schema.Literal(1) }),
]);
