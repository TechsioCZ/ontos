import { Effect } from '@modern-js/bff-effect/effect-client';
import { makeEffectBffClient } from '@app/shared-contracts/client-runtime';
import type { EffectBffRequestContext } from '@app/shared-contracts/client-runtime';
import type {
  HttpClientError,
  HttpApi,
  HttpApiClient,
  HttpApiGroup,
  Schema,
} from '@modern-js/bff-effect/effect-client';

import { privacyApiContract, privacyApi, privacyOperationContexts } from '../../shared/api.ts';
import type { PrivacyReadiness } from '../../shared/api.ts';

export { Effect } from '@modern-js/bff-effect/effect-client';
// <generated-action-http-client-exports>
export {
  executeAddProcessingPurposeVersionWithAuthorization,
  executeAddProcessingPurposeVersion,
} from './add-processing-purpose-version-action-client.ts';
export type { AddProcessingPurposeVersionActionClientOptions } from './add-processing-purpose-version-action-client.ts';
export {
  executeAssignDsrResolverWithAuthorization,
  executeAssignDsrResolver,
} from './assign-dsr-resolver-action-client.ts';
export type { AssignDsrResolverActionClientOptions } from './assign-dsr-resolver-action-client.ts';
export {
  executeAssignLegalBasisWithAuthorization,
  executeAssignLegalBasis,
} from './assign-legal-basis-action-client.ts';
export type { AssignLegalBasisActionClientOptions } from './assign-legal-basis-action-client.ts';
export {
  executeAssignPrivacyResponsibilityWithAuthorization,
  executeAssignPrivacyResponsibility,
} from './assign-privacy-responsibility-action-client.ts';
export type { AssignPrivacyResponsibilityActionClientOptions } from './assign-privacy-responsibility-action-client.ts';
export {
  executeConsentSelfServiceWithAuthorization,
  executeConsentSelfService,
} from './consent-self-service-action-client.ts';
export type { ConsentSelfServiceActionClientOptions } from './consent-self-service-action-client.ts';
export { executeCreateDsrCaseWithAuthorization, executeCreateDsrCase } from './create-dsr-case-action-client.ts';
export type { CreateDsrCaseActionClientOptions } from './create-dsr-case-action-client.ts';
export {
  executeCreateNoticeVersionWithAuthorization,
  executeCreateNoticeVersion,
} from './create-notice-version-action-client.ts';
export type { CreateNoticeVersionActionClientOptions } from './create-notice-version-action-client.ts';
export {
  executeCreatePrivacySubjectWithAuthorization,
  executeCreatePrivacySubject,
} from './create-privacy-subject-action-client.ts';
export type { CreatePrivacySubjectActionClientOptions } from './create-privacy-subject-action-client.ts';
export {
  executeCreateProcessingActivityWithAuthorization,
  executeCreateProcessingActivity,
} from './create-processing-activity-action-client.ts';
export type { CreateProcessingActivityActionClientOptions } from './create-processing-activity-action-client.ts';
export {
  executeCreateProcessingPurposeWithAuthorization,
  executeCreateProcessingPurpose,
} from './create-processing-purpose-action-client.ts';
export type { CreateProcessingPurposeActionClientOptions } from './create-processing-purpose-action-client.ts';
export {
  executeDispatchPrivacyMeasureWithAuthorization,
  executeDispatchPrivacyMeasure,
} from './dispatch-privacy-measure-action-client.ts';
export type { DispatchPrivacyMeasureActionClientOptions } from './dispatch-privacy-measure-action-client.ts';
export {
  executeEnqueueRetentionEvaluationWithAuthorization,
  executeEnqueueRetentionEvaluation,
} from './enqueue-retention-evaluation-action-client.ts';
export type { EnqueueRetentionEvaluationActionClientOptions } from './enqueue-retention-evaluation-action-client.ts';
export {
  executeEvaluateProcessingEligibilityWithAuthorization,
  executeEvaluateProcessingEligibility,
} from './evaluate-processing-eligibility-action-client.ts';
export type { EvaluateProcessingEligibilityActionClientOptions } from './evaluate-processing-eligibility-action-client.ts';
export {
  executeIssueDsrDeliveryAccessWithAuthorization,
  executeIssueDsrDeliveryAccess,
} from './issue-dsr-delivery-access-action-client.ts';
export type { IssueDsrDeliveryAccessActionClientOptions } from './issue-dsr-delivery-access-action-client.ts';
export {
  executeRecordAntiResurrectionProtectionWithAuthorization,
  executeRecordAntiResurrectionProtection,
} from './record-anti-resurrection-protection-action-client.ts';
export type { RecordAntiResurrectionProtectionActionClientOptions } from './record-anti-resurrection-protection-action-client.ts';
export {
  executeRecordApplicabilityPolicyWithAuthorization,
  executeRecordApplicabilityPolicy,
} from './record-applicability-policy-action-client.ts';
export type { RecordApplicabilityPolicyActionClientOptions } from './record-applicability-policy-action-client.ts';
export {
  executeRecordConsentDecisionWithAuthorization,
  executeRecordConsentDecision,
} from './record-consent-decision-action-client.ts';
export type { RecordConsentDecisionActionClientOptions } from './record-consent-decision-action-client.ts';
export {
  executeRecordDispositionDecisionWithAuthorization,
  executeRecordDispositionDecision,
} from './record-disposition-decision-action-client.ts';
export type { RecordDispositionDecisionActionClientOptions } from './record-disposition-decision-action-client.ts';
export {
  executeRecordDsrDeadlineWithAuthorization,
  executeRecordDsrDeadline,
} from './record-dsr-deadline-action-client.ts';
export type { RecordDsrDeadlineActionClientOptions } from './record-dsr-deadline-action-client.ts';
export {
  executeRecordDsrDeliveryEvidenceWithAuthorization,
  executeRecordDsrDeliveryEvidence,
} from './record-dsr-delivery-evidence-action-client.ts';
export type { RecordDsrDeliveryEvidenceActionClientOptions } from './record-dsr-delivery-evidence-action-client.ts';
export {
  executeRecordDsrResponseWithAuthorization,
  executeRecordDsrResponse,
} from './record-dsr-response-action-client.ts';
export type { RecordDsrResponseActionClientOptions } from './record-dsr-response-action-client.ts';
export {
  executeRecordDsrSubstantiveDecisionWithAuthorization,
  executeRecordDsrSubstantiveDecision,
} from './record-dsr-substantive-decision-action-client.ts';
export type { RecordDsrSubstantiveDecisionActionClientOptions } from './record-dsr-substantive-decision-action-client.ts';
export {
  executeRecordDsrVerificationWithAuthorization,
  executeRecordDsrVerification,
} from './record-dsr-verification-action-client.ts';
export type { RecordDsrVerificationActionClientOptions } from './record-dsr-verification-action-client.ts';
export {
  executeRecordExternalObligationWithAuthorization,
  executeRecordExternalObligation,
} from './record-external-obligation-action-client.ts';
export type { RecordExternalObligationActionClientOptions } from './record-external-obligation-action-client.ts';
export { executeRecordLegalHoldWithAuthorization, executeRecordLegalHold } from './record-legal-hold-action-client.ts';
export type { RecordLegalHoldActionClientOptions } from './record-legal-hold-action-client.ts';
export {
  executeRecordNoticeProvisionWithAuthorization,
  executeRecordNoticeProvision,
} from './record-notice-provision-action-client.ts';
export type { RecordNoticeProvisionActionClientOptions } from './record-notice-provision-action-client.ts';
export {
  executeRecordOwnerContributionWithAuthorization,
  executeRecordOwnerContribution,
} from './record-owner-contribution-action-client.ts';
export type { RecordOwnerContributionActionClientOptions } from './record-owner-contribution-action-client.ts';
export {
  executeRecordOwnerExecutionOutcomeWithAuthorization,
  executeRecordOwnerExecutionOutcome,
} from './record-owner-execution-outcome-action-client.ts';
export type { RecordOwnerExecutionOutcomeActionClientOptions } from './record-owner-execution-outcome-action-client.ts';
export {
  executeRecordPrivacyApplicabilityWithAuthorization,
  executeRecordPrivacyApplicability,
} from './record-privacy-applicability-action-client.ts';
export type { RecordPrivacyApplicabilityActionClientOptions } from './record-privacy-applicability-action-client.ts';
export {
  executeRecordPrivacyRepresentationWithAuthorization,
  executeRecordPrivacyRepresentation,
} from './record-privacy-representation-action-client.ts';
export type { RecordPrivacyRepresentationActionClientOptions } from './record-privacy-representation-action-client.ts';
export {
  executeRecordProcessingInterventionWithAuthorization,
  executeRecordProcessingIntervention,
} from './record-processing-intervention-action-client.ts';
export type { RecordProcessingInterventionActionClientOptions } from './record-processing-intervention-action-client.ts';
export {
  executeRecordRetentionExceptionWithAuthorization,
  executeRecordRetentionException,
} from './record-retention-exception-action-client.ts';
export type { RecordRetentionExceptionActionClientOptions } from './record-retention-exception-action-client.ts';
export {
  executeTransitionProcessingActivityWithAuthorization,
  executeTransitionProcessingActivity,
} from './transition-processing-activity-action-client.ts';
export type { TransitionProcessingActivityActionClientOptions } from './transition-processing-activity-action-client.ts';
export { executeUpdateDsrCaseWithAuthorization, executeUpdateDsrCase } from './update-dsr-case-action-client.ts';
export type { UpdateDsrCaseActionClientOptions } from './update-dsr-case-action-client.ts';
export {
  executeUpsertDsrOwnerTaskWithAuthorization,
  executeUpsertDsrOwnerTask,
} from './upsert-dsr-owner-task-action-client.ts';
export type { UpsertDsrOwnerTaskActionClientOptions } from './upsert-dsr-owner-task-action-client.ts';
export {
  executeUpsertRetentionRuleWithAuthorization,
  executeUpsertRetentionRule,
} from './upsert-retention-rule-action-client.ts';
export type { UpsertRetentionRuleActionClientOptions } from './upsert-retention-rule-action-client.ts';
export {
  executeUpsertTemporaryDsrExportWithAuthorization,
  executeUpsertTemporaryDsrExport,
} from './upsert-temporary-dsr-export-action-client.ts';
export type { UpsertTemporaryDsrExportActionClientOptions } from './upsert-temporary-dsr-export-action-client.ts';
// </generated-action-http-client-exports>

type PrivacyApiGroups = typeof privacyApi extends HttpApi.HttpApi<infer _ApiId, infer Groups> ? Groups : never;

export type PrivacyClient = HttpApiClient.Client<Extract<PrivacyApiGroups, HttpApiGroup.Constraint>>;

export type PrivacyClientError = HttpClientError.HttpClientError | Schema.SchemaError;

export type PrivacyClientEffect<Success> = Effect.Effect<Success, PrivacyClientError>;

export interface PrivacyClientOptions extends EffectBffRequestContext {
  baseUrl?: string | URL;
}

/* jscpd:ignore-start -- Generated client initialization intentionally follows the stable owner-client request-context protocol. */
export const createPrivacyClient = ({
  baseUrl,
  ...requestContext
}: PrivacyClientOptions = {}): PrivacyClientEffect<PrivacyClient> =>
  makeEffectBffClient({
    api: privacyApi,
    baseUrl: baseUrl ?? privacyApiContract.apiPrefix,
    defaultApiPrefix: privacyApiContract.apiPrefix,
    requestContext,
  });
/* jscpd:ignore-end */

export const getPrivacyReadiness = ({
  baseUrl,
  ...requestContext
}: PrivacyClientOptions = {}): PrivacyClientEffect<PrivacyReadiness> =>
  makeEffectBffClient({
    api: privacyApi,
    baseUrl: baseUrl ?? privacyApiContract.apiPrefix,
    defaultApiPrefix: privacyApiContract.apiPrefix,
    requestContext: {
      ...requestContext,
      operationContext: requestContext.operationContext ?? privacyOperationContexts.readiness,
    },
  }).pipe(Effect.flatMap((client) => client.foundation.readiness({})));
