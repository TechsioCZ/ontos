import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { OperationContextUnavailable } from '@app/core-runtime';
import { and, eq } from 'drizzle-orm';
import { DateTime, Effect, Option, Schema } from 'effect';
import { randomUUID } from 'node:crypto';

import { ProcessingActivitySchema } from '../../shared/domain/processing-activity.ts';
import {
  applyProcessingActivityTransition,
  buildProcessingActivity,
  ProcessingActivityRegistryError,
  processingActivityTransitionRejection,
} from '../domain/processing-activity-registry.ts';
import { processingActivities, processingActivityLifecycleEvents } from '../database/schema.ts';
import type { ProcessingActivityRepositoryService } from './processing-activity-repository.ts';

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];

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

const makeRepository = (
  transaction: ScopedTransaction,
  trustedScope: Readonly<{ legalEntityId: string; tenantId: string }>,
): ProcessingActivityRepositoryService => {
  const assertScope = (tenantId: string, legalEntityId: string) =>
    tenantId === trustedScope.tenantId && legalEntityId === trustedScope.legalEntityId
      ? Effect.void
      : Effect.fail(failure('Processing Activity request scope does not match the trusted operation scope'));

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
      if (input.activityRef !== undefined && input.activityRef.tenantId !== tenantId) {
        return yield* new ProcessingActivityRegistryError({
          code: 'privacy_processing_activity_transition_rejected',
          reason: 'Processing Activity identity must match the trusted tenant',
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
      const [tenantId, legalEntityId, resourceId, actor, actionInvocationId, to, decisionEvidenceRefs, effectiveAt] =
        args;
      const current = yield* get(tenantId, legalEntityId, resourceId);
      if (Option.isNone(current)) {
        return yield* new ProcessingActivityRegistryError({
          code: 'privacy_processing_activity_not_found',
          reason: 'Processing Activity was not found',
        });
      }
      const rejection = processingActivityTransitionRejection(current.value, to);
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
