import type { PgClient } from '@effect/sql-pg';
import { Duration, Effect, Schedule } from 'effect';

import { DatabaseConnectionError } from './connection-error.ts';

/**
 * A server that refuses the first connection (no free connection slot while a deploy overlaps the previous release,
 * a database restart) recovers within seconds. A Node process builds its database services once and keeps a failed
 * build for its whole life, so the check retries a refused connection with a capped backoff before startup gives up.
 */
export const SESSION_ROLE_CONNECT_RETRY = Schedule.min([
  Schedule.exponential(Duration.millis(250)),
  Schedule.spaced(Duration.seconds(5)),
]).pipe(Schedule.upTo({ duration: Duration.minutes(3) }));

/**
 * Refuse startup unless the checked session authenticates as the enrolled origin role. The native
 * pool has no physical-connection initialization hook: this does not verify every pooled connection.
 */
export const verifyDatabaseSessionRole = Effect.fn('SessionIdentity.verifyDatabaseSessionRole')(
  function* verifySessionRole(client: PgClient.PgClient, expectedRole: string) {
    const rows = yield* client.unsafe<{ role: string }>('select session_user::text as role').pipe(
      Effect.retry(SESSION_ROLE_CONNECT_RETRY),
      Effect.catchTag('SqlError', () =>
        Effect.fail(new DatabaseConnectionError({ reason: 'Unable to verify the PostgreSQL session role' })),
      ),
    );
    if (rows.length !== 1 || rows[0]?.role !== expectedRole) {
      return yield* new DatabaseConnectionError({
        reason: 'The PostgreSQL session does not match the required database identity',
      });
    }
    return yield* Effect.void;
  },
);
