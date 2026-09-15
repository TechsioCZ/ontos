import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { OperationContextUnavailable } from '@app/core-runtime';
import { and, eq } from 'drizzle-orm';
import { DateTime, Effect, Option, Schema } from 'effect';
import { randomUUID } from 'node:crypto';

import { PrivacyApplicabilityDecisionSchema } from '../../shared/domain/privacy-applicability.ts';
import { PrivacyLegalBasisAssignmentSchema } from '../../shared/domain/privacy-legal-basis.ts';
import { PrivacyResponsibilityAssignmentSchema } from '../../shared/domain/privacy-responsibility-assignment.ts';
import { PrivacyRetentionRuleVersionSchema } from '../../shared/domain/privacy-retention-rule.ts';
import { PrivacyMaterialChangeAssessmentSchema } from '../../shared/domain/privacy-material-change.ts';
import { PurposeVersionMaterialScopeSchema } from '../../shared/domain/processing-purpose.ts';
import {
  ProcessingActivitySchema,
  processingActivityInputForeignReferenceReason,
} from '../../shared/domain/processing-activity.ts';
import type { ProcessingActivity } from '../../shared/domain/processing-activity.ts';
import type { ProcessingActivityAuthoritativeCoverage } from '../../shared/domain/processing-coverage.ts';
import { ProcessingPurposeRefSchema } from '../../shared/resources/processing-purpose.ts';
import {
  applyProcessingActivityTransition,
  buildProcessingActivity,
  ProcessingActivityRegistryError,
  processingActivityTransitionRejection,
} from '../domain/processing-activity-registry.ts';
import type { ProcessingActivityPrerequisiteResolver } from '../domain/processing-activity-registry.ts';
import {
  applicabilityDecisions,
  legalBasisAssignments,
  processingActivities,
  processingActivityLifecycleEvents,
  processingPurposes,
  purposeVersions,
  responsibilityAssignments,
  retentionRules,
} from '../database/schema.ts';
import type { ProcessingActivityRepositoryService } from './processing-activity-repository.ts';

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];
const samePurposeRef = Schema.toEquivalence(ProcessingPurposeRefSchema);

const failure = (reason: string, cause?: unknown) => {
  const error = new ProcessingActivityRegistryError({
    code: 'privacy_processing_activity_persistence_unavailable',
    reason,
  });
  if (cause !== undefined) {
    Object.defineProperty(error, 'cause', { configurable: true, value: cause });
  }
  return error;
};

const scopeUnavailable = () =>
  new OperationContextUnavailable({
    code: 'operation_context_unavailable',
    reason: 'Processing Activity operations require a trusted Legal Entity scope',
  });

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- PostgreSQL jsonb is decoded immediately through the public Processing Activity schema.
const decodeActivity = (value: unknown) =>
  Schema.decodeUnknownEffect(ProcessingActivitySchema)(value).pipe(
    Effect.mapError((cause) => failure('Stored Processing Activity could not be decoded', cause)),
  );

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- JSONB is decoded immediately at this repository boundary.
const decodePrerequisite = <A, I>(schema: Schema.Codec<A, I>, value: unknown, label: string) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError((cause) => failure(`Stored ${label} could not be decoded`, cause)),
  );

const decodeNullablePrerequisite = <A, I>(schema: Schema.Codec<A, I>, value: I | null, label: string) =>
  value === null ? Effect.succeed(null) : decodePrerequisite(schema, value, label);

const decodePrerequisiteRows = <A, I>(
  schema: Schema.Codec<A, I>,
  rows: readonly { readonly record: unknown }[],
  label: string,
) => Effect.forEach(rows, ({ record }) => decodePrerequisite(schema, record, label), { concurrency: 1 });

const isoOrNull = (value: Date | null): string | null =>
  value === null ? null : DateTime.formatIso(DateTime.fromDateUnsafe(value));

const prerequisiteRejected = (reason: string) =>
  new ProcessingActivityRegistryError({
    code: 'privacy_processing_activity_transition_rejected',
    reason,
  });

const makeRepository = (
  transaction: ScopedTransaction,
  trustedScope: Readonly<{ legalEntityId: string; tenantId: string }>,
): ProcessingActivityRepositoryService => {
  const assertScope = (tenantId: string, legalEntityId: string) =>
    tenantId === trustedScope.tenantId && legalEntityId === trustedScope.legalEntityId
      ? Effect.void
      : Effect.fail(failure('Processing Activity request scope does not match the trusted operation scope'));

  const coverageMatchesTrustedScope = (coverage: ProcessingActivityAuthoritativeCoverage): boolean =>
    coverage.tenantId === trustedScope.tenantId && coverage.legalEntityId === trustedScope.legalEntityId;

  const resolvePurpose = Effect.fn('ProcessingActivityPostgresRepository.resolvePurpose')(
    function* resolvePurposeEffect(activity: ProcessingActivity) {
      const purposeRows = yield* transaction
        .select()
        .from(processingPurposes)
        .where(
          and(
            eq(processingPurposes.tenantId, trustedScope.tenantId),
            eq(processingPurposes.legalEntityId, trustedScope.legalEntityId),
            eq(processingPurposes.processingPurposeId, activity.processingScope.purposeRef.resourceId),
          ),
        )
        .limit(1)
        .pipe(Effect.mapError((cause) => failure('Processing Purpose prerequisite could not be resolved', cause)));
      const purposeRow = purposeRows.at(0);
      if (purposeRow === undefined) {
        return yield* prerequisiteRejected('Processing Activity references a missing Processing Purpose');
      }
      const purposeRef = {
        moduleId: 'privacy.core' as const,
        resourceId: purposeRow.processingPurposeId,
        resourceType: 'privacy.core.processing-purpose' as const,
        tenantId: purposeRow.tenantId,
      };
      if (!samePurposeRef(purposeRef, activity.processingScope.purposeRef)) {
        return yield* prerequisiteRejected('Processing Activity Purpose reference is not the exact stored identity');
      }
      return { purposeRef, purposeRow };
    },
  );

  const resolvePurposeVersion = Effect.fn('ProcessingActivityPostgresRepository.resolvePurposeVersion')(
    function* resolvePurposeVersionEffect(activity: ProcessingActivity) {
      const versionRows = yield* transaction
        .select()
        .from(purposeVersions)
        .where(
          and(
            eq(purposeVersions.tenantId, trustedScope.tenantId),
            eq(purposeVersions.legalEntityId, trustedScope.legalEntityId),
            eq(purposeVersions.processingPurposeId, activity.processingScope.purposeRef.resourceId),
            eq(purposeVersions.purposeVersionId, activity.processingScope.purposeVersionId),
          ),
        )
        .limit(1)
        .pipe(Effect.mapError((cause) => failure('Purpose Version prerequisite could not be resolved', cause)));
      const versionRow = versionRows.at(0);
      if (versionRow === undefined) {
        return yield* prerequisiteRejected('Processing Activity references a missing Purpose Version');
      }
      const [materialChangeAssessment, materialScope] = yield* Effect.all(
        [
          decodeNullablePrerequisite(
            PrivacyMaterialChangeAssessmentSchema,
            versionRow.materialChangeAssessment,
            'Purpose Version materiality assessment',
          ),
          decodeNullablePrerequisite(
            PurposeVersionMaterialScopeSchema,
            versionRow.materialScope,
            'Purpose Version material scope',
          ),
        ],
        { concurrency: 1 },
      );
      return {
        effectiveFrom: DateTime.formatIso(DateTime.fromDateUnsafe(versionRow.effectiveFrom)),
        effectiveTo: isoOrNull(versionRow.effectiveTo),
        materialChangeAssessment,
        materialScope,
        meaning: versionRow.meaning,
        recordedAt: DateTime.formatIso(DateTime.fromDateUnsafe(versionRow.recordedAt)),
        versionId: versionRow.purposeVersionId,
        versionNumber: versionRow.versionNumber,
      };
    },
  );

  const resolveResponsibilities = Effect.fn('ProcessingActivityPostgresRepository.resolveResponsibilities')(
    function* resolveResponsibilitiesEffect() {
      const rows = yield* transaction
        .select({ record: responsibilityAssignments.assignmentRecord })
        .from(responsibilityAssignments)
        .where(
          and(
            eq(responsibilityAssignments.tenantId, trustedScope.tenantId),
            eq(responsibilityAssignments.legalEntityId, trustedScope.legalEntityId),
          ),
        )
        .pipe(Effect.mapError((cause) => failure('Responsibility prerequisites could not be resolved', cause)));
      return yield* decodePrerequisiteRows(PrivacyResponsibilityAssignmentSchema, rows, 'Responsibility Assignment');
    },
  );

  const resolveApplicability = Effect.fn('ProcessingActivityPostgresRepository.resolveApplicability')(
    function* resolveApplicabilityEffect(activity: ProcessingActivity) {
      const rows = yield* transaction
        .select({ record: applicabilityDecisions.decisionRecord })
        .from(applicabilityDecisions)
        .where(
          and(
            eq(applicabilityDecisions.tenantId, trustedScope.tenantId),
            eq(applicabilityDecisions.legalEntityId, trustedScope.legalEntityId),
            eq(
              applicabilityDecisions.processingScopeRef,
              activity.processingScope.applicabilityScope.processingScopeRef.scopeId,
            ),
            eq(applicabilityDecisions.operation, activity.processingScope.applicabilityScope.operation),
          ),
        )
        .pipe(Effect.mapError((cause) => failure('Applicability prerequisites could not be resolved', cause)));
      return yield* decodePrerequisiteRows(PrivacyApplicabilityDecisionSchema, rows, 'Applicability Decision');
    },
  );

  const resolveLegalBasis = Effect.fn('ProcessingActivityPostgresRepository.resolveLegalBasis')(
    function* resolveLegalBasisEffect() {
      const rows = yield* transaction
        .select({ record: legalBasisAssignments.assignmentRecord })
        .from(legalBasisAssignments)
        .where(
          and(
            eq(legalBasisAssignments.tenantId, trustedScope.tenantId),
            eq(legalBasisAssignments.legalEntityId, trustedScope.legalEntityId),
          ),
        )
        .pipe(Effect.mapError((cause) => failure('Legal Basis prerequisites could not be resolved', cause)));
      return yield* decodePrerequisiteRows(PrivacyLegalBasisAssignmentSchema, rows, 'Legal Basis Assignment');
    },
  );

  const resolveRetention = Effect.fn('ProcessingActivityPostgresRepository.resolveRetention')(
    function* resolveRetentionEffect() {
      const rows = yield* transaction
        .select({ record: retentionRules.ruleRecord })
        .from(retentionRules)
        .where(
          and(
            eq(retentionRules.tenantId, trustedScope.tenantId),
            eq(retentionRules.legalEntityId, trustedScope.legalEntityId),
          ),
        )
        .pipe(Effect.mapError((cause) => failure('Retention prerequisites could not be resolved', cause)));
      return yield* decodePrerequisiteRows(PrivacyRetentionRuleVersionSchema, rows, 'Retention Rule');
    },
  );

  const resolvePrerequisites: ProcessingActivityPrerequisiteResolver = Effect.fn(
    'ProcessingActivityPostgresRepository.resolvePrerequisites',
  )(function* resolveActivityPrerequisites(activity, _asOf, authoritativeCoverage) {
    if (authoritativeCoverage === undefined) {
      return yield* prerequisiteRejected('Processing Activity owner coverage authority is not configured');
    }
    if (!coverageMatchesTrustedScope(authoritativeCoverage)) {
      return yield* prerequisiteRejected(
        'Processing Activity owner coverage authority does not match the trusted Tenant and Legal Entity',
      );
    }
    if (activity.processingScope.purposeRef.tenantId !== trustedScope.tenantId) {
      return yield* prerequisiteRejected('Processing Activity references a Processing Purpose from another tenant');
    }
    const { purposeRef, purposeRow } = yield* resolvePurpose(activity);
    const [purposeVersion, responsibilities, applicability, legalBasis, retention] = yield* Effect.all(
      [
        resolvePurposeVersion(activity),
        resolveResponsibilities(),
        resolveApplicability(activity),
        resolveLegalBasis(),
        resolveRetention(),
      ],
      { concurrency: 1 },
    );
    const purpose = {
      businessCode: purposeRow.businessCode,
      createdAt: DateTime.formatIso(DateTime.fromDateUnsafe(purposeRow.createdAt)),
      governanceOwnerId: purposeRow.governanceOwnerId,
      legalEntityId: purposeRow.legalEntityId,
      lifecycle: purposeRow.lifecycle === 'RETIRED' ? ('RETIRED' as const) : ('ACTIVE' as const),
      purposeRef,
      retiredAt: isoOrNull(purposeRow.retiredAt),
      versions: [purposeVersion],
    };
    return {
      applicabilityDecisions: applicability,
      coverage: authoritativeCoverage,
      legalBasisAssignments: legalBasis,
      purpose,
      purposeVersion,
      responsibilities,
      retentionRules: retention,
    };
  });

  const get: ProcessingActivityRepositoryService['get'] = Effect.fn('ProcessingActivityPostgresRepository.get')(
    function* getActivity(tenantId, legalEntityId, resourceId) {
      yield* assertScope(tenantId, legalEntityId);
      const rows = yield* transaction
        .select({ activityRecord: processingActivities.activityRecord })
        .from(processingActivities)
        .where(
          and(
            eq(processingActivities.tenantId, tenantId),
            eq(processingActivities.legalEntityId, legalEntityId),
            eq(processingActivities.processingActivityId, resourceId),
          ),
        )
        .limit(1)
        .pipe(Effect.mapError((cause) => failure('Processing Activity persistence is unavailable', cause)));
      const [row] = rows;
      return row === undefined ? Option.none() : Option.some(yield* decodeActivity(row.activityRecord));
    },
  );

  return {
    create: Effect.fn('ProcessingActivityPostgresRepository.create')(function* createActivity(
      ...args: Parameters<ProcessingActivityRepositoryService['create']>
    ) {
      const [tenantId, legalEntityId, actor, actionInvocationId, input] = args;
      yield* assertScope(tenantId, legalEntityId);
      const foreignReferenceReason = processingActivityInputForeignReferenceReason(tenantId, input);
      if (foreignReferenceReason !== undefined) {
        return yield* new ProcessingActivityRegistryError({
          code: 'privacy_processing_activity_transition_rejected',
          reason: foreignReferenceReason,
        });
      }
      const nowDateTime = yield* DateTime.now;
      const now = DateTime.toDateUtc(nowDateTime);
      const createdAt = DateTime.formatIso(nowDateTime);
      const activity = buildProcessingActivity({ actor, createdAt, legalEntityId, request: input, tenantId });
      yield* transaction
        .insert(processingActivities)
        .values({
          activityRecord: activity,
          createdAt: now,
          currentLifecycle: activity.currentLifecycle,
          legalEntityId,
          processingActivityId: activity.activityRef.resourceId,
          tenantId,
          updatedAt: now,
        })
        .pipe(Effect.mapError((cause) => failure('Processing Activity could not be created', cause)));
      yield* transaction
        .insert(processingActivityLifecycleEvents)
        .values({
          actionInvocationId,
          effectiveAt: now,
          eventRecord: activity.lifecycle[0],
          fromLifecycle: null,
          legalEntityId,
          lifecycleEventId: randomUUID(),
          processingActivityId: activity.activityRef.resourceId,
          recordedAt: now,
          tenantId,
          toLifecycle: 'PROPOSED',
        })
        .pipe(
          Effect.mapError((cause) => failure('Processing Activity lifecycle evidence could not be recorded', cause)),
        );
      return activity;
    }),
    get,
    list: Effect.fn('ProcessingActivityPostgresRepository.list')(function* listActivities(tenantId, legalEntityId) {
      yield* assertScope(tenantId, legalEntityId);
      const rows = yield* transaction
        .select({ processingActivityId: processingActivities.processingActivityId })
        .from(processingActivities)
        .where(and(eq(processingActivities.tenantId, tenantId), eq(processingActivities.legalEntityId, legalEntityId)))
        .pipe(Effect.mapError((cause) => failure('Processing Activity registry could not be listed', cause)));
      const loaded = yield* Effect.forEach(
        rows,
        ({ processingActivityId }) => get(tenantId, legalEntityId, processingActivityId),
        { concurrency: 1 },
      );
      return loaded.flatMap((activity) => (Option.isSome(activity) ? [activity.value] : []));
    }),
    transition: Effect.fn('ProcessingActivityPostgresRepository.transition')(function* transitionActivity(
      ...args: Parameters<ProcessingActivityRepositoryService['transition']>
    ) {
      const [
        tenantId,
        legalEntityId,
        resourceId,
        actor,
        actionInvocationId,
        to,
        decisionEvidenceRefs,
        effectiveAt,
        authoritativeCoverage,
      ] = args;
      const current = yield* get(tenantId, legalEntityId, resourceId);
      if (Option.isNone(current)) {
        return yield* new ProcessingActivityRegistryError({
          code: 'privacy_processing_activity_not_found',
          reason: 'Processing Activity was not found',
        });
      }
      const prerequisites =
        to === 'EFFECTIVE' ? yield* resolvePrerequisites(current.value, effectiveAt, authoritativeCoverage) : undefined;
      const rejection = processingActivityTransitionRejection(current.value, to, effectiveAt, prerequisites);
      if (rejection !== undefined) {
        return yield* rejection;
      }
      const nowDateTime = yield* DateTime.now;
      const now = DateTime.toDateUtc(nowDateTime);
      const updated = applyProcessingActivityTransition(
        current.value,
        actor,
        to,
        decisionEvidenceRefs,
        effectiveAt,
        DateTime.formatIso(nowDateTime),
      );
      const changed = yield* transaction
        .update(processingActivities)
        .set({ activityRecord: updated, currentLifecycle: to, updatedAt: now })
        .where(
          and(
            eq(processingActivities.tenantId, tenantId),
            eq(processingActivities.legalEntityId, legalEntityId),
            eq(processingActivities.processingActivityId, resourceId),
            eq(processingActivities.currentLifecycle, current.value.currentLifecycle),
          ),
        )
        .returning({ processingActivityId: processingActivities.processingActivityId })
        .pipe(Effect.mapError((cause) => failure('Processing Activity transition could not be stored', cause)));
      if (changed.length !== 1) {
        return yield* new ProcessingActivityRegistryError({
          code: 'privacy_processing_activity_transition_rejected',
          reason: 'Processing Activity changed concurrently; reload current lifecycle before retrying',
        });
      }
      const event = updated.lifecycle.at(-1);
      if (event === undefined) {
        return yield* failure('Processing Activity transition evidence is missing');
      }
      yield* transaction
        .insert(processingActivityLifecycleEvents)
        .values({
          actionInvocationId,
          effectiveAt: DateTime.toDateUtc(DateTime.makeUnsafe(effectiveAt)),
          eventRecord: event,
          fromLifecycle: current.value.currentLifecycle,
          legalEntityId,
          lifecycleEventId: randomUUID(),
          processingActivityId: resourceId,
          recordedAt: now,
          tenantId,
          toLifecycle: to,
        })
        .pipe(
          Effect.mapError((cause) => failure('Processing Activity transition evidence could not be recorded', cause)),
        );
      return updated;
    }),
  };
};

export const processingActivityRepositoryForScope = (
  transaction: ScopedTransaction,
  scope: OperationalScope,
): Effect.Effect<ProcessingActivityRepositoryService, OperationContextUnavailable> =>
  scope.legalEntityId === undefined
    ? Effect.fail(scopeUnavailable())
    : Effect.succeed(makeRepository(transaction, { legalEntityId: scope.legalEntityId, tenantId: scope.tenantId }));
