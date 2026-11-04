import { CoreSearchQueryRuntime, ReadHandlerUnavailable } from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
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

/** Company and tenant are trusted operation context, never provider input. */
export const loadSearch = Effect.fn('Tasks.loadSearch')(function* loadSearch(scope: OperationalScope, query: string) {
  const runtime = yield* CoreSearchQueryRuntime;
  const { legalEntityId } = scope;
  if (legalEntityId === undefined) {
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
