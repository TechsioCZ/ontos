import { CoreSearchProjectionInvalid, OperationContextUnavailable } from '@app/core-runtime';
import type { CoreSearchProjectionHit, OperationalScope } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import { ListAccessConditionSchema, evaluateListAccessPredicate } from '@app/core-runtime/access/decision/list-access';
import type { ListAccessPredicate } from '@app/core-runtime/access/decision/list-access';
import { RecordKeySchema } from '@app/core-runtime/access/ids';
import { matchesCoreSearchValues, parseCoreSearchQuery } from '@app/core-runtime/search-contract';
import { compareCoreSearchHits, coreSearchRelevance } from '@app/core-runtime/search-ranking';
import type { PropertyState } from '../../shared/apis/records.ts';
import { buildCurrentSearchDocuments } from './search-projection.ts';

const predicateSchema = Schema.Struct({
  groups: Schema.Array(
    Schema.Struct({
      clauses: Schema.NonEmptyArray(Schema.Struct({ conditions: Schema.NonEmptyArray(ListAccessConditionSchema) })),
    }),
  ),
});
const invalid = (cause?: unknown) =>
  new CoreSearchProjectionInvalid({
    cause,
    code: 'core_search_projection_invalid',
    reason: 'Property search requires consistent current owner evidence and admitted record access',
  });

/** Validate before opening owner SQL. A denied field must never participate in search or ranking. */
export const prepareOwnerSearch = Effect.fn('PropertySearch.prepare')(function* prepareSearch(
  listAccess: ListAccessPredicate | undefined,
  deniedFieldPaths: readonly (readonly string[])[] | undefined,
) {
  const predicate = yield* Schema.decodeUnknownEffect(predicateSchema, { onExcessProperty: 'error' })(listAccess).pipe(
    Effect.mapError(invalid),
  );
  const fields = yield* Schema.decodeUnknownEffect(Schema.Array(Schema.Array(Schema.String)))(deniedFieldPaths).pipe(
    Effect.mapError(invalid),
  );
  if (fields.length !== 0) {
    return yield* invalid();
  }
  return predicate;
});
interface OwnerSearchResult {
  readonly ref: CoreSearchProjectionHit['ref'];
  readonly relevance?: CoreSearchProjectionHit['relevance'];
  readonly selectedLegalEntityId: string;
  readonly title: string;
}
const visible = (predicate: ListAccessPredicate, id: string) =>
  evaluateListAccessPredicate(predicate, { recordKey: RecordKeySchema.make(id), teamIds: [] });

/** Search only the current admitted owner snapshot. Historical index text cannot control interactive results. */
export const loadOwnerSearch = Effect.fn('PropertySearch.load')(function* loadSearch(
  scope: OperationalScope,
  query: string,
  resourceType: 'property.portfolio.property' | 'property.portfolio.unit' | 'property.portfolio.asset',
  listAccess: ListAccessPredicate | undefined,
  state: PropertyState,
  deniedFieldPaths: readonly (readonly string[])[] | undefined,
) {
  const predicate = yield* prepareOwnerSearch(listAccess, deniedFieldPaths);
  const { legalEntityId, tenantId } = scope;
  if (legalEntityId === undefined) {
    return yield* new OperationContextUnavailable({
      code: 'operation_context_unavailable',
      reason: 'Property search requires a trusted selected company',
    });
  }
  const parsed = yield* Effect.fromResult(parseCoreSearchQuery(query)).pipe(Effect.mapError(invalid));
  const documents = yield* buildCurrentSearchDocuments({
    companies: [{ legalEntityId, state }],
    tenantId,
  });
  const matched = documents.filter(
    (document) =>
      document.ref.resourceType === resourceType &&
      visible(predicate, document.ref.resourceId) &&
      matchesCoreSearchValues([document.title, ...document.searchableText], parsed.tokens),
  );
  return matched
    .toSorted((left, right) => compareCoreSearchHits(left, right, parsed))
    .map((document): OwnerSearchResult => {
      const result = { ref: document.ref, selectedLegalEntityId: legalEntityId, title: document.title };
      return resourceType === 'property.portfolio.asset'
        ? { ...result, relevance: coreSearchRelevance(document, parsed) }
        : result;
    });
});
