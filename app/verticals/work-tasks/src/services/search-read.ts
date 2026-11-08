import { CoreSearchQueryRuntime, ReadHandlerUnavailable, ReadPermissionDenied } from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import { AccessDecisionGate } from '@app/core-runtime/access/enforcement';
import type { ListAccessPredicate } from '@app/core-runtime/access/decision/list-access';
import { workRecordsCarrier } from '../../shared/access-declarations.ts';
import { DateTime, Effect, Schema } from 'effect';
import { TasksProviderResponseSchema } from '../../shared/apis/tasks-search.ts';

export const searchUnavailable = (cause?: unknown) =>
  Object.defineProperty(
    new ReadHandlerUnavailable({
      code: 'read_handler_unavailable',
      reason: 'Tasks search is temporarily unavailable',
    }),
    'cause',
    { configurable: true, value: cause },
  );

/** Resolve the actual records reach before the search transaction opens. */
export const prepareTaskSearch = Effect.fn('Tasks.prepareSearch')(function* prepareTaskSearch(
  scope: OperationalScope,
  searchAccess: ListAccessPredicate | undefined,
) {
  if (scope.legalEntityId === undefined || searchAccess === undefined) {
    return yield* searchUnavailable();
  }
  const gate = yield* AccessDecisionGate;
  const records = yield* gate.list({
    carrier: workRecordsCarrier,
    legalEntityScope: 'required',
    now: yield* DateTime.nowAsDate,
    scope,
  });
  if (
    records.decision.outcome === 'UNAVAILABLE' ||
    (records.decision.outcome === 'ALLOWED' && records.predicate === undefined)
  ) {
    return yield* searchUnavailable();
  }
  if (records.decision.outcome !== 'ALLOWED' || records.predicate === undefined) {
    return yield* new ReadPermissionDenied({ code: 'read_permission_denied', reason: 'Task records are forbidden' });
  }
  return { groups: [...records.predicate.groups, ...searchAccess.groups] };
});

/** Company, tenant and the already-proven row filter are trusted operation context. */
export const loadSearch = Effect.fn('Tasks.loadSearch')(function* loadSearch(
  scope: OperationalScope,
  query: string,
  listAccess: ListAccessPredicate,
) {
  const runtime = yield* CoreSearchQueryRuntime;
  const { legalEntityId } = scope;
  if (legalEntityId === undefined || listAccess === undefined) {
    return yield* searchUnavailable();
  }
  const hits = yield* runtime
    .search(
      {
        includeArchived: false,
        includeRelevance: true,
        moduleId: 'work.tasks',
        query,
        resourceType: 'work.tasks.task',
        selectedLegalEntityId: legalEntityId,
        tenantId: scope.tenantId,
      },
      scope,
      { listAccess },
    )
    .pipe(Effect.mapError(searchUnavailable));
  const owned = hits.every(
    (hit) =>
      hit.ref.tenantId === scope.tenantId &&
      hit.selectedLegalEntityId === legalEntityId &&
      hit.ref.moduleId === 'work.tasks' &&
      hit.ref.resourceType === 'work.tasks.task' &&
      !hit.archived &&
      hit.subjectRef === undefined &&
      hit.matchedRef === undefined &&
      hit.matchedSubjectRef === undefined,
  );
  if (!owned) {
    return yield* searchUnavailable();
  }
  const results = hits.map((hit) => {
    const result = { ref: hit.ref, selectedLegalEntityId: legalEntityId, title: hit.title };
    return hit.relevance === undefined ? result : { ...result, relevance: hit.relevance };
  });
  return yield* Schema.decodeUnknownEffect(TasksProviderResponseSchema)(results).pipe(
    Effect.mapError(searchUnavailable),
  );
});
