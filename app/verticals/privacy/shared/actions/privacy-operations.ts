/* eslint-disable effect-native/no-nullable-schema-field, effect-native/no-unbranded-identifier-schema -- Public privacy operations carry owner-issued opaque references and explicit absence across generated Action transports. expires: 2027-03-31. */
/* oxlint-disable unicorn/prefer-export-from -- Action-specific result schema names intentionally bind canonical domain schemas into the generated operation contract. expires: 2027-03-31. */
import { Schema } from 'effect';

import { AntiResurrectionProtectionSchema } from '../domain/anti-resurrection.ts';
import {
  DsrDeliveryAccessSchema,
  DsrDeliveryEvidenceSchema,
  TemporaryDsrExportSchema,
} from '../domain/dsr-delivery-access.ts';
import { ExternalObligationSchema } from '../domain/external-obligations.ts';
import {
  PrivacyApplicabilityDecisionSchema,
  PrivacyApplicabilityPolicySchema,
  PrivacyApplicabilityScopeIntentSchema,
} from '../domain/privacy-applicability.ts';
import { ConsentDecisionSchema } from '../domain/privacy-consent-decision.ts';
import {
  DsrCaseSchema,
  DsrCaseLifecycleMutationSchema,
  DsrCaseRequestSchema,
  DsrDeadlineSchema,
  DsrOwnerTaskRequestSchema,
  DsrOwnerTaskSchema,
  DsrResolverAssignmentSchema,
  DsrResponseRequestSchema,
  DsrResponseSchema,
  DsrSubstantiveDecisionRequestSchema,
  DsrSubstantiveDecisionSchema,
  DsrVerificationSchema,
  DsrVerificationScopeSchema,
} from '../domain/privacy-dsr.ts';
import {
  PrivacyLegalBasisAssignmentInputSchema,
  PrivacyLegalBasisAssignmentSchema,
} from '../domain/privacy-legal-basis.ts';
import {
  OwnerExecutionOutcomeRequestSchema,
  OwnerExecutionOutcomeSchema,
  PrivacyMeasureHandoffSchema,
} from '../domain/privacy-measure-handoff.ts';
import { OwnerContributionSchema } from '../domain/owner-contribution.ts';
import { CreatePrivacyNoticeVersionInputSchema, PrivacyNoticeVersionSchema } from '../domain/privacy-notice-version.ts';
import {
  IntendedProcessingScopeSchema,
  PrivacyEligibilityEvidenceSchema,
  PrivacyEligibilityOutcomeSchema,
  PrivacyProcessingInterventionSchema,
} from '../domain/privacy-processing-eligibility.ts';
import { PrivacyResponsibilityAssignmentSchema } from '../domain/privacy-responsibility-assignment.ts';
import {
  PrivacyDispositionDecisionSchema,
  PrivacyDispositionDecisionRequestSchema,
  PrivacyLegalHoldSchema,
  RetentionEvaluationRequestSchema,
  RetentionEvaluationWorkSchema,
  RetentionProtectionRequestSchema,
  RetentionExceptionSchema,
} from '../domain/privacy-retention-disposition.ts';
import {
  PrivacyRetentionRuleUpsertRequestSchema,
  PrivacyRetentionRuleVersionSchema,
} from '../domain/privacy-retention-rule.ts';
import {
  RepresentationSchema,
  PrivacyIsoTimestampSchema,
  PrivacySubjectRecordSchema,
  PrivacySubjectSchema,
} from '../domain/privacy-subject.ts';
import { CreatePurposeVersionInputSchema, ProcessingPurposeSchema } from '../domain/processing-purpose.ts';
import { PrivacySubjectRefSchema } from '../resources/privacy-subject.ts';
import { PrivacyResponsibilityAssignmentRefSchema } from '../resources/privacy-responsibility-assignment.ts';
import { ProcessingPurposeRefSchema } from '../resources/processing-purpose.ts';

const Ref = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(300));

export const CreatePrivacySubjectPayloadSchema = Schema.Struct({
  subject: PrivacySubjectSchema,
  subjectRef: PrivacySubjectRefSchema,
});
export type CreatePrivacySubjectPayload = typeof CreatePrivacySubjectPayloadSchema.Type;
export const CreatePrivacySubjectResultSchema = PrivacySubjectRecordSchema;

export const AssignPrivacyResponsibilityPayloadSchema = Schema.Struct({
  assignment: PrivacyResponsibilityAssignmentSchema,
});
export type AssignPrivacyResponsibilityPayload = typeof AssignPrivacyResponsibilityPayloadSchema.Type;
export const AssignPrivacyResponsibilityResultSchema = PrivacyResponsibilityAssignmentSchema;

export const RecordPrivacyApplicabilityPayloadSchema = Schema.Struct({
  decisionId: Ref,
  proposedActivity: Schema.Boolean,
  responsibilityAssignmentRefs: Schema.Array(PrivacyResponsibilityAssignmentRefSchema).check(Schema.isMaxLength(32)),
  scope: PrivacyApplicabilityScopeIntentSchema,
});
export type RecordPrivacyApplicabilityPayload = typeof RecordPrivacyApplicabilityPayloadSchema.Type;
export const RecordPrivacyApplicabilityResultSchema = PrivacyApplicabilityDecisionSchema;

export const RecordPrivacyRepresentationPayloadSchema = Schema.Struct({
  representation: RepresentationSchema,
  representationId: Ref,
});
export type RecordPrivacyRepresentationPayload = typeof RecordPrivacyRepresentationPayloadSchema.Type;
export const RecordPrivacyRepresentationResultSchema = RepresentationSchema;

export const RecordApplicabilityPolicyPayloadSchema = Schema.Struct({ policy: PrivacyApplicabilityPolicySchema });
export type RecordApplicabilityPolicyPayload = typeof RecordApplicabilityPolicyPayloadSchema.Type;
export const RecordApplicabilityPolicyResultSchema = PrivacyApplicabilityPolicySchema;

export const RecordProcessingInterventionPayloadSchema = Schema.Struct({
  request: Schema.Struct({
    interventionRef: Ref,
    kind: Schema.Literals(['OBJECTION', 'RESTRICTION']),
    scope: IntendedProcessingScopeSchema,
  }),
});
export type RecordProcessingInterventionPayload = typeof RecordProcessingInterventionPayloadSchema.Type;
export const RecordProcessingInterventionResultSchema = PrivacyProcessingInterventionSchema;

export const AddProcessingPurposeVersionPayloadSchema = Schema.Struct({
  purposeRef: ProcessingPurposeRefSchema,
  version: CreatePurposeVersionInputSchema,
});
export type AddProcessingPurposeVersionPayload = typeof AddProcessingPurposeVersionPayloadSchema.Type;
export const AddProcessingPurposeVersionResultSchema = ProcessingPurposeSchema;

export const AssignLegalBasisPayloadSchema = Schema.Struct({ assignment: PrivacyLegalBasisAssignmentInputSchema });
export type AssignLegalBasisPayload = typeof AssignLegalBasisPayloadSchema.Type;
export const AssignLegalBasisResultSchema = PrivacyLegalBasisAssignmentSchema;

export const CreateNoticeVersionPayloadSchema = Schema.Struct({
  input: CreatePrivacyNoticeVersionInputSchema,
  noticeId: Schema.String.check(Schema.isUUID()),
});
export type CreateNoticeVersionPayload = typeof CreateNoticeVersionPayloadSchema.Type;
export const CreateNoticeVersionResultSchema = PrivacyNoticeVersionSchema;

export const RecordConsentDecisionPayloadSchema = Schema.Struct({ decision: ConsentDecisionSchema });
export type RecordConsentDecisionPayload = typeof RecordConsentDecisionPayloadSchema.Type;
export const RecordConsentDecisionResultSchema = ConsentDecisionSchema;

export const EvaluateProcessingEligibilityPayloadSchema = Schema.Struct({
  evidenceId: Ref,
  intendedScope: IntendedProcessingScopeSchema,
});
export type EvaluateProcessingEligibilityPayload = typeof EvaluateProcessingEligibilityPayloadSchema.Type;
export const EvaluateProcessingEligibilityResultSchema = Schema.Struct({
  evidence: PrivacyEligibilityEvidenceSchema,
  evidenceId: Ref,
  outcome: PrivacyEligibilityOutcomeSchema,
});

export const UpsertRetentionRulePayloadSchema = Schema.Struct({ request: PrivacyRetentionRuleUpsertRequestSchema });
export type UpsertRetentionRulePayload = typeof UpsertRetentionRulePayloadSchema.Type;
export const UpsertRetentionRuleResultSchema = PrivacyRetentionRuleVersionSchema;

export const RecordRetentionExceptionPayloadSchema = Schema.Struct({
  exception: RetentionProtectionRequestSchema,
});
export type RecordRetentionExceptionPayload = typeof RecordRetentionExceptionPayloadSchema.Type;
export const RecordRetentionExceptionResultSchema = RetentionExceptionSchema;

export const RecordLegalHoldPayloadSchema = Schema.Struct({ hold: RetentionProtectionRequestSchema });
export type RecordLegalHoldPayload = typeof RecordLegalHoldPayloadSchema.Type;
export const RecordLegalHoldResultSchema = PrivacyLegalHoldSchema;

export const RecordDispositionDecisionPayloadSchema = Schema.Struct({
  request: PrivacyDispositionDecisionRequestSchema,
});
export type RecordDispositionDecisionPayload = typeof RecordDispositionDecisionPayloadSchema.Type;
export const RecordDispositionDecisionResultSchema = PrivacyDispositionDecisionSchema;

export const CreateDsrCasePayloadSchema = Schema.Struct({ request: DsrCaseRequestSchema });
export type CreateDsrCasePayload = typeof CreateDsrCasePayloadSchema.Type;
export const CreateDsrCaseResultSchema = DsrCaseSchema;

export const UpdateDsrCasePayloadSchema = Schema.Struct({
  expectedUpdatedAt: Schema.NullOr(PrivacyIsoTimestampSchema),
  mutation: DsrCaseLifecycleMutationSchema,
});
export type UpdateDsrCasePayload = typeof UpdateDsrCasePayloadSchema.Type;
export const UpdateDsrCaseResultSchema = DsrCaseSchema;

export const RecordDsrVerificationPayloadSchema = Schema.Struct({
  caseRef: Ref,
  evidenceRefs: Schema.Array(Ref).check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  scope: DsrVerificationScopeSchema,
  subjectRef: Ref,
  verification: Schema.optional(Schema.Never),
  verificationRef: Ref,
});
export type RecordDsrVerificationPayload = typeof RecordDsrVerificationPayloadSchema.Type;
export const RecordDsrVerificationResultSchema = DsrVerificationSchema;

export const AssignDsrResolverPayloadSchema = Schema.Struct({ assignment: DsrResolverAssignmentSchema });
export type AssignDsrResolverPayload = typeof AssignDsrResolverPayloadSchema.Type;
export const AssignDsrResolverResultSchema = DsrResolverAssignmentSchema;

export const RecordDsrDeadlinePayloadSchema = Schema.Struct({
  caseRef: Ref,
  controllerRef: Ref,
  deadline: Schema.optional(Schema.Never),
});
export type RecordDsrDeadlinePayload = typeof RecordDsrDeadlinePayloadSchema.Type;
export const RecordDsrDeadlineResultSchema = DsrDeadlineSchema;

export const RecordDsrSubstantiveDecisionPayloadSchema = Schema.Struct({
  request: DsrSubstantiveDecisionRequestSchema,
});
export type RecordDsrSubstantiveDecisionPayload = typeof RecordDsrSubstantiveDecisionPayloadSchema.Type;
export const RecordDsrSubstantiveDecisionResultSchema = DsrSubstantiveDecisionSchema;

export const UpsertDsrOwnerTaskPayloadSchema = Schema.Struct({ request: DsrOwnerTaskRequestSchema });
export type UpsertDsrOwnerTaskPayload = typeof UpsertDsrOwnerTaskPayloadSchema.Type;
export const UpsertDsrOwnerTaskResultSchema = DsrOwnerTaskSchema;

export const RecordDsrResponsePayloadSchema = Schema.Struct({ response: DsrResponseRequestSchema });
export type RecordDsrResponsePayload = typeof RecordDsrResponsePayloadSchema.Type;
export const RecordDsrResponseResultSchema = DsrResponseSchema;

export const RecordOwnerContributionPayloadSchema = Schema.Struct({ contribution: OwnerContributionSchema });
export type RecordOwnerContributionPayload = typeof RecordOwnerContributionPayloadSchema.Type;
export const RecordOwnerContributionResultSchema = OwnerContributionSchema;

export const DispatchPrivacyMeasurePayloadSchema = Schema.Struct({ handoff: PrivacyMeasureHandoffSchema });
export type DispatchPrivacyMeasurePayload = typeof DispatchPrivacyMeasurePayloadSchema.Type;
export const DispatchPrivacyMeasureResultSchema = PrivacyMeasureHandoffSchema;

export const RecordOwnerExecutionOutcomePayloadSchema = Schema.Struct({ request: OwnerExecutionOutcomeRequestSchema });
export type RecordOwnerExecutionOutcomePayload = typeof RecordOwnerExecutionOutcomePayloadSchema.Type;
export const RecordOwnerExecutionOutcomeResultSchema = OwnerExecutionOutcomeSchema;

export const IssueDsrDeliveryAccessPayloadSchema = Schema.Struct({ requestRef: Ref });
export type IssueDsrDeliveryAccessPayload = typeof IssueDsrDeliveryAccessPayloadSchema.Type;
export const IssueDsrDeliveryAccessResultSchema = DsrDeliveryAccessSchema;

export const RecordDsrDeliveryEvidencePayloadSchema = Schema.Struct({
  accessId: Ref,
  deliveryClaimRef: Ref,
  evidence: Schema.optional(Schema.Never),
});
export type RecordDsrDeliveryEvidencePayload = typeof RecordDsrDeliveryEvidencePayloadSchema.Type;
export const RecordDsrDeliveryEvidenceResultSchema = DsrDeliveryEvidenceSchema;

export const UpsertTemporaryDsrExportPayloadSchema = Schema.Struct({ temporaryExport: TemporaryDsrExportSchema });
export type UpsertTemporaryDsrExportPayload = typeof UpsertTemporaryDsrExportPayloadSchema.Type;
export const UpsertTemporaryDsrExportResultSchema = TemporaryDsrExportSchema;

export const RecordExternalObligationPayloadSchema = Schema.Struct({ obligation: ExternalObligationSchema });
export type RecordExternalObligationPayload = typeof RecordExternalObligationPayloadSchema.Type;
export const RecordExternalObligationResultSchema = ExternalObligationSchema;

export const RecordAntiResurrectionProtectionPayloadSchema = Schema.Struct({
  request: OwnerExecutionOutcomeRequestSchema,
});
export type RecordAntiResurrectionProtectionPayload = typeof RecordAntiResurrectionProtectionPayloadSchema.Type;
export const RecordAntiResurrectionProtectionResultSchema = AntiResurrectionProtectionSchema;

export const EnqueueRetentionEvaluationPayloadSchema = Schema.Struct({ request: RetentionEvaluationRequestSchema });
export type EnqueueRetentionEvaluationPayload = typeof EnqueueRetentionEvaluationPayloadSchema.Type;
export const EnqueueRetentionEvaluationResultSchema = RetentionEvaluationWorkSchema;
