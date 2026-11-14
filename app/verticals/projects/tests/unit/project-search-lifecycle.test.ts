import {
  CoreSearchIngestion,
  CoreSearchProjectionUnavailable,
  CoreSearchProjectionStore,
  CoreSearchQuerySchema,
  createCoreSearchQueryRuntime,
  CoreSearchWorkerSnapshot,
  ReadHandlerUnavailable,
  makeCoreSearchIngestion,
  makeInMemoryCoreSearchProjectionStore,
} from '@app/core-runtime';
import type {
  CoreSearchProjectionStoreService,
  CoreSearchWorkerSnapshotService,
  OutboxWorkerHandlerContext,
} from '@app/core-runtime';
import { attestOutboxWorkerHandlerContext } from '@app/core-runtime/testing/outbox';
import { scriptedPgClientLayer, testSqlConnection } from '@app/core-runtime/testing/scripted-pg-client';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Effect, Layer, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { expect, it } from 'effect-rstest';
import { projectsRelations } from '../../src/db/schema.ts';
import {
  buildProjectSearchDocuments,
  projectSearchIngestionRegistrations,
  refreshProjectSearchProjection,
} from '../../src/services/project-search-projection.ts';
import type { ProjectSearchMetadata } from '../../src/services/project-search-projection.ts';
import { creatorId, tenantId } from '../support/project.ts';

const scope = {
  authBindingId: '40000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-session:projects-projection-test',
  authMethod: 'session',
  correlationId: 'projects-projection-test',
  principalId: creatorId,
  tenantId,
} as const;
const foreignTenantId = '10000000-0000-4000-8000-000000000002';
const row = (index: number): ProjectSearchMetadata => ({
  lifecycleState: 'active',
  name: `Project ${index}`,
  prefix: 'ONTO',
  projectId: `30000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
  tenantId,
});
const claim = (rebuild = false) =>
  attestOutboxWorkerHandlerContext({
    attemptNumber: 1,
    claimId: 'claim-projects-projection',
    compositionRevision: 'a'.repeat(64),
    consumerModuleKey: 'projects.core',
    deliveryId: 'delivery-projects-projection',
    domainEventId: 'event-projects-projection',
    legalEntityScope: 'forbidden',
    messageId: 'message-projects-projection',
    producerModuleKey: 'projects.core',
    tenantId,
    tenantSequenceNo: 1n,
    topic: rebuild ? 'projects.core.search-rebuild-requested.v1' : 'projects.core.search-refresh-requested.v1',
    workerKey: rebuild ? 'projects.core.rebuild-search' : 'projects.core.refresh-search',
  });

/** Scripted owner SQL only; Core claim/snapshot admission is separately enforced by its public runtime. */
const sourceFixture = Effect.fn('ProjectsProjectionTest.source')(function* source(
  current: () => readonly ProjectSearchMetadata[],
) {
  const statements: string[] = [];
  let reading = false;
  let version = 0;
  const connection = testSqlConnection((sql, params) => {
    statements.push(sql);
    expect(reading).toBe(true);
    expect(sql).toContain('from "projects"."projects"');
    expect(sql).toContain('"projects"."projects"."tenant_id" =');
    expect(sql).toContain('order by "projects"."projects"."project_id" asc');
    expect(sql).not.toMatch(/limit|join|short_text|owner_principal|created_by|parent_project|for update/iu);
    expect(params).toEqual([tenantId]);
    return Effect.succeed(current());
  });
  const sqlLayer = scriptedPgClientLayer(Effect.succeed(connection)).pipe(Layer.provide(Reactivity.layer));
  const executor = yield* makeWithDefaults({ relations: projectsRelations }).pipe(Effect.provide(sqlLayer));
  const reader: CoreSearchWorkerSnapshotService = {
    read: (_context, use) =>
      Effect.suspend(() => {
        version += 1;
        reading = true;
        return use({
          eventWatermark: String(version),
          forLegalEntity: () => Effect.die('Tenant Projects must not fan out across companies'),
          legalEntityIds: [],
          projectionVersion: String(version),
          tenant: (read) => read({ select: executor.select.bind(executor) }),
          tenantId,
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              reading = false;
            }),
          ),
        );
      }),
  };
  return { isReading: () => reading, reader, statements };
});
const candidates = (store: CoreSearchProjectionStoreService, query: string, includeArchived = false) =>
  Schema.decodeUnknownEffect(CoreSearchQuerySchema)({
    includeArchived,
    moduleId: 'projects.core',
    query,
    resourceType: 'projects.project',
    tenantId,
  }).pipe(Effect.flatMap((input) => store.queryCandidates(input, scope)));

const search = (store: CoreSearchProjectionStoreService, query: string, includeArchived = false) =>
  createCoreSearchQueryRuntime.pipe(
    Effect.provideService(CoreSearchProjectionStore, store),
    Effect.flatMap((runtime) =>
      runtime.search(
        {
          includeArchived,
          moduleId: 'projects.core',
          query,
          resourceType: 'projects.project',
          tenantId,
        },
        scope,
      ),
    ),
  );

it.effect(
  'first delivery reads all tenant Projects and publishes only current name/Prefix evidence after SQL releases',
  () =>
    Effect.gen(function* completeFirstDelivery() {
      const rows = Array.from({ length: 257 }, (_, index) => row(index + 1));
      const source = yield* sourceFixture(() => rows);
      const store = makeInMemoryCoreSearchProjectionStore();
      let writes = 0;
      const ingestion = makeCoreSearchIngestion(
        {
          apply: (input, context) => {
            expect(source.isReading()).toBe(false);
            writes += 1;
            return store.apply(input, context);
          },
        },
        projectSearchIngestionRegistrations,
      );
      yield* refreshProjectSearchProjection(claim()).pipe(
        Effect.provideService(CoreSearchWorkerSnapshot, source.reader),
        Effect.provideService(CoreSearchIngestion, ingestion),
      );
      expect(source.statements).toHaveLength(1);
      expect(writes).toBe(257);
      const documents = yield* candidates(store, 'ONTO');
      expect(documents).toHaveLength(257);
      expect(new Set(documents.map(({ ref }) => ref.resourceId)).size).toBe(257);
      expect(documents[0]).toMatchObject({
        facets: [],
        metadata: [],
        ref: { moduleId: 'projects.core', resourceType: 'projects.project', tenantId },
        searchableText: ['Project 1', 'ONTO'],
        title: 'Project 1',
      });
      expect(JSON.stringify(documents)).not.toMatch(/selectedLegalEntity|ownerPrincipal|shortText|parentProject/u);
    }),
);

it.effect(
  'refresh and rebuild projector calls share the real source, including updates, moves and archive/restore',
  () =>
    Effect.gen(function* lifecycle() {
      let rows: readonly ProjectSearchMetadata[] = [row(1)];
      const source = yield* sourceFixture(() => rows);
      const store = makeInMemoryCoreSearchProjectionStore();
      const ingestion = makeCoreSearchIngestion(store, projectSearchIngestionRegistrations);
      const publish = (context: OutboxWorkerHandlerContext) =>
        refreshProjectSearchProjection(context).pipe(
          Effect.provideService(CoreSearchWorkerSnapshot, source.reader),
          Effect.provideService(CoreSearchIngestion, ingestion),
        );
      yield* publish(claim(true));
      expect(yield* search(store, 'Project')).toHaveLength(1);
      rows = [{ ...row(1), name: 'Renamed' }, row(2)];
      yield* publish(claim());
      expect((yield* search(store, 'Renamed'))[0]?.ref.resourceId).toBe(row(1).projectId);
      expect((yield* search(store, 'Project')).map(({ ref }) => ref.resourceId)).toEqual([row(2).projectId]);
      // A move changes hierarchy, not tenant ownership or the approved name/Prefix evidence.
      yield* publish(claim());
      expect(yield* search(store, 'ONTO')).toHaveLength(2);
      rows = [{ ...row(1), lifecycleState: 'archived', name: 'Renamed' }, row(2)];
      yield* publish(claim());
      expect(yield* search(store, 'Renamed')).toEqual([]);
      expect((yield* search(store, 'Renamed', true))[0]?.archived).toBe(true);
      rows = [{ ...row(1), name: 'Restored' }, row(2)];
      yield* publish(claim());
      expect((yield* search(store, 'Restored'))[0]?.archived).toBe(false);
      expect(source.statements).toHaveLength(5);
    }),
);

it.effect('does not split a 10,001-row first population into destructive replacement pages', () =>
  Effect.gen(function* noReplacementPageCap() {
    const rows = Array.from({ length: 10_001 }, (_, index) => row(index + 1));
    const source = yield* sourceFixture(() => rows);
    const store = makeInMemoryCoreSearchProjectionStore();
    yield* refreshProjectSearchProjection(claim(true)).pipe(
      Effect.provideService(CoreSearchWorkerSnapshot, source.reader),
      Effect.provideService(CoreSearchIngestion, makeCoreSearchIngestion(store, projectSearchIngestionRegistrations)),
    );
    const documents = yield* candidates(store, 'ONTO');
    expect(source.statements).toHaveLength(1);
    expect(documents).toHaveLength(10_001);
    expect(documents.at(-1)?.ref.resourceId).toBe(row(10_001).projectId);
  }),
);

it.effect(
  'rejects invalid generations before publication rather than substituting timestamps or event watermarks',
  () =>
    Effect.gen(function* invalidGeneration() {
      for (const projectionVersion of ['0', '-1', '2026-11-04T00:00:00.000Z']) {
        const failure = yield* buildProjectSearchDocuments({ projectionVersion, projects: [row(1)], tenantId }).pipe(
          Effect.flip,
        );
        expect(Schema.is(ReadHandlerUnavailable)(failure)).toBe(true);
      }
    }),
);

it.effect('invalid owner data fails before publication; failures never masquerade as an empty complete corpus', () =>
  Effect.gen(function* invalidSource() {
    for (const rows of [[{ ...row(1), tenantId: foreignTenantId }], [row(1), row(1)]]) {
      const source = yield* sourceFixture(() => rows);
      const failure = yield* refreshProjectSearchProjection(claim()).pipe(
        Effect.provideService(CoreSearchWorkerSnapshot, source.reader),
        Effect.provideService(CoreSearchIngestion, { ingest: () => Effect.die('Invalid source must not publish') }),
        Effect.flip,
      );
      expect(Schema.is(ReadHandlerUnavailable)(failure)).toBe(true);
    }
    const failure = yield* refreshProjectSearchProjection({ ...claim(), consumerModuleKey: 'other.owner' }).pipe(
      Effect.provideService(CoreSearchWorkerSnapshot, { read: () => Effect.die('Foreign owner must not read') }),
      Effect.provideService(CoreSearchIngestion, { ingest: () => Effect.die('Foreign owner must not publish') }),
      Effect.flip,
    );
    expect(Schema.is(ReadHandlerUnavailable)(failure)).toBe(true);
  }),
);

it.effect(
  'failed delivery remains failed and retry republishes the complete current snapshot with a fresh generation',
  () =>
    Effect.gen(function* retryCompleteSnapshot() {
      let rows: readonly ProjectSearchMetadata[] = [row(1), row(2), row(3)];
      const source = yield* sourceFixture(() => rows);
      const store = makeInMemoryCoreSearchProjectionStore();
      const real = makeCoreSearchIngestion(store, projectSearchIngestionRegistrations);
      let writes = 0;
      const failure = yield* refreshProjectSearchProjection(claim()).pipe(
        Effect.provideService(CoreSearchWorkerSnapshot, source.reader),
        Effect.provideService(CoreSearchIngestion, {
          ingest: (input, context) => {
            writes += 1;
            return writes === 2
              ? Effect.fail(
                  new CoreSearchProjectionUnavailable({
                    code: 'core_search_projection_unavailable',
                    reason: 'Test write failure',
                  }),
                )
              : real.ingest(input, context);
          },
        }),
        Effect.flip,
      );
      expect(Schema.is(ReadHandlerUnavailable)(failure)).toBe(true);
      expect(writes).toBe(2);
      rows = [{ ...row(1), name: 'Current retry name' }, row(2), row(3)];
      yield* refreshProjectSearchProjection(claim()).pipe(
        Effect.provideService(CoreSearchWorkerSnapshot, source.reader),
        Effect.provideService(CoreSearchIngestion, real),
      );
      expect(yield* candidates(store, 'ONTO')).toHaveLength(3);
      expect((yield* search(store, 'Current retry'))[0]?.title).toBe('Current retry name');
      expect((yield* candidates(store, 'ONTO')).every((document) => document.projectionVersion === '2')).toBe(true);
    }),
);

it.effect(
  'rejects copied claims, company-scoped claims and unregistered worker identities before snapshot access',
  () =>
    Effect.gen(function* invalidWorkerIdentity() {
      for (const context of [
        { ...claim() },
        attestOutboxWorkerHandlerContext({ ...claim(), legalEntityScope: 'required' }),
        attestOutboxWorkerHandlerContext({ ...claim(), workerKey: 'projects.core.unregistered-search' }),
        attestOutboxWorkerHandlerContext({ ...claim(), topic: 'projects.core.unregistered.v1' }),
      ]) {
        const failure = yield* refreshProjectSearchProjection(context).pipe(
          Effect.provideService(CoreSearchWorkerSnapshot, {
            read: () => Effect.die('Invalid claim must not read Projects'),
          }),
          Effect.provideService(CoreSearchIngestion, {
            ingest: () => Effect.die('Invalid claim must not publish Projects'),
          }),
          Effect.flip,
        );
        expect(Schema.is(ReadHandlerUnavailable)(failure)).toBe(true);
      }
    }),
);
