import { CoreSearchQueryRuntime, ReadHandlerUnavailable } from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import { OpportunityRefSchema } from '../../shared/resources/opportunity.ts';
import {
  OpportunitiesProviderRelevanceSchema,
  OpportunitiesProviderRequestSchema,
} from '../../shared/apis/opportunities-search.ts';
import type {
  OpportunitiesProviderRelevance,
  OpportunitiesProviderResponse,
} from '../../shared/apis/opportunities-search.ts';

interface RelevanceCarrier {
  readonly relevance?: unknown;
}

/** Core emits relevance only when asked; validate the actual wire shape before publishing it. */
const readRelevance = (hit: RelevanceCarrier): OpportunitiesProviderRelevance | undefined =>
  Schema.is(OpportunitiesProviderRelevanceSchema)(hit.relevance) ? hit.relevance : undefined;

export const searchUnavailable = (cause?: unknown) =>
  Object.defineProperty(
    new ReadHandlerUnavailable({
      code: 'read_handler_unavailable',
      reason: 'Opportunities search is temporarily unavailable',
    }),
    'cause',
    { configurable: true, value: cause },
  );

/** Company and tenant are trusted operation context, never provider input. */
export const loadSearch = Effect.fn('Opportunities.loadSearch')(function* loadSearch(
  scope: OperationalScope,
  query: string,
) {
  const { legalEntityId } = scope;
  if (legalEntityId === undefined) {
    return yield* searchUnavailable();
  }
  const validatedQuery = yield* Schema.decodeEffect(OpportunitiesProviderRequestSchema.fields.query)(query).pipe(
    Effect.mapError(searchUnavailable),
  );
  const runtime = yield* CoreSearchQueryRuntime;
  const hits = yield* runtime
    .search(
      {
        includeArchived: false,
        includeRelevance: true,
        moduleId: 'demo.sales-pipeline',
        query: validatedQuery,
        resourceType: 'demo.sales-pipeline.opportunity',
        selectedLegalEntityId: legalEntityId,
        tenantId: scope.tenantId,
      },
      scope,
    )
    .pipe(Effect.mapError(searchUnavailable));
  return yield* Effect.forEach(
    hits,
    Effect.fn('DemoSalesPipeline.validateSearchHit')(function* validateHit(hit) {
      if (
        hit.ref.tenantId !== scope.tenantId ||
        hit.selectedLegalEntityId !== legalEntityId ||
        hit.ref.moduleId !== 'demo.sales-pipeline' ||
        hit.ref.resourceType !== 'demo.sales-pipeline.opportunity' ||
        hit.archived ||
        hit.subjectRef !== undefined ||
        hit.matchedRef !== undefined ||
        hit.matchedSubjectRef !== undefined
      ) {
        return yield* searchUnavailable();
      }
      const ref = yield* Schema.decodeUnknownEffect(OpportunityRefSchema)(hit.ref).pipe(
        Effect.mapError(searchUnavailable),
      );
      const relevance = readRelevance(hit);
      const result: OpportunitiesProviderResponse[number] = {
        ref,
        selectedLegalEntityId: legalEntityId,
        title: hit.title,
      };
      return relevance === undefined ? result : { ...result, relevance };
    }),
    { concurrency: 1 },
  );
});
