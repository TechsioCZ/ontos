import type { PgClient } from '@effect/sql-pg';
import { Effect } from 'effect';

/*
 * A workload binding of a principal of kind `system`, written as the operator's enrollment leaves it: directly in
 * `core.access_workload_bindings`. The generic binding writer (`writeWorkloadBindings`) refuses a `system` principal
 * once Core's own system workload enrollment is the only writer of one (#1536), so a suite that needs a bound system
 * principal states that fixture here instead of depending on which writer accepts it. Every other kind still goes
 * through the writer, which keeps proving its own path.
 */
export const insertSystemWorkloadBinding = Effect.fn('SystemWorkloadBindingFixture.insert')(
  function* insertSystemWorkloadBinding(
    admin: PgClient.PgClient,
    binding: {
      readonly bindingId: string;
      readonly incarnation: string;
      readonly principalId: string;
      readonly tenantId: string;
      readonly workloadKey: string;
    },
  ) {
    yield* admin.unsafe(
      `insert into core.access_workload_bindings (binding_id, tenant_id, principal_id, workload_key, incarnation, status)
       values ($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, 'active')`,
      [binding.bindingId, binding.tenantId, binding.principalId, binding.workloadKey, binding.incarnation],
    );
  },
);
