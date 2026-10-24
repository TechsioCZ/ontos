import { PgClient } from '@effect/sql-pg';
import { Context, Effect, Layer, Schema } from 'effect';
import type { Redacted } from 'effect';

import { guardedPgClientLayer } from './client.ts';

const SessionAdvisoryLockUnavailable = Schema.TaggedError<Error>()('SessionAdvisoryLockUnavailable', {
  cause: Schema.optionalKey(Schema.Defect()),
  reason: Schema.String,
});

/**
 * Serialize external side effects without an open SQL transaction. A private physical
 * session is disposed on success, failure and interruption; a lock is never returned
 * to a shared connection pool. Explicit unlock is acknowledged before completion because
 * sending Terminate alone does not wait for the backend to release session locks.
 * Busy callers retry the complete operation.
 */
export const withPostgresSessionAdvisoryLock = <Value, Failure, Requirements>(
  connectionString: Redacted.Redacted,
  lockKey: string,
  operation: Effect.Effect<Value, Failure, Requirements>,
) =>
  Effect.scoped(
    Effect.gen(function* sessionAdvisoryLock() {
      const context = yield* Layer.build(guardedPgClientLayer(connectionString, 1)).pipe(
        Effect.mapError(
          (cause) =>
            new SessionAdvisoryLockUnavailable({ cause, reason: 'Unable to acquire the advisory-lock session' }),
        ),
      );
      const client = Context.get(context, PgClient.PgClient);
      const connection = yield* client.reserve.pipe(
        Effect.mapError(
          (cause) =>
            new SessionAdvisoryLockUnavailable({ cause, reason: 'Unable to reserve the advisory-lock session' }),
        ),
      );
      const acquired = yield* Effect.acquireRelease(
        connection
          .executeValues('select pg_try_advisory_lock(hashtextextended($1, 0))', [lockKey])
          .pipe(
            Effect.mapError(
              (cause) =>
                new SessionAdvisoryLockUnavailable({ cause, reason: 'Unable to acquire the session advisory lock' }),
            ),
          ),
        (result) =>
          result[0]?.[0] === true
            ? connection
                .executeValues('select pg_advisory_unlock(hashtextextended($1, 0))', [lockKey])
                .pipe(Effect.asVoid, Effect.orDie)
            : Effect.void,
      );
      if (acquired[0]?.[0] !== true) {
        return yield* new SessionAdvisoryLockUnavailable({
          reason: 'Another operation owns the session advisory lock',
        });
      }
      return yield* operation;
    }),
  );
