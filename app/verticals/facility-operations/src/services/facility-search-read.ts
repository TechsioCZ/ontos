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

const FacilitySearchRelevanceSchema = Schema.Struct({
  score: Schema.Int.check(Schema.isBetween({ maximum: 1000, minimum: 0 })),
  version: Schema.Literal('1'),
});
export type FacilitySearchRelevance = typeof FacilitySearchRelevanceSchema.Type;

export interface FacilitySearchHit<Ref> {
  readonly ref: Ref;
  readonly relevance?: FacilitySearchRelevance;
  readonly selectedLegalEntityId: typeof SelectedLegalEntityIdSchema.Type;
  readonly title: string;
}

interface RelevanceCarrier {
  readonly relevance?: unknown;
}

/** Core emits relevance only when asked; validate the actual wire shape before publishing it. */
const readFacilitySearchRelevance = (hit: RelevanceCarrier): FacilitySearchRelevance | undefined =>
  Schema.is(FacilitySearchRelevanceSchema)(hit.relevance) ? hit.relevance : undefined;

/** The request contains search text only. Core's trusted scope chooses tenant and company. */
export const loadFacilitySearch = Effect.fn('FacilitySearch.read')(function* loadFacilitySearch<Ref, Encoded>(
  scope: OperationalScope,
  resource: 'asset' | 'device' | 'document' | 'meter',
  query: string,
  refSchema: Schema.Codec<Ref, Encoded>,
  includeArchived = false,
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
        includeArchived,
        includeRelevance: true,
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
        (hit.archived && !includeArchived) ||
        hit.subjectRef !== undefined ||
        hit.matchedRef !== undefined ||
        hit.matchedSubjectRef !== undefined
      ) {
        return Effect.fail(unavailable());
      }
      const relevance = readFacilitySearchRelevance(hit);
      return Schema.decodeUnknownEffect(refSchema)(hit.ref).pipe(
        Effect.mapError(unavailable),
        Effect.map((ref) => {
          const result: FacilitySearchHit<Ref> = { ref, selectedLegalEntityId, title: hit.title };
          return relevance === undefined ? result : { ...result, relevance };
        }),
      );
    },
    { concurrency: 1 },
  );
});
