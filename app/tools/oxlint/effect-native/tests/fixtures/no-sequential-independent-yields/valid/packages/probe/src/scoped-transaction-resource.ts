import { Effect } from 'effect';
import type { ScopedTransactionExecutor as Connection, OperationalScope } from '@app/core-runtime';
import { loadAssignablePrincipalDirectory } from '@app/core-runtime/auth/assignable-principals';
import { snapshot as initialSnapshot, returned } from '../../../../support/transaction-barrel.ts';

export const captured = Effect.fn('Owner.factory')(function* factory(connection: Connection, scope: OperationalScope) {
  const loadRecords = Effect.fn('Owner.records')(function* records() {
    const directory = yield* loadAssignablePrincipalDirectory(connection, scope);
    const rows = yield* connection.select().from({}).limit(1);
    return { directory, rows };
  });
  return { loadRecords };
});
export const alias = (connection: Connection) => {
  const sameConnection = connection;
  return Effect.gen(function* () {
    const first = yield* initialSnapshot(sameConnection);
    const second = yield* connection.select().from({});
    return { first, second };
  });
};
export const direct = (connection: Connection) => Effect.gen(function* () {
  const first = yield* connection.select().from({});
  const second = yield* connection.select().from({});
  return { first, second };
});
export const returnedQuery = (connection: Connection) => Effect.gen(function* () {
  const first = yield* returned(connection);
  const second = yield* connection.select().from({});
  return { first, second };
});
