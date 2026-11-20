import { and, asc, eq } from 'drizzle-orm';
import { Effect, Schema } from 'effect';

import { WorkloadKeySchema } from '../../authorization/access-declaration.ts';
import { accessWorkloadBindings, principals, tenants } from '../../db/schema.ts';
import type { PrincipalKind } from '../../db/schema.ts';
import type { CoreTransaction } from '../../db/types.ts';
import { accessDecisionUnavailable } from '../decision/errors.ts';
import { TenantIdSchema } from '../ids.ts';

/** One active Principal holding an active binding of a workload. */
export interface WorkloadBindingHolder {
  readonly kind: PrincipalKind;
  readonly principalId: string;
}

const querySchema = Schema.Struct({ tenantId: TenantIdSchema, workloadKey: WorkloadKeySchema });

/**
 * Factual registry read for an operator check: every active Principal of an active Tenant that holds an active
 * binding of one workload, in Principal order. It names who may run the workload; it constructs no authentication
 * context and grants nothing. A caller decides on the whole list, so another holder of the same workload is never
 * hidden by a limit.
 */
export const readActiveWorkloadBindingHolders = Effect.fn('AccessWorkloadBindings.readActiveHolders')(
  function* readActiveHolders(transaction: Pick<CoreTransaction, 'select'>, tenantId: string, workloadKey: string) {
    const query = yield* Schema.decodeUnknownEffect(querySchema)({ tenantId, workloadKey }).pipe(
      Effect.mapError((cause) => accessDecisionUnavailable('The Tenant or workload key is invalid', cause)),
    );
    const holders: readonly WorkloadBindingHolder[] = yield* transaction
      .select({ kind: principals.kind, principalId: principals.principalId })
      .from(accessWorkloadBindings)
      .innerJoin(
        principals,
        and(
          eq(principals.tenantId, accessWorkloadBindings.tenantId),
          eq(principals.principalId, accessWorkloadBindings.principalId),
        ),
      )
      .innerJoin(tenants, eq(tenants.tenantId, principals.tenantId))
      .where(
        and(
          eq(accessWorkloadBindings.tenantId, query.tenantId),
          eq(accessWorkloadBindings.workloadKey, query.workloadKey),
          eq(accessWorkloadBindings.status, 'active'),
          eq(principals.status, 'active'),
          eq(tenants.status, 'active'),
        ),
      )
      .orderBy(asc(principals.principalId))
      .pipe(Effect.mapError((cause) => accessDecisionUnavailable('The workload bindings could not be read', cause)));
    return holders;
  },
);
