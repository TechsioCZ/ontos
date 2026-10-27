// Tenant + legal-entity scope of every dispatcher read and ledger write. Same GUCs as core-runtime's operational scope:
// transaction-local, so a pooled (Hyperdrive) connection never carries one company's scope into the next statement.
import { PgClient } from '@effect/sql-pg';
import { Effect, Schema } from 'effect';
import type { SqlError } from 'effect/sql/SqlError';

export interface DeliveryScope {
  readonly legalEntityId: string;
  readonly tenantId: string;
}

class DeliveryScopeInstallationError extends Schema.TaggedError<DeliveryScopeInstallationError>()(
  'DeliveryScopeInstallationError',
  {},
) {}

/** Runs `effect` in one transaction whose RLS scope is exactly `scope`; dies when the scope did not install. */
export const inDeliveryScope = Effect.fn('EmailDelivery.inDeliveryScope')(function* installDeliveryScope<A, E, R>(
  scope: DeliveryScope,
  effect: Effect.Effect<A, E, R>,
): Effect.fn.Return<A, E | SqlError, R | PgClient.PgClient> {
  const sql = yield* PgClient.PgClient;
  return yield* sql.withTransaction(
    Effect.gen(function* runScopedDelivery() {
      const [installed] = yield* sql<{ readonly legal_entity_id: string; readonly tenant_id: string }>`
        select set_config('ontos.tenant_id', ${scope.tenantId}, true) as tenant_id,
          set_config('ontos.legal_entity_id', ${scope.legalEntityId}, true) as legal_entity_id`;
      if (installed?.tenant_id !== scope.tenantId || installed.legal_entity_id !== scope.legalEntityId) {
        return yield* Effect.die(new DeliveryScopeInstallationError());
      }
      return yield* effect;
    }),
  );
});
