import { Context } from 'effect';
import type { Effect } from 'effect';

import type { CoreTransaction } from '../../db/types.ts';
import type { OperationalScope } from '../../operations/context.ts';
import type { AccessDecisionUnavailable } from '../decision/errors.ts';
import type { PrincipalId, TenantId } from '../ids.ts';

/*
 * The workload registry port the enforcement seam reads (O73). It lives beside the seam contract so
 * the gate depends only on the port: the drizzle store is `access/workloads/bindings.ts`, and a
 * composition that binds none admits no workload at all (fail closed).
 */

/**
 * The one question the gate asks the workload registry: which workload keys this actor may run right
 * now (O73). The scope is the trusted request scope, so the reader answers only this tenant's rows.
 */
export interface WorkloadBindingQuery {
  readonly principalId: PrincipalId;
  readonly scope: OperationalScope;
  readonly tenantId: TenantId;
}

/**
 * The gate's read of the registered workload identities (O73). An unreadable registry is
 * `UNAVAILABLE` (O48), never "no bindings": an empty set would refuse a workload that really holds
 * one, which is a denial the caller could not distinguish from a missing binding.
 */
export interface AccessWorkloadBindings {
  /**
   * `transaction` is a transaction the caller already owns (O75): a workload decided inside an owner
   * Action's transaction must read its registry bindings from that transaction. A caller with no
   * transaction leaves it out and the read opens one of its own in the request's scope.
   */
  readonly readActiveWorkloadKeys: (
    query: WorkloadBindingQuery,
    transaction?: CoreTransaction,
  ) => Effect.Effect<ReadonlySet<string>, AccessDecisionUnavailable>;
}

/** The runtime binds the workload registry through this service tag. */
export class AccessWorkloadBindingSource extends Context.Service<AccessWorkloadBindingSource, AccessWorkloadBindings>()(
  '@app/core-runtime/access/enforcement/workload-port/AccessWorkloadBindingSource',
) {}
