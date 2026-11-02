import {
  CoreSearchIngestion,
  CoreSearchProjectionDocumentSchema,
  CoreSearchProjectionStore,
  ResourceContainmentRelationshipMutation,
  ownerResourceModuleContainment,
} from '@app/core-runtime';
import type { OutboxWorkerHandlerContext } from '@app/core-runtime';
import { Array as Arr, Effect, Schema } from 'effect';
import type { SearchSnapshot } from './search-source.ts';
import { loadSearchSnapshot } from './search-source.ts';
import { searchUnavailable } from './search-read.ts';

const moduleId = 'work.tasks';
const resourceType = 'work.tasks.task';

/** Preserve existing resource identities and reject cross-company collisions rather than overwriting another company's result. */
export const buildSearchDocuments = Effect.fn('WorkTasks.searchDocuments')(function* buildSearchDocuments(
  snapshot: SearchSnapshot,
) {
  const identities = new Set<string>();
  return yield* Effect.forEach(
    snapshot.records,
    (record) => {
      if (
        record.ref.tenantId !== snapshot.tenantId ||
        record.ref.moduleId !== moduleId ||
        record.ref.resourceType !== resourceType ||
        identities.has(record.ref.resourceId)
      ) {
        return Effect.fail(searchUnavailable());
      }
      identities.add(record.ref.resourceId);
      return Schema.decodeEffect(CoreSearchProjectionDocumentSchema)({
        aliases: [],
        archived: record.archived,
        facets: [],
        metadata: [],
        projectionVersion: snapshot.projectionVersion,
        ref: record.ref,
        searchableText: [record.title],
        selectedLegalEntityId: record.legalEntityId,
        title: record.title,
      }).pipe(Effect.mapError(searchUnavailable));
    },
    { concurrency: 1 },
  );
});

/** Both lifecycle delivery and operator rebuild replace the entire owner/type snapshot, including removed rows. */
export const publishSearchSnapshot = Effect.fn('WorkTasks.publishSearch')(function* publishSearchSnapshot(
  context: OutboxWorkerHandlerContext,
  snapshot: SearchSnapshot,
) {
  if (context.tenantId !== snapshot.tenantId) {
    return yield* searchUnavailable();
  }
  const documents = yield* buildSearchDocuments(snapshot);
  const containment = yield* ResourceContainmentRelationshipMutation;
  const relationships = yield* Effect.forEach(
    documents,
    (document) => {
      const relationship = ownerResourceModuleContainment(
        snapshot.tenantId,
        document.selectedLegalEntityId ?? '',
        document.ref,
      );
      return relationship === undefined ? Effect.fail(searchUnavailable()) : Effect.succeed(relationship);
    },
    { concurrency: 1 },
  );
  yield* Effect.forEach(Arr.chunksOf(relationships, 100), (batch) => containment.touch({ relationships: batch }), {
    concurrency: 1,
    discard: true,
  }).pipe(Effect.mapError(searchUnavailable));
  const ingestion = yield* CoreSearchIngestion;
  yield* Effect.forEach(
    documents,
    (document) =>
      ingestion.ingest(
        {
          consumerModuleKey: moduleId,
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
  ).pipe(Effect.mapError(searchUnavailable));
  const store = yield* CoreSearchProjectionStore;
  yield* store
    .replace(
      {
        documents,
        moduleId,
        rebuildVersion: snapshot.projectionVersion,
        resourceType,
        tenantId: snapshot.tenantId,
      },
      context,
    )
    .pipe(Effect.mapError(searchUnavailable));
  return yield* Effect.void;
});
export const projectSearch = Effect.fn('WorkTasks.projectSearch')(function* projectSearch(
  context: OutboxWorkerHandlerContext,
) {
  const snapshot = yield* loadSearchSnapshot(context);
  yield* publishSearchSnapshot(context, snapshot);
});
