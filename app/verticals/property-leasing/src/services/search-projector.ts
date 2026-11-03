import {
  CoreSearchProjectionStore,
  ResourceContainmentRelationshipMutation,
  ownerResourceModuleContainment,
} from '@app/core-runtime';
import type { OutboxWorkerHandlerContext, ResourceContainmentRelationship } from '@app/core-runtime';
import { Array as Arr, Effect } from 'effect';

import { buildSearchDocuments, invalidSearchSource } from '../search/projection.ts';
import type { SearchSourceSnapshot } from '../search/projection.ts';
import { loadSearchSnapshot } from './search-source.ts';

const definedRelationships = (
  relationships: readonly (ResourceContainmentRelationship | undefined)[],
): readonly ResourceContainmentRelationship[] | undefined => {
  const defined = relationships.filter(
    (relationship): relationship is ResourceContainmentRelationship => relationship !== undefined,
  );
  return defined.length === relationships.length ? defined : undefined;
};

export const projectSearchSnapshot = Effect.fn('OwnerSearch.projectSnapshot')(function* projectSnapshot(
  snapshot: SearchSourceSnapshot,
  context: OutboxWorkerHandlerContext,
  _rebuild: boolean,
) {
  const store = yield* CoreSearchProjectionStore;
  const containment = yield* ResourceContainmentRelationshipMutation;
  if (snapshot.tenantId !== context.tenantId || !/^[1-9][0-9]*$/u.test(snapshot.projectionVersion)) {
    return yield* invalidSearchSource();
  }
  const documents = yield* buildSearchDocuments(snapshot);
  const relationships = definedRelationships(
    documents.map((document) =>
      document.selectedLegalEntityId === undefined
        ? undefined
        : ownerResourceModuleContainment(snapshot.tenantId, document.selectedLegalEntityId, document.ref),
    ),
  );
  if (relationships === undefined) {
    return yield* invalidSearchSource();
  }
  // Snapshot SQL is closed before SpiceDB and projection writes. Publish only after containment succeeds.
  yield* Effect.forEach(Arr.chunksOf(relationships, 100), (batch) => containment.touch({ relationships: batch }), {
    concurrency: 1,
    discard: true,
  });
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
