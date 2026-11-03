import { CoreSearchWorkerSnapshot } from '@app/core-runtime';
import type { CoreSearchWorkerSnapshotService, OutboxWorkerHandlerContext } from '@app/core-runtime';
import { scriptedPgClientLayer, testSqlConnection } from '@app/core-runtime/testing/scripted-pg-client';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { PgClient } from '@effect/sql-pg';
import { Effect, Exit, Layer, Context } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { expect, it } from 'effect-rstest';

import { occupancyState } from '../../src/database/schema.ts';
import { defineRelations } from 'drizzle-orm';

import { invalidSearchSource } from '../../src/search/projection.ts';
import { loadSearchSnapshot } from '../../src/services/search-source.ts';

const occupancyRelations = defineRelations({ occupancyState });

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
  producerModuleKey: 'property.leasing',
  tenantId,
  tenantSequenceNo: 1n,
  topic: 'property.leasing.search-refresh-requested.v1',
  workerKey: 'property.leasing.refresh-search',
};

interface SourceOptions {
  readonly companies?: readonly string[];
  readonly payload?: unknown;
  readonly rowCount?: number;
  readonly snapshotTenant?: string;
}
const scenario = (rowTenant = tenantId, rowCompany?: string, options: SourceOptions = {}) =>
  Effect.scoped(
    Effect.gen(function* sourceScenario() {
      const queries: { readonly params: readonly unknown[]; readonly sql: string }[] = [];
      const scopes: string[] = [];
      const services = yield* Layer.build(
        scriptedPgClientLayer(
          Effect.succeed(
            testSqlConnection((sql, params) => {
              queries.push({ params, sql });
              return Effect.succeed(
                Array.from({ length: options.rowCount ?? 1 }, () => ({
                  legalEntityId: rowCompany ?? params[1],
                  payload: options.payload ?? { occupancies: [] },
                  tenantId: rowTenant,
                })),
              );
            }),
          ),
        ).pipe(Layer.provide(Reactivity.layer)),
      );
      const executor = yield* makeWithDefaults({ relations: occupancyRelations }).pipe(
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
            legalEntityIds: options.companies ?? [legalEntityId, otherCompany],
            projectionVersion: '37',
            tenant: () => Effect.fail(invalidSearchSource()),
            tenantId: options.snapshotTenant ?? tenantId,
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
    expect(queries.every((query) => query.sql.includes('"property_leasing"."state"'))).toBe(true);
  }),
);

it.effect('fails closed when a driver returns rows outside the trusted tenant or selected company', () =>
  Effect.gen(function* scenarioTest() {
    expect(Exit.isFailure((yield* scenario(otherCompany)).exit)).toBe(true);
    expect(Exit.isFailure((yield* scenario(tenantId, otherCompany)).exit)).toBe(true);
  }),
);

it.effect('rejects duplicate company authorities and mismatched snapshot tenants before owner SQL', () =>
  Effect.gen(function* snapshotScopeScenario() {
    for (const options of [{ companies: [legalEntityId, legalEntityId] }, { snapshotTenant: otherCompany }]) {
      const result = yield* scenario(tenantId, undefined, options);
      expect(Exit.isFailure(result.exit)).toBe(true);
      expect(result.queries).toEqual([]);
    }
  }),
);

it.effect('fails closed on duplicate aggregate rows or invalid owner payloads', () =>
  Effect.gen(function* invalidRowsScenario() {
    for (const options of [{ rowCount: 2 }, { payload: { occupancies: [{ note: 'PRIVATE MALFORMED RECORD' }] } }]) {
      const result = yield* scenario(tenantId, undefined, options);
      expect(Exit.isFailure(result.exit)).toBe(true);
      expect(result.queries.length).toBe(1);
    }
    const missing = yield* scenario(tenantId, undefined, { rowCount: 0 });
    expect(Exit.isSuccess(missing.exit)).toBe(true);
    if (Exit.isSuccess(missing.exit)) {
      expect(missing.exit.value.companies).toEqual([]);
    }
  }),
);
