import {
  CoreSearchIngestion,
  CoreSearchProjectionStore,
  ResourceContainmentRelationshipMutation,
  ownerResourceModuleContainment,
} from '@app/core-runtime';
import type { OutboxWorkerHandlerContext } from '@app/core-runtime';
import { Array as Arr, Effect } from 'effect';

import { buildSearchDocuments, invalidSearchSource } from '../search/projection.ts';
import type { SearchSourceSnapshot } from '../search/projection.ts';
import { loadSearchSnapshot } from './search-source.ts';

export const projectSearchSnapshot = Effect.fn('OwnerSearch.projectSnapshot')(function* projectSnapshot(
  snapshot: SearchSourceSnapshot,
  context: OutboxWorkerHandlerContext,
  rebuild: boolean,
) {
  const ingestion = yield* CoreSearchIngestion;
  const store = yield* CoreSearchProjectionStore;
  const containment = yield* ResourceContainmentRelationshipMutation;
  if (snapshot.tenantId !== context.tenantId || !/^[1-9][0-9]*$/u.test(snapshot.projectionVersion)) {
    return yield* invalidSearchSource();
  }
  const documents = yield* buildSearchDocuments(snapshot);
  const relationships = documents.map((document) =>
    document.selectedLegalEntityId === undefined
      ? undefined
      : ownerResourceModuleContainment(snapshot.tenantId, document.selectedLegalEntityId, document.ref),
  );
  if (relationships.some((relationship) => relationship === undefined)) {
    return yield* invalidSearchSource();
  }
  const validRelationships = relationships.filter((relationship) => relationship !== undefined);
  // Snapshot SQL is closed before SpiceDB and projection writes. Publish only after containment succeeds.
  yield* Effect.forEach(Arr.chunksOf(validRelationships, 100), (batch) => containment.touch({ relationships: batch }), {
    concurrency: 1,
    discard: true,
  });
  if (!rebuild) {
    yield* Effect.forEach(
      documents,
      (document) =>
        ingestion.ingest(
          {
            consumerModuleKey: 'property.portfolio',
            mutation: { document, kind: 'upsert' },
            producerModuleKey: context.producerModuleKey,
            projectionVersion: snapshot.projectionVersion,
            tenantId: snapshot.tenantId,
            topic: context.topic,
            workerKey: context.workerKey,
          },
          context,
        ),
      { concurrency: 1, discard: true },
    );
  }
  // The complete tenant snapshot also removes disappeared, archived and retired rows on ordinary refreshes.
  yield* Effect.forEach(
    ['property.portfolio.property', 'property.portfolio.unit'],
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
