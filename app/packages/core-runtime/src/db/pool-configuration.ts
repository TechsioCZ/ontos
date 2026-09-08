import { Effect, Redacted } from 'effect';
import type { PoolConfig } from 'pg';

import { DatabaseConnectionError } from './connection-error.ts';

export interface DatabasePoolDeadlines {
  readonly connectionTimeoutMillis: number;
  /**
   * Opt-in only. Row and advisory lock waits are designed serialization, so the statement
   * deadline is the single bound on them unless a caller explicitly chooses a shorter lock bound.
   */
  readonly lock_timeout?: number;
  readonly statement_timeout: number;
}

// Runtime work should fail promptly under saturation without cutting off ordinary queries.
export const DEFAULT_DATABASE_POOL_DEADLINES: Readonly<DatabasePoolDeadlines> =
  Object.freeze({
    connectionTimeoutMillis: 5000,
    statement_timeout: 30_000,
  });

/**
 * Override deadlines only through poolDeadlines, never connection-string parameters.
 * URL startup options are unsupported because PostgreSQL can use them to override deadlines.
 * Other URL settings, including SSL, are passed to pg unchanged.
 */
export const configureDatabasePool = Effect.fn(
  'PoolConfiguration.configureDatabasePool'
)(function* configureDatabasePool(
  connectionString: Redacted.Redacted,
  poolDeadlines?: Partial<DatabasePoolDeadlines>
): Effect.fn.Return<PoolConfig, DatabaseConnectionError> {
  const options = { ...DEFAULT_DATABASE_POOL_DEADLINES, ...poolDeadlines };
  for (const value of Object.values(options)) {
    if (value === undefined) {
      continue;
    }
    // Zero disables pg deadlines; oversized Node timers overflow to 1ms.
    if (!Number.isInteger(value) || value <= 0 || value > 2_147_483_647) {
      return yield* new DatabaseConnectionError({
        reason:
          'Database pool deadlines must be positive 32-bit millisecond integers',
      });
    }
  }

  const unredactedConnectionString = Redacted.value(connectionString);
  const url = URL.parse(unredactedConnectionString);
  if (url === null || !['postgres:', 'postgresql:'].includes(url.protocol)) {
    return yield* new DatabaseConnectionError({
      reason: 'Database connection string must be a PostgreSQL URL',
    });
  }

  // pg merges parsed URI parameters over explicit options. Reject rather than strip them,
  // preserving all unrelated URL settings verbatim and keeping one deadline policy.
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

  // These server deadlines belong in the startup packet. Do not use query_timeout or a Promise
  // race: those reject without cancelling server work.
  return { connectionString: unredactedConnectionString, ...options };
});
