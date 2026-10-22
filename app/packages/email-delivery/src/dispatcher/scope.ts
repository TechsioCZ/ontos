// @effect-diagnostics *:off
// Tenant + legal-entity scope of every dispatcher read and ledger write. Same GUCs as core-runtime's operational scope:
// transaction-local, so a pooled (Hyperdrive) connection never carries one company's scope into the next statement.
import { PgClient } from '@effect/sql-pg';
import { Effect } from 'effect';
import type { SqlError } from 'effect/unstable/sql/SqlError';

export interface DeliveryScope {
  readonly legalEntityId: string;
  readonly tenantId: string;
}

/** Runs `effect` in one transaction whose RLS scope is exactly `scope`; dies when the scope did not install. */
export const inDeliveryScope = <A, E, R>(
  scope: DeliveryScope,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | SqlError, R | PgClient.PgClient> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const [installed] = yield* sql<{ readonly legal_entity_id: string; readonly tenant_id: string }>`
          select set_config('ontos.tenant_id', ${scope.tenantId}, true) as tenant_id,
            set_config('ontos.legal_entity_id', ${scope.legalEntityId}, true) as legal_entity_id`;
        if (installed?.tenant_id !== scope.tenantId || installed.legal_entity_id !== scope.legalEntityId) {
          return yield* Effect.die(new Error('e-mail delivery scope could not be installed'));
        }
        return yield* effect;
      }),
    );
  });
