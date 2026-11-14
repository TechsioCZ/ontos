import { OperationContextUnavailable } from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import { ListAccessConditionSchema, evaluateListAccessPredicate } from '@app/core-runtime/access/decision/list-access';
import type { ListAccessPredicate } from '@app/core-runtime/access/decision/list-access';
import { RecordKeySchema } from '@app/core-runtime/access/ids';
import { matchesCoreSearchValues, parseCoreSearchQuery } from '@app/core-runtime/search-contract';
import { compareCoreSearchHits, coreSearchRelevance } from '@app/core-runtime/search-ranking';
import { OccupancyStateSchema } from '../../shared/apis/records.ts';
import type { OccupancyPersistence } from './persistence.service.ts';
import { buildCurrentSearchDocuments } from './search-projection.ts';

const predicateSchema = Schema.Struct({
  groups: Schema.Array(
    Schema.Struct({
      clauses: Schema.NonEmptyArray(Schema.Struct({ conditions: Schema.NonEmptyArray(ListAccessConditionSchema) })),
    }),
  ),
});

export type LeaseSearchCurrentState = Effect.Success<ReturnType<OccupancyPersistence['load']>>;
const currentStateSchema = Schema.Struct({
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  snapshot: Schema.toType(OccupancyStateSchema),
});
const uuidSchema = Schema.String.check(Schema.isUUID());
const unavailable = (cause?: unknown) =>
  Object.defineProperty(
    new OperationContextUnavailable({
      code: 'operation_context_unavailable',
      reason: 'Lease search requires current owner state and its admitted record predicate',
    }),
    'cause',
    { value: cause },
  );

export const requireLeaseSearchPredicate = (listAccess: ListAccessPredicate | undefined) =>
  Schema.decodeUnknownEffect(predicateSchema, { onExcessProperty: 'error' })(listAccess).pipe(
    Effect.mapError(unavailable),
  );

/** The mandatory current state comes from this Read's scoped owner load, never from the index. */
export const loadOwnerSearch = Effect.fn('LeaseSearch.load')(function* loadSearch(
  scope: OperationalScope,
  query: string,
  resourceType: 'property.leasing.occupancy',
  listAccess: ListAccessPredicate | undefined,
  current: LeaseSearchCurrentState,
) {
  const predicate = yield* requireLeaseSearchPredicate(listAccess);
  const { legalEntityId, tenantId } = scope;
  if (!Schema.is(uuidSchema)(legalEntityId) || !Schema.is(uuidSchema)(tenantId)) {
    return yield* unavailable();
  }
  const visible = yield* Schema.decodeUnknownEffect(currentStateSchema)(current).pipe(Effect.mapError(unavailable));
  const parsed = yield* Effect.fromResult(parseCoreSearchQuery(query)).pipe(Effect.mapError(unavailable));
  const documents = yield* buildCurrentSearchDocuments({ legalEntityId, state: visible.snapshot }, tenantId).pipe(
    Effect.mapError(unavailable),
  );
  // This Read already owns a coherent current snapshot. An historical index must not decide
  // presence, matching, labels or ranking, including when a new owner term was never projected.
  const matched = documents.filter(
    (document) =>
      document.ref.resourceType === resourceType &&
      evaluateListAccessPredicate(predicate, {
        recordKey: RecordKeySchema.make(document.ref.resourceId),
        teamIds: [],
      }) &&
      matchesCoreSearchValues([document.title, ...document.searchableText], parsed.tokens),
  );
  return matched
    .toSorted((left, right) => compareCoreSearchHits(left, right, parsed))
    .map((document) => ({
      ref: document.ref,
      relevance: coreSearchRelevance(document, parsed),
      selectedLegalEntityId: legalEntityId,
      title: document.title,
    }));
});
