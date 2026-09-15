import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { isPostgresUniqueViolation, OperationContextUnavailable } from '@app/core-runtime';
import { and, asc, desc, eq } from 'drizzle-orm';
import { DateTime, Effect, Option, Result, Schema } from 'effect';
import { randomUUID } from 'node:crypto';

import { AntiResurrectionProtectionSchema } from '../../shared/domain/anti-resurrection.ts';
import {
  DsrDeliveryAccessSchema,
  DsrDeliveryEvidenceSchema,
  TemporaryDsrExportSchema,
  isSuccessfulDelivery,
} from '../../shared/domain/dsr-delivery-access.ts';
import type { DsrDeliveryAccess, DsrDeliveryEvidence } from '../../shared/domain/dsr-delivery-access.ts';
import { ExternalObligationSchema } from '../../shared/domain/external-obligations.ts';
import { OwnerContributionSchema } from '../../shared/domain/owner-contribution.ts';
import {
  PrivacyApplicabilityDecisionSchema,
  PrivacyApplicabilityPolicySchema,
} from '../../shared/domain/privacy-applicability.ts';
import { ConsentDecisionSchema } from '../../shared/domain/privacy-consent-decision.ts';
import type { ConsentCurrentResolution, ConsentDecision } from '../../shared/domain/privacy-consent-decision.ts';
import {
  DsrCaseSchema,
  DsrDeadlineSchema,
  DsrOwnerTaskSchema,
  DsrResolverAssignmentSchema,
  DsrResponseSchema,
  DsrSubstantiveDecisionSchema,
  DsrVerificationSchema,
  canCloseDsrCase,
  canFinalizeDsrResponse,
} from '../../shared/domain/privacy-dsr.ts';
import { PrivacyLegalBasisAssignmentSchema } from '../../shared/domain/privacy-legal-basis.ts';
import {
  OwnerExecutionOutcomeSchema,
  PrivacyMeasureHandoffSchema,
} from '../../shared/domain/privacy-measure-handoff.ts';
import { PrivacyNoticeVersionSchema } from '../../shared/domain/privacy-notice-version.ts';
import type { PrivacyNoticeVersion } from '../../shared/domain/privacy-notice-version.ts';
import { PrivacyNoticeProvisionSchema, isProofOfProvision } from '../../shared/domain/privacy-notice-provision.ts';
import {
  IntendedProcessingScopeSchema,
  PrivacyEligibilityEvidenceSchema,
  PrivacyProcessingInterventionSchema,
} from '../../shared/domain/privacy-processing-eligibility.ts';
import type {
  PrivacyInputCurrentness,
  PrivacyProcessingIntervention,
} from '../../shared/domain/privacy-processing-eligibility.ts';
import { PrivacyResponsibilityAssignmentSchema } from '../../shared/domain/privacy-responsibility-assignment.ts';
import {
  PrivacyDispositionDecisionSchema,
  PrivacyLegalHoldSchema,
  RetentionEvaluationWorkSchema,
  RetentionExceptionSchema,
} from '../../shared/domain/privacy-retention-disposition.ts';
import { PrivacyRetentionRuleVersionSchema } from '../../shared/domain/privacy-retention-rule.ts';
import { PrivacySubjectRecordSchema, RepresentationSchema } from '../../shared/domain/privacy-subject.ts';
import {
  antiResurrectionProtections,
  applicabilityDecisions,
  applicabilityPolicies,
  consentDecisions,
  dispositionDecisions,
  dsrCases,
  dsrDeadlines,
  dsrDeliveryAccess,
  dsrDeliveryEvidence,
  dsrOwnerTasks,
  dsrResolverAssignments,
  dsrResponses,
  dsrSubstantiveDecisions,
  dsrVerifications,
  eligibilityEvidence,
  externalObligations,
  legalBasisAssignments,
  legalHolds,
  noticeProvisions,
  noticeVersions,
  ownerContributions,
  ownerExecutionOutcomes,
  privacyRepresentations,
  privacyMeasureDispatches,
  privacySubjects,
  processingPurposes,
  processingInterventions,
  purposeVersions,
  responsibilityAssignments,
  retentionEvaluationWork,
  retentionExceptions,
  retentionRules,
  temporaryDsrExports,
} from '../database/schema.ts';
import { PrivacyOperationPersistenceError } from './privacy-operation-repository.ts';
import type { PrivacyOperationRepositoryService } from './privacy-operation-repository.ts';

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];

const failure = (
  code: PrivacyOperationPersistenceError['code'],
  reason: string,
  cause?: unknown,
): PrivacyOperationPersistenceError => {
  const error = new PrivacyOperationPersistenceError({ code, reason });
  if (cause !== undefined) {
    Object.defineProperty(error, 'cause', { configurable: true, value: cause });
  }
  return error;
};

const persistenceFailure = (reason: string, cause?: unknown): PrivacyOperationPersistenceError => {
  const uniquenessFailure = isPostgresUniqueViolation(cause);
  return failure(
    uniquenessFailure ? 'privacy_operation_conflict' : 'privacy_operation_persistence_unavailable',
    reason,
    cause,
  );
};

const conflict = (reason: string): PrivacyOperationPersistenceError => failure('privacy_operation_conflict', reason);
const notFound = (reason: string): PrivacyOperationPersistenceError => failure('privacy_operation_not_found', reason);
const scopeMismatch = (reason: string): PrivacyOperationPersistenceError =>
  failure('privacy_operation_scope_mismatch', reason);

const scopeUnavailable = () =>
  new OperationContextUnavailable({
    code: 'operation_context_unavailable',
    reason: 'Privacy operations require a trusted Legal Entity scope',
  });

const date = (value: string): Date => DateTime.toDateUtc(DateTime.makeUnsafe(value));
const iso = (value: Date): string => DateTime.formatIso(DateTime.fromDateUnsafe(value));
const optionalDate = (value: Option.Option<string>): Date | null =>
  Option.match(value, { onNone: () => null, onSome: date });

type StoredPrivacyRecord = Schema.Schema.Type<typeof Schema.Unknown>;

const decode = <A, I>(schema: Schema.Codec<A, I>, value: StoredPrivacyRecord, label: string) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError((cause) => persistenceFailure(`Stored ${label} could not be decoded`, cause)),
  );

const decodeAll = <A, I>(schema: Schema.Codec<A, I>, rows: readonly StoredPrivacyRecord[], label: string) =>
  Effect.forEach(rows, (row) => decode(schema, row, label), { concurrency: 1 });

// Values reach this boundary only after their public schemas decoded them. Keeping the
// synchronous encoder outside Effect generators avoids turning impossible encode failures
// into undeclared defects while still writing the canonical JSON representation.
const encode = <A, I>(schema: Schema.Codec<A, I>, value: A): I => Result.getOrThrow(Schema.encodeResult(schema)(value));

const DSR_OWNER_TASK_LABEL = 'DSR Owner Task';

const consentEquivalent = Schema.toEquivalence(ConsentDecisionSchema);
const subjectEquivalent = Schema.toEquivalence(PrivacySubjectRecordSchema);
const retentionWorkEquivalent = Schema.toEquivalence(RetentionEvaluationWorkSchema);
const applicabilityPolicyEquivalent = Schema.toEquivalence(PrivacyApplicabilityPolicySchema);
const representationEquivalent = Schema.toEquivalence(RepresentationSchema);
const interventionEquivalent = Schema.toEquivalence(PrivacyProcessingInterventionSchema);
const ownerContributionEquivalent = Schema.toEquivalence(OwnerContributionSchema);
const dsrVerificationEquivalent = Schema.toEquivalence(DsrVerificationSchema);
const dsrResolverEquivalent = Schema.toEquivalence(DsrResolverAssignmentSchema);
const dsrDeadlineEquivalent = Schema.toEquivalence(DsrDeadlineSchema);
const dsrDecisionEquivalent = Schema.toEquivalence(DsrSubstantiveDecisionSchema);
const dsrResponseEquivalent = Schema.toEquivalence(DsrResponseSchema);
const dsrTaskEquivalent = Schema.toEquivalence(DsrOwnerTaskSchema);
const deliveryEvidenceEquivalent = Schema.toEquivalence(DsrDeliveryEvidenceSchema);
const temporaryExportEquivalent = Schema.toEquivalence(TemporaryDsrExportSchema);
const intendedScopeEquivalent = Schema.toEquivalence(IntendedProcessingScopeSchema);

const authoritativeCurrentness = (
  observedAt: string,
  revision: string,
  sourceRef: string,
  validUntil?: string,
): PrivacyInputCurrentness =>
  validUntil === undefined
    ? { authoritative: true, observedAt, revision, sourceRef }
    : { authoritative: true, observedAt, revision, sourceRef, validUntil };

const unavailableCurrentness = (asOf: string, revision: string, sourceRef: string): PrivacyInputCurrentness => ({
  authoritative: false,
  observedAt: asOf,
  revision,
  sourceRef,
});

const resolveCurrentConsent = (history: readonly ConsentDecision[]): ConsentCurrentResolution => {
  if (history.length === 0) {
    return { outcome: 'ABSENT' };
  }
  const ordered = history.toSorted((left, right) =>
    `${left.effectiveAt}\u0000${left.recordedAt}\u0000${left.decisionId}`.localeCompare(
      `${right.effectiveAt}\u0000${right.recordedAt}\u0000${right.decisionId}`,
    ),
  );
  const latestEffectiveAt = ordered.at(-1)?.effectiveAt;
  const latest = ordered.filter(({ effectiveAt }) => effectiveAt === latestEffectiveAt);
  const first = latest.at(0);
  if (
    first === undefined ||
    latest.some(
      (candidate) => candidate.decision !== first.decision || candidate.scope.scopeRef !== first.scope.scopeRef,
    )
  ) {
    return {
      decisions: latest,
      outcome: 'CONFLICT',
      reason: 'SAME_EFFECTIVE_TIME',
    };
  }
  return { decision: first, outcome: 'CURRENT' };
};

const makeRepository = (
  transaction: ScopedTransaction,
  trustedScope: Readonly<{ legalEntityId: string; tenantId: string }>,
): PrivacyOperationRepositoryService => {
  const assertScope = (tenantId: string, legalEntityId: string) =>
    tenantId === trustedScope.tenantId && legalEntityId === trustedScope.legalEntityId
      ? Effect.void
      : Effect.fail(scopeMismatch('Privacy request scope does not match the trusted operation scope'));

  const listSubjects: PrivacyOperationRepositoryService['listSubjects'] = Effect.fn(
    'PrivacyOperationPostgresRepository.listSubjects',
  )(function* listSubjectsEffect(tenantId, legalEntityId) {
    yield* assertScope(tenantId, legalEntityId);
    const rows = yield* transaction
      .select({ record: privacySubjects.subjectRecord })
      .from(privacySubjects)
      .where(and(eq(privacySubjects.tenantId, tenantId), eq(privacySubjects.legalEntityId, legalEntityId)))
      .orderBy(asc(privacySubjects.createdAt))
      .pipe(Effect.mapError((cause) => persistenceFailure('Privacy Subjects could not be listed', cause)));
    return yield* decodeAll(
      PrivacySubjectRecordSchema,
      rows.map(({ record }) => record),
      'Privacy Subject',
    );
  });

  const listResponsibilities: PrivacyOperationRepositoryService['listResponsibilities'] = Effect.fn(
    'PrivacyOperationPostgresRepository.listResponsibilities',
  )(function* listResponsibilitiesEffect(tenantId, legalEntityId) {
    yield* assertScope(tenantId, legalEntityId);
    const rows = yield* transaction
      .select({ record: responsibilityAssignments.assignmentRecord })
      .from(responsibilityAssignments)
      .where(
        and(
          eq(responsibilityAssignments.tenantId, tenantId),
          eq(responsibilityAssignments.legalEntityId, legalEntityId),
        ),
      )
      .orderBy(asc(responsibilityAssignments.effectiveFrom))
      .pipe(Effect.mapError((cause) => persistenceFailure('Responsibility Assignments could not be listed', cause)));
    return yield* decodeAll(
      PrivacyResponsibilityAssignmentSchema,
      rows.map(({ record }) => record),
      'Responsibility Assignment',
    );
  });

  const listApplicabilityDecisions: PrivacyOperationRepositoryService['listApplicabilityDecisions'] = Effect.fn(
    'PrivacyOperationPostgresRepository.listApplicabilityDecisions',
  )(function* listApplicabilityEffect(tenantId, legalEntityId) {
    yield* assertScope(tenantId, legalEntityId);
    const rows = yield* transaction
      .select({ record: applicabilityDecisions.decisionRecord })
      .from(applicabilityDecisions)
      .where(
        and(eq(applicabilityDecisions.tenantId, tenantId), eq(applicabilityDecisions.legalEntityId, legalEntityId)),
      )
      .orderBy(asc(applicabilityDecisions.evaluatedAt))
      .pipe(Effect.mapError((cause) => persistenceFailure('Applicability Decisions could not be listed', cause)));
    return yield* decodeAll(
      PrivacyApplicabilityDecisionSchema,
      rows.map(({ record }) => record),
      'Applicability Decision',
    );
  });

  const listApplicabilityPolicies: PrivacyOperationRepositoryService['listApplicabilityPolicies'] = Effect.fn(
    'PrivacyOperationPostgresRepository.listApplicabilityPolicies',
  )(function* listApplicabilityPoliciesEffect(tenantId, legalEntityId) {
    yield* assertScope(tenantId, legalEntityId);
    const rows = yield* transaction
      .select({ record: applicabilityPolicies.policyRecord })
      .from(applicabilityPolicies)
      .where(and(eq(applicabilityPolicies.tenantId, tenantId), eq(applicabilityPolicies.legalEntityId, legalEntityId)))
      .orderBy(asc(applicabilityPolicies.effectiveFrom))
      .pipe(Effect.mapError((cause) => persistenceFailure('Applicability Policies could not be listed', cause)));
    return yield* decodeAll(
      PrivacyApplicabilityPolicySchema,
      rows.map(({ record }) => record),
      'Applicability Policy',
    );
  });

  const listRepresentations: PrivacyOperationRepositoryService['listRepresentations'] = Effect.fn(
    'PrivacyOperationPostgresRepository.listRepresentations',
  )(function* listRepresentationsEffect(tenantId, legalEntityId) {
    yield* assertScope(tenantId, legalEntityId);
    const rows = yield* transaction
      .select({ record: privacyRepresentations.representationRecord })
      .from(privacyRepresentations)
      .where(
        and(eq(privacyRepresentations.tenantId, tenantId), eq(privacyRepresentations.legalEntityId, legalEntityId)),
      )
      .orderBy(asc(privacyRepresentations.validFrom))
      .pipe(Effect.mapError((cause) => persistenceFailure('Privacy Representations could not be listed', cause)));
    return yield* decodeAll(
      RepresentationSchema,
      rows.map(({ record }) => record),
      'Privacy Representation',
    );
  });

  const listOwnerContributions: PrivacyOperationRepositoryService['listOwnerContributions'] = Effect.fn(
    'PrivacyOperationPostgresRepository.listOwnerContributions',
  )(function* listOwnerContributionsEffect(tenantId, legalEntityId, controllerObligationRef) {
    yield* assertScope(tenantId, legalEntityId);
    const rows = yield* transaction
      .select({ record: ownerContributions.contributionRecord })
      .from(ownerContributions)
      .where(
        and(
          eq(ownerContributions.tenantId, tenantId),
          eq(ownerContributions.legalEntityId, legalEntityId),
          eq(ownerContributions.controllerObligationRef, controllerObligationRef),
        ),
      )
      .orderBy(asc(ownerContributions.observedAt))
      .pipe(Effect.mapError((cause) => persistenceFailure('Owner Contributions could not be listed', cause)));
    return yield* decodeAll(
      OwnerContributionSchema,
      rows.map(({ record }) => record),
      'Owner Contribution',
    );
  });

  const listLegalBasisAssignments: PrivacyOperationRepositoryService['listLegalBasisAssignments'] = Effect.fn(
    'PrivacyOperationPostgresRepository.listLegalBasisAssignments',
  )(function* listLegalBasisEffect(tenantId, legalEntityId) {
    yield* assertScope(tenantId, legalEntityId);
    const rows = yield* transaction
      .select({ record: legalBasisAssignments.assignmentRecord })
      .from(legalBasisAssignments)
      .where(and(eq(legalBasisAssignments.tenantId, tenantId), eq(legalBasisAssignments.legalEntityId, legalEntityId)))
      .orderBy(asc(legalBasisAssignments.effectiveFrom))
      .pipe(Effect.mapError((cause) => persistenceFailure('Legal Basis Assignments could not be listed', cause)));
    return yield* decodeAll(
      PrivacyLegalBasisAssignmentSchema,
      rows.map(({ record }) => record),
      'Legal Basis Assignment',
    );
  });

  const listNoticeVersions: PrivacyOperationRepositoryService['listNoticeVersions'] = Effect.fn(
    'PrivacyOperationPostgresRepository.listNoticeVersions',
  )(function* listNoticeVersionsEffect(tenantId, legalEntityId) {
    yield* assertScope(tenantId, legalEntityId);
    const rows = yield* transaction
      .select({ record: noticeVersions.noticeRecord })
      .from(noticeVersions)
      .where(and(eq(noticeVersions.tenantId, tenantId), eq(noticeVersions.legalEntityId, legalEntityId)))
      .orderBy(asc(noticeVersions.recordedAt))
      .pipe(Effect.mapError((cause) => persistenceFailure('Notice Versions could not be listed', cause)));
    return yield* decodeAll(
      PrivacyNoticeVersionSchema,
      rows.map(({ record }) => record),
      'Notice Version',
    );
  });

  const listRetentionRules: PrivacyOperationRepositoryService['listRetentionRules'] = Effect.fn(
    'PrivacyOperationPostgresRepository.listRetentionRules',
  )(function* listRetentionRulesEffect(tenantId, legalEntityId) {
    yield* assertScope(tenantId, legalEntityId);
    const rows = yield* transaction
      .select({ record: retentionRules.ruleRecord })
      .from(retentionRules)
      .where(and(eq(retentionRules.tenantId, tenantId), eq(retentionRules.legalEntityId, legalEntityId)))
      .orderBy(asc(retentionRules.ruleRef), asc(retentionRules.ruleVersion))
      .pipe(Effect.mapError((cause) => persistenceFailure('Retention Rules could not be listed', cause)));
    return yield* decodeAll(
      PrivacyRetentionRuleVersionSchema,
      rows.map(({ record }) => record),
      'Retention Rule',
    );
  });

  const listDsrCases: PrivacyOperationRepositoryService['listDsrCases'] = Effect.fn(
    'PrivacyOperationPostgresRepository.listDsrCases',
  )(function* listDsrCasesEffect(tenantId, legalEntityId) {
    yield* assertScope(tenantId, legalEntityId);
    const rows = yield* transaction
      .select({ record: dsrCases.caseRecord })
      .from(dsrCases)
      .where(and(eq(dsrCases.tenantId, tenantId), eq(dsrCases.legalEntityId, legalEntityId)))
      .orderBy(asc(dsrCases.originalReceivedAt))
      .pipe(Effect.mapError((cause) => persistenceFailure('DSR Cases could not be listed', cause)));
    return yield* decodeAll(
      DsrCaseSchema,
      rows.map(({ record }) => record),
      'DSR Case',
    );
  });

  const getDsrCase: PrivacyOperationRepositoryService['getDsrCase'] = Effect.fn(
    'PrivacyOperationPostgresRepository.getDsrCase',
  )(function* getDsrCaseEffect(tenantId, legalEntityId, caseRef) {
    yield* assertScope(tenantId, legalEntityId);
    const rows = yield* transaction
      .select({ record: dsrCases.caseRecord })
      .from(dsrCases)
      .where(
        and(eq(dsrCases.tenantId, tenantId), eq(dsrCases.legalEntityId, legalEntityId), eq(dsrCases.caseRef, caseRef)),
      )
      .limit(1)
      .pipe(Effect.mapError((cause) => persistenceFailure('DSR Case could not be loaded', cause)));
    const row = rows.at(0);
    return row === undefined ? Option.none() : Option.some(yield* decode(DsrCaseSchema, row.record, 'DSR Case'));
  });

  const listDsrWorkflow: PrivacyOperationRepositoryService['listDsrWorkflow'] = Effect.fn(
    'PrivacyOperationPostgresRepository.listDsrWorkflow',
  )(function* listDsrWorkflowEffect(tenantId, legalEntityId, caseRef) {
    yield* assertScope(tenantId, legalEntityId);
    const [verificationRows, resolverRows, deadlineRows, decisionRows, taskRows, responseRows] = yield* Effect.all(
      [
        transaction
          .select({ record: dsrVerifications.verificationRecord })
          .from(dsrVerifications)
          .where(
            and(
              eq(dsrVerifications.tenantId, tenantId),
              eq(dsrVerifications.legalEntityId, legalEntityId),
              eq(dsrVerifications.caseRef, caseRef),
            ),
          ),
        transaction
          .select({ record: dsrResolverAssignments.assignmentRecord })
          .from(dsrResolverAssignments)
          .where(
            and(
              eq(dsrResolverAssignments.tenantId, tenantId),
              eq(dsrResolverAssignments.legalEntityId, legalEntityId),
              eq(dsrResolverAssignments.caseRef, caseRef),
            ),
          ),
        transaction
          .select({ record: dsrDeadlines.deadlineRecord })
          .from(dsrDeadlines)
          .where(
            and(
              eq(dsrDeadlines.tenantId, tenantId),
              eq(dsrDeadlines.legalEntityId, legalEntityId),
              eq(dsrDeadlines.caseRef, caseRef),
            ),
          ),
        transaction
          .select({ record: dsrSubstantiveDecisions.decisionRecord })
          .from(dsrSubstantiveDecisions)
          .where(
            and(
              eq(dsrSubstantiveDecisions.tenantId, tenantId),
              eq(dsrSubstantiveDecisions.legalEntityId, legalEntityId),
              eq(dsrSubstantiveDecisions.caseRef, caseRef),
            ),
          ),
        transaction
          .select({ record: dsrOwnerTasks.taskRecord })
          .from(dsrOwnerTasks)
          .where(
            and(
              eq(dsrOwnerTasks.tenantId, tenantId),
              eq(dsrOwnerTasks.legalEntityId, legalEntityId),
              eq(dsrOwnerTasks.caseRef, caseRef),
            ),
          ),
        transaction
          .select({ record: dsrResponses.responseRecord })
          .from(dsrResponses)
          .where(
            and(
              eq(dsrResponses.tenantId, tenantId),
              eq(dsrResponses.legalEntityId, legalEntityId),
              eq(dsrResponses.caseRef, caseRef),
            ),
          ),
      ],
      { concurrency: 1 },
    ).pipe(Effect.mapError((cause) => persistenceFailure('DSR workflow records could not be listed', cause)));
    return {
      deadlines: yield* decodeAll(
        DsrDeadlineSchema,
        deadlineRows.map(({ record }) => record),
        'DSR Deadline',
      ),
      decisions: yield* decodeAll(
        DsrSubstantiveDecisionSchema,
        decisionRows.map(({ record }) => record),
        'DSR Decision',
      ),
      resolverAssignments: yield* decodeAll(
        DsrResolverAssignmentSchema,
        resolverRows.map(({ record }) => record),
        'DSR Resolver Assignment',
      ),
      responses: yield* decodeAll(
        DsrResponseSchema,
        responseRows.map(({ record }) => record),
        'DSR Response',
      ),
      tasks: yield* decodeAll(
        DsrOwnerTaskSchema,
        taskRows.map(({ record }) => record),
        DSR_OWNER_TASK_LABEL,
      ),
      verifications: yield* decodeAll(
        DsrVerificationSchema,
        verificationRows.map(({ record }) => record),
        'DSR Verification',
      ),
    };
  });

  const requireDsrCase = Effect.fn('PrivacyOperationPostgresRepository.requireDsrCase')(function* requireDsrCaseEffect(
    tenantId: string,
    legalEntityId: string,
    caseRef: string,
  ) {
    const current = yield* getDsrCase(tenantId, legalEntityId, caseRef);
    if (Option.isNone(current)) {
      return yield* notFound('DSR Case was not found');
    }
    return current.value;
  });

  return {
    assignDsrResolver: Effect.fn('PrivacyOperationPostgresRepository.assignDsrResolver')(
      function* assignDsrResolverEffect(tenantId, legalEntityId, actionInvocationId, assignment) {
        yield* assertScope(tenantId, legalEntityId);
        const caseRecord = yield* requireDsrCase(tenantId, legalEntityId, assignment.caseRef);
        if (!caseRecord.controllerObligations.some(({ controllerRef }) => controllerRef === assignment.controllerRef)) {
          return yield* conflict('DSR Resolver Assignment does not match a Controller obligation on the Case');
        }
        const replayRows = yield* transaction
          .select({ record: dsrResolverAssignments.assignmentRecord })
          .from(dsrResolverAssignments)
          .where(
            and(
              eq(dsrResolverAssignments.tenantId, tenantId),
              eq(dsrResolverAssignments.legalEntityId, legalEntityId),
              eq(dsrResolverAssignments.actionInvocationId, actionInvocationId),
            ),
          )
          .limit(1)
          .pipe(Effect.mapError((cause) => persistenceFailure('DSR Resolver replay could not be resolved', cause)));
        const replay = replayRows.at(0);
        if (replay !== undefined) {
          const retained = yield* decode(DsrResolverAssignmentSchema, replay.record, 'DSR Resolver Assignment');
          return dsrResolverEquivalent(retained, assignment)
            ? retained
            : yield* conflict('DSR Resolver Action invocation was replayed with a different assignment');
        }
        yield* transaction
          .insert(dsrResolverAssignments)
          .values({
            actionInvocationId,
            assignedAt: date(assignment.assignedAt),
            assignmentRecord: encode(DsrResolverAssignmentSchema, assignment),
            assignmentRef: assignment.assignmentRef,
            caseRef: assignment.caseRef,
            controllerRef: assignment.controllerRef,
            legalEntityId,
            tenantId,
          })
          .pipe(Effect.mapError((cause) => persistenceFailure('DSR Resolver Assignment could not be recorded', cause)));
        return assignment;
      },
    ),
    assignLegalBasis: Effect.fn('PrivacyOperationPostgresRepository.assignLegalBasis')(
      function* assignLegalBasisEffect(tenantId, legalEntityId, actionInvocationId, assignment) {
        yield* assertScope(tenantId, legalEntityId);
        yield* transaction
          .insert(legalBasisAssignments)
          .values({
            actionInvocationId,
            assignmentRecord: encode(PrivacyLegalBasisAssignmentSchema, assignment),
            assignmentRef: assignment.assignmentRef.resourceId,
            decision: assignment.decision,
            effectiveFrom: date(assignment.effectiveFrom),
            effectiveTo: assignment.effectiveTo === null ? null : date(assignment.effectiveTo),
            legalEntityId,
            processingScopeRef: assignment.scope.processingScopeRef.scopeId,
            tenantId,
          })
          .pipe(Effect.mapError((cause) => persistenceFailure('Legal Basis Assignment could not be recorded', cause)));
        return assignment;
      },
    ),
    assignResponsibility: Effect.fn('PrivacyOperationPostgresRepository.assignResponsibility')(
      function* assignResponsibilityEffect(tenantId, legalEntityId, actionInvocationId, assignment) {
        yield* assertScope(tenantId, legalEntityId);
        yield* transaction
          .insert(responsibilityAssignments)
          .values({
            actionInvocationId,
            assignmentRecord: encode(PrivacyResponsibilityAssignmentSchema, assignment),
            assignmentRef: assignment.assignmentRef.resourceId,
            effectiveFrom: date(assignment.effectiveFrom),
            effectiveTo: optionalDate(assignment.effectiveTo),
            legalEntityId,
            role: assignment.role,
            scopeRef: assignment.scopeRef.scopeId,
            tenantId,
          })
          .pipe(
            Effect.mapError((cause) => persistenceFailure('Responsibility Assignment could not be recorded', cause)),
          );
        return assignment;
      },
    ),
    createDsrCase: Effect.fn('PrivacyOperationPostgresRepository.createDsrCase')(
      // oxlint-disable-next-line effect-native/no-wide-factory-signature -- Fixed owner-repository port signature carries scope, invocation identity, and decoded input; expires: 2027-03-31.
      function* createDsrCaseEffect(tenantId, legalEntityId, _actionInvocationId, caseRecord) {
        yield* assertScope(tenantId, legalEntityId);
        const existing = yield* getDsrCase(tenantId, legalEntityId, caseRecord.caseRef);
        if (Option.isSome(existing)) {
          return yield* conflict('DSR Case identity already exists');
        }
        yield* transaction
          .insert(dsrCases)
          .values({
            caseRecord: encode(DsrCaseSchema, caseRecord),
            caseRef: caseRecord.caseRef,
            caseStatus: caseRecord.status,
            legalEntityId,
            originalReceivedAt: date(caseRecord.originalReceivedAt),
            tenantId,
            updatedAt: date(caseRecord.createdAt),
          })
          .pipe(Effect.mapError((cause) => persistenceFailure('DSR Case could not be created', cause)));
        return caseRecord;
      },
    ),
    /* oxlint-disable effect-native/no-wide-factory-signature -- Fixed owner-repository port signature carries scope, invocation identity, resource identity, and decoded input; expires: 2027-03-31. */
    createNoticeVersion: Effect.fn('PrivacyOperationPostgresRepository.createNoticeVersion')(
      // fallow-ignore-next-line complexity -- The owner transaction keeps notice version ordering, replay, scope, and evidence invariants in one atomic operation.
      function* createNoticeVersionEffect(tenantId, legalEntityId, _actionInvocationId, noticeId, input) {
        yield* assertScope(tenantId, legalEntityId);
        if (input.wording === null && input.evidenceArtifactRef === null) {
          return yield* conflict('Notice Version requires wording or an evidence artifact reference');
        }
        const prior = yield* transaction
          .select({
            effectiveFrom: noticeVersions.effectiveFrom,
            versionNumber: noticeVersions.versionNumber,
          })
          .from(noticeVersions)
          .where(
            and(
              eq(noticeVersions.tenantId, tenantId),
              eq(noticeVersions.legalEntityId, legalEntityId),
              eq(noticeVersions.noticeId, noticeId),
            ),
          )
          .orderBy(desc(noticeVersions.versionNumber))
          .limit(1)
          .pipe(Effect.mapError((cause) => persistenceFailure('Notice Version history could not be loaded', cause)));
        const nowDateTime = yield* DateTime.now;
        const recordedAt = DateTime.formatIso(nowDateTime);
        const effectiveFrom = input.effectiveFrom ?? recordedAt;
        if (input.effectiveTo !== undefined && input.effectiveTo !== null && input.effectiveTo <= effectiveFrom) {
          return yield* conflict('Notice Version effective period is invalid');
        }
        const previous = prior.at(0);
        if (previous !== undefined && effectiveFrom <= iso(previous.effectiveFrom)) {
          return yield* conflict('Notice Version effective time must follow the latest retained version');
        }
        const version: PrivacyNoticeVersion = {
          applicableScope: input.applicableScope,
          contentIdentity: input.contentIdentity,
          effectiveFrom,
          effectiveTo: input.effectiveTo ?? null,
          evidenceArtifactRef: input.evidenceArtifactRef,
          language: input.language,
          noticeRef: {
            moduleId: 'privacy.core',
            resourceId: noticeId,
            resourceType: 'privacy.core.privacy-notice-version',
            tenantId,
          },
          recordedAt,
          versionId: randomUUID(),
          versionNumber: (previous?.versionNumber ?? 0) + 1,
          wording: input.wording,
        };
        yield* transaction
          .insert(noticeVersions)
          .values({
            contentIdentity: version.contentIdentity,
            effectiveFrom: date(version.effectiveFrom),
            effectiveTo: version.effectiveTo === null ? null : date(version.effectiveTo),
            language: version.language,
            legalEntityId,
            noticeId,
            noticeRecord: encode(PrivacyNoticeVersionSchema, version),
            noticeVersionId: version.versionId,
            recordedAt: DateTime.toDateUtc(nowDateTime),
            tenantId,
            versionNumber: version.versionNumber,
          })
          .pipe(Effect.mapError((cause) => persistenceFailure('Notice Version could not be recorded', cause)));
        return version;
      },
    ),
    /* oxlint-enable effect-native/no-wide-factory-signature */
    createSubject: Effect.fn('PrivacyOperationPostgresRepository.createSubject')(
      // oxlint-disable-next-line effect-native/no-wide-factory-signature -- Fixed owner-repository port signature carries scope, invocation identity, and decoded input; expires: 2027-03-31.
      function* createSubjectEffect(tenantId, legalEntityId, _actionInvocationId, subject) {
        yield* assertScope(tenantId, legalEntityId);
        const rows = yield* transaction
          .select({ record: privacySubjects.subjectRecord })
          .from(privacySubjects)
          .where(
            and(
              eq(privacySubjects.tenantId, tenantId),
              eq(privacySubjects.legalEntityId, legalEntityId),
              eq(privacySubjects.privacySubjectId, subject.subjectRef.resourceId),
            ),
          )
          .limit(1)
          .pipe(Effect.mapError((cause) => persistenceFailure('Privacy Subject could not be loaded', cause)));
        const row = rows.at(0);
        if (row !== undefined) {
          const current = yield* decode(PrivacySubjectRecordSchema, row.record, 'Privacy Subject');
          return subjectEquivalent(current, subject) ? current : yield* conflict('Privacy Subject identity conflict');
        }
        yield* transaction
          .insert(privacySubjects)
          .values({
            createdAt: date(subject.createdAt),
            legalEntityId,
            privacySubjectId: subject.subjectRef.resourceId,
            subjectKind: subject.subject.kind,
            subjectRecord: encode(PrivacySubjectRecordSchema, subject),
            tenantId,
            updatedAt: date(subject.updatedAt),
          })
          .pipe(Effect.mapError((cause) => persistenceFailure('Privacy Subject could not be created', cause)));
        return subject;
      },
    ),
    dispatchMeasure: Effect.fn('PrivacyOperationPostgresRepository.dispatchMeasure')(
      function* dispatchMeasureEffect(tenantId, legalEntityId, _actionInvocationId, handoff) {
        yield* assertScope(tenantId, legalEntityId);
        const existing = yield* transaction
          .select({ record: privacyMeasureDispatches.handoffRecord })
          .from(privacyMeasureDispatches)
          .where(
            and(
              eq(privacyMeasureDispatches.tenantId, tenantId),
              eq(privacyMeasureDispatches.legalEntityId, legalEntityId),
              eq(privacyMeasureDispatches.idempotencyKey, handoff.idempotencyKey),
            ),
          )
          .limit(1)
          .pipe(Effect.mapError((cause) => persistenceFailure('Privacy Measure dispatch could not be loaded', cause)));
        const replay = existing.at(0);
        if (replay !== undefined) {
          const previous = yield* decode(PrivacyMeasureHandoffSchema, replay.record, 'Privacy Measure Handoff');
          return Schema.toEquivalence(PrivacyMeasureHandoffSchema)(previous, handoff)
            ? previous
            : yield* conflict('Privacy Measure idempotency conflict');
        }
        yield* transaction
          .insert(privacyMeasureDispatches)
          .values({
            handoffRecord: encode(PrivacyMeasureHandoffSchema, handoff),
            idempotencyKey: handoff.idempotencyKey,
            legalEntityId,
            measureId: handoff.measureId,
            status: 'RECEIVED',
            tenantId,
          })
          .pipe(Effect.mapError((cause) => persistenceFailure('Privacy Measure could not be dispatched', cause)));
        return handoff;
      },
    ),
    enqueueRetentionEvaluation: Effect.fn('PrivacyOperationPostgresRepository.enqueueRetentionEvaluation')(
      function* enqueueRetentionEffect(tenantId, legalEntityId, _actionInvocationId, work) {
        yield* assertScope(tenantId, legalEntityId);
        const existing = yield* transaction
          .select({ record: retentionEvaluationWork.workRecord })
          .from(retentionEvaluationWork)
          .where(
            and(
              eq(retentionEvaluationWork.tenantId, tenantId),
              eq(retentionEvaluationWork.legalEntityId, legalEntityId),
              eq(retentionEvaluationWork.idempotencyRef, work.idempotencyRef),
            ),
          )
          .limit(1)
          .pipe(Effect.mapError((cause) => persistenceFailure('Retention Evaluation work could not be loaded', cause)));
        const replay = existing.at(0);
        if (replay !== undefined) {
          const previous = yield* decode(RetentionEvaluationWorkSchema, replay.record, 'Retention Evaluation Work');
          return retentionWorkEquivalent(previous, work)
            ? previous
            : yield* conflict('Retention Evaluation idempotency conflict');
        }
        yield* transaction
          .insert(retentionEvaluationWork)
          .values({
            dueAt: date(work.dueAt),
            evaluatedAt: optionalDate(work.evaluatedAt),
            idempotencyRef: work.idempotencyRef,
            legalEntityId,
            ruleRef: work.ruleRef,
            ruleVersion: work.ruleVersion,
            status: work.status,
            tenantId,
            workRecord: encode(RetentionEvaluationWorkSchema, work),
            workRef: work.workRef,
          })
          .pipe(Effect.mapError((cause) => persistenceFailure('Retention Evaluation work could not be queued', cause)));
        return work;
      },
    ),
    getDsrCase,
    issueDeliveryAccess: Effect.fn('PrivacyOperationPostgresRepository.issueDeliveryAccess')(
      function* issueDeliveryAccessEffect(tenantId, legalEntityId, actionInvocationId, access) {
        yield* assertScope(tenantId, legalEntityId);
        const existing = yield* transaction
          .select({
            accessId: dsrDeliveryAccess.accessId,
            record: dsrDeliveryAccess.accessRecord,
          })
          .from(dsrDeliveryAccess)
          .where(
            and(
              eq(dsrDeliveryAccess.tenantId, tenantId),
              eq(dsrDeliveryAccess.legalEntityId, legalEntityId),
              eq(dsrDeliveryAccess.deliveryOutputRef, access.deliveryOutputRef),
            ),
          )
          .pipe(Effect.mapError((cause) => persistenceFailure('DSR Delivery Access could not be loaded', cause)));
        // oxlint-disable-next-line effect-native/no-imperative-loop-in-effect-gen -- Reissue must revoke prior grants serially and return early on an exact idempotent replay; expires: 2027-03-31.
        for (const row of existing) {
          const current = yield* decode(DsrDeliveryAccessSchema, row.record, 'DSR Delivery Access');
          if (current.idempotencyKey === access.idempotencyKey) {
            return Schema.toEquivalence(DsrDeliveryAccessSchema)(current, access)
              ? current
              : yield* conflict('DSR Delivery Access idempotency conflict');
          }
          if (current.revokedAt === null) {
            const revokedAt = access.issuedAt;
            const revoked: DsrDeliveryAccess = {
              ...current,
              revocationReason: `superseded-by:${access.accessId}`,
              revokedAt,
            };
            yield* transaction
              .update(dsrDeliveryAccess)
              .set({
                accessRecord: encode(DsrDeliveryAccessSchema, revoked),
                revokedAt: date(revokedAt),
                updatedAt: date(revokedAt),
              })
              .where(
                and(
                  eq(dsrDeliveryAccess.tenantId, tenantId),
                  eq(dsrDeliveryAccess.legalEntityId, legalEntityId),
                  eq(dsrDeliveryAccess.accessId, row.accessId),
                ),
              )
              .pipe(
                Effect.mapError((cause) => persistenceFailure('Prior delivery access could not be revoked', cause)),
              );
          }
        }
        yield* transaction
          .insert(dsrDeliveryAccess)
          .values({
            accessId: access.accessId,
            accessRecord: encode(DsrDeliveryAccessSchema, access),
            actionInvocationId,
            createdAt: date(access.issuedAt),
            deliveryOutputRef: access.deliveryOutputRef,
            expiresAt: date(access.expiresAt),
            idempotencyKey: access.idempotencyKey,
            legalEntityId,
            revokedAt: access.revokedAt === null ? null : date(access.revokedAt),
            tenantId,
            updatedAt: date(access.issuedAt),
          })
          .pipe(Effect.mapError((cause) => persistenceFailure('DSR Delivery Access could not be issued', cause)));
        return access;
      },
    ),
    listApplicabilityDecisions,
    listApplicabilityPolicies,
    listDsrCases,
    listDsrWorkflow,
    listLegalBasisAssignments,
    listNoticeVersions,
    listOwnerContributions,
    listRepresentations,
    listResponsibilities,
    listRetentionRules,
    listSubjects,
    readCurrentConsent: Effect.fn('PrivacyOperationPostgresRepository.readCurrentConsent')(
      function* readCurrentConsentEffect(tenantId, legalEntityId, scopeRef) {
        yield* assertScope(tenantId, legalEntityId);
        const rows = yield* transaction
          .select({ record: consentDecisions.decisionRecord })
          .from(consentDecisions)
          .where(
            and(
              eq(consentDecisions.tenantId, tenantId),
              eq(consentDecisions.legalEntityId, legalEntityId),
              eq(consentDecisions.scopeRef, scopeRef),
            ),
          )
          .orderBy(asc(consentDecisions.effectiveAt), asc(consentDecisions.recordedAt))
          .pipe(Effect.mapError((cause) => persistenceFailure('Consent history could not be loaded', cause)));
        const history = yield* decodeAll(
          ConsentDecisionSchema,
          rows.map(({ record }) => record),
          'Consent Decision',
        );
        return resolveCurrentConsent(history);
      },
    ),
    recordAntiResurrectionProtection: Effect.fn('PrivacyOperationPostgresRepository.recordAntiResurrectionProtection')(
      function* recordProtectionEffect(tenantId, legalEntityId, _actionInvocationId, protection) {
        yield* assertScope(tenantId, legalEntityId);
        yield* transaction
          .insert(antiResurrectionProtections)
          .values({
            legalEntityId,
            measure: protection.measure,
            protectedAt: date(protection.protectedAt),
            protectionId: protection.protectionId,
            protectionRecord: encode(AntiResurrectionProtectionSchema, protection),
            subjectRef: protection.subjectRef,
            tenantId,
          })
          .pipe(
            Effect.mapError((cause) => persistenceFailure('Anti-resurrection protection could not be recorded', cause)),
          );
        return protection;
      },
    ),
    recordApplicability: Effect.fn('PrivacyOperationPostgresRepository.recordApplicability')(
      function* recordApplicabilityEffect(tenantId, legalEntityId, actionInvocationId, decisionId, decision) {
        yield* assertScope(tenantId, legalEntityId);
        yield* transaction
          .insert(applicabilityDecisions)
          .values({
            actionInvocationId,
            decisionId,
            decisionRecord: encode(PrivacyApplicabilityDecisionSchema, decision),
            evaluatedAt: date(decision.evaluatedAt),
            legalEntityId,
            operation: decision.evaluatedScope.operation,
            outcome: decision.outcome,
            processingScopeRef: decision.evaluatedScope.processingScopeRef.scopeId,
            tenantId,
          })
          .pipe(Effect.mapError((cause) => persistenceFailure('Applicability Decision could not be recorded', cause)));
        return decision;
      },
    ),
    recordApplicabilityPolicy: Effect.fn('PrivacyOperationPostgresRepository.recordApplicabilityPolicy')(
      function* recordApplicabilityPolicyEffect(tenantId, legalEntityId, actionInvocationId, policy) {
        yield* assertScope(tenantId, legalEntityId);
        const replayRows = yield* transaction
          .select({ record: applicabilityPolicies.policyRecord })
          .from(applicabilityPolicies)
          .where(
            and(
              eq(applicabilityPolicies.tenantId, tenantId),
              eq(applicabilityPolicies.legalEntityId, legalEntityId),
              eq(applicabilityPolicies.actionInvocationId, actionInvocationId),
            ),
          )
          .limit(1)
          .pipe(
            Effect.mapError((cause) => persistenceFailure('Applicability Policy replay could not be resolved', cause)),
          );
        const replay = replayRows.at(0);
        if (replay !== undefined) {
          const retained = yield* decode(PrivacyApplicabilityPolicySchema, replay.record, 'Applicability Policy');
          return applicabilityPolicyEquivalent(retained, policy)
            ? retained
            : yield* conflict('Applicability Policy Action invocation was replayed with different input');
        }
        yield* transaction
          .insert(applicabilityPolicies)
          .values({
            actionInvocationId,
            effectiveFrom: date(policy.effectiveFrom),
            effectiveTo: policy.effectiveTo === null ? null : date(policy.effectiveTo),
            legalEntityId,
            policyKey: policy.policyKey,
            policyRecord: encode(PrivacyApplicabilityPolicySchema, policy),
            policyVersion: policy.policyVersion,
            scopeKey: policy.scopeKey,
            tenantId,
          })
          .pipe(Effect.mapError((cause) => persistenceFailure('Applicability Policy could not be recorded', cause)));
        return policy;
      },
    ),
    recordConsentDecision: Effect.fn('PrivacyOperationPostgresRepository.recordConsentDecision')(
      function* recordConsentDecisionEffect(tenantId, legalEntityId, actionInvocationId, decision) {
        yield* assertScope(tenantId, legalEntityId);
        const replayRows = yield* transaction
          .select({ record: consentDecisions.decisionRecord })
          .from(consentDecisions)
          .where(
            and(
              eq(consentDecisions.tenantId, tenantId),
              eq(consentDecisions.legalEntityId, legalEntityId),
              eq(consentDecisions.actionInvocationId, actionInvocationId),
            ),
          )
          .limit(1)
          .pipe(Effect.mapError((cause) => persistenceFailure('Consent replay could not be resolved', cause)));
        const replay = replayRows.at(0);
        if (replay !== undefined) {
          const previous = yield* decode(ConsentDecisionSchema, replay.record, 'Consent Decision');
          return consentEquivalent(previous, decision)
            ? previous
            : yield* conflict('Consent Action invocation was replayed with a different decision');
        }
        const purposeRows = yield* transaction
          .select({ meaning: purposeVersions.meaning })
          .from(purposeVersions)
          .innerJoin(
            processingPurposes,
            and(
              eq(processingPurposes.tenantId, purposeVersions.tenantId),
              eq(processingPurposes.legalEntityId, purposeVersions.legalEntityId),
              eq(processingPurposes.processingPurposeId, purposeVersions.processingPurposeId),
            ),
          )
          .where(
            and(
              eq(purposeVersions.tenantId, tenantId),
              eq(purposeVersions.legalEntityId, legalEntityId),
              eq(purposeVersions.purposeVersionId, decision.scope.purposeVersionRef),
              eq(processingPurposes.processingPurposeId, decision.scope.processingPurposeRef.resourceId),
            ),
          )
          .limit(1)
          .pipe(Effect.mapError((cause) => persistenceFailure('Consent Purpose Version could not be resolved', cause)));
        if (purposeRows.at(0)?.meaning !== decision.scope.purposeMeaning) {
          return yield* notFound('Consent scope does not match a retained Purpose Version');
        }
        const provisionRows = yield* transaction
          .select({ record: noticeProvisions.provisionRecord })
          .from(noticeProvisions)
          .where(and(eq(noticeProvisions.tenantId, tenantId), eq(noticeProvisions.legalEntityId, legalEntityId)))
          .pipe(
            Effect.mapError((cause) => persistenceFailure('Notice provision evidence could not be resolved', cause)),
          );
        const provisions = yield* decodeAll(
          PrivacyNoticeProvisionSchema,
          provisionRows.map(({ record }) => record),
          'Notice Provision',
        );
        const validNoticeEvidence = decision.noticeEvidenceRefs.every((evidenceRef) =>
          provisions.some(
            (provision) =>
              (provision.provisionId === evidenceRef || provision.evidenceRef === evidenceRef) &&
              isProofOfProvision(provision.outcome) &&
              provision.privacySubjectRef === decision.scope.privacySubjectRef.resourceId &&
              provision.processingPurposeRef === decision.scope.processingPurposeRef.resourceId,
          ),
        );
        if (!validNoticeEvidence) {
          return yield* notFound(
            'Consent Decision notice evidence is not authoritative for the exact subject and purpose',
          );
        }
        yield* transaction
          .insert(consentDecisions)
          .values({
            actionInvocationId,
            decision: decision.decision,
            decisionId: decision.decisionId,
            decisionRecord: encode(ConsentDecisionSchema, decision),
            effectiveAt: date(decision.effectiveAt),
            idempotencyKey: decision.idempotencyKey ?? null,
            legalEntityId,
            recordedAt: date(decision.recordedAt),
            scopeRef: decision.scope.scopeRef,
            tenantId,
          })
          .pipe(Effect.mapError((cause) => persistenceFailure('Consent Decision could not be recorded', cause)));
        return decision;
      },
    ),
    recordDispositionDecision: Effect.fn('PrivacyOperationPostgresRepository.recordDispositionDecision')(
      function* recordDispositionEffect(tenantId, legalEntityId, _actionInvocationId, decision) {
        yield* assertScope(tenantId, legalEntityId);
        yield* transaction
          .insert(dispositionDecisions)
          .values({
            decidedAt: date(decision.decidedAt),
            decisionRecord: encode(PrivacyDispositionDecisionSchema, decision),
            decisionRef: decision.decisionRef,
            legalEntityId,
            outcome: decision.outcome,
            ruleRef: decision.ruleRef,
            ruleVersion: decision.ruleVersion,
            tenantId,
          })
          .pipe(Effect.mapError((cause) => persistenceFailure('Disposition Decision could not be recorded', cause)));
        return decision;
      },
    ),
    recordDsrDeadline: Effect.fn('PrivacyOperationPostgresRepository.recordDsrDeadline')(
      function* recordDsrDeadlineEffect(tenantId, legalEntityId, actionInvocationId, deadline) {
        yield* assertScope(tenantId, legalEntityId);
        const caseRecord = yield* requireDsrCase(tenantId, legalEntityId, deadline.caseRef);
        const obligation = caseRecord.controllerObligations.find(
          ({ controllerRef }) => controllerRef === deadline.controllerRef,
        );
        if (obligation === undefined || obligation.receivedAt !== deadline.receivedAt) {
          return yield* conflict('DSR Deadline must preserve the matching Controller obligation receipt time');
        }
        const replayRows = yield* transaction
          .select({ record: dsrDeadlines.deadlineRecord })
          .from(dsrDeadlines)
          .where(
            and(
              eq(dsrDeadlines.tenantId, tenantId),
              eq(dsrDeadlines.legalEntityId, legalEntityId),
              eq(dsrDeadlines.actionInvocationId, actionInvocationId),
            ),
          )
          .limit(1)
          .pipe(Effect.mapError((cause) => persistenceFailure('DSR Deadline replay could not be resolved', cause)));
        const replay = replayRows.at(0);
        if (replay !== undefined) {
          const retained = yield* decode(DsrDeadlineSchema, replay.record, 'DSR Deadline');
          return dsrDeadlineEquivalent(retained, deadline)
            ? retained
            : yield* conflict('DSR Deadline Action invocation was replayed with different input');
        }
        yield* transaction
          .insert(dsrDeadlines)
          .values({
            actionInvocationId,
            caseRef: deadline.caseRef,
            controllerRef: deadline.controllerRef,
            deadlineAt: date(deadline.deadlineAt),
            deadlineRecord: encode(DsrDeadlineSchema, deadline),
            legalEntityId,
            tenantId,
          })
          .pipe(Effect.mapError((cause) => persistenceFailure('DSR Deadline could not be recorded', cause)));
        return deadline;
      },
    ),
    recordDsrDeliveryEvidence: Effect.fn('PrivacyOperationPostgresRepository.recordDsrDeliveryEvidence')(
      function* recordDsrDeliveryEvidenceEffect(tenantId, legalEntityId, actionInvocationId, evidence) {
        yield* assertScope(tenantId, legalEntityId);
        const accessRows = yield* transaction
          .select({ record: dsrDeliveryAccess.accessRecord })
          .from(dsrDeliveryAccess)
          .where(
            and(
              eq(dsrDeliveryAccess.tenantId, tenantId),
              eq(dsrDeliveryAccess.legalEntityId, legalEntityId),
              eq(dsrDeliveryAccess.accessId, evidence.accessId),
            ),
          )
          .limit(1)
          .pipe(Effect.mapError((cause) => persistenceFailure('DSR Delivery Access could not be loaded', cause)));
        const accessRow = accessRows.at(0);
        if (accessRow === undefined) {
          return yield* notFound('DSR Delivery Evidence Access was not found');
        }
        const access = yield* decode(DsrDeliveryAccessSchema, accessRow.record, 'DSR Delivery Access');
        const accessScopeRefs = new Set(access.deliveryScopeRefs);
        if (
          access.deliveryOutputRef !== evidence.deliveryOutputRef ||
          access.deliveryOutputRevision !== evidence.deliveryOutputRevision ||
          access.channel !== evidence.channel ||
          access.recipientRef !== evidence.recipientRef ||
          access.representationRef !== evidence.representationRef ||
          !evidence.deliveryScopeRefs.every((scopeRef) => accessScopeRefs.has(scopeRef))
        ) {
          return yield* conflict('DSR Delivery Evidence does not match the issued scoped access');
        }
        const replayRows = yield* transaction
          .select({ record: dsrDeliveryEvidence.evidenceRecord })
          .from(dsrDeliveryEvidence)
          .where(
            and(
              eq(dsrDeliveryEvidence.tenantId, tenantId),
              eq(dsrDeliveryEvidence.legalEntityId, legalEntityId),
              eq(dsrDeliveryEvidence.actionInvocationId, actionInvocationId),
            ),
          )
          .limit(1)
          .pipe(
            Effect.mapError((cause) => persistenceFailure('DSR Delivery Evidence replay could not be resolved', cause)),
          );
        const replay = replayRows.at(0);
        if (replay !== undefined) {
          const retained = yield* decode(DsrDeliveryEvidenceSchema, replay.record, 'DSR Delivery Evidence');
          return deliveryEvidenceEquivalent(retained, evidence)
            ? retained
            : yield* conflict('DSR Delivery Evidence Action invocation was replayed with different input');
        }
        yield* transaction
          .insert(dsrDeliveryEvidence)
          .values({
            accessId: evidence.accessId,
            actionInvocationId,
            deliveryOutputRef: evidence.deliveryOutputRef,
            evidenceId: evidence.evidenceId,
            evidenceRecord: encode(DsrDeliveryEvidenceSchema, evidence),
            legalEntityId,
            occurredAt: date(evidence.occurredAt),
            outcome: evidence.outcome,
            recordedAt: date(evidence.recordedAt),
            tenantId,
          })
          .pipe(Effect.mapError((cause) => persistenceFailure('DSR Delivery Evidence could not be recorded', cause)));
        return evidence;
      },
    ),
    recordDsrResponse: Effect.fn('PrivacyOperationPostgresRepository.recordDsrResponse')(
      // fallow-ignore-next-line complexity -- A DSR response is accepted only after every workflow, decision, owner-task, and replay invariant is checked atomically.
      function* recordDsrResponseEffect(tenantId, legalEntityId, actionInvocationId, response) {
        yield* assertScope(tenantId, legalEntityId);
        const caseRecord = yield* requireDsrCase(tenantId, legalEntityId, response.caseRef);
        const workflow = yield* listDsrWorkflow(tenantId, legalEntityId, response.caseRef);
        const decisionRefs = new Set(workflow.decisions.map(({ decisionRef }) => decisionRef));
        if (!response.decisionRefs.every((decisionRef) => decisionRefs.has(decisionRef))) {
          return yield* conflict('DSR Response references a decision outside the Case workflow');
        }
        if (response.final && Option.isNone(response.deliveryEvidenceRef)) {
          return yield* conflict('A final DSR Response requires delivery evidence');
        }
        let deliveryEvidence: DsrDeliveryEvidence | undefined;
        if (Option.isSome(response.deliveryEvidenceRef)) {
          const evidenceRows = yield* transaction
            .select({ record: dsrDeliveryEvidence.evidenceRecord })
            .from(dsrDeliveryEvidence)
            .where(
              and(
                eq(dsrDeliveryEvidence.tenantId, tenantId),
                eq(dsrDeliveryEvidence.legalEntityId, legalEntityId),
                eq(dsrDeliveryEvidence.evidenceId, response.deliveryEvidenceRef.value),
              ),
            )
            .limit(1)
            .pipe(Effect.mapError((cause) => persistenceFailure('DSR Delivery Evidence could not be loaded', cause)));
          const evidenceRow = evidenceRows.at(0);
          if (evidenceRow === undefined) {
            return yield* notFound('DSR Response delivery evidence was not found');
          }
          const evidence = yield* decode(DsrDeliveryEvidenceSchema, evidenceRow.record, 'DSR Delivery Evidence');
          deliveryEvidence = evidence;
          const deliveredScopeRefs = new Set(evidence.deliveryScopeRefs);
          if (
            !isSuccessfulDelivery(evidence) ||
            !response.scopeRefs.every((scopeRef) => deliveredScopeRefs.has(scopeRef))
          ) {
            return yield* conflict('DSR Response requires successful delivery evidence for every response scope');
          }
        }
        if (
          response.final &&
          (deliveryEvidence === undefined ||
            !canFinalizeDsrResponse({
              caseRecord,
              decisions: workflow.decisions,
              deliveryEvidence,
              response,
              tasks: workflow.tasks,
            }))
        ) {
          return yield* conflict(
            'A final DSR Response requires a complete closeable workflow and exact delivery proof',
          );
        }
        const replayRows = yield* transaction
          .select({ record: dsrResponses.responseRecord })
          .from(dsrResponses)
          .where(
            and(
              eq(dsrResponses.tenantId, tenantId),
              eq(dsrResponses.legalEntityId, legalEntityId),
              eq(dsrResponses.actionInvocationId, actionInvocationId),
            ),
          )
          .limit(1)
          .pipe(Effect.mapError((cause) => persistenceFailure('DSR Response replay could not be resolved', cause)));
        const replay = replayRows.at(0);
        if (replay !== undefined) {
          const retained = yield* decode(DsrResponseSchema, replay.record, 'DSR Response');
          return dsrResponseEquivalent(retained, response)
            ? retained
            : yield* conflict('DSR Response Action invocation was replayed with different input');
        }
        yield* transaction
          .insert(dsrResponses)
          .values({
            actionInvocationId,
            caseRef: response.caseRef,
            createdAt: date(response.createdAt),
            final: response.final,
            legalEntityId,
            responseRecord: encode(DsrResponseSchema, response),
            responseRef: response.responseRef,
            tenantId,
          })
          .pipe(Effect.mapError((cause) => persistenceFailure('DSR Response could not be recorded', cause)));
        return response;
      },
    ),
    recordDsrSubstantiveDecision: Effect.fn('PrivacyOperationPostgresRepository.recordDsrSubstantiveDecision')(
      function* recordDsrSubstantiveDecisionEffect(tenantId, legalEntityId, actionInvocationId, decision) {
        yield* assertScope(tenantId, legalEntityId);
        const caseRecord = yield* requireDsrCase(tenantId, legalEntityId, decision.caseRef);
        const matches = caseRecord.controllerObligations.some(
          (obligation) =>
            obligation.controllerRef === decision.controllerRef && obligation.requestedRights.includes(decision.right),
        );
        if (!matches) {
          return yield* conflict('DSR Decision does not match a requested Controller-and-right obligation');
        }
        const replayRows = yield* transaction
          .select({ record: dsrSubstantiveDecisions.decisionRecord })
          .from(dsrSubstantiveDecisions)
          .where(
            and(
              eq(dsrSubstantiveDecisions.tenantId, tenantId),
              eq(dsrSubstantiveDecisions.legalEntityId, legalEntityId),
              eq(dsrSubstantiveDecisions.actionInvocationId, actionInvocationId),
            ),
          )
          .limit(1)
          .pipe(Effect.mapError((cause) => persistenceFailure('DSR Decision replay could not be resolved', cause)));
        const replay = replayRows.at(0);
        if (replay !== undefined) {
          const retained = yield* decode(DsrSubstantiveDecisionSchema, replay.record, 'DSR Decision');
          return dsrDecisionEquivalent(retained, decision)
            ? retained
            : yield* conflict('DSR Decision Action invocation was replayed with different input');
        }
        yield* transaction
          .insert(dsrSubstantiveDecisions)
          .values({
            actionInvocationId,
            caseRef: decision.caseRef,
            controllerRef: decision.controllerRef,
            decidedAt: date(decision.decidedAt),
            decisionRecord: encode(DsrSubstantiveDecisionSchema, decision),
            decisionRef: decision.decisionRef,
            legalEntityId,
            outcome: decision.outcome,
            right: decision.right,
            tenantId,
          })
          .pipe(Effect.mapError((cause) => persistenceFailure('DSR Decision could not be recorded', cause)));
        return decision;
      },
    ),
    recordDsrVerification: Effect.fn('PrivacyOperationPostgresRepository.recordDsrVerification')(
      function* recordDsrVerificationEffect(tenantId, legalEntityId, actionInvocationId, verification) {
        yield* assertScope(tenantId, legalEntityId);
        yield* requireDsrCase(tenantId, legalEntityId, verification.caseRef);
        const replayRows = yield* transaction
          .select({ record: dsrVerifications.verificationRecord })
          .from(dsrVerifications)
          .where(
            and(
              eq(dsrVerifications.tenantId, tenantId),
              eq(dsrVerifications.legalEntityId, legalEntityId),
              eq(dsrVerifications.actionInvocationId, actionInvocationId),
            ),
          )
          .limit(1)
          .pipe(Effect.mapError((cause) => persistenceFailure('DSR Verification replay could not be resolved', cause)));
        const replay = replayRows.at(0);
        if (replay !== undefined) {
          const retained = yield* decode(DsrVerificationSchema, replay.record, 'DSR Verification');
          return dsrVerificationEquivalent(retained, verification)
            ? retained
            : yield* conflict('DSR Verification Action invocation was replayed with different input');
        }
        yield* transaction
          .insert(dsrVerifications)
          .values({
            actionInvocationId,
            caseRef: verification.caseRef,
            legalEntityId,
            outcome: verification.outcome,
            subjectRef: verification.subjectRef,
            tenantId,
            verificationRecord: encode(DsrVerificationSchema, verification),
            verificationRef: verification.verificationRef,
            verificationScope: verification.scope,
          })
          .pipe(Effect.mapError((cause) => persistenceFailure('DSR Verification could not be recorded', cause)));
        return verification;
      },
    ),
    recordEligibility: Effect.fn('PrivacyOperationPostgresRepository.recordEligibility')(
      function* recordEligibilityEffect(tenantId, legalEntityId, actionInvocationId, record) {
        yield* assertScope(tenantId, legalEntityId);
        yield* transaction
          .insert(eligibilityEvidence)
          .values({
            actionInvocationId,
            evaluatedAt: date(record.evidence.trustedDecisionTime),
            evidenceId: record.evidenceId,
            evidenceRecord: encode(PrivacyEligibilityEvidenceSchema, record.evidence),
            legalEntityId,
            outcome: record.outcome.outcome,
            processingScopeRef: record.outcome.evaluatedScope.processingScopeRef.scopeId,
            tenantId,
          })
          .pipe(Effect.mapError((cause) => persistenceFailure('Eligibility Evidence could not be recorded', cause)));
        return record;
      },
    ),
    recordExternalObligation: Effect.fn('PrivacyOperationPostgresRepository.recordExternalObligation')(
      function* recordExternalObligationEffect(tenantId, legalEntityId, actionInvocationId, obligation) {
        yield* assertScope(tenantId, legalEntityId);
        const rows = yield* transaction
          .select({ record: externalObligations.obligationRecord })
          .from(externalObligations)
          .where(
            and(
              eq(externalObligations.tenantId, tenantId),
              eq(externalObligations.legalEntityId, legalEntityId),
              eq(externalObligations.obligationId, obligation.obligationId),
            ),
          )
          .limit(1)
          .pipe(Effect.mapError((cause) => persistenceFailure('External Obligation could not be loaded', cause)));
        const row = rows.at(0);
        if (row !== undefined) {
          const current = yield* decode(ExternalObligationSchema, row.record, 'External Obligation');
          if (obligation.revision !== current.revision + 1) {
            return yield* conflict('External Obligation revision must advance exactly once');
          }
          const changed = yield* transaction
            .update(externalObligations)
            .set({
              actionInvocationId,
              obligationRecord: encode(ExternalObligationSchema, obligation),
              revision: obligation.revision,
              status: obligation.executionStatus,
              updatedAt: date(obligation.updatedAt),
            })
            .where(
              and(
                eq(externalObligations.tenantId, tenantId),
                eq(externalObligations.legalEntityId, legalEntityId),
                eq(externalObligations.obligationId, obligation.obligationId),
                eq(externalObligations.revision, current.revision),
              ),
            )
            .returning({ obligationId: externalObligations.obligationId })
            .pipe(Effect.mapError((cause) => persistenceFailure('External Obligation could not be updated', cause)));
          if (changed.length !== 1) {
            return yield* conflict('External Obligation changed concurrently');
          }
          return obligation;
        }
        if (obligation.revision !== 1) {
          return yield* conflict('A new External Obligation must start at revision one');
        }
        yield* transaction
          .insert(externalObligations)
          .values({
            actionInvocationId,
            createdAt: date(obligation.createdAt),
            legalEntityId,
            measureId: obligation.measureId,
            obligationId: obligation.obligationId,
            obligationRecord: encode(ExternalObligationSchema, obligation),
            revision: obligation.revision,
            status: obligation.executionStatus,
            tenantId,
            updatedAt: date(obligation.updatedAt),
          })
          .pipe(Effect.mapError((cause) => persistenceFailure('External Obligation could not be recorded', cause)));
        return obligation;
      },
    ),
    recordLegalHold: Effect.fn('PrivacyOperationPostgresRepository.recordLegalHold')(
      function* recordLegalHoldEffect(tenantId, legalEntityId, actionInvocationId, hold) {
        yield* assertScope(tenantId, legalEntityId);
        yield* transaction
          .insert(legalHolds)
          .values({
            actionInvocationId,
            effectiveFrom: date(hold.effectiveFrom),
            effectiveTo: date(hold.effectiveTo),
            holdRecord: encode(PrivacyLegalHoldSchema, hold),
            holdRef: hold.holdRef,
            legalEntityId,
            releasedAt: optionalDate(hold.releasedAt),
            tenantId,
          })
          .pipe(Effect.mapError((cause) => persistenceFailure('Legal Hold could not be recorded', cause)));
        return hold;
      },
    ),
    recordOwnerContribution: Effect.fn('PrivacyOperationPostgresRepository.recordOwnerContribution')(
      function* recordOwnerContributionEffect(tenantId, legalEntityId, actionInvocationId, contribution) {
        yield* assertScope(tenantId, legalEntityId);
        const cases = yield* listDsrCases(tenantId, legalEntityId);
        if (
          !cases.some((caseRecord) =>
            caseRecord.controllerObligations.some(
              ({ obligationRef }) => obligationRef === contribution.controllerObligationRef,
            ),
          )
        ) {
          return yield* notFound('Owner Contribution does not match a retained Controller obligation');
        }
        const replayRows = yield* transaction
          .select({ record: ownerContributions.contributionRecord })
          .from(ownerContributions)
          .where(
            and(
              eq(ownerContributions.tenantId, tenantId),
              eq(ownerContributions.legalEntityId, legalEntityId),
              eq(ownerContributions.actionInvocationId, actionInvocationId),
            ),
          )
          .limit(1)
          .pipe(
            Effect.mapError((cause) => persistenceFailure('Owner Contribution replay could not be resolved', cause)),
          );
        const replay = replayRows.at(0);
        if (replay !== undefined) {
          const retained = yield* decode(OwnerContributionSchema, replay.record, 'Owner Contribution');
          return ownerContributionEquivalent(retained, contribution)
            ? retained
            : yield* conflict('Owner Contribution Action invocation was replayed with different input');
        }
        const latestRows = yield* transaction
          .select({ revision: ownerContributions.revision })
          .from(ownerContributions)
          .where(
            and(
              eq(ownerContributions.tenantId, tenantId),
              eq(ownerContributions.legalEntityId, legalEntityId),
              eq(ownerContributions.controllerObligationRef, contribution.controllerObligationRef),
              eq(ownerContributions.ownerModuleId, contribution.owningCapability),
              eq(ownerContributions.subjectRef, contribution.subjectRef),
              eq(ownerContributions.right, contribution.right),
            ),
          )
          .orderBy(desc(ownerContributions.revision))
          .limit(1)
          .pipe(
            Effect.mapError((cause) => persistenceFailure('Owner Contribution history could not be loaded', cause)),
          );
        if (contribution.revision !== (latestRows.at(0)?.revision ?? 0) + 1) {
          return yield* conflict('Owner Contribution revision must advance exactly once');
        }
        yield* transaction
          .insert(ownerContributions)
          .values({
            actionInvocationId,
            contributionId: contribution.contributionId,
            contributionRecord: encode(OwnerContributionSchema, contribution),
            controllerObligationRef: contribution.controllerObligationRef,
            legalEntityId,
            observedAt: date(contribution.observationTime),
            ownerModuleId: contribution.owningCapability,
            revision: contribution.revision,
            right: contribution.right,
            subjectRef: contribution.subjectRef,
            tenantId,
          })
          .pipe(Effect.mapError((cause) => persistenceFailure('Owner Contribution could not be recorded', cause)));
        return contribution;
      },
    ),
    recordOwnerOutcome: Effect.fn('PrivacyOperationPostgresRepository.recordOwnerOutcome')(
      function* recordOwnerOutcomeEffect(tenantId, legalEntityId, _actionInvocationId, outcome) {
        yield* assertScope(tenantId, legalEntityId);
        const dispatch = yield* transaction
          .select({ record: privacyMeasureDispatches.handoffRecord })
          .from(privacyMeasureDispatches)
          .where(
            and(
              eq(privacyMeasureDispatches.tenantId, tenantId),
              eq(privacyMeasureDispatches.legalEntityId, legalEntityId),
              eq(privacyMeasureDispatches.measureId, outcome.measureId),
            ),
          )
          .limit(1)
          .pipe(Effect.mapError((cause) => persistenceFailure('Privacy Measure could not be loaded', cause)));
        const dispatchRow = dispatch.at(0);
        if (dispatchRow === undefined) {
          return yield* notFound('Privacy Measure dispatch was not found');
        }
        const handoff = yield* decode(PrivacyMeasureHandoffSchema, dispatchRow.record, 'Privacy Measure Handoff');
        if (
          handoff.idempotencyKey !== outcome.idempotencyKey ||
          handoff.owningCapability !== outcome.owningCapability ||
          handoff.sourceDecisionRef !== outcome.sourceDecisionRef ||
          handoff.sourceDecisionRevision !== outcome.sourceDecisionRevision ||
          handoff.taskId !== outcome.taskId
        ) {
          return yield* conflict('Owner outcome does not match the dispatched Privacy Measure');
        }
        yield* transaction
          .insert(ownerExecutionOutcomes)
          .values({
            attempt: outcome.attempt,
            legalEntityId,
            measureId: outcome.measureId,
            outcomeId: outcome.outcomeId,
            outcomeRecord: encode(OwnerExecutionOutcomeSchema, outcome),
            recordedAt: date(outcome.recordedAt),
            status: outcome.status,
            tenantId,
          })
          .pipe(Effect.mapError((cause) => persistenceFailure('Owner Execution Outcome could not be recorded', cause)));
        yield* transaction
          .update(privacyMeasureDispatches)
          .set({ status: outcome.status, updatedAt: date(outcome.recordedAt) })
          .where(
            and(
              eq(privacyMeasureDispatches.tenantId, tenantId),
              eq(privacyMeasureDispatches.legalEntityId, legalEntityId),
              eq(privacyMeasureDispatches.measureId, outcome.measureId),
            ),
          )
          .pipe(Effect.mapError((cause) => persistenceFailure('Privacy Measure status could not be updated', cause)));
        return outcome;
      },
    ),
    recordProcessingIntervention: Effect.fn('PrivacyOperationPostgresRepository.recordProcessingIntervention')(
      function* recordProcessingInterventionEffect(tenantId, legalEntityId, actionInvocationId, intervention) {
        yield* assertScope(tenantId, legalEntityId);
        if (!intervention.currentness.authoritative) {
          return yield* conflict('Processing Intervention must come from an authoritative source');
        }
        const replayRows = yield* transaction
          .select({ record: processingInterventions.interventionRecord })
          .from(processingInterventions)
          .where(
            and(
              eq(processingInterventions.tenantId, tenantId),
              eq(processingInterventions.legalEntityId, legalEntityId),
              eq(processingInterventions.actionInvocationId, actionInvocationId),
            ),
          )
          .limit(1)
          .pipe(
            Effect.mapError((cause) =>
              persistenceFailure('Processing Intervention replay could not be resolved', cause),
            ),
          );
        const replay = replayRows.at(0);
        if (replay !== undefined) {
          const retained = yield* decode(PrivacyProcessingInterventionSchema, replay.record, 'Processing Intervention');
          return interventionEquivalent(retained, intervention)
            ? retained
            : yield* conflict('Processing Intervention Action invocation was replayed with different input');
        }
        yield* transaction
          .insert(processingInterventions)
          .values({
            actionInvocationId,
            interventionKind: intervention.kind,
            interventionRecord: encode(PrivacyProcessingInterventionSchema, intervention),
            interventionRef: intervention.interventionRef,
            legalEntityId,
            observedAt: date(intervention.currentness.observedAt),
            processingScopeRef: intervention.scope.processingScopeRef.scopeId,
            status: intervention.status,
            tenantId,
          })
          .pipe(Effect.mapError((cause) => persistenceFailure('Processing Intervention could not be recorded', cause)));
        return intervention;
      },
    ),
    recordRepresentation: Effect.fn('PrivacyOperationPostgresRepository.recordRepresentation')(
      function* recordRepresentationEffect(
        tenantId,
        legalEntityId,
        actionInvocationId,
        representationId,
        representation,
      ) {
        yield* assertScope(tenantId, legalEntityId);
        if (
          representation.representativePrincipal.tenantId !== tenantId ||
          representation.scope.subjectRef.tenantId !== tenantId
        ) {
          return yield* scopeMismatch('Privacy Representation references another tenant');
        }
        const subjectRows = yield* transaction
          .select({ id: privacySubjects.privacySubjectId })
          .from(privacySubjects)
          .where(
            and(
              eq(privacySubjects.tenantId, tenantId),
              eq(privacySubjects.legalEntityId, legalEntityId),
              eq(privacySubjects.privacySubjectId, representation.scope.subjectRef.resourceId),
            ),
          )
          .limit(1)
          .pipe(
            Effect.mapError((cause) => persistenceFailure('Representation Privacy Subject could not be loaded', cause)),
          );
        if (subjectRows.length === 0) {
          return yield* notFound('Representation Privacy Subject was not found');
        }
        const replayRows = yield* transaction
          .select({ record: privacyRepresentations.representationRecord })
          .from(privacyRepresentations)
          .where(
            and(
              eq(privacyRepresentations.tenantId, tenantId),
              eq(privacyRepresentations.legalEntityId, legalEntityId),
              eq(privacyRepresentations.actionInvocationId, actionInvocationId),
            ),
          )
          .limit(1)
          .pipe(Effect.mapError((cause) => persistenceFailure('Representation replay could not be resolved', cause)));
        const replay = replayRows.at(0);
        if (replay !== undefined) {
          const retained = yield* decode(RepresentationSchema, replay.record, 'Privacy Representation');
          return representationEquivalent(retained, representation)
            ? retained
            : yield* conflict('Representation Action invocation was replayed with different input');
        }
        yield* transaction
          .insert(privacyRepresentations)
          .values({
            actionInvocationId,
            legalEntityId,
            representationId,
            representationRecord: encode(RepresentationSchema, representation),
            representativePrincipalId: representation.representativePrincipal.principalId,
            subjectRef: representation.scope.subjectRef.resourceId,
            tenantId,
            validFrom: date(representation.validFrom),
            validTo: optionalDate(representation.validTo),
          })
          .pipe(Effect.mapError((cause) => persistenceFailure('Privacy Representation could not be recorded', cause)));
        return representation;
      },
    ),
    recordRetentionException: Effect.fn('PrivacyOperationPostgresRepository.recordRetentionException')(
      function* recordRetentionExceptionEffect(tenantId, legalEntityId, actionInvocationId, exception) {
        yield* assertScope(tenantId, legalEntityId);
        yield* transaction
          .insert(retentionExceptions)
          .values({
            actionInvocationId,
            effectiveFrom: date(exception.effectiveFrom),
            effectiveTo: date(exception.effectiveTo),
            exceptionRecord: encode(RetentionExceptionSchema, exception),
            exceptionRef: exception.exceptionRef,
            legalEntityId,
            releasedAt: optionalDate(exception.releasedAt),
            tenantId,
          })
          .pipe(Effect.mapError((cause) => persistenceFailure('Retention Exception could not be recorded', cause)));
        return exception;
      },
    ),
    resolveEligibilityInputs: Effect.fn('PrivacyOperationPostgresRepository.resolveEligibilityInputs')(
      // fallow-ignore-next-line complexity -- Eligibility resolution atomically reconciles all independently versioned evidence streams before returning a decision input.
      function* resolveEligibilityInputsEffect(tenantId, legalEntityId, intendedScope, applicabilityScope, asOf) {
        yield* assertScope(tenantId, legalEntityId);
        const [applicabilityHistory, basisHistory, consentResolution, interventionRows] = yield* Effect.all(
          [
            listApplicabilityDecisions(tenantId, legalEntityId),
            listLegalBasisAssignments(tenantId, legalEntityId),
            makeRepository(transaction, trustedScope).readCurrentConsent(
              tenantId,
              legalEntityId,
              intendedScope.processingScopeRef.scopeId,
            ),
            transaction
              .select({ record: processingInterventions.interventionRecord })
              .from(processingInterventions)
              .where(
                and(
                  eq(processingInterventions.tenantId, tenantId),
                  eq(processingInterventions.legalEntityId, legalEntityId),
                  eq(processingInterventions.processingScopeRef, intendedScope.processingScopeRef.scopeId),
                ),
              )
              .orderBy(desc(processingInterventions.observedAt))
              .pipe(
                Effect.mapError((cause) => persistenceFailure('Processing Interventions could not be resolved', cause)),
              ),
          ],
          { concurrency: 1 },
        );
        const interventions = yield* decodeAll(
          PrivacyProcessingInterventionSchema,
          interventionRows.map(({ record }) => record),
          'Processing Intervention',
        );

        const matchingApplicability = applicabilityHistory
          .filter(
            (decision) =>
              decision.evaluatedAt <= asOf &&
              decision.evaluatedScope.operation === applicabilityScope.operation &&
              decision.evaluatedScope.processingScopeRef.scopeId === applicabilityScope.processingScopeRef.scopeId &&
              decision.evaluatedScope.processingScopeRef.scopeType === applicabilityScope.processingScopeRef.scopeType,
          )
          .toSorted((left, right) => right.evaluatedAt.localeCompare(left.evaluatedAt));
        const applicability = matchingApplicability.at(0) ?? null;
        const applicabilityConflict =
          applicability !== null &&
          matchingApplicability.filter(({ evaluatedAt }) => evaluatedAt === applicability.evaluatedAt).length > 1;
        let applicabilityCurrentness: PrivacyInputCurrentness | null = null;
        if (applicability !== null) {
          applicabilityCurrentness = applicabilityConflict
            ? unavailableCurrentness(asOf, 'conflict', 'privacy.core.applicability-decisions')
            : authoritativeCurrentness(
                applicability.evaluatedAt,
                applicability.policyIdentities
                  .map(({ policyKey, policyVersion }) => `${policyKey}:${policyVersion}`)
                  .join(','),
                'privacy.core.applicability-decisions',
              );
        }

        const matchingBasis = basisHistory.filter(
          (assignment) =>
            assignment.decision === 'APPROVED' &&
            assignment.effectiveFrom <= asOf &&
            (assignment.effectiveTo === null || asOf < assignment.effectiveTo) &&
            assignment.scope.controllerRef === intendedScope.controllerRef &&
            assignment.scope.processingScopeRef.scopeId === intendedScope.processingScopeRef.scopeId &&
            assignment.scope.processingScopeRef.scopeType === intendedScope.processingScopeRef.scopeType &&
            assignment.scope.purposeRef.resourceId === intendedScope.purposeRef &&
            assignment.scope.purposeVersionId === intendedScope.purposeVersionId,
        );
        const basisAssignment = matchingBasis.length === 1 ? matchingBasis.at(0) : undefined;
        const legalBasis =
          basisAssignment === undefined
            ? null
            : {
                basisRef: `legal-basis:${basisAssignment.basis.toLowerCase()}`,
                basisVersion: basisAssignment.basisVersion,
                currentness: authoritativeCurrentness(
                  basisAssignment.provenance.recordedAt,
                  basisAssignment.assignmentRef.resourceId,
                  'privacy.core.legal-basis-assignments',
                  basisAssignment.effectiveTo ?? undefined,
                ),
                scope: intendedScope,
              };

        const consent = consentResolution.outcome === 'CURRENT' ? consentResolution.decision : null;
        let consentCurrentness: PrivacyInputCurrentness | null = null;
        if (consentResolution.outcome === 'CURRENT') {
          consentCurrentness = authoritativeCurrentness(
            consentResolution.decision.recordedAt,
            consentResolution.decision.decisionId,
            'privacy.core.consent-decisions',
          );
        } else if (consentResolution.outcome === 'CONFLICT') {
          consentCurrentness = unavailableCurrentness(asOf, 'conflict', 'privacy.core.consent-decisions');
        }

        const currentIntervention = (kind: PrivacyProcessingIntervention['kind']) => {
          const matching = interventions
            .filter(
              (intervention) =>
                intervention.kind === kind &&
                intervention.currentness.observedAt <= asOf &&
                intendedScopeEquivalent(intervention.scope, intendedScope),
            )
            .toSorted((left, right) => right.currentness.observedAt.localeCompare(left.currentness.observedAt));
          const current = matching.at(0);
          if (current !== undefined) {
            return current;
          }
          return {
            currentness: authoritativeCurrentness(
              asOf,
              'complete-empty-snapshot',
              'privacy.core.processing-interventions',
            ),
            interventionRef: `privacy-${kind.toLowerCase()}:absent:${intendedScope.processingScopeRef.scopeId}`,
            kind,
            scope: intendedScope,
            status: 'ABSENT' as const,
          };
        };
        const objectionRecord = currentIntervention('OBJECTION');
        const restrictionRecord = currentIntervention('RESTRICTION');
        const objection = {
          currentness: objectionRecord.currentness,
          objectionRef: objectionRecord.interventionRef,
          scope: objectionRecord.scope,
          status: objectionRecord.status,
        };
        const restriction = {
          currentness: restrictionRecord.currentness,
          restrictionRef: restrictionRecord.interventionRef,
          scope: restrictionRecord.scope,
          status: restrictionRecord.status,
        };
        const authoritativeReferences = [
          ...(applicability === null
            ? []
            : [
                {
                  kind: 'PRIVACY_APPLICABILITY_DECISION',
                  reference: applicability.evaluatedAt,
                  revision: applicabilityCurrentness?.revision ?? 'unknown',
                },
              ]),
          ...(basisAssignment === undefined
            ? []
            : [
                {
                  kind: 'PRIVACY_LEGAL_BASIS_ASSIGNMENT',
                  reference: basisAssignment.assignmentRef.resourceId,
                  revision: basisAssignment.basisVersion,
                },
              ]),
          ...(consent === null
            ? []
            : [
                {
                  kind: 'PRIVACY_CONSENT_DECISION',
                  reference: consent.decisionId,
                  revision: consent.recordedAt,
                },
              ]),
          {
            kind: 'PRIVACY_PROCESSING_OBJECTION',
            reference: objection.objectionRef,
            revision: objection.currentness.revision,
          },
          {
            kind: 'PRIVACY_PROCESSING_RESTRICTION',
            reference: restriction.restrictionRef,
            revision: restriction.currentness.revision,
          },
        ];
        return {
          authoritativeReferences,
          input: {
            applicability,
            applicabilityCurrentness,
            applicabilityScope,
            asOf,
            consent,
            consentCurrentness,
            intendedScope,
            legalBasis,
            objection,
            restriction,
          },
          policyRevisions:
            applicability?.policyIdentities.map(({ policyKey, policyVersion }) => ({
              policyRef: policyKey,
              revision: policyVersion,
            })) ?? [],
        };
      },
    ),
    updateDsrCase: Effect.fn('PrivacyOperationPostgresRepository.updateDsrCase')(
      function* updateDsrCaseEffect(tenantId, legalEntityId, _actionInvocationId, caseRecord, expectedUpdatedAt) {
        yield* assertScope(tenantId, legalEntityId);
        const existing = yield* requireDsrCase(tenantId, legalEntityId, caseRecord.caseRef);
        if (
          existing.originalReceivedAt !== caseRecord.originalReceivedAt ||
          existing.createdAt !== caseRecord.createdAt
        ) {
          return yield* conflict('DSR Case intake timestamps are immutable');
        }
        if (['RESPONDED', 'CLOSED'].includes(caseRecord.status)) {
          const workflow = yield* listDsrWorkflow(tenantId, legalEntityId, caseRecord.caseRef);
          const finalResponse = workflow.responses.some(({ final }) => final);
          if (!finalResponse || !canCloseDsrCase(caseRecord, workflow.decisions, workflow.tasks)) {
            return yield* conflict('DSR Case cannot be responded or closed before every obligation is complete');
          }
        }
        const now = DateTime.toDateUtc(yield* DateTime.now);
        const predicate = and(
          eq(dsrCases.tenantId, tenantId),
          eq(dsrCases.legalEntityId, legalEntityId),
          eq(dsrCases.caseRef, caseRecord.caseRef),
          ...(expectedUpdatedAt === null ? [] : [eq(dsrCases.updatedAt, date(expectedUpdatedAt))]),
        );
        const changed = yield* transaction
          .update(dsrCases)
          .set({
            caseRecord: encode(DsrCaseSchema, caseRecord),
            caseStatus: caseRecord.status,
            updatedAt: now,
          })
          .where(predicate)
          .returning({ caseRef: dsrCases.caseRef })
          .pipe(Effect.mapError((cause) => persistenceFailure('DSR Case could not be updated', cause)));
        if (changed.length !== 1) {
          const concurrent = yield* getDsrCase(tenantId, legalEntityId, caseRecord.caseRef);
          return yield* Option.isNone(concurrent)
            ? notFound('DSR Case was not found')
            : conflict('DSR Case changed concurrently');
        }
        return caseRecord;
      },
    ),
    upsertDsrOwnerTask: Effect.fn('PrivacyOperationPostgresRepository.upsertDsrOwnerTask')(
      function* upsertDsrOwnerTaskEffect(tenantId, legalEntityId, actionInvocationId, task) {
        yield* assertScope(tenantId, legalEntityId);
        const caseRecord = yield* requireDsrCase(tenantId, legalEntityId, task.caseRef);
        if (
          !caseRecord.controllerObligations.some(
            (obligation) =>
              obligation.controllerRef === task.controllerRef && obligation.requestedRights.includes(task.right),
          )
        ) {
          return yield* conflict('DSR Owner Task does not match a requested Controller-and-right obligation');
        }
        const replayRows = yield* transaction
          .select({ record: dsrOwnerTasks.taskRecord })
          .from(dsrOwnerTasks)
          .where(
            and(
              eq(dsrOwnerTasks.tenantId, tenantId),
              eq(dsrOwnerTasks.legalEntityId, legalEntityId),
              eq(dsrOwnerTasks.actionInvocationId, actionInvocationId),
            ),
          )
          .limit(1)
          .pipe(Effect.mapError((cause) => persistenceFailure('DSR Owner Task replay could not be resolved', cause)));
        const replay = replayRows.at(0);
        if (replay !== undefined) {
          const retained = yield* decode(DsrOwnerTaskSchema, replay.record, DSR_OWNER_TASK_LABEL);
          return dsrTaskEquivalent(retained, task)
            ? retained
            : yield* conflict('DSR Owner Task Action invocation was replayed with different input');
        }
        const currentRows = yield* transaction
          .select({ record: dsrOwnerTasks.taskRecord })
          .from(dsrOwnerTasks)
          .where(
            and(
              eq(dsrOwnerTasks.tenantId, tenantId),
              eq(dsrOwnerTasks.legalEntityId, legalEntityId),
              eq(dsrOwnerTasks.taskId, task.taskRef),
            ),
          )
          .limit(1)
          .pipe(Effect.mapError((cause) => persistenceFailure('DSR Owner Task could not be loaded', cause)));
        const currentRow = currentRows.at(0);
        if (currentRow === undefined) {
          yield* transaction
            .insert(dsrOwnerTasks)
            .values({
              actionInvocationId,
              caseRef: task.caseRef,
              idempotencyKey: task.idempotencyKey,
              legalEntityId,
              owningCapability: task.ownerModuleId,
              status: task.status,
              taskId: task.taskRef,
              taskRecord: encode(DsrOwnerTaskSchema, task),
              tenantId,
            })
            .pipe(Effect.mapError((cause) => persistenceFailure('DSR Owner Task could not be recorded', cause)));
          return task;
        }
        const current = yield* decode(DsrOwnerTaskSchema, currentRow.record, DSR_OWNER_TASK_LABEL);
        if (
          current.idempotencyKey !== task.idempotencyKey ||
          current.caseRef !== task.caseRef ||
          current.controllerRef !== task.controllerRef ||
          current.ownerModuleId !== task.ownerModuleId ||
          current.right !== task.right
        ) {
          return yield* conflict('DSR Owner Task immutable identity changed');
        }
        yield* transaction
          .update(dsrOwnerTasks)
          .set({
            actionInvocationId,
            status: task.status,
            taskRecord: encode(DsrOwnerTaskSchema, task),
            updatedAt: DateTime.toDateUtc(yield* DateTime.now),
          })
          .where(
            and(
              eq(dsrOwnerTasks.tenantId, tenantId),
              eq(dsrOwnerTasks.legalEntityId, legalEntityId),
              eq(dsrOwnerTasks.taskId, task.taskRef),
            ),
          )
          .pipe(Effect.mapError((cause) => persistenceFailure('DSR Owner Task could not be updated', cause)));
        return task;
      },
    ),
    upsertRetentionRule: Effect.fn('PrivacyOperationPostgresRepository.upsertRetentionRule')(
      function* upsertRetentionRuleEffect(tenantId, legalEntityId, actionInvocationId, rule) {
        yield* assertScope(tenantId, legalEntityId);
        const rows = yield* transaction
          .select({ ruleVersion: retentionRules.ruleVersion })
          .from(retentionRules)
          .where(
            and(
              eq(retentionRules.tenantId, tenantId),
              eq(retentionRules.legalEntityId, legalEntityId),
              eq(retentionRules.ruleRef, rule.ruleRef),
            ),
          )
          .orderBy(desc(retentionRules.ruleVersion))
          .limit(1)
          .pipe(Effect.mapError((cause) => persistenceFailure('Retention Rule history could not be loaded', cause)));
        const latest = rows.at(0)?.ruleVersion ?? 0;
        if (rule.ruleVersion !== latest + 1) {
          return yield* conflict('Retention Rule version must advance exactly once');
        }
        yield* transaction
          .insert(retentionRules)
          .values({
            actionInvocationId,
            contentScopeRef: rule.contentScopeRef,
            effectiveFrom: date(rule.effectiveFrom),
            effectiveTo: optionalDate(rule.effectiveTo),
            legalEntityId,
            retentionRuleId: randomUUID(),
            ruleRecord: encode(PrivacyRetentionRuleVersionSchema, rule),
            ruleRef: rule.ruleRef,
            ruleVersion: rule.ruleVersion,
            tenantId,
          })
          .pipe(Effect.mapError((cause) => persistenceFailure('Retention Rule could not be recorded', cause)));
        return rule;
      },
    ),
    upsertTemporaryDsrExport: Effect.fn('PrivacyOperationPostgresRepository.upsertTemporaryDsrExport')(
      // fallow-ignore-next-line complexity -- Temporary export persistence deliberately keeps replay, expiry, scope, and immutable-evidence checks in one transaction.
      function* upsertTemporaryDsrExportEffect(tenantId, legalEntityId, actionInvocationId, temporaryExport) {
        yield* assertScope(tenantId, legalEntityId);
        const rows = yield* transaction
          .select({
            actionInvocationId: temporaryDsrExports.actionInvocationId,
            record: temporaryDsrExports.exportRecord,
          })
          .from(temporaryDsrExports)
          .where(
            and(
              eq(temporaryDsrExports.tenantId, tenantId),
              eq(temporaryDsrExports.legalEntityId, legalEntityId),
              eq(temporaryDsrExports.exportRef, temporaryExport.exportRef),
            ),
          )
          .limit(1)
          .pipe(Effect.mapError((cause) => persistenceFailure('Temporary DSR Export could not be loaded', cause)));
        const row = rows.at(0);
        if (row === undefined) {
          yield* transaction
            .insert(temporaryDsrExports)
            .values({
              actionInvocationId,
              createdAt: date(temporaryExport.createdAt),
              deliveryOutputRef: temporaryExport.deliveryOutputRef,
              deliveryOutputRevision: temporaryExport.deliveryOutputRevision,
              disposedAt: temporaryExport.disposedAt === null ? null : date(temporaryExport.disposedAt),
              exportRecord: encode(TemporaryDsrExportSchema, temporaryExport),
              exportRef: temporaryExport.exportRef,
              legalEntityId,
              retainUntil: date(temporaryExport.retainUntil),
              tenantId,
              updatedAt: date(temporaryExport.createdAt),
            })
            .pipe(Effect.mapError((cause) => persistenceFailure('Temporary DSR Export could not be recorded', cause)));
          return temporaryExport;
        }
        const current = yield* decode(TemporaryDsrExportSchema, row.record, 'Temporary DSR Export');
        if (row.actionInvocationId === actionInvocationId) {
          return temporaryExportEquivalent(current, temporaryExport)
            ? current
            : yield* conflict('Temporary DSR Export Action invocation was replayed with different input');
        }
        if (
          current.deliveryOutputRef !== temporaryExport.deliveryOutputRef ||
          current.deliveryOutputRevision !== temporaryExport.deliveryOutputRevision ||
          current.createdAt !== temporaryExport.createdAt ||
          current.retainUntil !== temporaryExport.retainUntil ||
          current.storageRef !== temporaryExport.storageRef ||
          (current.disposedAt !== null && temporaryExport.disposedAt === null)
        ) {
          return yield* conflict('Temporary DSR Export immutable identity or disposition changed invalidly');
        }
        yield* transaction
          .update(temporaryDsrExports)
          .set({
            actionInvocationId,
            disposedAt: temporaryExport.disposedAt === null ? null : date(temporaryExport.disposedAt),
            exportRecord: encode(TemporaryDsrExportSchema, temporaryExport),
            updatedAt: DateTime.toDateUtc(yield* DateTime.now),
          })
          .where(
            and(
              eq(temporaryDsrExports.tenantId, tenantId),
              eq(temporaryDsrExports.legalEntityId, legalEntityId),
              eq(temporaryDsrExports.exportRef, temporaryExport.exportRef),
            ),
          )
          .pipe(Effect.mapError((cause) => persistenceFailure('Temporary DSR Export could not be updated', cause)));
        return temporaryExport;
      },
    ),
  };
};

export const privacyOperationRepositoryForScope = (
  transaction: ScopedTransaction,
  scope: OperationalScope,
): Effect.Effect<PrivacyOperationRepositoryService, OperationContextUnavailable> =>
  scope.legalEntityId === undefined
    ? Effect.fail(scopeUnavailable())
    : Effect.succeed(
        makeRepository(transaction, {
          legalEntityId: scope.legalEntityId,
          tenantId: scope.tenantId,
        }),
      );
