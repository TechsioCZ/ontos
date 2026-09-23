import { Effect, Predicate } from 'effect';
import { expect, it } from 'effect-rstest';

import { acquirePriceGroupCatalogPool, makePriceGroupCatalogDatabase } from '../../src/database/client.ts';

it.effect('finalizes the Price Group Catalog pool with its Effect scope', () =>
  Effect.gen(function* finalizeCatalogPool() {
    let finalized = false;
    yield* Effect.scoped(
      acquirePriceGroupCatalogPool(() => ({
        end: () => {
          finalized = true;
          return Promise.resolve();
        },
      })),
    );
    expect(finalized).toBe(true);
  }),
);

it.effect('keeps pool acquisition failures in the typed channel', () =>
  Effect.gen(function* catalogPoolFailure() {
    const error = yield* Effect.flip(
      Effect.scoped(
        makePriceGroupCatalogDatabase(
          {
            connectionString: 'postgresql://ontos_runtime:test@localhost:5433/ontos',
            database: 'ontos',
            host: 'localhost',
            port: 5433,
            user: 'ontos_runtime',
          },
          () => {
            throw new Error('pool construction failed');
          },
        ),
      ),
    );
    expect(Predicate.isTagged(error, 'PriceGroupCatalogDatabaseConnectionError')).toBe(true);
    expect(error.reason).toBe('Unable to initialize the Price Group Catalog PostgreSQL connection pool');
  }),
);
