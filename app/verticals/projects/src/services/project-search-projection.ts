// Worker-safe Project search projection: the generated refresh/rebuild workers and the Outbox Worker host bundle this
// module. Worker services and verified claim identity come from Core's worker entry; the public Core registry
// helpers register the exact self-consumer identities without importing another owner's implementation.
import {
  CoreSearchIngestion,
  CoreSearchProjectionDocumentSchema,
  CoreSearchWorkerSnapshot,
  ReadHandlerUnavailable,
  isVerifiedOutboxWorkerHandlerContext,
} from '@app/core-runtime/outbox/worker';
import { coreSearchIngestionRegistryLayer, defineCoreSearchIngestionRegistrations } from '@app/core-runtime';
import type { CoreSearchWorkerSnapshotView, OutboxWorkerHandlerContext } from '@app/core-runtime/outbox/worker';
import { asc, eq } from 'drizzle-orm';
import { Effect, Schema } from 'effect';
import {
  ProjectLifecycleStateSchema,
  ProjectNameSchema,
  ProjectPersistenceUnavailable,
  ProjectPrefixSchema,
  ProjectUuidSchema,
} from '../../shared/domain/project.ts';
import { projects } from '../db/schema.ts';

const moduleId = 'projects.core';
const resourceType = 'projects.project';

const unavailable = <Failure>(cause?: Failure) =>
  new ProjectPersistenceUnavailable({
    cause,
    code: 'project_persistence_unavailable',
    reason: 'Project persistence is temporarily unavailable',
  });
const attempt = <Value, Failure>(operation: () => Effect.Effect<Value, Failure>) =>
  operation().pipe(Effect.mapError(unavailable));
const searchUnavailable = (cause?: unknown) =>
  Object.defineProperty(
    new ReadHandlerUnavailable({
      code: 'read_handler_unavailable',
      reason: 'Project search is temporarily unavailable',
    }),
    'cause',
    { value: cause },
  );

/** Current tenant-owned search evidence only; never a full Project DTO or a business mutation. */
export const ProjectSearchMetadataSchema = Schema.Struct({
  lifecycleState: ProjectLifecycleStateSchema,
  name: ProjectNameSchema,
  prefix: ProjectPrefixSchema,
  projectId: ProjectUuidSchema,
  tenantId: ProjectUuidSchema,
});
export type ProjectSearchMetadata = typeof ProjectSearchMetadataSchema.Type;

export interface ProjectSearchSnapshot {
  readonly projectionVersion: string;
  readonly projects: readonly ProjectSearchMetadata[];
  readonly tenantId: string;
}

/**
 * Read the complete tenant-owned corpus under Core's coherent post-commit snapshot. Projects are
 * tenant-owned, not company-owned: no Legal Entity fan-out, Owner assignment filter or index join.
 * Do not limit/page this read: a first lifecycle delivery must also populate untouched Projects.
 * Only the same name/Prefix evidence used by the current authorized provider is projected.
 */
export const loadProjectSearchSnapshot = Effect.fn('Projects.loadSearchSnapshot')(function* loadSearchSnapshot(
  snapshot: CoreSearchWorkerSnapshotView,
  tenantId: string,
) {
  if (snapshot.tenantId !== tenantId) {
    return yield* unavailable();
  }
  const rows = yield* snapshot.tenant((executor) =>
    attempt(() =>
      executor
        .select({
          lifecycleState: projects.lifecycleState,
          name: projects.name,
          prefix: projects.prefix,
          projectId: projects.projectId,
          tenantId: projects.tenantId,
        })
        .from(projects)
        .where(eq(projects.tenantId, tenantId))
        .orderBy(asc(projects.projectId)),
    ),
  );
  const current = yield* Schema.decodeUnknownEffect(Schema.Array(ProjectSearchMetadataSchema))(rows).pipe(
    Effect.mapError(unavailable),
  );
  if (
    current.some((project) => project.tenantId !== tenantId) ||
    new Set(current.map((project) => project.projectId)).size !== current.length
  ) {
    return yield* unavailable();
  }
  return { projectionVersion: snapshot.projectionVersion, projects: current, tenantId } satisfies ProjectSearchSnapshot;
}, Effect.mapError(unavailable));

/** Exact self-consumer identities for the generated lifecycle and explicit rebuild workers. */
export const projectSearchIngestionRegistrations = defineCoreSearchIngestionRegistrations([
  {
    consumerModuleKey: moduleId,
    producerModuleKey: moduleId,
    topic: 'projects.core.search-refresh-requested.v1',
    workerKey: 'projects.core.refresh-search',
  },
  {
    consumerModuleKey: moduleId,
    producerModuleKey: moduleId,
    topic: 'projects.core.search-rebuild-requested.v1',
    workerKey: 'projects.core.rebuild-search',
  },
]);
export const projectSearchIngestionRegistryLive = coreSearchIngestionRegistryLayer(projectSearchIngestionRegistrations);

export const buildProjectSearchDocuments = Effect.fn('Projects.buildSearchDocuments')(function* buildSearchDocuments(
  snapshot: ProjectSearchSnapshot,
) {
  if (
    !/^[1-9][0-9]*$/u.test(snapshot.projectionVersion) ||
    snapshot.projects.some((project) => project.tenantId !== snapshot.tenantId) ||
    new Set(snapshot.projects.map((project) => project.projectId)).size !== snapshot.projects.length
  ) {
    return yield* searchUnavailable();
  }
  return yield* Effect.forEach(
    snapshot.projects,
    (project) =>
      Schema.decodeUnknownEffect(CoreSearchProjectionDocumentSchema)({
        archived: project.lifecycleState === 'archived',
        facets: [],
        metadata: [],
        projectionVersion: snapshot.projectionVersion,
        ref: { moduleId, resourceId: project.projectId, resourceType, tenantId: snapshot.tenantId },
        searchableText: [project.name, project.prefix],
        title: project.name,
      }).pipe(Effect.mapError(searchUnavailable)),
    { concurrency: 1 },
  );
});

/**
 * Generated self-consuming workers call this only after a committed Action. Core validates the
 * claim/registration and reserves a fresh generation; owner reads finish before any index write.
 * Every delivery publishes every Project, including archived and previously untouched rows. This
 * deliberately uses ingestion rather than paged replacements: a page is not a complete rebuild,
 * and the public replacement contract is bounded at 10,000 documents. No row cap, fake timestamp
 * version, empty rebuild floor or fabricated tombstone is used. A failed publication fails the
 * delivery; retry re-reads current persistence and cannot overwrite a newer generation.
 */
export const refreshProjectSearchProjection = Effect.fn('Projects.refreshSearchProjection')(function* refreshSearch(
  context: OutboxWorkerHandlerContext,
) {
  if (
    !isVerifiedOutboxWorkerHandlerContext(context) ||
    context.legalEntityScope !== 'forbidden' ||
    context.producerModuleKey !== moduleId ||
    context.consumerModuleKey !== moduleId ||
    !projectSearchIngestionRegistrations.some(
      (registration) => registration.topic === context.topic && registration.workerKey === context.workerKey,
    )
  ) {
    return yield* searchUnavailable();
  }
  const reader = yield* CoreSearchWorkerSnapshot;
  const snapshot = yield* reader
    .read(context, (view) => loadProjectSearchSnapshot(view, context.tenantId))
    .pipe(Effect.mapError(searchUnavailable));
  const documents = yield* buildProjectSearchDocuments(snapshot);
  const ingestion = yield* CoreSearchIngestion;
  return yield* Effect.forEach(
    documents,
    (document) =>
      ingestion
        .ingest(
          {
            consumerModuleKey: moduleId,
            mutation: { document, kind: 'upsert' },
            producerModuleKey: moduleId,
            projectionVersion: snapshot.projectionVersion,
            tenantId: snapshot.tenantId,
            topic: context.topic,
            workerKey: context.workerKey,
          },
          context,
        )
        .pipe(Effect.mapError(searchUnavailable)),
    { concurrency: 1, discard: true },
  );
});
