import { matchesCoreSearchValues, parseCoreSearchQuery } from '@app/core-runtime/search-contract';
import { coreSearchRelevance } from '@app/core-runtime/search-ranking';
import type { PipelineSearchRecord } from './search-record-access.ts';
import { CoreSearchQueryRuntime, CoreSearchProjectionHitSchema, ReadHandlerUnavailable } from '@app/core-runtime';
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

/** Current admitted owner evidence must still match; stale titles, dates and stages cannot disclose a record. */
export const loadCurrentOpportunitySearch = Effect.fn('Pipeline.search.current')(function* current(
  scope: OperationalScope,
  query: string,
  records: readonly PipelineSearchRecord[],
) {
  const parsed = yield* Effect.fromResult(parseCoreSearchQuery(query)).pipe(Effect.mapError(searchUnavailable));
  const hits = yield* loadSearch(scope, query);
  const byId = new Map<string, PipelineSearchRecord>(records.map((record) => [record.id, record]));
  const result = yield* Effect.forEach(
    hits,
    Effect.fn('Pipeline.search.qualifyCurrent')(function* qualifyCurrent(hit) {
      const record = byId.get(hit.ref.resourceId);
      if (
        record === undefined ||
        !matchesCoreSearchValues([record.title, record.id, record.expectedCloseDate, record.stage], parsed.tokens)
      ) {
        return [];
      }
      const currentHit = yield* Schema.decodeUnknownEffect(CoreSearchProjectionHitSchema)({
        ...hit,
        archived: false,
        facets: [],
        metadata: [],
        title: record.title,
      }).pipe(Effect.mapError(searchUnavailable));
      return [
        {
          ref: hit.ref,
          relevance: coreSearchRelevance(currentHit, parsed),
          selectedLegalEntityId: hit.selectedLegalEntityId,
          title: record.title,
        },
      ];
    }),
    { concurrency: 1 },
  );
  return result.flat();
});
