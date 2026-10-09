import { DateTime, Effect } from 'effect';
import { expect, it } from 'effect-rstest';

import { coreRelations } from '../../src/db/schema.ts';
import { trustedTransactionTime } from '../../src/operations/transaction-time.ts';
import { makeTestDatabaseFromClient, testDatabaseClients } from '../support/database.ts';

it.live('reads one PostgreSQL transaction timestamp as a stable UTC DateTime', () =>
  Effect.gen(function* transactionTimeIntegration() {
    const { runtime: runtimeClient } = yield* testDatabaseClients;
    const database = yield* makeTestDatabaseFromClient(runtimeClient, coreRelations);
    const [first, second] = yield* database.transaction((transaction) =>
      Effect.gen(function* readTransactionTimeTwice() {
        const initial = yield* trustedTransactionTime(transaction);
        const repeated = yield* trustedTransactionTime(transaction);
        return [initial, repeated] as const;
      }),
    );

    expect(DateTime.isUtc(first)).toBe(true);
    expect(DateTime.toEpochMillis(first)).toBe(DateTime.toEpochMillis(second));
    expect(DateTime.formatIso(first)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
  }),
);
