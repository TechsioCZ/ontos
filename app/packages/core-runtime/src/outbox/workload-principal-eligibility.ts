import { and, eq } from 'drizzle-orm';
import { Effect, Schema } from 'effect';

import { PrincipalIdSchema } from '../access/ids.ts';
import { WorkloadKeySchema } from '../authorization/access-declaration.ts';
import { accessWorkloadBindings, principals, tenants } from '../db/schema.ts';
import type { CoreTransaction } from '../db/types.ts';
import { OutboxWorkerTenantScopeError } from './tenant-scope-error.ts';

const querySchema = Schema.Struct({
  kind: Schema.Literals(['integration', 'service', 'system']),
  principalId: PrincipalIdSchema,
  workloadKey: WorkloadKeySchema,
});

export type WorkerWorkloadPrincipalQuery = typeof querySchema.Encoded;
export type WorkerWorkloadPrincipalEligibility = (
  input: WorkerWorkloadPrincipalQuery,
) => Effect.Effect<boolean, OutboxWorkerTenantScopeError>;

const unavailable = (cause?: unknown) =>
  new OutboxWorkerTenantScopeError({
    cause,
    code: 'outbox_worker_tenant_scope_unavailable',
    reason: 'The current workload principal could not be checked',
    retryable: true,
  });

/** Core reads only the current native identity and binding inside its verified worker transaction. */
export const readWorkerWorkloadPrincipalEligibility = Effect.fn('OutboxWorker.readWorkloadPrincipalEligibility')(
  function* readWorkloadPrincipalEligibility(
    transaction: Pick<CoreTransaction, 'select'>,
    tenantId: string,
    input: WorkerWorkloadPrincipalQuery,
  ) {
    const query = yield* Schema.decodeUnknownEffect(querySchema)(input).pipe(Effect.mapError(unavailable));
    const rows = yield* transaction
      .select({ principalId: principals.principalId })
      .from(principals)
      .innerJoin(tenants, eq(tenants.tenantId, principals.tenantId))
      .innerJoin(
        accessWorkloadBindings,
        and(
          eq(accessWorkloadBindings.tenantId, principals.tenantId),
          eq(accessWorkloadBindings.principalId, principals.principalId),
        ),
      )
      .where(
        and(
          eq(principals.tenantId, tenantId),
          eq(principals.principalId, query.principalId),
          eq(principals.kind, query.kind),
          eq(principals.status, 'active'),
          eq(tenants.status, 'active'),
          eq(accessWorkloadBindings.workloadKey, query.workloadKey),
          eq(accessWorkloadBindings.status, 'active'),
        ),
      )
      .limit(1)
      .pipe(Effect.mapError(unavailable));
    return rows.length === 1;
  },
);
