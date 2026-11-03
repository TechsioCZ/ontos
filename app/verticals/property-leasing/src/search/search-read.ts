import { CoreSearchQueryRuntime, OperationContextUnavailable } from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import { Effect, Schema } from 'effect';

import { LeasesProviderRelevanceSchema } from '../../shared/apis/leases-search.ts';
import type { LeasesProviderRelevance, LeasesProviderResponse } from '../../shared/apis/leases-search.ts';

const owningModuleKey = 'property.leasing';

interface RelevanceCarrier {
  readonly relevance?: unknown;
}

/** Core emits relevance only when asked; validate the actual wire shape before publishing it. */
const readRelevance = (hit: RelevanceCarrier): LeasesProviderRelevance | undefined =>
  Schema.is(LeasesProviderRelevanceSchema)(hit.relevance) ? hit.relevance : undefined;

/** Browser input supplies text only. Both query scope and returned company are checked against trusted context. */
export const loadOwnerSearch = Effect.fn('LeaseSearch.load')(function* loadSearch(
  scope: OperationalScope,
  query: string,
  resourceType: 'property.leasing.occupancy',
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
      includeRelevance: true,
      moduleId: owningModuleKey,
      query,
      resourceType,
      selectedLegalEntityId: legalEntityId,
      tenantId,
    },
    scope,
  );
  // Core owns relevance ordering; filtering a trusted scope must not alphabetize it again.
  return hits.flatMap((hit) => {
    if (
      hit.archived ||
      hit.ref.moduleId !== owningModuleKey ||
      hit.ref.resourceType !== resourceType ||
      hit.ref.tenantId !== tenantId ||
      hit.selectedLegalEntityId !== legalEntityId
    ) {
      return [];
    }
    const relevance = readRelevance(hit);
    const result: LeasesProviderResponse[number] = {
      ref: {
        moduleId: owningModuleKey,
        resourceId: hit.ref.resourceId,
        resourceType,
        tenantId: hit.ref.tenantId,
      },
      selectedLegalEntityId: legalEntityId,
      title: hit.title,
    };
    return [relevance === undefined ? result : { ...result, relevance }];
  });
});
