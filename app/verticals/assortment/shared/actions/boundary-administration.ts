import { DateTime, Schema } from 'effect';
import {
  AssortmentCatalogSelectorSchema,
  AssortmentCommercialScopeSchema,
  AssortmentDecisionPurposeSchema,
  AssortmentOwnerResourceRefSchema,
  AssortmentPurchasingSubjectSchema,
  AssortmentClosedBoundaryRefSchema,
} from '../domain/decision-contracts.ts';

const ReasonSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(500));
const ProvenanceRefSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(500));
const InstantSchema = Schema.DateTimeUtcFromString;
const FingerprintSchema = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));

/** Owner-emitted collection revision identity; it is never accepted in a write payload. */
export const AssortmentCollectionRevisionRefSchema = AssortmentOwnerResourceRefSchema.check(
  Schema.makeFilter((ref) =>
    ref.moduleId === 'commerce.assortment' && ref.resourceType === 'commerce.assortment.collection-revision'
      ? undefined
      : 'reference must identify an Assortment collection revision',
  ),
);

export const AssortmentAdmissionSetInputSchema = Schema.Struct({
  entries: Schema.Array(AssortmentCatalogSelectorSchema),
});

export const CreateClosedAssortmentBoundaryPayloadSchema = Schema.Struct({
  admissionSet: AssortmentAdmissionSetInputSchema,
  commercialScope: AssortmentCommercialScopeSchema,
  decisionPurpose: AssortmentDecisionPurposeSchema,
  effectiveFrom: InstantSchema,
  provenanceRef: ProvenanceRefSchema,
  reason: ReasonSchema,
  subject: AssortmentPurchasingSubjectSchema,
});
export type CreateClosedAssortmentBoundaryPayload = typeof CreateClosedAssortmentBoundaryPayloadSchema.Type;

const AdmissionSetEvidenceSchema = Schema.Struct({
  collectionRevisionRef: AssortmentCollectionRevisionRefSchema,
  contentHash: FingerprintSchema,
  memberCount: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  setKind: Schema.Literals(['EMPTY', 'ENTRIES']),
});

export const CreateClosedAssortmentBoundaryResultSchema = Schema.Struct({
  admissionSet: AdmissionSetEvidenceSchema,
  boundaryRef: AssortmentClosedBoundaryRefSchema,
  created: Schema.Boolean,
});

export const EndClosedAssortmentBoundaryPayloadSchema = Schema.Struct({
  boundaryRef: AssortmentClosedBoundaryRefSchema,
  effectiveAt: InstantSchema,
  expectedBasisFingerprint: FingerprintSchema,
  provenanceRef: ProvenanceRefSchema,
  reason: ReasonSchema,
});
export type EndClosedAssortmentBoundaryPayload = typeof EndClosedAssortmentBoundaryPayloadSchema.Type;

export const EndClosedAssortmentBoundaryResultSchema = Schema.Struct({
  boundaryRef: AssortmentClosedBoundaryRefSchema,
  ended: Schema.Boolean,
});

export const ReplaceClosedAssortmentBoundaryPayloadSchema = Schema.Struct({
  effectiveAt: InstantSchema,
  existingBoundaryRef: AssortmentClosedBoundaryRefSchema,
  expectedExistingBasisFingerprint: FingerprintSchema,
  proposedAdmissionSet: AssortmentAdmissionSetInputSchema,
  proposedCommercialScope: AssortmentCommercialScopeSchema,
  proposedDecisionPurpose: AssortmentDecisionPurposeSchema,
  proposedEffectiveFrom: InstantSchema,
  proposedSubject: AssortmentPurchasingSubjectSchema,
  provenanceRef: ProvenanceRefSchema,
  reason: ReasonSchema,
}).check(
  Schema.makeFilter((payload) =>
    DateTime.formatIso(payload.effectiveAt) === DateTime.formatIso(payload.proposedEffectiveFrom)
      ? undefined
      : 'a boundary replacement must end and create at one trusted effective time',
  ),
);
export type ReplaceClosedAssortmentBoundaryPayload = typeof ReplaceClosedAssortmentBoundaryPayloadSchema.Type;

export const ReplaceClosedAssortmentBoundaryResultSchema = Schema.Struct({
  createdBoundaryRef: AssortmentClosedBoundaryRefSchema,
  endedBoundaryRef: AssortmentClosedBoundaryRefSchema,
  replaced: Schema.Boolean,
});
