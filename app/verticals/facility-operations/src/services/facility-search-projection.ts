import {
  CoreSearchProjectionDocumentSchema,
  CoreSearchProjectionStore,
  ResourceContainmentRelationshipMutation,
  ownerResourceModuleContainment,
  ReadHandlerUnavailable,
} from '@app/core-runtime';
import type { OutboxWorkerHandlerContext } from '@app/core-runtime';
import { Array as Arr, Effect, Schema } from 'effect';
import { loadFacilitySearchSnapshot } from './facility-search-source.ts';
import type { FacilitySearchSnapshot } from './facility-search-source.ts';
import type { ApplyCommandResult } from '../../shared/actions/apply-command.ts';

const unavailable = (cause?: unknown) =>
  Object.defineProperty(
    new ReadHandlerUnavailable({
      code: 'read_handler_unavailable',
      reason: 'Facility search projection is temporarily unavailable',
    }),
    'cause',
    { value: cause },
  );

export const buildFacilitySearchDocuments = Effect.fn('FacilitySearch.documents')(function* buildDocuments(
  snapshot: FacilitySearchSnapshot,
) {
  const identities = new Set<string>();
  return yield* Effect.forEach(
    snapshot.rows,
    (row) => {
      const identity = `${row.legalEntityId}:${row.type}:${row.id}`;
      if (row.tenantId !== snapshot.tenantId || identities.has(identity)) {
        return Effect.fail(unavailable());
      }
      identities.add(identity);
      return Schema.decodeEffect(CoreSearchProjectionDocumentSchema)({
        aliases: [],
        archived: row.archived,
        facets: [],
        metadata: [],
        projectionVersion: snapshot.projectionVersion,
        ref: {
          moduleId: 'facility.operations',
          resourceId: `${row.legalEntityId}.${row.id}`,
          resourceType: `facility.operations.${row.type}`,
          tenantId: row.tenantId,
        },
        searchableText: row.text,
        selectedLegalEntityId: row.legalEntityId,
        title: row.title.trim() || { asset: 'Majetek', device: 'Zařízení', document: 'Dokument' }[row.type],
      }).pipe(Effect.mapError(unavailable));
    },
    { concurrency: 1 },
  );
});

/** The snapshot transaction has closed. Containment changes precede index publication and grant no readers. */
export const publishFacilitySearch = Effect.fn('FacilitySearch.publish')(function* publish(
  context: OutboxWorkerHandlerContext,
  snapshot: FacilitySearchSnapshot,
) {
  if (snapshot.tenantId !== context.tenantId) {
    return yield* unavailable();
  }
  const documents = yield* buildFacilitySearchDocuments(snapshot);
  const store = yield* CoreSearchProjectionStore;
  const containment = yield* ResourceContainmentRelationshipMutation;
  const relationships = yield* Effect.forEach(
    documents,
    (document) => {
      const relationship = ownerResourceModuleContainment(
        snapshot.tenantId,
        document.selectedLegalEntityId ?? '',
        document.ref,
      );
      return relationship === undefined ? Effect.fail(unavailable()) : Effect.succeed(relationship);
    },
    { concurrency: 1 },
  );
  yield* Effect.forEach(Arr.chunksOf(relationships, 100), (batch) => containment.touch({ relationships: batch }), {
    concurrency: 1,
    discard: true,
  });
  yield* Effect.forEach(
    ['asset', 'device', 'document'],
    (type) =>
      store.replace(
        {
          documents: documents.filter((document) => document.ref.resourceType === `facility.operations.${type}`),
          moduleId: 'facility.operations',
          rebuildVersion: snapshot.projectionVersion,
          resourceType: `facility.operations.${type}`,
          tenantId: snapshot.tenantId,
        },
        context,
      ),
    { concurrency: 1, discard: true },
  );
  return yield* Effect.void;
});

export const projectFacilitySearch = Effect.fn('FacilitySearch.project')(function* project(
  context: OutboxWorkerHandlerContext,
) {
  const snapshot = yield* loadFacilitySearchSnapshot(context);
  yield* publishFacilitySearch(context, snapshot);
});

/** Every successful mutation of a searched agenda refreshes its authoritative owner snapshot, including removals. */
export const facilitySearchChanged = (result: ApplyCommandResult): boolean =>
  result.agenda === 'assets' || result.agenda === 'security' || result.agenda === 'documents';
