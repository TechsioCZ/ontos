import { CoreSearchProjectionStore } from '@app/core-runtime';
import type { OutboxWorkerHandlerContext } from '@app/core-runtime';
import { Effect } from 'effect';

import { buildSearchDocuments, invalidSearchSource } from './search-projection.ts';
import type { SearchSourceSnapshot } from './search-projection.ts';
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
  // Both workers hold a complete tenant snapshot. One atomic replacement publishes updates and
  // withdrawals together; per-document ingestion would duplicate work and expose a partial refresh.
  yield* store.replace(
    {
      documents,
      moduleId: 'property.leasing',
      rebuildVersion: snapshot.projectionVersion,
      resourceType: 'property.leasing.occupancy',
      tenantId: snapshot.tenantId,
    },
    context,
  );
  return yield* Effect.void;
});

export const projectSearch = Effect.fn('LeaseSearch.projectCommittedSnapshot')(function* projectCommittedSnapshot(
  context: OutboxWorkerHandlerContext,
  rebuild: boolean,
) {
  const snapshot = yield* loadSearchSnapshot(context);
  return yield* projectSearchSnapshot(snapshot, context, rebuild);
});
