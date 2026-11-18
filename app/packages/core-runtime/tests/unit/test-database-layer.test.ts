import { Duplex } from 'node:stream';
import { finished } from 'node:stream/promises';

import type { PgClient } from '@effect/sql-pg';
import { sql } from 'drizzle-orm';
import { Context, Effect, Exit, Layer, Match, Redacted } from 'effect';
import { expect, it } from 'effect-rstest';

import { coreRelations } from '../../src/db/schema.ts';
import { layerTestDatabase } from '../support/database.ts';
import type { TestDatabaseFromClient } from '../support/database.ts';

class TestDatabase extends Context.Service<TestDatabase, TestDatabaseFromClient<typeof coreRelations>>()(
  '@app/core-runtime/tests/unit/test-database-layer.test/TestDatabase',
) {}
const adminUrl = 'postgresql://test-admin@database.invalid:5432/fixture';

interface PoolRun {
  readonly events: string[];
  released: boolean;
}

interface PoolObservations {
  readonly configurations: PgClient.PgPoolConfig<unknown>[];
  readonly runs: PoolRun[];
  readonly transports: Duplex[];
}

const backendFrame = (type: string, payload = Buffer.alloc(0)) => {
  const header = Buffer.alloc(5);
  header.write(type, 0, 'ascii');
  header.writeInt32BE(payload.length + 4, 1);
  return Buffer.concat([header, payload]);
};

/** The native driver talks PostgreSQL over its public custom-stream transport. */
const scriptedPostgres = (run: PoolRun) =>
  Duplex.from(async function* postgresTransport(source: AsyncIterable<Uint8Array>) {
    let pending = Buffer.alloc(0);
    let startup = true;
    const statements = new Map<string, string>();
    const session = { statement: '' };

    for await (const chunk of source) {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 5) {
        const offset = startup ? 0 : 1;
        const length = pending.readInt32BE(offset) + offset;
        if (pending.length < length) {
          break;
        }
        const frame = pending.subarray(0, length);
        pending = pending.subarray(length);
        if (startup) {
          startup = false;
          yield backendFrame('R', Buffer.alloc(4));
          yield backendFrame('Z', Buffer.from('I'));
        } else {
          const replies = Match.value(frame.toString('ascii', 0, 1)).pipe(
            Match.when('P', () => {
              const nameEnd = frame.indexOf(0, 5);
              const queryEnd = frame.indexOf(0, nameEnd + 1);
              statements.set(frame.toString('utf-8', 5, nameEnd), frame.toString('utf-8', nameEnd + 1, queryEnd));
              return [backendFrame('1')];
            }),
            Match.when('B', () => {
              const portalEnd = frame.indexOf(0, 5);
              const nameEnd = frame.indexOf(0, portalEnd + 1);
              const boundStatement = statements.get(frame.toString('utf-8', portalEnd + 1, nameEnd));
              if (boundStatement === undefined) {
                return expect.unreachable('Bind referenced an unknown statement');
              }
              session.statement = boundStatement;
              return [backendFrame('2')];
            }),
            Match.when('D', () => [backendFrame('n')]),
            Match.when('E', () => {
              expect(run.released).toBe(false);
              run.events.push(session.statement);
              return [backendFrame('C', Buffer.from('SELECT 0\0'))];
            }),
            Match.when('S', () => [backendFrame('Z', Buffer.from('I'))]),
            Match.when('X', () => {
              run.released = true;
              run.events.push('client-release');
              return [];
            }),
            Match.orElse((type) => expect.unreachable(`Unexpected PostgreSQL message: ${type}`)),
          );
          yield* replies;
        }
      }
    }
  });

it.live('acquires one configured admin pool per fixture and keeps it open through cleanup on success and failure', () =>
  Effect.gen(function* databaseLayerLifetime() {
    const observations: PoolObservations = { configurations: [], runs: [], transports: [] };
    const databaseLayer = layerTestDatabase(TestDatabase, {
      connectionString: adminUrl,
      poolOptions: {
        idleTimeout: '30 seconds',
        maxConnections: 2,
        stream: () => {
          const run: PoolRun = { events: [], released: false };
          observations.runs.push(run);
          const transport = scriptedPostgres(run);
          observations.transports.push(transport);
          return transport;
        },
      },
      relations: coreRelations,
    });

    for (const failFixture of [false, true]) {
      const exit = yield* Effect.scoped(
        Effect.gen(function* fixtureWithCleanup() {
          const services = yield* Layer.build(databaseLayer);
          const db = Context.get(services, TestDatabase);
          observations.configurations.push(db.$client.config);
          yield* Effect.addFinalizer(() => db.execute(sql`select 2`, 'objects').pipe(Effect.orDie));
          yield* db.execute(sql`select 1`, 'objects');
          return yield* failFixture ? Effect.fail('fixture-failed') : Effect.void;
        }),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(failFixture);
    }

    yield* Effect.promise(() => Promise.all(observations.transports.map((transport) => finished(transport))));
    expect(new Set(observations.configurations).size).toBe(2);
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
