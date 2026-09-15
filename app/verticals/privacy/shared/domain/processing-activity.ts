/* eslint-disable effect-native/no-unbranded-identifier-schema -- Privacy cross-owner wire contracts preserve explicit JSON null, canonical UTC string encodings, and owner-issued opaque references; generated API and Resource boundaries validate provenance without a misleading shared brand. expires: 2027-03-31. */
import { PrincipalRefSchema } from '@app/core-runtime';
import { Schema } from 'effect';

import { PrivacyApplicabilityDecisionSchema, PrivacyApplicabilityScopeSchema } from './privacy-applicability.ts';
import {
  PersonalDataCoverageSchema,
  ProcessingRecipientTransferSchema,
  ProcessingRetentionReferenceSchema,
} from './processing-coverage.ts';
import { PrivacyIsoTimestampSchema } from './privacy-subject.ts';
import { PrivacyResponsibilityAssignmentRefSchema } from '../resources/privacy-responsibility-assignment.ts';
import { ProcessingActivityRefSchema } from '../resources/processing-activity.ts';
import { ProcessingPurposeRefSchema } from '../resources/processing-purpose.ts';

const Text = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(500));
const ReferenceList = Schema.Array(Text).check(Schema.isMaxLength(64));
const Uuid = Schema.String.check(Schema.isUUID());

export const ProcessingActivityLifecycleSchema = Schema.Literals(['PROPOSED', 'EFFECTIVE', 'SUSPENDED', 'ENDED']);
export type ProcessingActivityLifecycle = typeof ProcessingActivityLifecycleSchema.Type;

export const ProcessingActivityLifecycleEventSchema = Schema.Struct({
  actor: PrincipalRefSchema,
  decisionEvidenceRefs: Schema.Array(Text).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
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
  dataCategoryRefs: ReferenceList,
  dataCoverage: Schema.Array(PersonalDataCoverageSchema).check(Schema.isMaxLength(64)),
  legalBasisAssignmentRefs: ReferenceList,
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
  recipientRefs: ReferenceList,
  recipientTransfers: Schema.Array(ProcessingRecipientTransferSchema).check(Schema.isMaxLength(64)),
  retentionCoverage: Schema.Array(ProcessingRetentionReferenceSchema).check(Schema.isMaxLength(64)),
  retentionRuleRefs: ReferenceList,
  systemOfRecordRefs: ReferenceList,
  updatedAt: PrivacyIsoTimestampSchema,
});
export type ProcessingActivity = typeof ProcessingActivitySchema.Type;

export const CreateProcessingActivityInputSchema = Schema.Struct({
  activityRef: Schema.optionalKey(ProcessingActivityRefSchema),
  applicabilityDecisions: Schema.optionalKey(
    Schema.Array(PrivacyApplicabilityDecisionSchema).check(Schema.isMaxLength(32)),
  ),
  dataCategoryRefs: Schema.optionalKey(ReferenceList),
  dataCoverage: Schema.optionalKey(Schema.Array(PersonalDataCoverageSchema).check(Schema.isMaxLength(64))),
  legalBasisAssignmentRefs: Schema.optionalKey(ReferenceList),
  processingScope: Schema.Struct({
    applicabilityScope: PrivacyApplicabilityScopeSchema,
    purposeRef: ProcessingPurposeRefSchema,
    purposeVersionId: Uuid,
    responsibilityAssignmentRefs: Schema.Array(PrivacyResponsibilityAssignmentRefSchema).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(32),
    ),
  }),
  recipientRefs: Schema.optionalKey(ReferenceList),
  recipientTransfers: Schema.optionalKey(Schema.Array(ProcessingRecipientTransferSchema).check(Schema.isMaxLength(64))),
  retentionCoverage: Schema.optionalKey(Schema.Array(ProcessingRetentionReferenceSchema).check(Schema.isMaxLength(64))),
  retentionRuleRefs: Schema.optionalKey(ReferenceList),
  systemOfRecordRefs: Schema.optionalKey(ReferenceList),
});
export type CreateProcessingActivityInput = typeof CreateProcessingActivityInputSchema.Type;
