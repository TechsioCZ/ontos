/* oxlint-disable effect-native/no-wide-factory-signature -- The owner repository port explicitly carries trusted Tenant/Legal Entity scope, Action invocation identity, resource identity, and decoded input. expires: 2027-03-31. */
import type { Effect, Option } from 'effect';
import { Schema } from 'effect';

import type {
  AntiResurrectionEnforcementReceipt,
  AntiResurrectionProtection,
} from '../../shared/domain/anti-resurrection.ts';
import type {
  DsrDeliveryAccess,
  DsrDeliveryAccessAuthorityResult,
  DsrDeliveryEvidence,
  TemporaryDsrExport,
} from '../../shared/domain/dsr-delivery-access.ts';
import type { ExternalObligation } from '../../shared/domain/external-obligations.ts';
import type { OwnerContribution } from '../../shared/domain/owner-contribution.ts';
import type {
  PrivacyApplicabilityDecision,
  PrivacyApplicabilityEligibilityAuthorityResult,
  PrivacyApplicabilityPolicy,
} from '../../shared/domain/privacy-applicability.ts';
import type { ConsentCurrentResolution, ConsentDecision } from '../../shared/domain/privacy-consent-decision.ts';
import type {
  DsrCase,
  DsrCaseLifecycleMutation,
  DsrDeadline,
  DsrOwnerInventoryAuthorityResult,
  DsrDeadlinePolicy,
  DsrOwnerTaskAuthorityResult,
  DsrOwnerTask,
  DsrResolverAssignment,
  DsrResponse,
  DsrResponseRequest,
  DsrSubstantiveDecision,
  DsrSubstantiveDecisionAuthorityResult,
  DsrVerification,
} from '../../shared/domain/privacy-dsr.ts';
import type { PrivacyLegalBasisAssignment } from '../../shared/domain/privacy-legal-basis.ts';
import type {
  OwnerExecutionAuthorityResult,
  OwnerExecutionOutcome,
  OwnerExecutionOutcomeRequest,
  PrivacyMeasureHandoff,
} from '../../shared/domain/privacy-measure-handoff.ts';
import type {
  CreatePrivacyNoticeVersionInput,
  PrivacyNoticeVersion,
} from '../../shared/domain/privacy-notice-version.ts';
import type {
  PrivacyEligibilityAuthoritativeReference,
  PrivacyEligibilityEvidence,
  PrivacyEligibilityOutcome,
  PrivacyEligibilityPolicyRevision,
  PrivacyProcessingIntervention,
  ResolvePrivacyEligibilityInputsInput,
  ProcessingInterventionAuthorityResult,
} from '../../shared/domain/privacy-processing-eligibility.ts';
import type { PrivacyResponsibilityAssignmentSchema } from '../../shared/domain/privacy-responsibility-assignment.ts';
import type {
  PrivacyDispositionDecision,
  PrivacyDispositionDecisionAuthorityResult,
  PrivacyLegalHold,
  RetentionProtectionRequest,
  RetentionEvaluation,
  RetentionEvaluationRequest,
  RetentionEvaluationWork,
  RetentionException,
} from '../../shared/domain/privacy-retention-disposition.ts';
import type {
  PrivacyRetentionRuleVersion,
  RetentionRuleAuthorityResolution,
} from '../../shared/domain/privacy-retention-rule.ts';
import type { PrivacySubjectRecord, Representation } from '../../shared/domain/privacy-subject.ts';

type PrivacyResponsibilityAssignment = typeof PrivacyResponsibilityAssignmentSchema.Type;

export class PrivacyOperationPersistenceError extends Schema.TaggedError<PrivacyOperationPersistenceError>()(
  'PrivacyOperationPersistenceError',
  {
    code: Schema.Literals([
      'privacy_operation_conflict',
      'privacy_operation_not_found',
      'privacy_operation_persistence_unavailable',
      'privacy_operation_scope_mismatch',
    ]),
    reason: Schema.String,
  },
) {}

export interface PrivacyEligibilityRecord {
  readonly evidence: PrivacyEligibilityEvidence;
  readonly evidenceId: string;
  readonly outcome: PrivacyEligibilityOutcome;
}

export interface ResolvedPrivacyEligibilityInputs {
  readonly authoritativeReferences: readonly PrivacyEligibilityAuthoritativeReference[];
  readonly input: ResolvePrivacyEligibilityInputsInput;
  readonly policyRevisions: readonly PrivacyEligibilityPolicyRevision[];
}

interface DsrWorkflowRecords {
  readonly deadlines: readonly DsrDeadline[];
  readonly decisions: readonly DsrSubstantiveDecision[];
  readonly resolverAssignments: readonly DsrResolverAssignment[];
  readonly responses: readonly DsrResponse[];
  readonly tasks: readonly DsrOwnerTask[];
  readonly verifications: readonly DsrVerification[];
}

// oxlint-disable-next-line effect-native/require-context-service-for-service-interface -- Generated Actions and reads receive this owner-local repository from their scoped Core transaction factory. expires: 2027-03-31.
export interface PrivacyOperationRepositoryService {
  readonly assignDsrResolver: (
    tenantId: string,
    legalEntityId: string,
    actionInvocationId: string,
    assignment: DsrResolverAssignment,
  ) => Effect.Effect<DsrResolverAssignment, PrivacyOperationPersistenceError>;
  readonly assignLegalBasis: (
    tenantId: string,
    legalEntityId: string,
    actionInvocationId: string,
    assignment: PrivacyLegalBasisAssignment,
  ) => Effect.Effect<PrivacyLegalBasisAssignment, PrivacyOperationPersistenceError>;
  readonly assignResponsibility: (
    tenantId: string,
    legalEntityId: string,
    actionInvocationId: string,
    assignment: PrivacyResponsibilityAssignment,
  ) => Effect.Effect<PrivacyResponsibilityAssignment, PrivacyOperationPersistenceError>;
  readonly createDsrCase: (
    tenantId: string,
    legalEntityId: string,
    actionInvocationId: string,
    caseRecord: DsrCase,
  ) => Effect.Effect<DsrCase, PrivacyOperationPersistenceError>;
  readonly createNoticeVersion: (
    tenantId: string,
    legalEntityId: string,
    actionInvocationId: string,
    noticeId: string,
    input: CreatePrivacyNoticeVersionInput,
  ) => Effect.Effect<PrivacyNoticeVersion, PrivacyOperationPersistenceError>;
  readonly createSubject: (
    tenantId: string,
    legalEntityId: string,
    actionInvocationId: string,
    subject: PrivacySubjectRecord,
  ) => Effect.Effect<PrivacySubjectRecord, PrivacyOperationPersistenceError>;
  readonly dispatchMeasure: (
    tenantId: string,
    legalEntityId: string,
    actionInvocationId: string,
    handoff: PrivacyMeasureHandoff,
  ) => Effect.Effect<PrivacyMeasureHandoff, PrivacyOperationPersistenceError>;
  readonly enqueueRetentionEvaluation: (
    tenantId: string,
    legalEntityId: string,
    actionInvocationId: string,
    request: RetentionEvaluationRequest,
  ) => Effect.Effect<RetentionEvaluationWork, PrivacyOperationPersistenceError>;
  readonly getDsrCase: (
    tenantId: string,
    legalEntityId: string,
    caseRef: string,
  ) => Effect.Effect<Option.Option<DsrCase>, PrivacyOperationPersistenceError>;
  readonly getPrivacyMeasureHandoff: (
    tenantId: string,
    legalEntityId: string,
    measureId: string,
  ) => Effect.Effect<Option.Option<PrivacyMeasureHandoff>, PrivacyOperationPersistenceError>;
  readonly issueDeliveryAccess: (
    tenantId: string,
    legalEntityId: string,
    actionInvocationId: string,
    access: DsrDeliveryAccessAuthorityResult,
  ) => Effect.Effect<DsrDeliveryAccess, PrivacyOperationPersistenceError>;
  readonly listApplicabilityDecisions: (
    tenantId: string,
    legalEntityId: string,
  ) => Effect.Effect<readonly PrivacyApplicabilityDecision[], PrivacyOperationPersistenceError>;
  readonly listApplicabilityPolicies: (
    tenantId: string,
    legalEntityId: string,
  ) => Effect.Effect<readonly PrivacyApplicabilityPolicy[], PrivacyOperationPersistenceError>;
  readonly listDsrCases: (
    tenantId: string,
    legalEntityId: string,
  ) => Effect.Effect<readonly DsrCase[], PrivacyOperationPersistenceError>;
  readonly listDsrWorkflow: (
    tenantId: string,
    legalEntityId: string,
    caseRef: string,
  ) => Effect.Effect<DsrWorkflowRecords, PrivacyOperationPersistenceError>;
  readonly listLegalBasisAssignments: (
    tenantId: string,
    legalEntityId: string,
  ) => Effect.Effect<readonly PrivacyLegalBasisAssignment[], PrivacyOperationPersistenceError>;
  readonly listNoticeVersions: (
    tenantId: string,
    legalEntityId: string,
  ) => Effect.Effect<readonly PrivacyNoticeVersion[], PrivacyOperationPersistenceError>;
  readonly listOwnerContributions: (
    tenantId: string,
    legalEntityId: string,
    controllerObligationRef: string,
  ) => Effect.Effect<readonly OwnerContribution[], PrivacyOperationPersistenceError>;
  readonly listRepresentations: (
    tenantId: string,
    legalEntityId: string,
  ) => Effect.Effect<readonly Representation[], PrivacyOperationPersistenceError>;
  readonly listResponsibilities: (
    tenantId: string,
    legalEntityId: string,
  ) => Effect.Effect<readonly PrivacyResponsibilityAssignment[], PrivacyOperationPersistenceError>;
  readonly listRetentionRules: (
    tenantId: string,
    legalEntityId: string,
  ) => Effect.Effect<readonly PrivacyRetentionRuleVersion[], PrivacyOperationPersistenceError>;
  readonly listSubjects: (
    tenantId: string,
    legalEntityId: string,
  ) => Effect.Effect<readonly PrivacySubjectRecord[], PrivacyOperationPersistenceError>;
  readonly readCurrentConsent: (
    tenantId: string,
    legalEntityId: string,
    scopeRef: string,
  ) => Effect.Effect<ConsentCurrentResolution, PrivacyOperationPersistenceError>;
  readonly recordAntiResurrectionProtection: (
    tenantId: string,
    legalEntityId: string,
    actionInvocationId: string,
    request: OwnerExecutionOutcomeRequest,
    authority: OwnerExecutionAuthorityResult,
    enforcementReceipt: AntiResurrectionEnforcementReceipt,
  ) => Effect.Effect<AntiResurrectionProtection, PrivacyOperationPersistenceError>;
  readonly recordApplicability: (
    tenantId: string,
    legalEntityId: string,
    actionInvocationId: string,
    decisionId: string,
    decision: PrivacyApplicabilityDecision,
  ) => Effect.Effect<PrivacyApplicabilityDecision, PrivacyOperationPersistenceError>;
  readonly recordApplicabilityPolicy: (
    tenantId: string,
    legalEntityId: string,
    actionInvocationId: string,
    policy: PrivacyApplicabilityPolicy,
  ) => Effect.Effect<PrivacyApplicabilityPolicy, PrivacyOperationPersistenceError>;
  readonly recordConsentDecision: (
    tenantId: string,
    legalEntityId: string,
    actionInvocationId: string,
    decision: ConsentDecision,
  ) => Effect.Effect<ConsentDecision, PrivacyOperationPersistenceError>;
  readonly recordDispositionDecision: (
    tenantId: string,
    legalEntityId: string,
    actionInvocationId: string,
    authority: PrivacyDispositionDecisionAuthorityResult,
  ) => Effect.Effect<PrivacyDispositionDecision, PrivacyOperationPersistenceError>;
  readonly recordDsrDeadline: (
    tenantId: string,
    legalEntityId: string,
    actionInvocationId: string,
    deadline: DsrDeadline,
  ) => Effect.Effect<DsrDeadline, PrivacyOperationPersistenceError>;
  readonly recordDsrDeliveryEvidence: (
    tenantId: string,
    legalEntityId: string,
    actionInvocationId: string,
    evidence: DsrDeliveryEvidence,
  ) => Effect.Effect<DsrDeliveryEvidence, PrivacyOperationPersistenceError>;
  readonly recordDsrResponse: (
    tenantId: string,
    legalEntityId: string,
    actionInvocationId: string,
    response: DsrResponseRequest,
    ownerInventory: DsrOwnerInventoryAuthorityResult | undefined,
  ) => Effect.Effect<DsrResponse, PrivacyOperationPersistenceError>;
  readonly recordDsrSubstantiveDecision: (
    tenantId: string,
    legalEntityId: string,
    actionInvocationId: string,
    authority: DsrSubstantiveDecisionAuthorityResult,
  ) => Effect.Effect<DsrSubstantiveDecision, PrivacyOperationPersistenceError>;
  readonly recordDsrVerification: (
    tenantId: string,
    legalEntityId: string,
    actionInvocationId: string,
    verification: DsrVerification,
  ) => Effect.Effect<DsrVerification, PrivacyOperationPersistenceError>;
  readonly recordEligibility: (
    tenantId: string,
    legalEntityId: string,
    actionInvocationId: string,
    record: PrivacyEligibilityRecord,
  ) => Effect.Effect<PrivacyEligibilityRecord, PrivacyOperationPersistenceError>;
  readonly recordExternalObligation: (
    tenantId: string,
    legalEntityId: string,
    actionInvocationId: string,
    obligation: ExternalObligation,
  ) => Effect.Effect<ExternalObligation, PrivacyOperationPersistenceError>;
  readonly recordLegalHold: (
    tenantId: string,
    legalEntityId: string,
    actionInvocationId: string,
    hold: PrivacyLegalHold,
  ) => Effect.Effect<PrivacyLegalHold, PrivacyOperationPersistenceError>;
  readonly recordOwnerContribution: (
    tenantId: string,
    legalEntityId: string,
    actionInvocationId: string,
    contribution: OwnerContribution,
  ) => Effect.Effect<OwnerContribution, PrivacyOperationPersistenceError>;
  readonly recordOwnerOutcome: (
    tenantId: string,
    legalEntityId: string,
    actionInvocationId: string,
    request: OwnerExecutionOutcomeRequest,
    authority: OwnerExecutionAuthorityResult,
  ) => Effect.Effect<OwnerExecutionOutcome, PrivacyOperationPersistenceError>;
  readonly recordProcessingIntervention: (
    tenantId: string,
    legalEntityId: string,
    actionInvocationId: string,
    intervention: ProcessingInterventionAuthorityResult,
  ) => Effect.Effect<PrivacyProcessingIntervention, PrivacyOperationPersistenceError>;
  readonly recordRepresentation: (
    tenantId: string,
    legalEntityId: string,
    actionInvocationId: string,
    representationId: string,
    representation: Representation,
  ) => Effect.Effect<Representation, PrivacyOperationPersistenceError>;
  readonly recordRetentionException: (
    tenantId: string,
    legalEntityId: string,
    actionInvocationId: string,
    exception: RetentionException,
  ) => Effect.Effect<RetentionException, PrivacyOperationPersistenceError>;
  /** Resolves the versioned Controller deadline policy; callers cannot provide policy authority. */
  readonly resolveDsrDeadlinePolicy: (
    tenantId: string,
    legalEntityId: string,
    controllerRef: string,
    receivedAt: string,
  ) => Effect.Effect<DsrDeadlinePolicy, PrivacyOperationPersistenceError>;
  readonly resolveEligibilityInputs: (
    tenantId: string,
    legalEntityId: string,
    intendedScope: ResolvePrivacyEligibilityInputsInput['intendedScope'],
    asOf: string,
    authority: PrivacyApplicabilityEligibilityAuthorityResult,
  ) => Effect.Effect<ResolvedPrivacyEligibilityInputs, PrivacyOperationPersistenceError>;
  /** Resolves a legal hold from a trusted governance authority; caller fields are never persisted as governance. */
  readonly resolveLegalHoldGovernance: (
    tenantId: string,
    legalEntityId: string,
    actorPrincipalRef: string,
    request: RetentionProtectionRequest,
  ) => Effect.Effect<PrivacyLegalHold, PrivacyOperationPersistenceError>;
  /** Resolves one current, authoritative, determinate evaluation before a decision is recorded. */
  readonly resolveRetentionEvaluation: (
    tenantId: string,
    legalEntityId: string,
    evaluationRef: string,
    asOf: string,
  ) => Effect.Effect<RetentionEvaluation, PrivacyOperationPersistenceError>;
  /** Resolves a retention exception from a trusted governance authority; caller fields are never persisted as governance. */
  readonly resolveRetentionExceptionGovernance: (
    tenantId: string,
    legalEntityId: string,
    actorPrincipalRef: string,
    request: RetentionProtectionRequest,
  ) => Effect.Effect<RetentionException, PrivacyOperationPersistenceError>;
  readonly updateDsrCase: (
    tenantId: string,
    legalEntityId: string,
    actionInvocationId: string,
    mutation: DsrCaseLifecycleMutation,
    expectedUpdatedAt: string | null,
    ownerInventory: DsrOwnerInventoryAuthorityResult | undefined,
  ) => Effect.Effect<DsrCase, PrivacyOperationPersistenceError>;
  readonly upsertDsrOwnerTask: (
    tenantId: string,
    legalEntityId: string,
    actionInvocationId: string,
    authority: DsrOwnerTaskAuthorityResult,
  ) => Effect.Effect<DsrOwnerTask, PrivacyOperationPersistenceError>;
  readonly upsertRetentionRule: (
    tenantId: string,
    legalEntityId: string,
    actionInvocationId: string,
    resolution: RetentionRuleAuthorityResolution,
  ) => Effect.Effect<PrivacyRetentionRuleVersion, PrivacyOperationPersistenceError>;
  readonly upsertTemporaryDsrExport: (
    tenantId: string,
    legalEntityId: string,
    actionInvocationId: string,
    temporaryExport: TemporaryDsrExport,
  ) => Effect.Effect<TemporaryDsrExport, PrivacyOperationPersistenceError>;
}
