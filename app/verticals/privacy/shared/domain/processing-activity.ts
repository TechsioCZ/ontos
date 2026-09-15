/* eslint-disable effect-native/no-unbranded-identifier-schema -- Privacy cross-owner wire contracts preserve explicit JSON null, canonical UTC string encodings, and owner-issued opaque references; generated API and Resource boundaries validate provenance without a misleading shared brand. expires: 2027-03-31. */
import { PrincipalRefSchema } from '@app/core-runtime';
import { Schema } from 'effect';

import { PrivacyApplicabilityDecisionSchema, PrivacyApplicabilityScopeSchema } from './privacy-applicability.ts';
import {
  PersonalDataCoverageSchema,
  ProcessingRecipientTransferSchema,
  ProcessingRetentionReferenceSchema,
  PrivacyOwnerResourceRefSchema,
} from './processing-coverage.ts';
import type { ProcessingRecipientTransfer, PrivacyOwnerResourceRef } from './processing-coverage.ts';
import { PrivacyIsoTimestampSchema } from './privacy-subject.ts';
import { PrivacyResponsibilityAssignmentRefSchema } from '../resources/privacy-responsibility-assignment.ts';
import { ProcessingActivityRefSchema } from '../resources/processing-activity.ts';
import { ProcessingPurposeRefSchema } from '../resources/processing-purpose.ts';
import { LegalBasisAssignmentRefSchema } from '../resources/legal-basis-assignment.ts';

const Text = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(500));
const OwnerResourceRefList = Schema.Array(PrivacyOwnerResourceRefSchema).check(Schema.isMaxLength(64));
const Uuid = Schema.String.check(Schema.isUUID());
const PrivacyRetentionRuleRefSchema = PrivacyOwnerResourceRefSchema.check(
  Schema.makeFilter((reference) =>
    reference.moduleId === 'privacy.core' && reference.resourceType === 'privacy.core.retention-rule'
      ? undefined
      : 'Processing Activity Retention Rule reference must identify a privacy.core Retention Rule',
  ),
);

export const ProcessingActivityLifecycleSchema = Schema.Literals(['PROPOSED', 'EFFECTIVE', 'SUSPENDED', 'ENDED']);
export type ProcessingActivityLifecycle = typeof ProcessingActivityLifecycleSchema.Type;

export const ProcessingActivityLifecycleEventSchema = Schema.Struct({
  actor: PrincipalRefSchema,
  decisionEvidenceRefs: Schema.Array(Text).check(Schema.isMaxLength(32)),
  effectiveAt: PrivacyIsoTimestampSchema,
  from: Schema.toEncoded(Schema.OptionFromNullOr(ProcessingActivityLifecycleSchema)),
  reason: Text,
  recordedAt: PrivacyIsoTimestampSchema,
  to: ProcessingActivityLifecycleSchema,
});
export type ProcessingActivityLifecycleEvent = typeof ProcessingActivityLifecycleEventSchema.Type;

export const ProcessingActivitySchema = Schema.Struct({
  activityRef: ProcessingActivityRefSchema,
  applicabilityDecisions: Schema.Array(PrivacyApplicabilityDecisionSchema).check(Schema.isMaxLength(32)),
  createdAt: PrivacyIsoTimestampSchema,
  currentLifecycle: ProcessingActivityLifecycleSchema,
  dataCategoryRefs: OwnerResourceRefList,
  dataCoverage: Schema.Array(PersonalDataCoverageSchema).check(Schema.isMaxLength(64)),
  legalBasisAssignmentRefs: Schema.Array(LegalBasisAssignmentRefSchema).check(Schema.isMaxLength(64)),
  legalEntityId: Uuid,
  lifecycle: Schema.Array(ProcessingActivityLifecycleEventSchema).check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  processingScope: Schema.Struct({
    applicabilityScope: PrivacyApplicabilityScopeSchema,
    purposeRef: ProcessingPurposeRefSchema,
    purposeVersionId: Schema.String.check(Schema.isUUID()),
    responsibilityAssignmentRefs: Schema.Array(PrivacyResponsibilityAssignmentRefSchema).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(32),
    ),
  }),
  recipientRefs: OwnerResourceRefList,
  recipientTransfers: Schema.Array(ProcessingRecipientTransferSchema).check(Schema.isMaxLength(64)),
  retentionCoverage: Schema.Array(ProcessingRetentionReferenceSchema).check(Schema.isMaxLength(64)),
  retentionRuleRefs: Schema.Array(PrivacyRetentionRuleRefSchema).check(Schema.isMaxLength(64)),
  systemOfRecordRefs: OwnerResourceRefList,
  updatedAt: PrivacyIsoTimestampSchema,
});
export type ProcessingActivity = typeof ProcessingActivitySchema.Type;

export const CreateProcessingActivityInputSchema = Schema.Struct({
  activityRef: Schema.optionalKey(ProcessingActivityRefSchema),
  applicabilityDecisions: Schema.optionalKey(
    Schema.Array(PrivacyApplicabilityDecisionSchema).check(Schema.isMaxLength(32)),
  ),
  dataCategoryRefs: Schema.optionalKey(OwnerResourceRefList),
  dataCoverage: Schema.optionalKey(Schema.Array(PersonalDataCoverageSchema).check(Schema.isMaxLength(64))),
  legalBasisAssignmentRefs: Schema.optionalKey(
    Schema.Array(LegalBasisAssignmentRefSchema).check(Schema.isMaxLength(64)),
  ),
  processingScope: Schema.Struct({
    applicabilityScope: PrivacyApplicabilityScopeSchema,
    purposeRef: ProcessingPurposeRefSchema,
    purposeVersionId: Uuid,
    responsibilityAssignmentRefs: Schema.Array(PrivacyResponsibilityAssignmentRefSchema).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(32),
    ),
  }),
  recipientRefs: Schema.optionalKey(OwnerResourceRefList),
  recipientTransfers: Schema.optionalKey(Schema.Array(ProcessingRecipientTransferSchema).check(Schema.isMaxLength(64))),
  retentionCoverage: Schema.optionalKey(Schema.Array(ProcessingRetentionReferenceSchema).check(Schema.isMaxLength(64))),
  retentionRuleRefs: Schema.optionalKey(Schema.Array(PrivacyRetentionRuleRefSchema).check(Schema.isMaxLength(64))),
  systemOfRecordRefs: Schema.optionalKey(OwnerResourceRefList),
});
export type CreateProcessingActivityInput = typeof CreateProcessingActivityInputSchema.Type;

const optionalReferences = <T>(references: readonly T[] | undefined): readonly T[] => references ?? [];

const recipientTargetReference = (target: ProcessingRecipientTransfer['recipientTarget']): PrivacyOwnerResourceRef =>
  'recipientRef' in target ? target.recipientRef : target.recipientCategoryRef;

const processingActivityOwnerResourceReferences = (input: CreateProcessingActivityInput) => [
  ...optionalReferences(input.dataCategoryRefs),
  ...optionalReferences(input.dataCoverage).flatMap(({ dataCategoryRef, systemOfRecordRef }) => [
    dataCategoryRef,
    systemOfRecordRef,
  ]),
  ...optionalReferences(input.recipientRefs),
  ...optionalReferences(input.systemOfRecordRefs),
  ...optionalReferences(input.recipientTransfers).flatMap((transfer) => [
    ...transfer.dataCategoryRefs,
    ...transfer.downstreamSystemRefs,
    recipientTargetReference(transfer.recipientTarget),
  ]),
];

const processingActivityPrerequisiteReferences = (input: CreateProcessingActivityInput) => [
  ...optionalReferences(input.legalBasisAssignmentRefs),
  ...optionalReferences(input.retentionRuleRefs),
];

export const processingActivityInputForeignReferenceReason = (
  tenantId: string,
  input: CreateProcessingActivityInput,
): string | undefined => {
  if (input.activityRef !== undefined && input.activityRef.tenantId !== tenantId) {
    return 'Processing Activity identity must match the trusted tenant';
  }
  if (input.processingScope.purposeRef.tenantId !== tenantId) {
    return 'Processing Purpose identity must match the trusted tenant';
  }
  if (input.processingScope.responsibilityAssignmentRefs.some((reference) => reference.tenantId !== tenantId)) {
    return 'Processing Activity responsibility references must match the trusted tenant';
  }
  const ownerReferences = processingActivityOwnerResourceReferences(input);
  if (ownerReferences.some((reference) => reference.tenantId !== tenantId)) {
    return 'Processing Activity owner resource references must match the trusted tenant';
  }
  if (processingActivityPrerequisiteReferences(input).some((reference) => reference.tenantId !== tenantId)) {
    return 'Processing Activity prerequisite references must match the trusted tenant';
  }
  return undefined;
};
