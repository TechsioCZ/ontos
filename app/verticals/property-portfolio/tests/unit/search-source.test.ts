import { CoreSearchWorkerSnapshot } from '@app/core-runtime';
import type { CoreSearchWorkerSnapshotService, OutboxWorkerHandlerContext } from '@app/core-runtime';
import { scriptedPgClientLayer, testSqlConnection } from '@app/core-runtime/testing/scripted-pg-client';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { PgClient } from '@effect/sql-pg';
import { Effect, Exit, Layer, Context } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { expect, it } from 'effect-rstest';

import { propertyRelations } from '../../src/database/schema.ts';
import type { PropertyState } from '../../shared/apis/records.ts';
import { invalidSearchSource } from '../../src/services/search-projection.ts';
import { loadSearchSnapshot } from '../../src/services/search-source.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const legalEntityId = '20000000-0000-4000-8000-000000000001';
const otherCompany = '20000000-0000-4000-8000-000000000002';
const context: OutboxWorkerHandlerContext = {
  attemptNumber: 1,
  claimId: 'claim',
  compositionRevision: 'a'.repeat(64),
  deliveryId: 'delivery',
  domainEventId: 'event',
  messageId: 'message',
  producerModuleKey: 'property.portfolio',
  tenantId,
  tenantSequenceNo: 1n,
  topic: 'property.portfolio.search-refresh-requested.v1',
  workerKey: 'property.portfolio.refresh-search',
};

const emptyState: PropertyState = { assets: [], properties: [], units: [] };

const scenario = (
  rowTenant = tenantId,
  rowCompany?: string,
  snapshotTenant = tenantId,
  payload: PropertyState = emptyState,
  malformed = false,
) =>
  Effect.scoped(
    Effect.gen(function* sourceScenario() {
      const queries: { readonly params: readonly unknown[]; readonly sql: string }[] = [];
      const scopes: string[] = [];
      const services = yield* Layer.build(
        scriptedPgClientLayer(
          Effect.succeed(
            testSqlConnection((sql, params) => {
              queries.push({ params, sql });
              return Effect.succeed([
                {
                  legalEntityId: rowCompany ?? params[1],
                  payload: malformed ? { assets: [], properties: [], units: 'invalid' } : payload,
                  tenantId: rowTenant,
                },
              ]);
            }),
          ),
        ).pipe(Layer.provide(Reactivity.layer)),
      );
      const executor = yield* makeWithDefaults({ relations: propertyRelations }).pipe(
        Effect.provideService(PgClient.PgClient, Context.get(services, PgClient.PgClient)),
      );
      const reader: CoreSearchWorkerSnapshotService = {
        read: (_claim, readSnapshot) =>
          readSnapshot({
            eventWatermark: '12',
            forLegalEntity: (company, read) => {
              scopes.push(company);
              return read({ select: executor.select.bind(executor) });
            },
            legalEntityIds: [legalEntityId, otherCompany],
            projectionVersion: '37',
            tenant: () => Effect.fail(invalidSearchSource()),
            tenantId: snapshotTenant,
          }),
      };
      const exit = yield* Effect.exit(
        loadSearchSnapshot(context).pipe(Effect.provideService(CoreSearchWorkerSnapshot, reader)),
      );
      return { exit, queries, scopes };
    }),
  );

it.effect('reads every company through Core-scoped snapshots with explicit tenant AND company SQL predicates', () =>
  Effect.gen(function* scenarioTest() {
    const { exit, queries, scopes } = yield* scenario();
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value.projectionVersion).toBe('37');
      expect(exit.value.companies.map((company) => company.legalEntityId)).toEqual([legalEntityId, otherCompany]);
    }
    expect(scopes).toEqual([legalEntityId, otherCompany]);
    expect(queries.map((query) => query.params)).toEqual([
      [tenantId, legalEntityId],
      [tenantId, otherCompany],
    ]);
    expect(queries.every((query) => query.sql.includes('"property_portfolio"."state"'))).toBe(true);
  }),
);

const assetPayload = {
  assets: [
    {
      acquiredAt: null,
      assetRef: {
        moduleId: 'property.portfolio',
        resourceId: '40000000-0000-4000-8000-000000000010',
        resourceType: 'property.portfolio.asset',
        tenantId,
      },
      category: 'Stroj',
      code: 'LOAD-9',
      lastServiceAt: null,
      lifecycleState: 'IN_SERVICE',
      name: 'Kolový nakladač',
      nextServiceAt: null,
      propertyRef: {
        moduleId: 'property.portfolio',
        resourceId: '40000000-0000-4000-8000-000000000011',
        resourceType: 'property.portfolio.property',
        tenantId,
      },
      serialNumber: 'SN-SOURCE-9',
      unitRef: null,
    },
  ],
  properties: [],
  units: [],
} satisfies PropertyState;

it.effect('loads the actual asset collection from the owner payload without dropping approved fields', () =>
  Effect.gen(function* assetSnapshotScenario() {
    const { exit } = yield* scenario(tenantId, undefined, tenantId, assetPayload);
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value.companies[0]?.state.assets).toEqual([
        expect.objectContaining({
          category: 'Stroj',
          code: 'LOAD-9',
          lifecycleState: 'IN_SERVICE',
          name: 'Kolový nakladač',
          serialNumber: 'SN-SOURCE-9',
        }),
      ]);
    }
  }),
);

it.effect('rejects a foreign snapshot before opening company reads and rejects malformed owner payloads', () =>
  Effect.gen(function* invalidSnapshotScenario() {
    const foreign = yield* scenario(tenantId, undefined, otherCompany);
    expect(Exit.isFailure(foreign.exit)).toBe(true);
    expect(foreign.scopes).toEqual([]);
    expect(foreign.queries).toEqual([]);
    const malformed = yield* scenario(tenantId, undefined, tenantId, emptyState, true);
    expect(Exit.isFailure(malformed.exit)).toBe(true);
    expect(malformed.scopes).toEqual([legalEntityId]);
    expect(malformed.queries.length).toBe(1);
  }),
);

it.effect('fails closed when a driver returns rows outside the trusted tenant or selected company', () =>
  Effect.gen(function* scenarioTest() {
    expect(Exit.isFailure((yield* scenario(otherCompany)).exit)).toBe(true);
    expect(Exit.isFailure((yield* scenario(tenantId, otherCompany)).exit)).toBe(true);
  }),
);
