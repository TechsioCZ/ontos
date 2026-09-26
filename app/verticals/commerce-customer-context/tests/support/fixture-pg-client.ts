import { PgClient } from '@effect/sql-pg';
import { Context, Effect, Layer, Redacted, Scope } from 'effect';

/**
 * Acquires a native PostgreSQL resource in a scope of its own that closes only after every
 * finalizer the caller registers afterwards.
 *
 * The native pool cannot open a connection once its owning scope has begun closing, so a cleanup
 * finalizer registered in that same scope waits forever whenever no pooled connection is left open
 * (none was ever opened, or all were idle-closed). Owning the pool in a separate scope, closed by a
 * finalizer registered before any cleanup, keeps it usable for every later finalizer.
 */
export const acquireOutlivingCleanup = <Value, Failure, Requirements>(
  acquire: Effect.Effect<Value, Failure, Requirements>,
) =>
  Effect.gen(function* acquireInOwnScope() {
    const resourceScope = yield* Scope.make();
    yield* Effect.addFinalizer((exit) => Scope.close(resourceScope, exit));
    return yield* acquire.pipe(Scope.provide(resourceScope));
  });

/** A native client for a fixture whose cleanup runs as a finalizer of the same scope. */
export const acquireFixturePgClient = (connectionString: string, maxConnections?: number) =>
  acquireOutlivingCleanup(Layer.build(PgClient.layer({ maxConnections, url: Redacted.make(connectionString) }))).pipe(
    Effect.map(Context.get(PgClient.PgClient)),
  );
