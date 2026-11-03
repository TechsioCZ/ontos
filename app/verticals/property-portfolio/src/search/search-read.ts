import {
  CoreSearchProjectionHitSchema,
  CoreSearchProjectionInvalid,
  CoreSearchQueryRuntime,
  OperationContextUnavailable,
} from '@app/core-runtime';
import type { CoreSearchProjectionHit, OperationalScope } from '@app/core-runtime';
import { Effect, Schema } from 'effect';

type CoreSearchRelevance = NonNullable<CoreSearchProjectionHit['relevance']>;

interface OwnerSearchResult {
  readonly ref: CoreSearchProjectionHit['ref'];
  readonly relevance?: CoreSearchRelevance;
  readonly selectedLegalEntityId: string;
  readonly title: string;
}

/** Browser input supplies text only. Both query scope and returned company are checked against trusted context. */
export const loadOwnerSearch = Effect.fn('PropertySearch.load')(function* loadSearch(
  scope: OperationalScope,
  query: string,
  resourceType: 'property.portfolio.property' | 'property.portfolio.unit' | 'property.portfolio.asset',
) {
  const runtime = yield* CoreSearchQueryRuntime;
  const { legalEntityId, tenantId } = scope;
  if (legalEntityId === undefined) {
    return yield* new OperationContextUnavailable({
      code: 'operation_context_unavailable',
      reason: 'Property search requires a trusted selected company',
    });
  }
  const baseQuery = {
    includeArchived: false,
    moduleId: 'property.portfolio',
    query,
    resourceType,
    selectedLegalEntityId: legalEntityId,
    tenantId,
  } as const;
  const hits = yield* runtime.search(
    resourceType === 'property.portfolio.asset' ? { ...baseQuery, includeRelevance: true } : baseQuery,
    scope,
  );
  const validated = yield* Schema.decodeUnknownEffect(Schema.Array(CoreSearchProjectionHitSchema))(hits).pipe(
    Effect.mapError(
      (cause) =>
        new CoreSearchProjectionInvalid({
          cause,
          code: 'core_search_projection_invalid',
          reason: 'Property search returned malformed resource rows',
        }),
    ),
  );
  const results: OwnerSearchResult[] = [];
  for (const hit of validated) {
    if (
      hit.archived ||
      hit.ref.moduleId !== 'property.portfolio' ||
      hit.ref.resourceType !== resourceType ||
      hit.ref.tenantId !== tenantId ||
      hit.selectedLegalEntityId !== legalEntityId
    ) {
      continue;
    }
    const result = { ref: hit.ref, selectedLegalEntityId: legalEntityId, title: hit.title };
    results.push(
      resourceType === 'property.portfolio.asset' && hit.relevance !== undefined
        ? { ...result, relevance: hit.relevance }
        : result,
    );
  }
  if (new Set(results.map(({ ref }) => ref.resourceId)).size !== results.length) {
    return yield* new CoreSearchProjectionInvalid({
      code: 'core_search_projection_invalid',
      reason: 'Property search returned duplicate resource rows',
    });
  }
  return results.toSorted(
    (left, right) =>
      (right.relevance?.score ?? -1) - (left.relevance?.score ?? -1) ||
      left.title.localeCompare(right.title) ||
      left.ref.resourceId.localeCompare(right.ref.resourceId),
  );
});
