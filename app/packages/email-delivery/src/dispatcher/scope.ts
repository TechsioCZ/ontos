// Transaction-local scope prevents pooled connections from carrying identity into the next request.
import { PgClient } from '@effect/sql-pg';
import { Effect, Schema } from 'effect';
import type { SqlError } from 'effect/unstable/sql/SqlError';

export interface DeliveryScope {
  readonly legalEntityId: string;
  readonly tenantId: string;
}

class DeliveryScopeInstallationFailed extends Schema.TaggedError<DeliveryScopeInstallationFailed>()(
  'DeliveryScopeInstallationFailed',
  { message: Schema.String },
) {}

/** Execute in precisely the requested RLS scope; a failed installation is an invariant defect. */
export const inDeliveryScope = Effect.fn('EmailLedger.inDeliveryScope')(function* scopedDelivery<A, E, R>(
  scope: DeliveryScope,
  effect: Effect.Effect<A, E, R>,
): Effect.fn.Return<A, E | SqlError, R | PgClient.PgClient> {
  const sql = yield* PgClient.PgClient;
  return yield* sql.withTransaction(
    Effect.gen(function* installDeliveryScope() {
      const [installed] = yield* sql<{ readonly legal_entity_id: string; readonly tenant_id: string }>`
      select set_config('ontos.tenant_id', ${scope.tenantId}, true) as tenant_id,
        set_config('ontos.legal_entity_id', ${scope.legalEntityId}, true) as legal_entity_id`;
      if (installed?.tenant_id !== scope.tenantId || installed.legal_entity_id !== scope.legalEntityId) {
        return yield* Effect.die(
          new DeliveryScopeInstallationFailed({ message: 'e-mail delivery scope could not be installed' }),
        );
      }
      return yield* effect;
    }),
  );
});
