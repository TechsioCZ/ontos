import {
  CoreSearchProjectionDocumentSchema,
  CoreSearchProjectionReplacementSchema,
  CoreSearchProjectionStore,
  ReadHandlerUnavailable,
} from '@app/core-runtime';
import type { OutboxWorkerHandlerContext } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import { loadWorkforceSearchSnapshot } from './workforce-search-source.ts';
import type { WorkforceSearchSnapshot } from './workforce-search-source.ts';

const unavailable = (cause?: unknown) =>
  Object.defineProperty(
    new ReadHandlerUnavailable({
      code: 'read_handler_unavailable',
      reason: 'Workforce search projection is temporarily unavailable',
    }),
    'cause',
    { value: cause },
  );

export const buildWorkforceSearchDocuments = Effect.fn('WorkforceSearch.documents')(function* buildDocuments(
  snapshot: WorkforceSearchSnapshot,
) {
  const identities = new Set<string>();
  const documents = yield* Effect.forEach(
    snapshot.employees,
    (employee) => {
      // Core's replacement key is tenant/module/type/resourceId. Never silently overwrite a sibling company.
      if (employee.tenantId !== snapshot.tenantId || identities.has(employee.id)) {
        return Effect.fail(unavailable());
      }
      identities.add(employee.id);
      // Inactive employment is not an archive-search offering. Remove its personal evidence physically.
      if (!employee.active) {
        return Effect.succeed([]);
      }
      return Schema.decodeEffect(CoreSearchProjectionDocumentSchema)({
        aliases: [],
        archived: false,
        facets: [],
        metadata: [],
        projectionVersion: snapshot.projectionVersion,
        ref: {
          moduleId: 'demo.workforce',
          resourceId: employee.id,
          resourceType: 'demo.workforce.employee',
          tenantId: snapshot.tenantId,
        },
        searchableText: [employee.fullName, employee.role, employee.department],
        selectedLegalEntityId: employee.legalEntityId,
        title: employee.fullName,
      }).pipe(
        Effect.mapError(unavailable),
        Effect.map((document) => [document]),
      );
    },
    { concurrency: 1 },
  );
  return documents.flat();
});

/**
 * Called only after Core's source transaction closes. One tenant-wide replacement includes every
 * company, so omission withdraws stale evidence without erasing unrelated company documents.
 * Core atomically validates/publishes the unit and fences replay with its snapshot generation.
 */
export const publishWorkforceSearch = Effect.fn('WorkforceSearch.publish')(function* publish(
  context: OutboxWorkerHandlerContext,
  snapshot: WorkforceSearchSnapshot,
) {
  if (snapshot.tenantId !== context.tenantId) {
    return yield* unavailable();
  }
  const documents = yield* buildWorkforceSearchDocuments(snapshot);
  const replacement = yield* Schema.decodeEffect(CoreSearchProjectionReplacementSchema)({
    documents,
    moduleId: 'demo.workforce',
    rebuildVersion: snapshot.projectionVersion,
    resourceType: 'demo.workforce.employee',
    tenantId: snapshot.tenantId,
  }).pipe(Effect.mapError(unavailable));
  const store = yield* CoreSearchProjectionStore;
  return yield* store.replace(replacement, context);
});

/** Shared refresh/rebuild implementation; always rereads committed owner data, never an event's employee payload. */
export const projectWorkforceSearch = Effect.fn('WorkforceSearch.project')(function* project(
  context: OutboxWorkerHandlerContext,
) {
  const snapshot = yield* loadWorkforceSearchSnapshot(context);
  yield* publishWorkforceSearch(context, snapshot);
});
