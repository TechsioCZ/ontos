import { PgClient } from '@effect/sql-pg';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Context, Effect } from 'effect';
import { Reactivity } from 'effect/unstable/reactivity';
import type { Connection } from 'effect/unstable/sql/SqlConnection';
import type { SqlError } from 'effect/unstable/sql/SqlError';
import { Pool } from 'pg';

import { acquirePoolResource } from '../../src/db/client.ts';
import type { DatabaseConfigValue } from '../../src/db/config.ts';
import { coreRelations } from '../../src/db/schema.ts';

/** Per-fiber faults run where the native SQL driver executes a statement. */
export const TestQueryHook = Context.Reference('TestQueryHook', {
  defaultValue:
    (): ((statement: string) => Effect.Effect<void, SqlError>) => () =>
      Effect.void,
});

export const makeFaultInjectableCoreDatabase = Effect.fn(
  'makeFaultInjectableCoreDatabase'
)(function* makeFaultInjectableCoreDatabase(
  configuration: DatabaseConfigValue
) {
  const pool = yield* acquirePoolResource(
    () => new Pool({ connectionString: configuration.connectionString })
  );
  const reactivity = yield* Reactivity.make;
  const source = yield* PgClient.fromPool({
    acquire: Effect.succeed(pool),
  }).pipe(Effect.provideService(Reactivity.Reactivity, reactivity));
  const before = (statement: string) =>
    TestQueryHook.pipe(Effect.flatMap((hook) => hook(statement)));
  const acquirer = source.reserve.pipe(
    Effect.map((connection): Connection => ({
      ...connection,
      execute: (statement, params, transform) =>
        before(statement).pipe(
          Effect.andThen(() => connection.execute(statement, params, transform))
        ),
      executeRaw: (statement, params) =>
        before(statement).pipe(
          Effect.andThen(() => connection.executeRaw(statement, params))
        ),
      executeUnprepared: (statement, params, transform) =>
        before(statement).pipe(
          Effect.andThen(() =>
            connection.executeUnprepared(statement, params, transform)
          )
        ),
      executeValues: (statement, params) =>
        before(statement).pipe(
          Effect.andThen(() => connection.executeValues(statement, params))
        ),
      executeValuesUnprepared: (statement, params) =>
        before(statement).pipe(
          Effect.andThen(() =>
            connection.executeValuesUnprepared(statement, params)
          )
        ),
    }))
  );
  const client = yield* PgClient.makeWith({
    acquirer,
    config: {},
    listenAcquirer: Effect.die(
      'This test database does not support notifications'
    ),
    transactionAcquirer: acquirer,
  }).pipe(Effect.provideService(Reactivity.Reactivity, reactivity));
  const executor = yield* makeWithDefaults({ relations: coreRelations }).pipe(
    Effect.provideService(PgClient.PgClient, client)
  );
  return { executor };
});
