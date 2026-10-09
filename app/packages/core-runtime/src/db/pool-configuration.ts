import type { PgClient } from '@effect/sql-pg';
import { Duration, Effect, Redacted } from 'effect';

import { DatabaseConnectionError } from './connection-error.ts';

export interface DatabasePoolDeadlines {
  /** Bounds each physical connection's transport, TLS negotiation, startup, and authentication. */
  readonly connectTimeoutMillis: number;
  /**
   * Opt-in only. Row and advisory lock waits are designed serialization, so the statement
   * deadline is the single bound on them unless a caller explicitly chooses a shorter lock bound.
   */
  readonly lock_timeout?: number;
  readonly statement_timeout: number;
}

// Runtime work should fail promptly when PostgreSQL is unreachable without cutting off ordinary queries.
export const DEFAULT_DATABASE_POOL_DEADLINES: Readonly<DatabasePoolDeadlines> = Object.freeze({
  connectTimeoutMillis: 5000,
  statement_timeout: 30_000,
});

// PostgreSQL accepts these deadlines from the startup packet and URL `options`; only poolDeadlines may set them.
const REJECTED_URL_PARAMETERS = [
  'connectTimeoutMillis',
  'connectionTimeoutMillis',
  'connect_timeout',
  'lock_timeout',
  'statement_timeout',
  'query_timeout',
  'options',
] as const;

/**
 * Override deadlines only through poolDeadlines, never connection-string parameters.
 * URL startup options are unsupported because PostgreSQL can use them to override deadlines.
 * Other URL settings, including SSL, are parsed by the native driver unchanged.
 */
export const configureDatabasePool = Effect.fn('PoolConfiguration.configureDatabasePool')(
  function* configureDatabasePool(
    connectionString: Redacted.Redacted,
    poolDeadlines?: Partial<DatabasePoolDeadlines>,
  ): Effect.fn.Return<PgClient.PgPoolConfig, DatabaseConnectionError> {
    const { connectTimeoutMillis, ...serverDeadlines } = { ...DEFAULT_DATABASE_POOL_DEADLINES, ...poolDeadlines };
    for (const value of [connectTimeoutMillis, ...Object.values(serverDeadlines)]) {
      if (value === undefined) {
        continue;
      }
      // PostgreSQL treats zero as disabled; oversized Node timers overflow to 1ms.
      if (!Number.isInteger(value) || value <= 0 || value > 2_147_483_647) {
        return yield* new DatabaseConnectionError({
          reason: 'Database pool deadlines must be positive 32-bit millisecond integers',
        });
      }
    }

    const url = URL.parse(Redacted.value(connectionString));
    if (url === null || !['postgres:', 'postgresql:'].includes(url.protocol)) {
      return yield* new DatabaseConnectionError({
        reason: 'Database connection string must be a PostgreSQL URL',
      });
    }

    // Reject rather than strip them, preserving all unrelated URL settings verbatim and keeping one deadline policy.
    if (REJECTED_URL_PARAMETERS.some((key) => url.searchParams.has(key))) {
      return yield* new DatabaseConnectionError({
        reason: 'Database URL deadline parameters and startup options are unsupported; use poolDeadlines',
      });
    }

    // Server deadlines belong in every physical connection's startup packet, so PostgreSQL cancels the
    // work itself. Do not race queries against a client timer: that rejects without cancelling server work.
    const startupParameters: Record<string, string> = {};
    for (const [name, value] of Object.entries(serverDeadlines)) {
      if (value !== undefined) {
        startupParameters[name] = `${value}ms`;
      }
    }
    return {
      connectTimeout: Duration.millis(connectTimeoutMillis),
      startupParameters,
      url: connectionString,
    };
  },
);
