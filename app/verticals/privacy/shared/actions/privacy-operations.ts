import { Schema } from 'effect';

import { TemporaryDsrExportSchema } from '../domain/dsr-delivery-access.ts';
import { ExternalObligationSchema } from '../domain/external-obligations.ts';
import {
  PrivacyApplicabilityPolicySchema,
  PrivacyApplicabilityScopeIntentSchema,
} from '../domain/privacy-applicability.ts';
import { ConsentDecisionSchema } from '../domain/privacy-consent-decision.ts';
import {
  DsrCaseLifecycleMutationSchema,
  DsrCaseRequestSchema,
  DsrOwnerTaskRequestSchema,
  DsrResolverAssignmentSchema,
  DsrResponseRequestSchema,
  DsrSubstantiveDecisionRequestSchema,
  DsrVerificationScopeSchema,
} from '../domain/privacy-dsr.ts';
import { PrivacyLegalBasisAssignmentInputSchema } from '../domain/privacy-legal-basis.ts';
import { OwnerExecutionOutcomeRequestSchema, PrivacyMeasureHandoffSchema } from '../domain/privacy-measure-handoff.ts';
import { OwnerContributionSchema } from '../domain/owner-contribution.ts';
import { CreatePrivacyNoticeVersionInputSchema } from '../domain/privacy-notice-version.ts';
import {
  IntendedProcessingScopeSchema,
  PrivacyEligibilityEvidenceSchema,
  PrivacyEligibilityOutcomeSchema,
} from '../domain/privacy-processing-eligibility.ts';
import { PrivacyResponsibilityAssignmentSchema } from '../domain/privacy-responsibility-assignment.ts';
import {
  PrivacyDispositionDecisionRequestSchema,
  RetentionEvaluationRequestSchema,
  RetentionProtectionRequestSchema,
} from '../domain/privacy-retention-disposition.ts';
import { PrivacyRetentionRuleUpsertRequestSchema } from '../domain/privacy-retention-rule.ts';
import { RepresentationSchema, PrivacyIsoTimestampSchema, PrivacySubjectSchema } from '../domain/privacy-subject.ts';
import { CreatePurposeVersionInputSchema } from '../domain/processing-purpose.ts';
import { PrivacySubjectRefSchema } from '../resources/privacy-subject.ts';
import { PrivacyResponsibilityAssignmentRefSchema } from '../resources/privacy-responsibility-assignment.ts';
import { ProcessingPurposeRefSchema } from '../resources/processing-purpose.ts';

const Ref = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(300));

export const CreatePrivacySubjectPayloadSchema = Schema.Struct({
  subject: PrivacySubjectSchema,
  subjectRef: PrivacySubjectRefSchema,
});
export type CreatePrivacySubjectPayload = typeof CreatePrivacySubjectPayloadSchema.Type;
export { PrivacySubjectRecordSchema as CreatePrivacySubjectResultSchema } from '../domain/privacy-subject.ts';

export const AssignPrivacyResponsibilityPayloadSchema = Schema.Struct({
  assignment: PrivacyResponsibilityAssignmentSchema,
});
export type AssignPrivacyResponsibilityPayload = typeof AssignPrivacyResponsibilityPayloadSchema.Type;
export { PrivacyResponsibilityAssignmentSchema as AssignPrivacyResponsibilityResultSchema } from '../domain/privacy-responsibility-assignment.ts';

export const RecordPrivacyApplicabilityPayloadSchema = Schema.Struct({
  decisionId: Schema.toEncoded(Ref.pipe(Schema.brand('PrivacyDecisionId'))),
  proposedActivity: Schema.Boolean,
  responsibilityAssignmentRefs: Schema.Array(PrivacyResponsibilityAssignmentRefSchema).check(Schema.isMaxLength(32)),
  scope: PrivacyApplicabilityScopeIntentSchema,
});
export type RecordPrivacyApplicabilityPayload = typeof RecordPrivacyApplicabilityPayloadSchema.Type;
export { PrivacyApplicabilityDecisionSchema as RecordPrivacyApplicabilityResultSchema } from '../domain/privacy-applicability.ts';

export const RecordPrivacyRepresentationPayloadSchema = Schema.Struct({
  representation: RepresentationSchema,
  representationId: Schema.toEncoded(Ref.pipe(Schema.brand('PrivacyRepresentationId'))),
});
export type RecordPrivacyRepresentationPayload = typeof RecordPrivacyRepresentationPayloadSchema.Type;
export { RepresentationSchema as RecordPrivacyRepresentationResultSchema } from '../domain/privacy-subject.ts';

export const RecordApplicabilityPolicyPayloadSchema = Schema.Struct({ policy: PrivacyApplicabilityPolicySchema });
export type RecordApplicabilityPolicyPayload = typeof RecordApplicabilityPolicyPayloadSchema.Type;
export { PrivacyApplicabilityPolicySchema as RecordApplicabilityPolicyResultSchema } from '../domain/privacy-applicability.ts';

export const RecordProcessingInterventionPayloadSchema = Schema.Struct({
  request: Schema.Struct({
    interventionRef: Ref,
    kind: Schema.Literals(['OBJECTION', 'RESTRICTION']),
    scope: IntendedProcessingScopeSchema,
  }),
});
export type RecordProcessingInterventionPayload = typeof RecordProcessingInterventionPayloadSchema.Type;
export { PrivacyProcessingInterventionSchema as RecordProcessingInterventionResultSchema } from '../domain/privacy-processing-eligibility.ts';

export const AddProcessingPurposeVersionPayloadSchema = Schema.Struct({
  purposeRef: ProcessingPurposeRefSchema,
  version: CreatePurposeVersionInputSchema,
});
export type AddProcessingPurposeVersionPayload = typeof AddProcessingPurposeVersionPayloadSchema.Type;
export { ProcessingPurposeSchema as AddProcessingPurposeVersionResultSchema } from '../domain/processing-purpose.ts';

export const AssignLegalBasisPayloadSchema = Schema.Struct({ assignment: PrivacyLegalBasisAssignmentInputSchema });
export type AssignLegalBasisPayload = typeof AssignLegalBasisPayloadSchema.Type;
export { PrivacyLegalBasisAssignmentSchema as AssignLegalBasisResultSchema } from '../domain/privacy-legal-basis.ts';

export const CreateNoticeVersionPayloadSchema = Schema.Struct({
  input: CreatePrivacyNoticeVersionInputSchema,
  noticeId: Schema.toEncoded(Schema.String.check(Schema.isUUID()).pipe(Schema.brand('PrivacyNoticeId'))),
});
export type CreateNoticeVersionPayload = typeof CreateNoticeVersionPayloadSchema.Type;
export { PrivacyNoticeVersionSchema as CreateNoticeVersionResultSchema } from '../domain/privacy-notice-version.ts';

export const RecordConsentDecisionPayloadSchema = Schema.Struct({ decision: ConsentDecisionSchema });
export type RecordConsentDecisionPayload = typeof RecordConsentDecisionPayloadSchema.Type;
export { ConsentDecisionSchema as RecordConsentDecisionResultSchema } from '../domain/privacy-consent-decision.ts';

export const EvaluateProcessingEligibilityPayloadSchema = Schema.Struct({
  evidenceId: Schema.toEncoded(Ref.pipe(Schema.brand('PrivacyEvidenceId'))),
  intendedScope: IntendedProcessingScopeSchema,
});
export type EvaluateProcessingEligibilityPayload = typeof EvaluateProcessingEligibilityPayloadSchema.Type;
export const EvaluateProcessingEligibilityResultSchema = Schema.Struct({
  evidence: PrivacyEligibilityEvidenceSchema,
  evidenceId: Schema.toEncoded(Ref.pipe(Schema.brand('PrivacyEvidenceId'))),
  outcome: PrivacyEligibilityOutcomeSchema,
});

export const UpsertRetentionRulePayloadSchema = Schema.Struct({ request: PrivacyRetentionRuleUpsertRequestSchema });
export type UpsertRetentionRulePayload = typeof UpsertRetentionRulePayloadSchema.Type;
export { PrivacyRetentionRuleVersionSchema as UpsertRetentionRuleResultSchema } from '../domain/privacy-retention-rule.ts';

export const RecordRetentionExceptionPayloadSchema = Schema.Struct({
  exception: RetentionProtectionRequestSchema,
});
export type RecordRetentionExceptionPayload = typeof RecordRetentionExceptionPayloadSchema.Type;
export { RetentionExceptionSchema as RecordRetentionExceptionResultSchema } from '../domain/privacy-retention-disposition.ts';

export const RecordLegalHoldPayloadSchema = Schema.Struct({ hold: RetentionProtectionRequestSchema });
export type RecordLegalHoldPayload = typeof RecordLegalHoldPayloadSchema.Type;
export { PrivacyLegalHoldSchema as RecordLegalHoldResultSchema } from '../domain/privacy-retention-disposition.ts';

export const RecordDispositionDecisionPayloadSchema = Schema.Struct({
  request: PrivacyDispositionDecisionRequestSchema,
});
export type RecordDispositionDecisionPayload = typeof RecordDispositionDecisionPayloadSchema.Type;
export { PrivacyDispositionDecisionSchema as RecordDispositionDecisionResultSchema } from '../domain/privacy-retention-disposition.ts';

export const CreateDsrCasePayloadSchema = Schema.Struct({ request: DsrCaseRequestSchema });
export type CreateDsrCasePayload = typeof CreateDsrCasePayloadSchema.Type;
export { DsrCaseSchema as CreateDsrCaseResultSchema } from '../domain/privacy-dsr.ts';

export const UpdateDsrCasePayloadSchema = Schema.Struct({
  expectedUpdatedAt: Schema.toEncoded(Schema.OptionFromNullOr(PrivacyIsoTimestampSchema)),
  mutation: DsrCaseLifecycleMutationSchema,
});
export type UpdateDsrCasePayload = typeof UpdateDsrCasePayloadSchema.Type;
export { DsrCaseSchema as UpdateDsrCaseResultSchema } from '../domain/privacy-dsr.ts';

export const RecordDsrVerificationPayloadSchema = Schema.Struct({
  caseRef: Ref,
  evidenceRefs: Schema.Array(Ref).check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  scope: DsrVerificationScopeSchema,
  subjectRef: Ref,
  verification: Schema.optional(Schema.Never),
  verificationRef: Ref,
});
export type RecordDsrVerificationPayload = typeof RecordDsrVerificationPayloadSchema.Type;
export { DsrVerificationSchema as RecordDsrVerificationResultSchema } from '../domain/privacy-dsr.ts';

export const AssignDsrResolverPayloadSchema = Schema.Struct({ assignment: DsrResolverAssignmentSchema });
export type AssignDsrResolverPayload = typeof AssignDsrResolverPayloadSchema.Type;
export { DsrResolverAssignmentSchema as AssignDsrResolverResultSchema } from '../domain/privacy-dsr.ts';

export const RecordDsrDeadlinePayloadSchema = Schema.Struct({
  caseRef: Ref,
  controllerRef: Ref,
  deadline: Schema.optional(Schema.Never),
});
export type RecordDsrDeadlinePayload = typeof RecordDsrDeadlinePayloadSchema.Type;
export { DsrDeadlineSchema as RecordDsrDeadlineResultSchema } from '../domain/privacy-dsr.ts';

export const RecordDsrSubstantiveDecisionPayloadSchema = Schema.Struct({
  request: DsrSubstantiveDecisionRequestSchema,
});
export type RecordDsrSubstantiveDecisionPayload = typeof RecordDsrSubstantiveDecisionPayloadSchema.Type;
export { DsrSubstantiveDecisionSchema as RecordDsrSubstantiveDecisionResultSchema } from '../domain/privacy-dsr.ts';

export const UpsertDsrOwnerTaskPayloadSchema = Schema.Struct({ request: DsrOwnerTaskRequestSchema });
export type UpsertDsrOwnerTaskPayload = typeof UpsertDsrOwnerTaskPayloadSchema.Type;
export { DsrOwnerTaskSchema as UpsertDsrOwnerTaskResultSchema } from '../domain/privacy-dsr.ts';

export const RecordDsrResponsePayloadSchema = Schema.Struct({ response: DsrResponseRequestSchema });
export type RecordDsrResponsePayload = typeof RecordDsrResponsePayloadSchema.Type;
export { DsrResponseSchema as RecordDsrResponseResultSchema } from '../domain/privacy-dsr.ts';

export const RecordOwnerContributionPayloadSchema = Schema.Struct({ contribution: OwnerContributionSchema });
export type RecordOwnerContributionPayload = typeof RecordOwnerContributionPayloadSchema.Type;
export { OwnerContributionSchema as RecordOwnerContributionResultSchema } from '../domain/owner-contribution.ts';

export const DispatchPrivacyMeasurePayloadSchema = Schema.Struct({ handoff: PrivacyMeasureHandoffSchema });
export type DispatchPrivacyMeasurePayload = typeof DispatchPrivacyMeasurePayloadSchema.Type;
export { PrivacyMeasureHandoffSchema as DispatchPrivacyMeasureResultSchema } from '../domain/privacy-measure-handoff.ts';

export const RecordOwnerExecutionOutcomePayloadSchema = Schema.Struct({ request: OwnerExecutionOutcomeRequestSchema });
export type RecordOwnerExecutionOutcomePayload = typeof RecordOwnerExecutionOutcomePayloadSchema.Type;
export { OwnerExecutionOutcomeSchema as RecordOwnerExecutionOutcomeResultSchema } from '../domain/privacy-measure-handoff.ts';

export const IssueDsrDeliveryAccessPayloadSchema = Schema.Struct({ requestRef: Ref });
export type IssueDsrDeliveryAccessPayload = typeof IssueDsrDeliveryAccessPayloadSchema.Type;
export { DsrDeliveryAccessSchema as IssueDsrDeliveryAccessResultSchema } from '../domain/dsr-delivery-access.ts';

export const RecordDsrDeliveryEvidencePayloadSchema = Schema.Struct({
  accessId: Schema.toEncoded(Ref.pipe(Schema.brand('PrivacyAccessId'))),
  deliveryClaimRef: Ref,
  evidence: Schema.optional(Schema.Never),
});
export type RecordDsrDeliveryEvidencePayload = typeof RecordDsrDeliveryEvidencePayloadSchema.Type;
export { DsrDeliveryEvidenceSchema as RecordDsrDeliveryEvidenceResultSchema } from '../domain/dsr-delivery-access.ts';

export const UpsertTemporaryDsrExportPayloadSchema = Schema.Struct({ temporaryExport: TemporaryDsrExportSchema });
export type UpsertTemporaryDsrExportPayload = typeof UpsertTemporaryDsrExportPayloadSchema.Type;
export { TemporaryDsrExportSchema as UpsertTemporaryDsrExportResultSchema } from '../domain/dsr-delivery-access.ts';

export const RecordExternalObligationPayloadSchema = Schema.Struct({ obligation: ExternalObligationSchema });
export type RecordExternalObligationPayload = typeof RecordExternalObligationPayloadSchema.Type;
export { ExternalObligationSchema as RecordExternalObligationResultSchema } from '../domain/external-obligations.ts';

export const RecordAntiResurrectionProtectionPayloadSchema = Schema.Struct({
  request: OwnerExecutionOutcomeRequestSchema,
});
export type RecordAntiResurrectionProtectionPayload = typeof RecordAntiResurrectionProtectionPayloadSchema.Type;
export { AntiResurrectionProtectionSchema as RecordAntiResurrectionProtectionResultSchema } from '../domain/anti-resurrection.ts';

export const EnqueueRetentionEvaluationPayloadSchema = Schema.Struct({ request: RetentionEvaluationRequestSchema });
export type EnqueueRetentionEvaluationPayload = typeof EnqueueRetentionEvaluationPayloadSchema.Type;
export { RetentionEvaluationWorkSchema as EnqueueRetentionEvaluationResultSchema } from '../domain/privacy-retention-disposition.ts';
