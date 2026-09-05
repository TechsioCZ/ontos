// expect-count: 1
import { Effect } from 'effect';

interface SettingRow {
  readonly tenant_id: string;
}

/** Audit B4 evidence shape: a Promise-shaped transaction contract with no tag in the module. */
export interface OperationalScopeTransactionService {
  readonly install: (scope: { readonly tenantId: string }) => Promise<void>;
  readonly verify: () => Promise<SettingRow | undefined>;
}

export const installOperationalScope = (
  transaction: OperationalScopeTransactionService,
): Effect.Effect<void> => Effect.promise(() => transaction.install({ tenantId: 'a' }));
