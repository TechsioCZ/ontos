import {
  CoreSearchProjectionStore,
  CoreSearchQueryRuntime,
  CoreSearchIngestion,
  CoreSearchWorkerSnapshot,
  ResourceContainmentRelationshipMutation,
  OperationContextUnavailable,
  OperationContextDenied,
  ReadHandlerUnavailable,
  ActionPermissionDenied,
  CoreSearchProjectionHitSchema,
  createCoreSearchQueryRuntime,
  makeCoreSearchIngestion,
  makeInMemoryCoreSearchProjectionStore,
  ResourceContainmentMutationUnavailable,
  toModuleAccessObjectId,
  toResourceAccessObjectId,
} from '@app/core-runtime';
import type {
  CoreSearchWorkerSnapshotService,
  CoreSearchQueryRuntimeService,
  CoreSearchIngestionService,
  CoreSearchProjectionStoreService,
  ResourceContainmentRelationshipMutationService,
  OperationalScope,
  ResourceContainmentRelationshipMutationInput,
} from '@app/core-runtime';
import { makeActionTestHarness } from '@app/core-runtime/testing/actions';
import { attestOutboxWorkerHandlerContext } from '@app/core-runtime/testing/outbox';
import { makeReadTestHarness } from '@app/core-runtime/testing/reads';
import { scriptedPgClientLayer, testSqlConnection } from '@app/core-runtime/testing/scripted-pg-client';
import { NodeCrypto } from '@effect/platform-node';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { DateTime, Effect, Layer, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { TestClock } from 'effect/testing';
import { describe, expect, it } from 'effect-rstest';

import { MarketsProviderResponseSchema } from '../../shared/apis/markets-search.ts';
import { requestSearchRebuildAction } from '../../src/actions/request-search-rebuild.action.ts';
import { loadMarkets as loadMarketsWithContext, marketsRead } from '../../src/search/markets.provider.ts';
import {
  buildMarketSearchDocuments,
  makeMarketSearchProjector as makeMarketSearchProjectorWithContext,
} from '../../src/services/market-search-projection.ts';
import {
  makeMarketSearchSource as makeMarketSearchSourceWithContext,
  MarketSearchUnavailable,
  MarketSearchSource,
} from '../../src/services/market-search-source.ts';
import type { MarketSearchSnapshot, MarketSearchSourceService } from '../../src/services/market-search-source.ts';
import { marketSearchIngestionRegistrations } from '../../src/worker-host/search-ingestion-registrations.ts';
import { outboxWorkers } from '../../src/workers/index.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const companyId = '22222222-2222-4222-8222-222222222222';
const otherCompany = '33333333-3333-4333-8333-333333333333';
const marketId = '44444444-4444-4444-8444-444444444444';
const principalId = '55555555-5555-4555-8555-555555555555';
const otherTenant = '66666666-6666-4666-8666-666666666666';
const moduleId = 'commerce.market-catalog';
const resourceType = 'commerce.market-catalog.market';
const january = '2026-01-01T00:00:00.000Z';
const june = '2026-06-01T00:00:00.000Z';
const july = '2026-07-01T00:00:00.000Z';
const ref = { moduleId, resourceId: marketId, resourceType, tenantId };
const scope: OperationalScope = {
  authContextRef: 'better-auth-session:market-search-test',
  authMethod: 'session',
  correlationId: 'market-search-test',
  legalEntityId: companyId,
  principalId,
  tenantId,
};
const context = attestOutboxWorkerHandlerContext({
  attemptNumber: 1,
  claimId: 'claim',
  compositionRevision: 'a'.repeat(64),
  consumerModuleKey: moduleId,
  deliveryId: 'delivery',
  domainEventId: 'event',
  messageId: 'message',
  producerModuleKey: moduleId,
  tenantId,
  tenantSequenceNo: 3n,
  topic: 'commerce.market-catalog.market-created.v1',
  workerKey: 'commerce.market-catalog.project-market-created-to-search',
});
const rebuildContext = attestOutboxWorkerHandlerContext({
  ...context,
  topic: 'commerce.market-catalog.search-rebuild-requested.v1',
  workerKey: 'commerce.market-catalog.rebuild-search',
});
const initial: MarketSearchSnapshot = {
  projectionVersion: '1',
  records: [
    {
      businessCode: 'AKROS-CZ',
      definitions: [{ effectiveFrom: new Date(january), effectiveTo: null, purpose: 'Český maloobchod' }],
      lifecycles: [{ effectiveFrom: new Date(january), effectiveTo: null, lifecycle: 'ACTIVE' }],
      marketId,
      sellingLegalEntityId: companyId,
      tenantId,
    },
  ],
  tenantId,
};

const loadMarkets = (
  search: CoreSearchQueryRuntimeService,
  selectedScope: OperationalScope,
  input: { readonly query: string },
) => loadMarketsWithContext(selectedScope, input).pipe(Effect.provideService(CoreSearchQueryRuntime, search));
const makeMarketSearchProjector = (
  source: MarketSearchSourceService,
  ingestion: CoreSearchIngestionService,
  store: CoreSearchProjectionStoreService,
  containment: ResourceContainmentRelationshipMutationService,
) =>
  makeMarketSearchProjectorWithContext.pipe(
    Effect.provideService(MarketSearchSource, source),
    Effect.provideService(CoreSearchIngestion, ingestion),
    Effect.provideService(CoreSearchProjectionStore, store),
    Effect.provideService(ResourceContainmentRelationshipMutation, containment),
  );
const makeMarketSearchSource = (reader: CoreSearchWorkerSnapshotService) =>
  makeMarketSearchSourceWithContext.pipe(Effect.provideService(CoreSearchWorkerSnapshot, reader));

const searchHarness = Effect.gen(function* marketSearchHarness() {
  const store = makeInMemoryCoreSearchProjectionStore();
  const search = yield* createCoreSearchQueryRuntime.pipe(Effect.provideService(CoreSearchProjectionStore, store));
  let snapshot = initial;
  const relationships: ResourceContainmentRelationshipMutationInput[] = [];
  const projector = yield* makeMarketSearchProjector(
    { load: () => Effect.succeed(snapshot) },
    makeCoreSearchIngestion(store, marketSearchIngestionRegistrations),
    store,
    { touch: (input) => Effect.sync(() => relationships.push(input)).pipe(Effect.asVoid) },
  );
  yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe(june)));
  return {
    projector,
    relationships,
    search,
    setSnapshot: (next: MarketSearchSnapshot) => {
      snapshot = next;
    },
  };
});

describe('Market search projection', () => {
  it.effect('indexes public business labels, purpose periods and the trusted seller only', () =>
    Effect.gen(function* documentContent() {
      const [document] = yield* buildMarketSearchDocuments(initial);
      expect(document).toEqual({
        archived: false,
        facets: [],
        metadata: [],
        projectionVersion: '1',
        ref,
        searchableText: [],
        selectedLegalEntityId: companyId,
        temporalFacets: [{ key: 'visible-market', validFrom: january, value: 'yes' }],
        temporalSearchableText: [{ validFrom: january, value: 'Český maloobchod' }],
        title: 'AKROS-CZ',
      });
      const harness = yield* searchHarness;
      yield* harness.projector.project(context, { marketId });
      const hits = yield* loadMarkets(harness.search, scope, { query: 'cesky' });
      expect(hits).toEqual([{ ref, selectedLegalEntityId: companyId, title: 'AKROS-CZ' }]);
      expect(harness.relationships).toHaveLength(1);
      expect(harness.relationships).toEqual([
        {
          relationships: [
            {
              container: {
                objectId: toModuleAccessObjectId(tenantId, companyId, moduleId),
                objectType: 'module_access',
              },
              relation: 'module',
              resource: { objectId: toResourceAccessObjectId(tenantId, companyId, ref), objectType: 'resource' },
            },
          ],
        },
      ]);
    }),
  );

  it.effect('uses selected company scope and rejects another tenant even if the person has multiple companies', () =>
    Effect.gen(function* queryScope() {
      const harness = yield* searchHarness;
      yield* harness.projector.project(context, { marketId });
      expect(yield* loadMarkets(harness.search, { ...scope, legalEntityId: otherCompany }, { query: 'AKROS' })).toEqual(
        [],
      );
      expect(yield* loadMarkets(harness.search, { ...scope, tenantId: otherTenant }, { query: 'AKROS' })).toEqual([]);
      const { legalEntityId: _company, ...withoutCompany } = scope;
      expect(yield* loadMarkets(harness.search, withoutCompany, { query: 'AKROS' }).pipe(Effect.flip)).toBeInstanceOf(
        OperationContextUnavailable,
      );
    }),
  );

  it.effect('fails closed on stale or forged Core hits and requires both company and tenant on the wire', () =>
    Effect.gen(function* responseScope() {
      for (const patch of [
        { ref: { ...ref, tenantId: otherTenant } },
        { selectedLegalEntityId: otherCompany },
        { archived: true },
        { ref: { ...ref, moduleId: 'foreign.module' } },
        { ref: { ...ref, resourceType: 'foreign.resource' } },
      ]) {
        const hit = yield* Schema.decodeUnknownEffect(CoreSearchProjectionHitSchema)({
          archived: false,
          facets: [],
          metadata: [],
          ref,
          selectedLegalEntityId: companyId,
          title: 'AKROS-CZ',
          ...patch,
        });
        expect(
          yield* loadMarkets({ search: () => Effect.succeed([hit]) }, scope, { query: 'AKROS' }).pipe(Effect.flip),
        ).toBeInstanceOf(ReadHandlerUnavailable);
      }
      expect(Schema.is(MarketsProviderResponseSchema)([{ ref, title: 'AKROS' }])).toBe(false);
      expect(
        Schema.is(MarketsProviderResponseSchema)([
          { ref: { moduleId, resourceId: marketId, resourceType }, selectedLegalEntityId: companyId, title: 'AKROS' },
        ]),
      ).toBe(false);
    }),
  );

  it.effect('updates purpose text, hides retirement at its effective boundary and tombstones a deleted market', () =>
    Effect.gen(function* lifecycleProjection() {
      const harness = yield* searchHarness;
      yield* harness.projector.project(context, { marketId });
      const [row] = initial.records;
      expect(row).toBeDefined();
      if (row === undefined) {
        return;
      }
      harness.setSnapshot({
        ...initial,
        projectionVersion: '2',
        records: [
          {
            ...row,
            definitions: [{ effectiveFrom: new Date(january), effectiveTo: null, purpose: 'Slovenský predaj' }],
          },
        ],
      });
      yield* harness.projector.project(context, { marketId });
      expect(yield* loadMarkets(harness.search, scope, { query: 'cesky' })).toEqual([]);
      expect(yield* loadMarkets(harness.search, scope, { query: 'slovensky' })).toHaveLength(1);
      harness.setSnapshot({
        ...initial,
        projectionVersion: '3',
        records: [
          {
            ...row,
            lifecycles: [
              { effectiveFrom: new Date(january), effectiveTo: new Date(july), lifecycle: 'SUSPENDED' },
              { effectiveFrom: new Date(july), effectiveTo: null, lifecycle: 'RETIRED' },
            ],
          },
        ],
      });
      yield* harness.projector.project(context, { marketId });
      expect(yield* loadMarkets(harness.search, scope, { query: 'AKROS' })).toHaveLength(1);
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe(july)));
      expect(yield* loadMarkets(harness.search, scope, { query: 'AKROS' })).toEqual([]);
      harness.setSnapshot({ ...initial, projectionVersion: '4', records: [] });
      yield* harness.projector.project(context, { marketId });
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe(june)));
      expect(yield* loadMarkets(harness.search, scope, { query: 'AKROS' })).toEqual([]);
      // A delayed delivery carrying an older owner generation cannot resurrect the deleted record.
      harness.setSnapshot(initial);
      yield* harness.projector.project(context, { marketId });
      expect(yield* loadMarkets(harness.search, scope, { query: 'AKROS' })).toEqual([]);
    }),
  );

  it.effect('replaces only this tenant resource set, repairs containment and removes stale rows idempotently', () =>
    Effect.gen(function* rebuildProjection() {
      const harness = yield* searchHarness;
      yield* harness.projector.project(context, { marketId });
      harness.setSnapshot({ ...initial, projectionVersion: '2' });
      yield* harness.projector.project(rebuildContext, { rebuild: true });
      yield* harness.projector.project(rebuildContext, { rebuild: true });
      expect(yield* loadMarkets(harness.search, scope, { query: 'AKROS' })).toHaveLength(1);
      expect(harness.relationships).toHaveLength(3);
      harness.setSnapshot({ ...initial, projectionVersion: '3', records: [] });
      yield* harness.projector.project(rebuildContext, { rebuild: true });
      expect(yield* loadMarkets(harness.search, scope, { query: 'AKROS' })).toEqual([]);
    }),
  );

  it.effect('refuses cross-tenant snapshots and never publishes documents when containment fails', () =>
    Effect.gen(function* invalidSnapshotAndContainment() {
      const harness = yield* searchHarness;
      harness.setSnapshot({ ...initial, tenantId: otherTenant });
      expect(yield* harness.projector.project(context, { marketId }).pipe(Effect.flip)).toBeInstanceOf(
        MarketSearchUnavailable,
      );
      expect(harness.relationships).toEqual([]);
      const store = makeInMemoryCoreSearchProjectionStore();
      const projector = yield* makeMarketSearchProjector(
        { load: () => Effect.succeed(initial) },
        makeCoreSearchIngestion(store, marketSearchIngestionRegistrations),
        store,
        {
          touch: () =>
            Effect.fail(
              new ResourceContainmentMutationUnavailable({
                reason: 'Unavailable',
              }),
            ),
        },
      );
      expect(yield* projector.project(context, { marketId }).pipe(Effect.flip)).toBeInstanceOf(MarketSearchUnavailable);
      const search = yield* createCoreSearchQueryRuntime.pipe(Effect.provideService(CoreSearchProjectionStore, store));
      expect(yield* loadMarkets(search, scope, { query: 'AKROS' })).toEqual([]);
    }),
  );
});

it.effect('owner snapshot binds every query to trusted tenant and seller and closes before containment', () =>
  Effect.gen(function* ownerSnapshot() {
    const queries: { params: readonly unknown[]; sql: string }[] = [];
    let snapshotOpen = false;
    const connection = testSqlConnection((sql, params) => {
      queries.push({ params, sql });
      if (sql.includes('"market_definition_revisions"')) {
        return Effect.succeed([{ effectiveFrom: new Date(january), effectiveTo: null, purpose: 'Český maloobchod' }]);
      }
      if (sql.includes('"market_lifecycle_periods"')) {
        return Effect.succeed([{ effectiveFrom: new Date(january), effectiveTo: null, lifecycle: 'ACTIVE' }]);
      }
      return Effect.succeed([{ businessCode: 'AKROS-CZ', marketId, sellingLegalEntityId: companyId, tenantId }]);
    });
    const database = yield* makeWithDefaults().pipe(
      Effect.provide(scriptedPgClientLayer(Effect.succeed(connection)).pipe(Layer.provide(Reactivity.layer))),
    );
    const reader: CoreSearchWorkerSnapshotService = {
      read: (_context, read) => {
        snapshotOpen = true;
        return read({
          eventWatermark: '99',
          forLegalEntity: (id, readCompany) => {
            expect(id).toBe(companyId);
            return readCompany(database);
          },
          legalEntityIds: [companyId],
          projectionVersion: '1',
          tenant: () => Effect.die('Market source must not use an unselected tenant scope'),
          tenantId,
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              snapshotOpen = false;
            }),
          ),
        );
      },
    };
    const source = yield* makeMarketSearchSource(reader);
    const store = makeInMemoryCoreSearchProjectionStore();
    const projector = yield* makeMarketSearchProjector(
      source,
      makeCoreSearchIngestion(store, marketSearchIngestionRegistrations),
      store,
      {
        touch: () =>
          Effect.sync(() => {
            expect(snapshotOpen).toBe(false);
          }),
      },
    );
    yield* projector.project(context, { marketId });
    expect(queries).toHaveLength(3);
    for (const query of queries) {
      expect(query.params).toEqual([tenantId, companyId, marketId]);
      expect(query.sql).not.toContain('change_reason');
      expect(query.sql).not.toContain('retirement_impact_assessment');
      expect(query.sql).not.toContain('acting_principal_id');
    }
    const foreignReader: CoreSearchWorkerSnapshotService = {
      read: (_context, read) =>
        read({
          eventWatermark: '99',
          forLegalEntity: (_id, readCompany) => readCompany(database),
          legalEntityIds: [otherCompany],
          projectionVersion: '2',
          tenant: (readTenant) => readTenant(database),
          tenantId,
        }),
    };
    expect(
      yield* (yield* makeMarketSearchSource(foreignReader)).load(context, { marketId }).pipe(Effect.flip),
    ).toBeInstanceOf(MarketSearchUnavailable);
  }).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)),
);

it.effect('governed rebuild requires explicit operator execution and queues committed intent only', () =>
  Effect.gen(function* governedRebuild() {
    const { descriptor } = requestSearchRebuildAction;
    expect(descriptor.tenantPermission?.({})).toBe('manage_identity');
    expect(descriptor.entrypoint.authorization).toEqual({ kind: 'action_execution', provisioning: 'explicit' });
    expect(descriptor.idempotency).toBe('required');
    const principal = {
      authBindingId: '77777777-7777-4777-8777-777777777777',
      authContextRef: scope.authContextRef,
      authMethod: 'session' as const,
      principalId,
      tenantId,
    };
    const request = {
      payload: {},
      principal,
      registration: requestSearchRebuildAction,
      transport: { correlationId: 'rebuild-search-test', idempotencyKey: 'market-search-rebuild-1' },
    };
    const allowed = yield* makeActionTestHarness({ actionPermission: 'allowed', tenantPermission: 'allowed' });
    const result = yield* allowed.runtime.runAction(request);
    expect(result.status).toBe('QUEUED');
    const { committed } = allowed.snapshot();
    expect(committed).toHaveLength(1);
    expect(committed[0]?.evidence.dataAccessEvents).toEqual([]);
    expect(committed[0]?.evidence.outboxMessages).toMatchObject([
      {
        domainEventIndex: 0,
        message: {
          payloadJson: { requestId: result.requestId },
          producerModuleKey: moduleId,
          topic: 'commerce.market-catalog.search-rebuild-requested.v1',
        },
      },
    ]);
    const denied = yield* makeActionTestHarness({ actionPermission: 'denied', tenantPermission: 'allowed' });
    expect(yield* denied.runtime.runAction(request).pipe(Effect.flip)).toBeInstanceOf(ActionPermissionDenied);
    expect(denied.snapshot().committed).toEqual([]);
    const notOperator = yield* makeActionTestHarness({ actionPermission: 'allowed', tenantPermission: 'denied' });
    expect(yield* notOperator.runtime.runAction(request).pipe(Effect.flip)).toBeInstanceOf(ActionPermissionDenied);
    expect(notOperator.snapshot().committed).toEqual([]);
  }),
);

it.effect('registers every lifecycle consumer and rejects denied company context before loading search rows', () =>
  Effect.gen(function* registrationsAndAuthorization() {
    for (const registration of marketSearchIngestionRegistrations) {
      const worker = outboxWorkers.find(({ descriptor }) => descriptor.workerKey === registration.workerKey);
      expect(worker?.descriptor.topic).toBe(registration.topic);
      expect(worker?.descriptor.entrypoint.authorization.kind).toBe('owner_local_background');
    }
    expect(marketSearchIngestionRegistrations).toHaveLength(6);
    const harness = yield* makeReadTestHarness({
      executeOwnerQuery: () => Effect.die('Denied search must never query owner state'),
      operationTime: new Date(june),
      permissionDecision: 'denied',
      scope,
    });
    const failure = yield* harness.runtime
      .runRead({
        input: { query: 'AKROS' },
        principal: {
          authBindingId: '77777777-7777-4777-8777-777777777777',
          authContextRef: scope.authContextRef,
          authMethod: 'session',
          legalEntityId: companyId,
          principalId,
          tenantId,
        },
        registration: marketsRead,
        transport: { correlationId: 'denied-market-search' },
      })
      .pipe(Effect.flip);
    expect(failure).toBeInstanceOf(OperationContextDenied);
  }).pipe(
    Effect.scoped,
    Effect.provide(NodeCrypto.layer),
    Effect.provideService(CoreSearchQueryRuntime, { search: () => Effect.die('Denied context must not query search') }),
  ),
);
