import { CoreSearchQueryRuntime, OperationContextUnavailable } from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import { Effect } from 'effect';

/** Browser input supplies text only. Both query scope and returned company are checked against trusted context. */
export const loadOwnerSearch = Effect.fn('PropertySearch.load')(function* loadSearch(
  scope: OperationalScope,
  query: string,
  resourceType: 'property.portfolio.property' | 'property.portfolio.unit',
) {
  const runtime = yield* CoreSearchQueryRuntime;
  const { legalEntityId, tenantId } = scope;
  if (legalEntityId === undefined) {
    return yield* new OperationContextUnavailable({
      code: 'operation_context_unavailable',
      reason: 'Property search requires a trusted selected company',
    });
  }
  const hits = yield* runtime.search(
    {
      includeArchived: false,
      moduleId: 'property.portfolio',
      query,
      resourceType,
      selectedLegalEntityId: legalEntityId,
      tenantId,
    },
    scope,
  );
  return hits
    .flatMap((hit) =>
      !hit.archived &&
      hit.ref.moduleId === 'property.portfolio' &&
      hit.ref.resourceType === resourceType &&
      hit.ref.tenantId === tenantId &&
      hit.selectedLegalEntityId === legalEntityId
        ? [{ ref: hit.ref, selectedLegalEntityId: legalEntityId, title: hit.title }]
        : [],
    )
    .toSorted(
      (left, right) => left.title.localeCompare(right.title) || left.ref.resourceId.localeCompare(right.ref.resourceId),
    );
});
