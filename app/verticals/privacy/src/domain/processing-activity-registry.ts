import { randomUUID } from 'node:crypto';
import { DateTime, Effect, Option, Schema } from 'effect';

import type { PrincipalRef } from '@app/core-runtime';
import type { PrivacyApplicabilityDecision } from '../../shared/domain/privacy-applicability.ts';
import type {
  CreateProcessingActivityInput,
  ProcessingActivity,
  ProcessingActivityLifecycle,
  ProcessingActivityLifecycleEvent,
} from '../../shared/domain/processing-activity.ts';
import type { ProcessingActivityRef } from '../../shared/resources/processing-activity.ts';
import type { ProcessingActivityRepositoryService } from '../persistence/processing-activity-repository.ts';

export type {
  CreateProcessingActivityInput,
  ProcessingActivity,
  ProcessingActivityLifecycle,
} from '../../shared/domain/processing-activity.ts';

export class ProcessingActivityRegistryError extends Schema.TaggedError<ProcessingActivityRegistryError>()(
  'ProcessingActivityRegistryError',
  {
    code: Schema.Literals([
      'privacy_processing_activity_not_found',
      'privacy_processing_activity_persistence_unavailable',
      'privacy_processing_activity_transition_rejected',
    ]),
    reason: Schema.String,
  },
) {}

const activityRef = (tenantId: string, resourceId: string): ProcessingActivityRef => ({
  moduleId: 'privacy.core',
  resourceId,
  resourceType: 'privacy.core.processing-activity',
  tenantId,
});

const hasApprovedApplicability = (decisions: readonly PrivacyApplicabilityDecision[]): boolean =>
  decisions.length > 0 && decisions.every(({ outcome }) => outcome === 'APPLICABLE');

const isProcessingActivityReadyForEffect = (activity: ProcessingActivity): boolean =>
  activity.processingScope.responsibilityAssignmentRefs.length > 0 &&
  activity.legalBasisAssignmentRefs.length > 0 &&
  activity.retentionRuleRefs.length > 0 &&
  hasApprovedApplicability(activity.applicabilityDecisions);

const copyOrEmpty = <Value>(values: readonly Value[] | undefined): Value[] => (values === undefined ? [] : [...values]);
const processingActivityScopedKey = (tenantId: string, legalEntityId: string, resourceId: string): string =>
  `${tenantId}:${legalEntityId}:${resourceId}`;

export const buildProcessingActivity = (input: {
  readonly actor: PrincipalRef;
  readonly createdAt: string;
  readonly legalEntityId: string;
  readonly request: CreateProcessingActivityInput;
  readonly tenantId: string;
}): ProcessingActivity => {
  const { actor, createdAt, legalEntityId, request, tenantId } = input;
  const id = request.activityRef?.resourceId ?? randomUUID();
  const initialEvent: ProcessingActivityLifecycleEvent = {
    actor,
    decisionEvidenceRefs: ['activity-proposed'],
    effectiveAt: createdAt,
    from: null,
    reason: 'Processing Activity proposed',
    recordedAt: createdAt,
    to: 'PROPOSED',
  };
  return {
    activityRef: request.activityRef ?? activityRef(tenantId, id),
    applicabilityDecisions: copyOrEmpty(request.applicabilityDecisions),
    createdAt,
    currentLifecycle: 'PROPOSED',
    dataCategoryRefs: copyOrEmpty(request.dataCategoryRefs),
    dataCoverage: copyOrEmpty(request.dataCoverage),
    legalBasisAssignmentRefs: copyOrEmpty(request.legalBasisAssignmentRefs),
    legalEntityId,
    lifecycle: [initialEvent],
    processingScope: {
      applicabilityScope: request.processingScope.applicabilityScope,
      purposeRef: request.processingScope.purposeRef,
      purposeVersionId: request.processingScope.purposeVersionId,
      responsibilityAssignmentRefs: [...request.processingScope.responsibilityAssignmentRefs],
    },
    recipientRefs: copyOrEmpty(request.recipientRefs),
    recipientTransfers: copyOrEmpty(request.recipientTransfers),
    retentionCoverage: copyOrEmpty(request.retentionCoverage),
    retentionRuleRefs: copyOrEmpty(request.retentionRuleRefs),
    systemOfRecordRefs: copyOrEmpty(request.systemOfRecordRefs),
    updatedAt: createdAt,
  };
};

export const processingActivityTransitionRejection = (
  activity: ProcessingActivity,
  target: ProcessingActivityLifecycle,
): ProcessingActivityRegistryError | undefined => {
  if (target === 'EFFECTIVE' && !isProcessingActivityReadyForEffect(activity)) {
    return new ProcessingActivityRegistryError({
      code: 'privacy_processing_activity_transition_rejected',
      reason:
        'Effective processing requires complete approved purpose, scope, responsibility, applicability, legal basis, and retention references',
    });
  }
  if (activity.currentLifecycle === 'ENDED') {
    return new ProcessingActivityRegistryError({
      code: 'privacy_processing_activity_transition_rejected',
      reason: 'Ended Processing Activity cannot be resurrected',
    });
  }
  return undefined;
};

export const applyProcessingActivityTransition = (
  activity: ProcessingActivity,
  actor: PrincipalRef,
  to: ProcessingActivityLifecycle,
  decisionEvidenceRefs: readonly string[],
  effectiveAt: string,
  recordedAt: string,
): ProcessingActivity => ({
  ...activity,
  currentLifecycle: to,
  lifecycle: [
    ...activity.lifecycle,
    {
      actor,
      decisionEvidenceRefs: [...decisionEvidenceRefs],
      effectiveAt,
      from: activity.currentLifecycle,
      reason: `Processing Activity transitioned to ${to}`,
      recordedAt,
      to,
    },
  ],
  updatedAt: recordedAt,
});

export const makeInMemoryProcessingActivityRegistry = (): ProcessingActivityRepositoryService => {
  const activities = new Map<string, ProcessingActivity>();
  return {
    create: Effect.fn('makeInMemoryProcessingActivityRegistry.create')(function* create(
      tenantId: string,
      legalEntityId: string,
      actor: PrincipalRef,
      _actionInvocationId: string,
      input: CreateProcessingActivityInput,
    ) {
      if (input.activityRef !== undefined && input.activityRef.tenantId !== tenantId) {
        return yield* new ProcessingActivityRegistryError({
          code: 'privacy_processing_activity_transition_rejected',
          reason: 'Processing Activity identity must match the trusted tenant',
        });
      }
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      const activity = buildProcessingActivity({ actor, createdAt, legalEntityId, request: input, tenantId });
      activities.set(processingActivityScopedKey(tenantId, legalEntityId, activity.activityRef.resourceId), activity);
      return activity;
    }),
    get: (tenantId: string, legalEntityId: string, resourceId: string) =>
      Effect.succeed(
        Option.fromNullishOr(activities.get(processingActivityScopedKey(tenantId, legalEntityId, resourceId))),
      ),
    list: (tenantId: string, legalEntityId: string) =>
      Effect.succeed(
        [...activities.values()].filter(
          (activity) => activity.activityRef.tenantId === tenantId && activity.legalEntityId === legalEntityId,
        ),
      ),
    transition: Effect.fn('makeInMemoryProcessingActivityRegistry.transition')(function* transitionActivity(
      tenantId: string,
      legalEntityId: string,
      resourceId: string,
      actor: PrincipalRef,
      _actionInvocationId: string,
      to: ProcessingActivityLifecycle,
      decisionEvidenceRefs: readonly string[],
      effectiveAt: string,
    ) {
      const key = processingActivityScopedKey(tenantId, legalEntityId, resourceId);
      const current = activities.get(key);
      if (current === undefined) {
        return yield* new ProcessingActivityRegistryError({
          code: 'privacy_processing_activity_not_found',
          reason: 'Processing Activity was not found',
        });
      }
      const rejection = processingActivityTransitionRejection(current, to);
      if (rejection !== undefined) {
        return yield* rejection;
      }
      const recordedAt = DateTime.formatIso(yield* DateTime.now);
      const updated = applyProcessingActivityTransition(
        current,
        actor,
        to,
        decisionEvidenceRefs,
        effectiveAt,
        recordedAt,
      );
      activities.set(key, updated);
      return updated;
    }),
  };
};
