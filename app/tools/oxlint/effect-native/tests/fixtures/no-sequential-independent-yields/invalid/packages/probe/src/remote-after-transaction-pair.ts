// expect-count: 1
import { Effect } from 'effect';
import type { ScopedTransactionExecutor } from '@app/core-runtime';
import { snapshot } from '../../../../support/transaction-barrel.ts';

declare const remote: { read(): Effect.Effect<unknown> };
export const read = (connection: ScopedTransactionExecutor) => Effect.gen(function* () {
  const first = yield* snapshot(connection);
  const second = yield* connection.select().from({});
  const third = yield* remote.read();
  return { first, second, third };
});
