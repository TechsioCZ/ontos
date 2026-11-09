import { readVerifiedGatewayWorkload } from '../../auth/system-principal-context-provenance.ts';
import { and, eq, sql } from 'drizzle-orm';
import { Effect, Layer } from 'effect';

import { CoreDatabase } from '../../db/client.ts';
import { installOperationalScope } from '../../db/scoped-transaction.ts';
import { accessWorkloadBindings } from '../../db/schema.ts';
import type { CoreTransaction } from '../../db/types.ts';
import { accessDecisionUnavailable } from '../decision/errors.ts';
import type { AccessDecisionUnavailable } from '../decision/errors.ts';
import { AccessWorkloadBindingSource } from '../enforcement/workload-port.ts';
import type { AccessWorkloadBindings, WorkloadBindingQuery } from '../enforcement/workload-port.ts';
import type { AccessIntentDatabase } from '../intent/persistence.ts';

/*
 * The read side of the registered workload identities (O73). Legacy required an explicit per-Action
 * executor tuple for every service principal; v2 keeps the same rule as data. An `accessWorkload`
 * carrier names the workload keys it admits, and a `service`/`integration`/`system` principal is
 * admitted only when this registry holds an active binding for one of them. The kind alone grants
 * nothing, so a tenant-created managed API key runs only the workloads its principal is bound for.
 *
 * PostgreSQL holds the registry as Core-owned intent. The reader answers only the scoped tenant's
 * rows through row-level security (O66); the write side is `binding-store.ts`, and Core is its only
 * writer.
 */

/** The Core executor the registry is built over; the caller owns the pool and its deadlines. */
export interface AccessWorkloadBindingDatabase {
  readonly executor: AccessIntentDatabase['executor'];
}

const readUnavailable = (cause?: unknown): AccessDecisionUnavailable =>
  accessDecisionUnavailable('The registered workloads of this actor could not be read', cause);

export const makeDrizzleAccessWorkloadBindings = (database: AccessWorkloadBindingDatabase): AccessWorkloadBindings => ({
  readActiveWorkloadKeys: Effect.fn('AccessWorkloadBindings.readActiveWorkloadKeys')(
    function* readActiveWorkloadKeysEffect(query: WorkloadBindingQuery, transaction?: CoreTransaction) {
      const workload = readVerifiedGatewayWorkload(query.scope);
      if (workload?.sourceMode === 'historical_delivery' && workload.recovery === undefined) {
        return new Set<string>();
      }
      if (
        workload !== undefined &&
        workload.recovery === undefined &&
        (workload.originalWorkloadKey === undefined ||
          workload.originalWorkloadBindingIncarnation === undefined ||
          workload.originalOwnerBindingIncarnation === undefined)
      ) {
        return new Set<string>();
      }
      const read = (opened: CoreTransaction) =>
        // The registry forces tenant row security on `ontos_runtime`, so the request's own scope is
        // installed before the read: a principal id from another tenant answers nothing (O66).
        installOperationalScope(opened, query.scope).pipe(
          Effect.andThen(() =>
            opened
              .select({ workloadKey: accessWorkloadBindings.workloadKey })
              .from(accessWorkloadBindings)
              .where(
                and(
                  eq(accessWorkloadBindings.tenantId, query.tenantId),
                  eq(accessWorkloadBindings.principalId, query.principalId),
                  eq(accessWorkloadBindings.status, 'active'),
                  ...(workload === undefined
                    ? []
                    : [
                        eq(accessWorkloadBindings.incarnation, workload.bindingIncarnation),
                        eq(accessWorkloadBindings.workloadKey, workload.workloadKey),
                        ...(workload.sourceMode === 'worker'
                          ? [
                              sql`trust.registered_workload_delivery_is_active(${workload.runReference}::uuid, ${workload.claimId ?? ''}, ${workload.workerKey ?? ''}, ${workload.workerModuleKey ?? ''}, ${query.tenantId}::uuid)`,
                            ]
                          : []),
                        sql`exists (select 1 from core.principals s where s.tenant_id = ${query.tenantId}::uuid and s.principal_id = ${query.principalId}::uuid and s.kind = 'system' and s.status = 'active')`,
                        ...(workload.recovery === undefined
                          ? [
                              sql`exists (select 1 from core.principals p join core.access_workload_bindings b on b.tenant_id = p.tenant_id and b.principal_id = p.principal_id join core.access_workload_bindings ob on ob.tenant_id = p.tenant_id and ob.principal_id = p.principal_id and ob.workload_key = ${workload.workloadKey} and ob.incarnation = ${workload.originalOwnerBindingIncarnation}::uuid and ob.status = 'active' where p.tenant_id = ${query.tenantId}::uuid and p.principal_id = ${workload.originalPrincipalId}::uuid and p.status = 'active' and p.kind = 'integration' and b.workload_key = ${workload.originalWorkloadKey} and b.incarnation = ${workload.originalWorkloadBindingIncarnation}::uuid and b.status = 'active')`,
                            ]
                          : []),
                      ]),
                ),
              ),
          ),
        );
      const keys = yield* (transaction === undefined ? database.executor.transaction(read) : read(transaction)).pipe(
        Effect.mapError(readUnavailable),
      );
      return new Set(keys.map(({ workloadKey }) => workloadKey));
    },
  ),
});

export const AccessWorkloadBindingSourceLive: Layer.Layer<AccessWorkloadBindingSource, never, CoreDatabase> =
  Layer.effect(
    AccessWorkloadBindingSource,
    Effect.gen(function* accessWorkloadBindingSourceLive() {
      const database = yield* CoreDatabase;
      return makeDrizzleAccessWorkloadBindings(database);
    }),
  );
