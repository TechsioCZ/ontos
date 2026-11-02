import { CoreSearchQueryRuntime, ReadHandlerUnavailable } from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import { SelectedLegalEntityIdSchema } from '../../shared/domain/search-identifiers.ts';

const unavailable = (cause?: unknown) =>
  Object.defineProperty(
    new ReadHandlerUnavailable({
      code: 'read_handler_unavailable',
      reason: 'Facility search is temporarily unavailable',
    }),
    'cause',
    { value: cause },
  );

/** The request contains search text only. Core's trusted scope chooses tenant and company. */
export const loadFacilitySearch = Effect.fn('FacilitySearch.read')(function* loadFacilitySearch<Ref, Encoded>(
  scope: OperationalScope,
  resource: 'asset' | 'device' | 'document',
  query: string,
  refSchema: Schema.Codec<Ref, Encoded>,
) {
  const { legalEntityId } = scope;
  if (legalEntityId === undefined) {
    return yield* unavailable();
  }
  const selectedLegalEntityId = yield* Schema.decodeUnknownEffect(SelectedLegalEntityIdSchema)(legalEntityId).pipe(
    Effect.mapError(unavailable),
  );
  const runtime = yield* CoreSearchQueryRuntime;
  const hits = yield* runtime
    .search(
      {
        includeArchived: false,
        moduleId: 'facility.operations',
        query,
        resourceType: `facility.operations.${resource}`,
        selectedLegalEntityId: legalEntityId,
        tenantId: scope.tenantId,
      },
      scope,
    )
    .pipe(Effect.mapError(unavailable));
  return yield* Effect.forEach(
    hits,
    (hit) => {
      if (
        hit.ref.tenantId !== scope.tenantId ||
        hit.selectedLegalEntityId !== legalEntityId ||
        !hit.ref.resourceId.startsWith(`${legalEntityId}.`) ||
        hit.ref.moduleId !== 'facility.operations' ||
        hit.ref.resourceType !== `facility.operations.${resource}` ||
        hit.archived ||
        hit.subjectRef !== undefined ||
        hit.matchedRef !== undefined ||
        hit.matchedSubjectRef !== undefined
      ) {
        return Effect.fail(unavailable());
      }
      return Schema.decodeUnknownEffect(refSchema)(hit.ref).pipe(
        Effect.mapError(unavailable),
        Effect.map((ref) => ({ ref, selectedLegalEntityId, title: hit.title })),
      );
    },
    { concurrency: 1 },
  );
});
