import { Effect, Predicate } from 'effect';
import { expect, it } from 'effect-rstest';

import { makePartyDatabase } from '../../src/db/client.ts';

it.effect('keeps Party Registry client configuration failure in the typed error channel', () =>
  Effect.gen(function* testScenario1() {
    const error = yield* Effect.flip(
      Effect.scoped(
        makePartyDatabase({
          connectionString: 'postgresql://ontos_runtime:test@localhost:5433/ontos?statement_timeout=1',
          database: 'ontos',
          host: 'localhost',
          port: 5433,
          user: 'ontos_runtime',
        }),
      ),
    );
    expect(Predicate.isTagged(error, 'PartyDatabaseConnectionError')).toBe(true);
    expect(error.reason).toBe(
      'Database URL deadline parameters and startup options are unsupported; use poolDeadlines',
    );
  }),
);
