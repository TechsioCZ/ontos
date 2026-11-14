import { AsyncLocalStorage, AsyncResource } from 'node:async_hooks';

import { makeEffectDrizzleAuthAdapter } from '@app/better-auth-effect-drizzle/server';
import { APIError } from 'better-auth/api';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Cause, Effect, Exit, Layer } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { expect, it } from 'effect-rstest';

import { scriptedPgClientLayer } from '../../../../packages/core-runtime/src/testing/scripted-pg-client.ts';
import { testSqlConnection } from '../../../../packages/core-runtime/tests/support/sql-connection.ts';
import { authDatabaseSchema, authRelations } from '../../api/auth/db/schema.ts';

const fixture = Effect.gen(function* nativeTransactionFixture() {
  const endpointContext = new AsyncLocalStorage<string>();
  const acquisitionContexts: (string | undefined)[] = [];
  const statements: string[] = [];
  const socket = yield* Effect.acquireRelease(
    Effect.sync(() => new AsyncResource('scripted-auth-connection')),
    (resource) => Effect.sync(() => resource.emitDestroy()),
  );
  const connection = testSqlConnection((sql) =>
    Effect.sync(() => {
      statements.push(sql.trim().toUpperCase());
      return sql.includes('count(') ? [{ count: 0 }] : [];
    }),
  );
  // Resume from an already-created socket resource, not from the caller's endpoint context.
  const acquire = Effect.callback<ReturnType<typeof testSqlConnection>>(
    function acquireOutsideEndpoint(resume, signal) {
      const dispatcher = this.makeDispatcher();
      socket.runInAsyncScope(() =>
        dispatcher.scheduleTask(() => {
          if (!signal.aborted) {
            acquisitionContexts.push(endpointContext.getStore());
            resume(Effect.succeed(connection));
          }
        }, 0),
      );
    },
  );
  const executor = yield* makeWithDefaults({ relations: authRelations }).pipe(
    Effect.provide(scriptedPgClientLayer(acquire).pipe(Layer.provideMerge(Reactivity.layer))),
  );
  const adapter = yield* makeEffectDrizzleAuthAdapter(executor, authDatabaseSchema);
  return { acquisitionContexts, adapter: adapter({}), endpointContext, statements };
});

it.effect('preserves the generic transaction result and commits through the native SQL client', () =>
  Effect.scoped(
    Effect.gen(function* committedTransactionResult() {
      const test = yield* fixture;
      const expected = Object.freeze({ label: 'committed', value: 42 });
      const result = yield* Effect.promise(() => test.adapter.transaction(() => Promise.resolve(expected)));
      expect(result).toBe(expected);
      expect(result.value).toBe(42);
      expect(test.statements).toEqual(['BEGIN', 'COMMIT']);
    }),
  ),
);

it.effect('preserves APIError identity and rolls the native transaction back without committing', () =>
  Effect.scoped(
    Effect.gen(function* rejectedTransactionIdentity() {
      const test = yield* fixture;
      const rejected = new APIError('BAD_REQUEST', { message: 'Controlled transaction rejection' });
      const result = yield* Effect.promise(() => test.adapter.transaction(() => Promise.reject(rejected))).pipe(
        Effect.exit,
      );
      if (!Exit.isFailure(result)) {
        expect.unreachable('The rejected native transaction must fail');
      }
      expect(Cause.squash(result.cause)).toBe(rejected);
      expect(test.statements).toEqual(['BEGIN', 'ROLLBACK']);
    }),
  ),
);

it.effect('retains the caller endpoint context after acquiring a connection outside that context', () =>
  Effect.scoped(
    Effect.gen(function* callerTransactionContext() {
      const test = yield* fixture;
      yield* Effect.promise(() => test.adapter.count({ model: 'user' }));
      const seen = yield* Effect.promise(() =>
        test.endpointContext.run('endpoint', () =>
          test.adapter.transaction(() => Promise.resolve(test.endpointContext.getStore())),
        ),
      );
      expect(seen).toBe('endpoint');
      expect(test.acquisitionContexts.length).toBeGreaterThanOrEqual(2);
      expect(test.acquisitionContexts.every((context) => context === undefined)).toBe(true);
      expect(test.statements.slice(-2)).toEqual(['BEGIN', 'COMMIT']);
    }),
  ),
);
