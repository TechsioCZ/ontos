import { Effect, Predicate } from 'effect';
import { expect, it } from 'effect-rstest';

import { acquirePoolResource, makePartyDatabase } from '../../src/db/client.ts';

it.effect('finalizes the Party Registry pool when its Effect scope closes', () =>
  Effect.gen(function* testScenario1() {
    let finalized = false;
    yield* Effect.scoped(
      acquirePoolResource(() => ({
        end: () => {
          finalized = true;
          return Promise.resolve();
        },
      })),
    );
    expect(finalized).toBe(true);
  }),
);

it.effect('keeps Party Registry pool acquisition failure in the typed error channel', () =>
  Effect.gen(function* testScenario2() {
    const error = yield* Effect.flip(
      Effect.scoped(
        makePartyDatabase(
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
    expect(Predicate.isTagged(error, 'PartyDatabaseConnectionError')).toBe(true);
    expect(error.reason).toBe('Unable to initialize the Party Registry PostgreSQL connection pool');
  }),
);
