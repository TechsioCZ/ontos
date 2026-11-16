import type { OperationalScope, ScopedTransactionExecutor } from '@app/core-runtime';
import { readScopedGatewayPrincipalKind } from '@app/core-runtime/access/enforcement';
import { Effect } from 'effect';

import { symmyJobStoreFactory } from '../persistence/symmy-job-store.ts';

export interface SymmyJobOperationServices extends Effect.Success<ReturnType<typeof symmyJobStoreFactory>> {
  readonly readPrincipalKind: () => ReturnType<typeof readScopedGatewayPrincipalKind>;
}

/** The business store and exact current Core actor are both read inside this operation's scope. */
export const symmyJobOperationFactory = (
  transaction: ScopedTransactionExecutor,
  scope: OperationalScope,
): Effect.Effect<SymmyJobOperationServices> =>
  symmyJobStoreFactory(transaction, scope).pipe(
    Effect.map((store) => ({
      ...store,
      readPrincipalKind: () => readScopedGatewayPrincipalKind(transaction, scope),
    })),
  );
