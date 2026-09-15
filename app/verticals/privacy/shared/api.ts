/* eslint-disable oxc/no-barrel-file, sonarjs/no-wildcard-import -- The published Effect API entrypoint composes and exports the governed Privacy read contract. expires: 2027-03-31. */
// oxlint-disable-next-line typescript/consistent-type-imports -- The strict API boundary requires Schema in the framework value import so generated contracts remain visibly schema-backed. expires: 2027-03-31.
import { HttpApi, HttpApiEndpoint, HttpApiGroup, Schema } from '@modern-js/bff-effect/effect-client';
import {
  MicroVerticalBuildMarkerSchema,
  MicroVerticalReadinessSchema,
  createMicroVerticalOperationContext,
} from '@modern-js/bff-effect/microvertical-api';
import type { MicroVerticalOperationContext } from '@modern-js/bff-effect/microvertical-api';
import { identity } from 'effect';

// <generated-governed-http-api-imports>
import { AddProcessingPurposeVersionActionApi } from './apis/add-processing-purpose-version-action.ts';
import { ApplicabilityDecisionsApi } from './apis/applicability-decisions.ts';
import { AssignDsrResolverActionApi } from './apis/assign-dsr-resolver-action.ts';
import { AssignLegalBasisActionApi } from './apis/assign-legal-basis-action.ts';
import { AssignPrivacyResponsibilityActionApi } from './apis/assign-privacy-responsibility-action.ts';
import { CreateDsrCaseActionApi } from './apis/create-dsr-case-action.ts';
import { CreateNoticeVersionActionApi } from './apis/create-notice-version-action.ts';
import { CreatePrivacySubjectActionApi } from './apis/create-privacy-subject-action.ts';
import { CreateProcessingActivityActionApi } from './apis/create-processing-activity-action.ts';
import { CreateProcessingPurposeActionApi } from './apis/create-processing-purpose-action.ts';
import { CurrentConsentApi } from './apis/current-consent.ts';
import { DispatchPrivacyMeasureActionApi } from './apis/dispatch-privacy-measure-action.ts';
import { DsrCasesApi } from './apis/dsr-cases.ts';
import { EnqueueRetentionEvaluationActionApi } from './apis/enqueue-retention-evaluation-action.ts';
import { EvaluateProcessingEligibilityActionApi } from './apis/evaluate-processing-eligibility-action.ts';
import { IssueDsrDeliveryAccessActionApi } from './apis/issue-dsr-delivery-access-action.ts';
import { LegalBasisAssignmentsApi } from './apis/legal-basis-assignments.ts';
import { NoticeVersionsApi } from './apis/notice-versions.ts';
import { OwnerInventoryApi } from './apis/owner-inventory.ts';
import { PrivacySubjectsApi } from './apis/privacy-subjects.ts';
import { ProcessingActivitiesApi } from './apis/processing-activities.ts';
import { ProcessingEligibilityApi } from './apis/processing-eligibility.ts';
import { ProcessingPurposesApi } from './apis/processing-purposes.ts';
import { RecordAntiResurrectionProtectionActionApi } from './apis/record-anti-resurrection-protection-action.ts';
import { RecordApplicabilityPolicyActionApi } from './apis/record-applicability-policy-action.ts';
import { RecordConsentDecisionActionApi } from './apis/record-consent-decision-action.ts';
import { RecordDispositionDecisionActionApi } from './apis/record-disposition-decision-action.ts';
import { RecordDsrDeadlineActionApi } from './apis/record-dsr-deadline-action.ts';
import { RecordDsrDeliveryEvidenceActionApi } from './apis/record-dsr-delivery-evidence-action.ts';
import { RecordDsrResponseActionApi } from './apis/record-dsr-response-action.ts';
import { RecordDsrSubstantiveDecisionActionApi } from './apis/record-dsr-substantive-decision-action.ts';
import { RecordDsrVerificationActionApi } from './apis/record-dsr-verification-action.ts';
import { RecordExternalObligationActionApi } from './apis/record-external-obligation-action.ts';
import { RecordLegalHoldActionApi } from './apis/record-legal-hold-action.ts';
import { RecordNoticeProvisionActionApi } from './apis/record-notice-provision-action.ts';
import { RecordOwnerContributionActionApi } from './apis/record-owner-contribution-action.ts';
import { RecordOwnerExecutionOutcomeActionApi } from './apis/record-owner-execution-outcome-action.ts';
import { RecordPrivacyApplicabilityActionApi } from './apis/record-privacy-applicability-action.ts';
import { RecordPrivacyRepresentationActionApi } from './apis/record-privacy-representation-action.ts';
import { RecordProcessingInterventionActionApi } from './apis/record-processing-intervention-action.ts';
import { RecordRetentionExceptionActionApi } from './apis/record-retention-exception-action.ts';
import { ResponsibilityAssignmentsApi } from './apis/responsibility-assignments.ts';
import { RetentionRulesApi } from './apis/retention-rules.ts';
import { TransitionProcessingActivityActionApi } from './apis/transition-processing-activity-action.ts';
import { UpdateDsrCaseActionApi } from './apis/update-dsr-case-action.ts';
import { UpsertDsrOwnerTaskActionApi } from './apis/upsert-dsr-owner-task-action.ts';
import { UpsertRetentionRuleActionApi } from './apis/upsert-retention-rule-action.ts';
import { UpsertTemporaryDsrExportActionApi } from './apis/upsert-temporary-dsr-export-action.ts';
// </generated-governed-http-api-imports>

export * from './apis/applicability-decisions.ts';
export * from './apis/current-consent.ts';
export * from './apis/dsr-cases.ts';
export * from './apis/legal-basis-assignments.ts';
export * from './apis/notice-versions.ts';
export * from './apis/owner-inventory.ts';
export * from './apis/privacy-subjects.ts';
export * from './apis/processing-activities.ts';
export * from './apis/processing-eligibility.ts';
export * from './apis/processing-purposes.ts';
export * from './apis/responsibility-assignments.ts';
export * from './apis/retention-rules.ts';

export const privacyMarkerSchema: Schema.Codec<typeof MicroVerticalBuildMarkerSchema.Type> =
  MicroVerticalBuildMarkerSchema;
export type PrivacyMarker = typeof privacyMarkerSchema.Type;

export const privacyReadinessSchema: Schema.Codec<typeof MicroVerticalReadinessSchema.Type> =
  MicroVerticalReadinessSchema;
export type PrivacyReadiness = typeof privacyReadinessSchema.Type;

export type OperationContext = MicroVerticalOperationContext;

export const privacyFoundationApi = HttpApi.make('PrivacyApiFoundation').add(
  HttpApiGroup.make('foundation').add(
    HttpApiEndpoint.get('readiness', '/privacy/readiness', { success: privacyReadinessSchema }),
  ),
);

export const privacyApi = HttpApi.make('PrivacyApi')
  .addHttpApi(privacyFoundationApi)
  // <generated-governed-http-api-additions>
  .addHttpApi(AddProcessingPurposeVersionActionApi)
  .addHttpApi(ApplicabilityDecisionsApi)
  .addHttpApi(AssignDsrResolverActionApi)
  .addHttpApi(AssignLegalBasisActionApi)
  .addHttpApi(AssignPrivacyResponsibilityActionApi)
  .addHttpApi(CreateDsrCaseActionApi)
  .addHttpApi(CreateNoticeVersionActionApi)
  .addHttpApi(CreatePrivacySubjectActionApi)
  .addHttpApi(CreateProcessingActivityActionApi)
  .addHttpApi(CreateProcessingPurposeActionApi)
  .addHttpApi(CurrentConsentApi)
  .addHttpApi(DispatchPrivacyMeasureActionApi)
  .addHttpApi(DsrCasesApi)
  .addHttpApi(EnqueueRetentionEvaluationActionApi)
  .addHttpApi(EvaluateProcessingEligibilityActionApi)
  .addHttpApi(IssueDsrDeliveryAccessActionApi)
  .addHttpApi(LegalBasisAssignmentsApi)
  .addHttpApi(NoticeVersionsApi)
  .addHttpApi(OwnerInventoryApi)
  .addHttpApi(PrivacySubjectsApi)
  .addHttpApi(ProcessingActivitiesApi)
  .addHttpApi(ProcessingEligibilityApi)
  .addHttpApi(ProcessingPurposesApi)
  .addHttpApi(RecordAntiResurrectionProtectionActionApi)
  .addHttpApi(RecordApplicabilityPolicyActionApi)
  .addHttpApi(RecordConsentDecisionActionApi)
  .addHttpApi(RecordDispositionDecisionActionApi)
  .addHttpApi(RecordDsrDeadlineActionApi)
  .addHttpApi(RecordDsrDeliveryEvidenceActionApi)
  .addHttpApi(RecordDsrResponseActionApi)
  .addHttpApi(RecordDsrSubstantiveDecisionActionApi)
  .addHttpApi(RecordDsrVerificationActionApi)
  .addHttpApi(RecordExternalObligationActionApi)
  .addHttpApi(RecordLegalHoldActionApi)
  .addHttpApi(RecordNoticeProvisionActionApi)
  .addHttpApi(RecordOwnerContributionActionApi)
  .addHttpApi(RecordOwnerExecutionOutcomeActionApi)
  .addHttpApi(RecordPrivacyApplicabilityActionApi)
  .addHttpApi(RecordPrivacyRepresentationActionApi)
  .addHttpApi(RecordProcessingInterventionActionApi)
  .addHttpApi(RecordRetentionExceptionActionApi)
  .addHttpApi(ResponsibilityAssignmentsApi)
  .addHttpApi(RetentionRulesApi)
  .addHttpApi(TransitionProcessingActivityActionApi)
  .addHttpApi(UpdateDsrCaseActionApi)
  .addHttpApi(UpsertDsrOwnerTaskActionApi)
  .addHttpApi(UpsertRetentionRuleActionApi)
  .addHttpApi(UpsertTemporaryDsrExportActionApi)
  // </generated-governed-http-api-additions>
  .pipe(identity);

export const privacyOperationContexts = {
  readiness: createMicroVerticalOperationContext({
    method: 'GET',
    operationId: 'PrivacyApi:privacy:readiness',
    routePath: '/privacy/readiness',
  }),
} satisfies Record<string, OperationContext>;

export const privacyApiContract = {
  apiPrefix: '/privacy-api',
  basePath: '/privacy-api/privacy',
  ownerId: 'privacy',
  readinessPath: '/privacy-api/privacy/readiness',
} as const;
