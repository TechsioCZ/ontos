import { CoreSearchWorkerSnapshot } from '@app/core-runtime';
import type { CoreSearchWorkerSnapshotService } from '@app/core-runtime';
import { scriptedPgClientLayer, testSqlConnection } from '@app/core-runtime/testing/scripted-pg-client';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { PgClient } from '@effect/sql-pg';
import { Context, Effect, Exit, Layer } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { expect, it } from 'effect-rstest';
import { facilityOperationsRelations } from '../../src/database/schema.ts';
import { loadFacilitySearchSnapshot } from '../../src/services/facility-search-source.ts';
import { company, otherCompany, snapshot, tenantId, workerContext } from './facility-search-fixtures.ts';

const scenario = Effect.fn('FacilitySearchTest.sourceScenario')(function* scenario(
  rowTenant = tenantId,
  rowCompany?: string,
) {
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
              records: snapshot.rows.map(({ legalEntityId: _company, tenantId: _tenant, ...row }) => row),
              tenantId: rowTenant,
            },
          ]);
        }),
      ),
    ).pipe(Layer.provide(Reactivity.layer)),
  );
  const executor = yield* makeWithDefaults({ relations: facilityOperationsRelations }).pipe(
    Effect.provideService(PgClient.PgClient, Context.get(services, PgClient.PgClient)),
  );
  const reader: CoreSearchWorkerSnapshotService = {
    read: (_claim, consume) =>
      consume({
        eventWatermark: '12',
        forLegalEntity: (legalEntityId, read) => {
          scopes.push(legalEntityId);
          return read({ select: executor.select.bind(executor) });
        },
        legalEntityIds: [company, otherCompany],
        projectionVersion: '37',
        tenant: () => Effect.die('Tenant SQL forbidden'),
        tenantId,
      }),
  };
  const exit = yield* Effect.exit(
    loadFacilitySearchSnapshot(workerContext('rebuild')).pipe(Effect.provideService(CoreSearchWorkerSnapshot, reader)),
  );
  return { exit, queries, scopes };
});

it.effect('selects only approved labels under explicit tenant/company SQL predicates in every Core company scope', () =>
  Effect.scoped(
    Effect.gen(function* source() {
      const { exit, queries, scopes } = yield* scenario();
      expect(Exit.isSuccess(exit)).toBe(true);
      if (Exit.isSuccess(exit)) {
        expect(exit.value.projectionVersion).toBe('37');
        expect(exit.value.rows.length).toBe(6);
      }
      expect(scopes).toEqual([company, otherCompany]);
      expect(queries.map((q) => q.params)).toEqual([
        [tenantId, company, 'assets', 'security', 'documents'],
        [tenantId, otherCompany, 'assets', 'security', 'documents'],
      ]);
      expect(
        queries.every(
          (q) => q.sql.includes('jsonb_build_object') && q.sql.includes('"facility_operations"."agenda_states"'),
        ),
      ).toBe(true);
      for (const privateField of [
        'note',
        'description',
        'versions',
        'comments',
        'contract',
        'administrator',
        'locationDetail',
        'responsible',
      ]) {
        expect(queries.every((q) => !q.sql.includes(`'${privateField}'`))).toBe(true);
      }
    }),
  ),
);

it.effect('rejects rows outside the trusted tenant or company', () =>
  Effect.scoped(
    Effect.gen(function* foreignSource() {
      expect(Exit.isFailure((yield* scenario(otherCompany)).exit)).toBe(true);
      expect(Exit.isFailure((yield* scenario(tenantId, otherCompany)).exit)).toBe(true);
    }),
  ),
);

it.effect('rejects a foreign snapshot before owner SQL is reachable', () =>
  Effect.gen(function* foreignSnapshot() {
    let reached = false;
    const exit = yield* Effect.exit(
      loadFacilitySearchSnapshot(workerContext('rebuild')).pipe(
        Effect.provideService(CoreSearchWorkerSnapshot, {
          read: (_context, read) =>
            read({
              eventWatermark: '1',
              forLegalEntity: () =>
                Effect.sync(() => {
                  reached = true;
                }).pipe(Effect.andThen(Effect.die('Foreign SQL'))),
              legalEntityIds: [company],
              projectionVersion: '2',
              tenant: () => Effect.die('Tenant SQL forbidden'),
              tenantId: otherCompany,
            }),
        }),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(reached).toBe(false);
  }),
);
