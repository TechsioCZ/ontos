import { Effect, Predicate } from 'effect';
import { expect, it } from 'effect-rstest';

import { makePriceGroupCatalogDatabase } from '../../src/database/client.ts';

it.effect('keeps client configuration failures in the typed channel', () =>
  Effect.gen(function* catalogClientConfigurationFailure() {
    const error = yield* Effect.flip(
      Effect.scoped(
        makePriceGroupCatalogDatabase({
          connectionString: 'postgresql://ontos_runtime:test@localhost:5433/ontos?statement_timeout=1',
          database: 'ontos',
          host: 'localhost',
          port: 5433,
          user: 'ontos_runtime',
        }),
      ),
    );
    expect(Predicate.isTagged(error, 'PriceGroupCatalogDatabaseConnectionError')).toBe(true);
    expect(error.reason).toBe(
      'Database URL deadline parameters and startup options are unsupported; use poolDeadlines',
    );
  }),
);
