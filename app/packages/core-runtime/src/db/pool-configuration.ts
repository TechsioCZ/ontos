import { Effect } from 'effect';
import type { PoolConfig } from 'pg';
import { DatabaseConnectionError } from './connection-error.ts';

export interface DatabasePoolDeadlines {
  readonly connectionTimeoutMillis: number;
  /**
   * Opt-in only. Row and advisory lock waits (duplicate invocation rendezvous, search
   * rebuilds, case merges) are designed serialization, so the statement deadline is the
   * single bound on them; a shorter pool-wide lock deadline would turn waiting into failure.
   */
  readonly lock_timeout?: number;
  readonly statement_timeout: number;
}

// Runtime work should fail promptly under saturation without cutting off ordinary queries.
export const DEFAULT_DATABASE_POOL_DEADLINES: Readonly<DatabasePoolDeadlines> = Object.freeze({
  connectionTimeoutMillis: 5000,
  statement_timeout: 30_000,
});

/**
 * Override deadlines only through poolDeadlines, never connection-string parameters.
 * URL startup options are unsupported: PostgreSQL can use them to override deadlines.
 * Other URL settings (including SSL) are passed to pg unchanged.
 */
export const makeDatabasePoolConfiguration = Effect.fn(
  'PoolConfiguration.makeDatabasePoolConfiguration',
)(function* makeDatabasePoolConfiguration(
  connectionString: string,
  poolDeadlines?: Partial<DatabasePoolDeadlines>,
): Effect.fn.Return<PoolConfig, DatabaseConnectionError> {
  const options = { ...DEFAULT_DATABASE_POOL_DEADLINES, ...poolDeadlines };
  for (const value of Object.values(options)) {
    if (value === undefined) {
      continue;
    }
    // Zero disables pg deadlines; oversized Node timers overflow to 1ms.
    if (!Number.isInteger(value) || value <= 0 || value > 2_147_483_647) {
      return yield* new DatabaseConnectionError({
        reason: 'Database pool deadlines must be positive 32-bit millisecond integers',
      });
    }
  }
  const url = URL.parse(connectionString);
  if (url === null || !['postgres:', 'postgresql:'].includes(url.protocol)) {
    return yield* new DatabaseConnectionError({
      reason: 'Database connection string must be a PostgreSQL URL',
    });
  }
  // pg 8.22 ConnectionParameters merges parsed URI parameters OVER explicit options.
  // Reject rather than strip them, preserving all unrelated URL settings verbatim.
  // Reject startup options wholesale instead of attempting to parse PostgreSQL's
  // separate command-line grammar (including escaping and --name=value aliases).
  if (
    [
      'connectionTimeoutMillis',
      'connect_timeout',
      'lock_timeout',
      'statement_timeout',
      'query_timeout',
      'options',
    ].some((key) => url.searchParams.has(key))
  ) {
    return yield* new DatabaseConnectionError({
      reason:
        'Database URL deadline parameters and startup options are unsupported; use poolDeadlines',
    });
  }
  // pg 8.22 sends these server deadlines in its startup packet. Do not use
  // query_timeout or a Promise race: those reject without cancelling server work.
  // A transport failure during COMMIT still has an unknown outcome, not a rollback.
  return { connectionString, ...options };
});
