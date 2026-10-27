import {
  PgAuth,
  PgClient as actualPgClient,
  PgConnection,
  PgMigrator,
  PgPool,
  PgProtocol,
  PgTypes,
} from '@effect/sql-pg' with { rstest: 'importActual' };
import { sql } from 'drizzle-orm';
import { Context, Effect, Exit, Layer, Redacted } from 'effect';
import { expect, it, rstest } from 'effect-rstest';

import { coreRelations } from '../../src/db/schema.ts';
import { scriptedPgClientLayer } from '../../src/testing/scripted-pg-client.ts';
import { layerTestDatabase } from '../support/database.ts';
import type { TestDatabaseFromClient } from '../support/database.ts';
import { testSqlConnection } from '../support/sql-connection.ts';

const { makeNativePool } = rstest.hoisted(() => ({
  makeNativePool: rstest.fn<typeof actualPgClient.make>(),
}));

rstest.mock('@effect/sql-pg', () => ({
  PgAuth,
  PgClient: {
    ...actualPgClient,
    make: makeNativePool,
  },
  PgConnection,
  PgMigrator,
  PgPool,
  PgProtocol,
  PgTypes,
}));

class TestDatabase extends Context.Service<TestDatabase, TestDatabaseFromClient<typeof coreRelations>>()(
  '@app/core-runtime/tests/unit/test-database-layer.test/TestDatabase',
) {}
const adminUrl = 'postgresql://test-admin@database.invalid:5432/fixture';

interface PoolRun {
  readonly events: string[];
  released: boolean;
}

interface PoolObservations {
  readonly configurations: actualPgClient.PgPoolConfig[];
  readonly runs: PoolRun[];
}

const recordStatement = (run: PoolRun, statement: string) =>
  Effect.sync(() => {
    expect(run.released).toBe(false);
    run.events.push(statement);
    return [];
  });

const releasePool = (run: PoolRun) =>
  Effect.sync(() => {
    run.released = true;
    run.events.push('client-release');
  });

/** Only native acquisition is mocked; Drizzle, SQL execution and scoped finalizers remain real. */
const scriptedNativePool = (observations: PoolObservations) => (configuration: actualPgClient.PgPoolConfig) =>
  Effect.gen(function* acquireScriptedNativePool() {
    observations.configurations.push(configuration);
    const run: PoolRun = { events: [], released: false };
    observations.runs.push(run);
    const connection = testSqlConnection((statement) => recordStatement(run, statement));
    const services = yield* Layer.build(scriptedPgClientLayer(Effect.succeed(connection)));
    yield* Effect.addFinalizer(() => releasePool(run));
    return Context.get(services, actualPgClient.PgClient);
  });

it.effect(
  'acquires one configured admin pool per fixture and keeps it open through cleanup on success and failure',
  () =>
    Effect.gen(function* databaseLayerLifetime() {
      const observations: PoolObservations = { configurations: [], runs: [] };
      const nativeMake = rstest.mocked(makeNativePool).mockImplementation(scriptedNativePool(observations));
      yield* Effect.addFinalizer(() => Effect.sync(() => nativeMake.mockReset()));
      const databaseLayer = layerTestDatabase(TestDatabase, {
        connectionString: adminUrl,
        poolOptions: { idleTimeout: '30 seconds', maxConnections: 2 },
        relations: coreRelations,
      });

      for (const failFixture of [false, true]) {
        const exit = yield* Effect.scoped(
          Effect.gen(function* fixtureWithCleanup() {
            const services = yield* Layer.build(databaseLayer);
            const db = Context.get(services, TestDatabase);
            yield* Effect.addFinalizer(() => db.execute(sql`select 2`, 'objects').pipe(Effect.orDie));
            yield* db.execute(sql`select 1`, 'objects');
            return yield* failFixture ? Effect.fail('fixture-failed') : Effect.void;
          }),
        ).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(failFixture);
      }

      expect(nativeMake).toHaveBeenCalledTimes(2);
      expect(observations.configurations).toHaveLength(2);
      for (const configuration of observations.configurations) {
        expect(configuration.maxConnections).toBe(2);
        expect(configuration.idleTimeout).toBe('30 seconds');
        expect(Redacted.value(configuration.url ?? Redacted.make('missing-url'))).toBe(adminUrl);
      }
      expect(observations.runs).toHaveLength(2);
      expect(observations.runs[0]).not.toBe(observations.runs[1]);
      for (const run of observations.runs) {
        expect(run.released).toBe(true);
        expect(run.events).toEqual(['select 1', 'select 2', 'client-release']);
      }
    }),
);
