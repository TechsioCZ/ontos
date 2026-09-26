import { expect, it } from 'effect-rstest';
import { Effect, Predicate } from 'effect';
import { makePaymentTermCatalogDatabase } from '../../src/database/client.ts';

const configuration = {
  database: 'ontos',
  host: 'localhost',
  port: 5433,
  user: 'ontos_runtime',
} as const;

it.effect('keeps catalog client configuration failures in the typed channel', () =>
  Effect.gen(function* catalogClientConfigurationFailure() {
    const error = yield* Effect.flip(
      Effect.scoped(
        makePaymentTermCatalogDatabase({
          ...configuration,
          connectionString: 'postgresql://ontos_runtime:test@localhost:5433/ontos?statement_timeout=0',
        }),
      ),
    );
    expect(Predicate.isTagged(error, 'PaymentTermCatalogDatabaseConnectionError')).toBe(true);
    expect(error.reason).toBe(
      'Database URL deadline parameters and startup options are unsupported; use poolDeadlines',
    );
  }),
);

it.effect('rejects invalid catalog pool deadlines before constructing the client', () =>
  Effect.gen(function* catalogClientDeadlineFailure() {
    const error = yield* Effect.flip(
      Effect.scoped(
        makePaymentTermCatalogDatabase({
          ...configuration,
          connectionString: 'postgresql://ontos_runtime:test@localhost:5433/ontos',
          poolDeadlines: { statement_timeout: 0 },
        }),
      ),
    );
    expect(Predicate.isTagged(error, 'PaymentTermCatalogDatabaseConnectionError')).toBe(true);
    expect(error.reason).toBe('Database pool deadlines must be positive 32-bit millisecond integers');
  }),
);
