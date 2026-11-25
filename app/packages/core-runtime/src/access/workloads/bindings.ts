import {
  readVerifiedGatewayRouteScope,
  readVerifiedGatewayWorkload,
} from '../../auth/system-principal-context-provenance.ts';
import type { RegisteredGatewayWorkload } from '../../auth/system-principal-context-provenance.ts';
import { internalWorkloadPrincipalId } from '../../auth/module-credentials.ts';
import { and, eq, sql } from 'drizzle-orm';
import { Effect, Layer } from 'effect';

import { CoreDatabase } from '../../db/client.ts';
import { DatabaseIdentityEnrollmentContext } from '../../db/database-identities.ts';
import type { DatabaseIdentityEnrollment } from '../../db/database-identities.ts';
import { installOperationalScope } from '../../db/scoped-transaction.ts';
import { accessWorkloadBindings, accessWorkloadCompanyBindings, legalEntities } from '../../db/schema.ts';
import type { CoreTransaction } from '../../db/types.ts';
import { accessDecisionUnavailable } from '../decision/errors.ts';
import type { AccessDecisionUnavailable } from '../decision/errors.ts';
import { AccessWorkloadBindingSource } from '../enforcement/workload-port.ts';
import type { AccessWorkloadBindings, WorkloadBindingQuery } from '../enforcement/workload-port.ts';
import { LegalEntityIdSchema } from '../ids.ts';
import type { LegalEntityId } from '../ids.ts';
import type { AccessIntentDatabase } from '../intent/persistence.ts';
import { activeRegisteredCompany, activeRegistrationOfBinding } from './company-registration.ts';

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
 *
 * The same read answers the companies a binding is explicitly registered for (D6): a workload acts and
 * selects only in these, directly and as the subject of a module call, and the write side of that
 * owner-declared fact is `company-bindings.ts`.
 */

/** The Core executor the registry is built over; the caller owns the pool and its deadlines. */
export interface AccessWorkloadBindingDatabase {
  /** The enrolled database identities whose scope authority the installed scope is verified against. */
  readonly enrollment: DatabaseIdentityEnrollment;
  readonly executor: AccessIntentDatabase['executor'];
}

const readUnavailable = (cause?: unknown): AccessDecisionUnavailable =>
  accessDecisionUnavailable('The registered workloads of this actor could not be read', cause);

/** The signed receiver is an active native executor, never the external integration's executor alias. */
export const registeredGatewayExecutorEligibility = (
  query: Pick<WorkloadBindingQuery, 'tenantId' | 'principalId'>,
  workload: Pick<RegisteredGatewayWorkload, 'legalEntityId' | 'workloadKey'>,
) => {
  const canonical =
    workload.legalEntityId === undefined
      ? sql`true`
      : sql`s.principal_id = ${internalWorkloadPrincipalId({
          legalEntityId: workload.legalEntityId,
          tenantId: query.tenantId,
          workloadKey: workload.workloadKey,
        })}::uuid`;
  return sql`exists (
    select 1 from core.principals s
    where s.tenant_id = ${query.tenantId}::uuid and s.principal_id = ${query.principalId}::uuid
      and s.status = 'active'
      and (s.kind = 'system' or (
        s.kind = 'service' and s.platform_role = 'internal_workload' and ${canonical}
        and exists (
          select 1 from core.access_workload_company_bindings cb
          join core.legal_entities le on le.tenant_id=cb.tenant_id
            and le.legal_entity_id=cb.legal_entity_id and le.status='active'
          where cb.tenant_id=s.tenant_id
            and cb.workload_binding_id=${accessWorkloadBindings.bindingId} and cb.status='active'
            ${workload.legalEntityId === undefined ? sql`` : sql`and cb.legal_entity_id=${workload.legalEntityId}::uuid`}
        )
      ))
  )`;
};

/** Original admission stays live; owner authority is the exact signed native receiver binding, not an alias. */
export const registeredGatewayOriginalAdmission = (
  query: Pick<WorkloadBindingQuery, 'tenantId' | 'principalId'>,
  workload: Pick<
    RegisteredGatewayWorkload,
    | 'originalPrincipalId'
    | 'originalWorkloadKey'
    | 'originalWorkloadBindingIncarnation'
    | 'originalOwnerBindingIncarnation'
  >,
) =>
  sql`exists (
    select 1 from core.principals p
    join core.access_workload_bindings b on b.tenant_id=p.tenant_id and b.principal_id=p.principal_id
    where p.tenant_id=${query.tenantId}::uuid and p.principal_id=${workload.originalPrincipalId}::uuid
      and p.status='active' and p.kind='integration'
      and b.workload_key=${workload.originalWorkloadKey}
      and b.incarnation=${workload.originalWorkloadBindingIncarnation}::uuid and b.status='active'
  ) and ${accessWorkloadBindings.incarnation}=${workload.originalOwnerBindingIncarnation}::uuid`;

export const makeDrizzleAccessWorkloadBindings = (database: AccessWorkloadBindingDatabase): AccessWorkloadBindings => ({
  readWorkloadAuthority: Effect.fn('AccessWorkloadBindings.readWorkloadAuthority')(
    function* readWorkloadAuthorityEffect(query: WorkloadBindingQuery, transaction?: CoreTransaction) {
      // A verified gateway workload (a system workload acting for a source integration) holds exactly the one binding
      // its assertion names; a historical delivery or an incomplete original admits nothing (source execution fence).
      const workload = readVerifiedGatewayWorkload(query.scope);
      const nativeRead = readVerifiedGatewayRouteScope(query.scope)?.nativeReadReceiver;
      const nothing = { activeCompanyIds: new Set<LegalEntityId>(), workloadKeys: new Set<string>() };
      if (workload?.sourceMode === 'historical_delivery' && workload.recovery === undefined) {
        return nothing;
      }
      if (
        workload !== undefined &&
        workload.recovery === undefined &&
        (workload.originalWorkloadKey === undefined ||
          workload.originalWorkloadBindingIncarnation === undefined ||
          workload.originalOwnerBindingIncarnation === undefined)
      ) {
        return nothing;
      }
      const read = (opened: CoreTransaction) =>
        // The registry forces tenant row security on `ontos_runtime`, so the request's own scope is
        // installed before the read: a principal id from another tenant answers nothing (O66).
        installOperationalScope(opened, query.scope, database.enrollment).pipe(
          Effect.andThen(() =>
            opened
              .select({
                legalEntityId: legalEntities.legalEntityId,
                workloadKey: accessWorkloadBindings.workloadKey,
              })
              .from(accessWorkloadBindings)
              // A registration counts only while the binding it was written for is still active: the keys and the
              // companies come from the same active bindings in the same read, so a revoked binding takes its key
              // and its company together (D6). The predicate is the one every registration reader shares.
              .leftJoin(accessWorkloadCompanyBindings, activeRegistrationOfBinding())
              .leftJoin(legalEntities, activeRegisteredCompany())
              .where(
                and(
                  eq(accessWorkloadBindings.tenantId, query.tenantId),
                  eq(accessWorkloadBindings.principalId, query.principalId),
                  eq(accessWorkloadBindings.status, 'active'),
                  ...(nativeRead === undefined
                    ? []
                    : [
                        eq(accessWorkloadBindings.incarnation, nativeRead.bindingIncarnation),
                        eq(accessWorkloadBindings.workloadKey, nativeRead.workloadKey),
                        registeredGatewayExecutorEligibility(
                          query,
                          nativeRead.enrollmentLegalEntityId === undefined
                            ? { workloadKey: nativeRead.workloadKey }
                            : {
                                legalEntityId: nativeRead.enrollmentLegalEntityId,
                                workloadKey: nativeRead.workloadKey,
                              },
                        ),
                        registeredGatewayOriginalAdmission(query, {
                          ...nativeRead,
                          originalOwnerBindingIncarnation: nativeRead.bindingIncarnation,
                        }),
                      ]),
                  // A verified gateway workload reads only the binding its assertion names, of an active native
                  // principal, for a delivery still running when it is a worker's, and only while the original
                  // integration's admission stays active; its keys and companies are the receiver binding's alone.
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
                        registeredGatewayExecutorEligibility(query, workload),
                        ...(workload.recovery === undefined
                          ? [registeredGatewayOriginalAdmission(query, workload)]
                          : []),
                      ]),
                ),
              ),
          ),
        );
      const rows = yield* (transaction === undefined ? database.executor.transaction(read) : read(transaction)).pipe(
        Effect.mapError(readUnavailable),
      );
      const workloadKeys = new Set<string>();
      const activeCompanyIds = new Set<LegalEntityId>();
      for (const row of rows) {
        workloadKeys.add(row.workloadKey);
        if (row.legalEntityId !== null) {
          activeCompanyIds.add(LegalEntityIdSchema.make(row.legalEntityId));
        }
      }
      // A workload, including a C14 system workload, acts in a company only through an active company registration.
      // Without one, the company gate answers deny.workload_unbound.
      return { activeCompanyIds, workloadKeys };
    },
  ),
});

export const AccessWorkloadBindingSourceLive: Layer.Layer<
  AccessWorkloadBindingSource,
  never,
  CoreDatabase | DatabaseIdentityEnrollmentContext
> = Layer.effect(
  AccessWorkloadBindingSource,
  Effect.gen(function* accessWorkloadBindingSourceLive() {
    const database = yield* CoreDatabase;
    const enrollment = yield* DatabaseIdentityEnrollmentContext;
    return makeDrizzleAccessWorkloadBindings({ enrollment, executor: database.executor });
  }),
);
