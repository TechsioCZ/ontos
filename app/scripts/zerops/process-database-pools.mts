import { Context, Effect, Layer, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { DatabasePoolRegistryLive, DatabasePools } from '../../packages/core-runtime/src/db/database-client.ts';

class DatabasePoolHostAlreadyStarted extends Schema.TaggedError<DatabasePoolHostAlreadyStarted>()(
  'DatabasePoolHostAlreadyStarted',
  { reason: Schema.String },
) {}

/** One registry per host process. RcMap and every native pool close with this startup scope. */
export const startProcessDatabasePools = Effect.gen(function* startPools() {
  const registry = Context.get(
    yield* Layer.build(DatabasePoolRegistryLive.pipe(Layer.provide(Reactivity.layer))),
    DatabasePools,
  );
  yield* Effect.acquireRelease(
    Effect.gen(function* publishRegistry() {
      if (globalThis.ontosDatabasePoolRegistry !== undefined) {
        return yield* new DatabasePoolHostAlreadyStarted({
          reason: 'The process already owns a database pool registry',
        });
      }
      return yield* Effect.sync(() => {
        globalThis.ontosDatabasePoolRegistry = registry;
      });
    }),
    () =>
      Effect.sync(() => {
        if (globalThis.ontosDatabasePoolRegistry === registry) {
          delete globalThis.ontosDatabasePoolRegistry;
        }
      }),
  );
  return yield* Effect.void;
});

export const ProcessDatabasePoolsLive = Layer.effectDiscard(startProcessDatabasePools);
