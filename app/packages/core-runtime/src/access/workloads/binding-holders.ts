import { and, asc, eq, exists, isNull, sql } from 'drizzle-orm';
import { Effect, Schema } from 'effect';

import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '../../auth/staff-authentication-namespace.ts';
import { WorkloadKeySchema } from '../../authorization/access-declaration.ts';
import { accessWorkloadBindings, principalAuthBindings, principals, tenants } from '../../db/schema.ts';
import type { PrincipalKind } from '../../db/schema.ts';
import type { CoreTransaction } from '../../db/types.ts';
import { accessDecisionUnavailable } from '../decision/errors.ts';
import { TenantIdSchema } from '../ids.ts';

/** One active Principal holding an active binding of a workload. */
export interface WorkloadBindingHolder {
  /**
   * The Principal holds an active, unrevoked Better Auth API-key auth binding of the staff namespace, the binding the
   * Shell gateway resolves an `x-api-key` to (`resolveBetterAuthApiKey`).
   */
  readonly apiKey: boolean;
  readonly kind: PrincipalKind;
  readonly principalId: string;
}

const querySchema = Schema.Struct({ tenantId: TenantIdSchema, workloadKey: WorkloadKeySchema });

/**
 * Factual registry read for an operator check: every active Principal of an active Tenant that holds an active
 * binding of one workload, in Principal order, and whether each holds an active, unrevoked API-key auth binding. It
 * names who may run the workload; it constructs no authentication context and grants nothing. A caller decides on the
 * whole list, so another holder of the same workload is never hidden by a limit.
 */
export const readActiveWorkloadBindingHolders = Effect.fn('AccessWorkloadBindings.readActiveHolders')(
  function* readActiveHolders(transaction: Pick<CoreTransaction, 'select'>, tenantId: string, workloadKey: string) {
    const query = yield* Schema.decodeUnknownEffect(querySchema)({ tenantId, workloadKey }).pipe(
      Effect.mapError((cause) => accessDecisionUnavailable('The Tenant or workload key is invalid', cause)),
    );
    const holders: readonly WorkloadBindingHolder[] = yield* transaction
      .select({
        apiKey: sql<boolean>`${exists(
          transaction
            .select({ bindingId: principalAuthBindings.principalAuthBindingId })
            .from(principalAuthBindings)
            .where(
              and(
                eq(principalAuthBindings.tenantId, principals.tenantId),
                eq(principalAuthBindings.principalId, principals.principalId),
                eq(principalAuthBindings.provider, 'better_auth'),
                eq(principalAuthBindings.authenticationNamespaceId, STAFF_AUTHENTICATION_NAMESPACE_ID),
                eq(principalAuthBindings.subjectType, 'api_key'),
                eq(principalAuthBindings.status, 'active'),
                isNull(principalAuthBindings.revokedAt),
              ),
            ),
        )}`,
        kind: principals.kind,
        principalId: principals.principalId,
      })
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
