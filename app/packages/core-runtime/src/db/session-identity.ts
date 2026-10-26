import type { PgClient } from '@effect/sql-pg';
import { Effect } from 'effect';

import { DatabaseConnectionError } from './connection-error.ts';

/**
 * Refuse startup unless the checked session authenticates as the enrolled origin role. The native
 * pool has no physical-connection initialization hook: this does not verify every pooled connection.
 */
export const verifyDatabaseSessionRole = Effect.fn('SessionIdentity.verifyDatabaseSessionRole')(
  function* verifySessionRole(client: PgClient.PgClient, expectedRole: string) {
    const rows = yield* client
      .unsafe<{ role: string }>('select session_user::text as role')
      .pipe(
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
