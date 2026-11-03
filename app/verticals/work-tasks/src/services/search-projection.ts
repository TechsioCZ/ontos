import {
  CoreSearchProjectionDocumentSchema,
  CoreSearchProjectionReplacementSchema,
  CoreSearchProjectionStore,
  ResourceContainmentRelationshipMutation,
  isVerifiedOutboxWorkerHandlerContext,
  ownerResourceModuleContainment,
} from '@app/core-runtime';
import type { OutboxWorkerHandlerContext } from '@app/core-runtime';
import { Array as Arr, Effect, Schema } from 'effect';
import type { SearchSnapshot } from './search-source.ts';
import { loadSearchSnapshot } from './search-source.ts';
import { searchUnavailable } from './search-read.ts';
import { searchIngestionRegistrations } from '../worker-host/search-ingestion-registrations.ts';

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
        (record.ownerPrincipalRef !== undefined && record.ownerPrincipalRef.tenantId !== snapshot.tenantId) ||
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
        // Technical IDs are evidence, not fabricated customer/assignee labels. No private free text.
        searchableText: [
          ...new Set(
            [
              record.title,
              record.ref.resourceId,
              record.dueDate,
              record.ownerPrincipalRef?.principalId,
              record.projectId,
              record.state,
              record.priority,
            ].filter((value) => value !== undefined),
          ),
        ],
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
  if (
    !isVerifiedOutboxWorkerHandlerContext(context) ||
    !/^[a-f0-9]{64}$/u.test(context.compositionRevision) ||
    context.tenantId !== snapshot.tenantId ||
    !searchIngestionRegistrations.some(
      (registration) =>
        registration.consumerModuleKey === context.consumerModuleKey &&
        registration.producerModuleKey === context.producerModuleKey &&
        registration.topic === context.topic &&
        registration.workerKey === context.workerKey,
    )
  ) {
    return yield* searchUnavailable();
  }
  const documents = yield* buildSearchDocuments(snapshot);
  const replacement = yield* Schema.decodeEffect(CoreSearchProjectionReplacementSchema)({
    documents,
    moduleId,
    rebuildVersion: snapshot.projectionVersion,
    resourceType,
    tenantId: snapshot.tenantId,
  }).pipe(Effect.mapError(searchUnavailable));
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
  // Publish exactly once. Per-document ingests would expose a partial generation if replace fails.
  // Core replacement owns idempotence, tombstones, rebuild floors and the atomic failure boundary.
  const store = yield* CoreSearchProjectionStore;
  yield* store.replace(replacement, context).pipe(Effect.mapError(searchUnavailable));
  return yield* Effect.void;
});
export const projectSearch = Effect.fn('WorkTasks.projectSearch')(function* projectSearch(
  context: OutboxWorkerHandlerContext,
) {
  const snapshot = yield* loadSearchSnapshot(context);
  yield* publishSearchSnapshot(context, snapshot);
});
