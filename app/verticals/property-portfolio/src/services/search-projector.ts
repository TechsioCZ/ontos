import { CoreSearchProjectionStore } from '@app/core-runtime';
import type { OutboxWorkerHandlerContext } from '@app/core-runtime';
import { Effect } from 'effect';

import { buildSearchDocuments, invalidSearchSource } from '../search/projection.ts';
import type { SearchSourceSnapshot } from '../search/projection.ts';
import { loadSearchSnapshot } from './search-source.ts';

export const projectSearchSnapshot = Effect.fn('OwnerSearch.projectSnapshot')(function* projectSnapshot(
  snapshot: SearchSourceSnapshot,
  context: OutboxWorkerHandlerContext,
  _rebuild: boolean,
) {
  const store = yield* CoreSearchProjectionStore;
  if (snapshot.tenantId !== context.tenantId || !/^[1-9][0-9]*$/u.test(snapshot.projectionVersion)) {
    return yield* invalidSearchSource();
  }
  const documents = yield* buildSearchDocuments(snapshot);
  // Snapshot SQL is closed before Core index writes. Core Search enforces the caller's access list
  // predicate and field projection; the owner writes no permission-graph containment edge.
  // Publish each complete type once. Do not upsert individual documents first:
  // that exposes a partial generation and duplicates the subsequent atomic replacement.
  // Complete tenant snapshots also remove disappeared, archived and retired rows on ordinary refreshes.
  yield* Effect.forEach(
    ['property.portfolio.property', 'property.portfolio.unit', 'property.portfolio.asset'],
    (resourceType) =>
      store.replace(
        {
          documents: documents.filter((document) => document.ref.resourceType === resourceType),
          moduleId: 'property.portfolio',
          rebuildVersion: snapshot.projectionVersion,
          resourceType,
          tenantId: snapshot.tenantId,
        },
        context,
      ),
    { concurrency: 1, discard: true },
  );
  return yield* Effect.void;
});

export const projectSearch = Effect.fn('PropertySearch.projectCommittedSnapshot')(function* projectCommittedSnapshot(
  context: OutboxWorkerHandlerContext,
  rebuild: boolean,
) {
  const snapshot = yield* loadSearchSnapshot(context);
  return yield* projectSearchSnapshot(snapshot, context, rebuild);
});
