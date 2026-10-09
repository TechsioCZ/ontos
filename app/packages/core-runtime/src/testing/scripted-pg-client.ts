import { PgClient } from '@effect/sql-pg';
import { Effect, Function as Fn, Layer } from 'effect';
import type { Reactivity } from 'effect/unstable/reactivity';
import { SqlClient, Statement } from 'effect/unstable/sql';
import type { Acquirer } from 'effect/unstable/sql/SqlConnection';

/**
 * Test double of the `PgClient` service over scripted in-memory connections.
 *
 * Statements, transactions, and savepoints run through Effect's own `SqlClient` with the PostgreSQL
 * compiler, so Drizzle executes exactly as it does against the native driver. Notifications are
 * outside the scripted protocol and die when used.
 */
export const scriptedPgClientLayer = (
  acquirer: Acquirer,
): Layer.Layer<PgClient.PgClient, never, Reactivity.Reactivity> =>
  Layer.effect(
    PgClient.PgClient,
    Effect.gen(function* makeScriptedPgClient() {
      // Transaction control mirrors the native PgClient so scripted fixtures observe its exact statements.
      const client = yield* SqlClient.make({
        acquirer,
        compiler: PgClient.makeCompiler(),
        prepareTransactionControls: true,
        releaseSavepoint: (name) => `RELEASE SAVEPOINT ${name}`,
        spanAttributes: [['db.system.name', 'postgresql']],
      });
      const notificationsUnavailable = Effect.die('Notifications are unavailable on a scripted PostgreSQL client');
      const service: PgClient.PgClient = Object.assign(client, {
        config: {},
        json: Fn.flow(Statement.custom<PgClient.PgCustom>('PgJson'), (segment) => Statement.fragment([segment])),
        listen: () => notificationsUnavailable,
        notify: () => notificationsUnavailable,
        [PgClient.TypeId]: PgClient.TypeId,
      });
      return service;
    }),
  );
