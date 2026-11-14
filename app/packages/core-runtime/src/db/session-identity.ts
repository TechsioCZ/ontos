import type { PgClient } from '@effect/sql-pg';
import { Effect, Ref } from 'effect';
import { ConnectionError, SqlError } from 'effect/sql/SqlError';

import { DatabaseConnectionError } from './connection-error.ts';
import { beforePoolAcquisition } from './transaction-io-guard.ts';

export const SESSION_ROLE_MISMATCH_REASON = 'The PostgreSQL session does not match the required database identity';

const sessionRoleMismatch = () =>
  new SqlError({
    reason: new ConnectionError({
      cause: new DatabaseConnectionError({ reason: SESSION_ROLE_MISMATCH_REASON }),
      message: SESSION_ROLE_MISMATCH_REASON,
    }),
  });

/**
 * Confirms the enrolled origin role on the client's first statement, transaction or reservation, so building a
 * root opens no connection. Until a check succeeds no statement runs: a refused connection or a foreign role fails
 * that use as a connection-class SqlError and is not remembered, so the next use checks again (a server that
 * refuses the first connection during a deploy recovers without a restart). The native pool has no
 * physical-connection initialization hook: this does not verify every pooled connection.
 */
export const verifySessionRoleOnFirstUse = (client: PgClient.PgClient, expectedRole: string): PgClient.PgClient => {
  const verified = Ref.makeUnsafe(false);
  const verify = client
    .unsafe<{ role: string }>('select session_user::text as role')
    .pipe(
      Effect.flatMap((rows) =>
        rows.length === 1 && rows[0]?.role === expectedRole
          ? Ref.set(verified, true)
          : Effect.fail(sessionRoleMismatch()),
      ),
    );
  return beforePoolAcquisition(client, Ref.get(verified).pipe(Effect.flatMap((done) => (done ? Effect.void : verify))));
};
