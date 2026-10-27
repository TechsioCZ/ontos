// expect-count: 4
import { Effect } from 'effect';
import type { ScopedTransactionExecutor as Connection } from '@app/core-runtime';
import { snapshot } from '../../../../support/transaction-barrel.ts';

declare const replacement: Connection;
export const written = (connection: Connection) => {
  connection = replacement;
  return Effect.gen(function* () {
    const first = yield* snapshot(connection);
    const second = yield* connection.select().from({});
    return { first, second };
  });
};
export const asserted = (input: unknown) => {
  const connection = input as Connection;
  return Effect.gen(function* () {
    const first = yield* snapshot(connection);
    const second = yield* connection.select().from({});
    return { first, second };
  });
};
export const localType = () => {
  interface ScopedTransactionExecutor { select(): any }
  return (connection: ScopedTransactionExecutor) => Effect.gen(function* () {
    const first = yield* connection.select().from({});
    const second = yield* connection.select().from({});
    return { first, second };
  });
};
export const shadowedType = () => {
  interface Connection { select(): any }
  return (connection: Connection) => Effect.gen(function* () {
    const first = yield* connection.select().from({});
    const second = yield* connection.select().from({});
    return { first, second };
  });
};
