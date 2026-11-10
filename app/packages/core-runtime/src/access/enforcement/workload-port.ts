import { Context } from 'effect';
import type { Effect } from 'effect';

import type { CoreTransaction } from '../../db/types.ts';
import type { OperationalScope } from '../../operations/context.ts';
import type { AccessDecisionUnavailable } from '../decision/errors.ts';
import type { LegalEntityId, PrincipalId, TenantId } from '../ids.ts';

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
 * What the owner declared for the bindings of one workload (D6). A standalone workload selects and
 * acts only in `activeCompanyIds`; no declaration means no company authority. A verified module
 * subject with no declaration retains the tenant-wide authority established by its calling module.
 */
export interface WorkloadCompanyDeclaration {
  /** Every company an active registration names right now, each an active company of this tenant. */
  readonly activeCompanyIds: ReadonlySet<LegalEntityId>;
  /**
   * The owner declared a company for an active binding of this workload, so the workload is pinned to
   * `activeCompanyIds`. The pin outlives the registration: revoking the last one leaves it pinned to no
   * company, which is why a revoked registration ends the prepared Action's company exactly as a
   * revoked binding ends its key.
   */
  readonly pinned: boolean;
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
  /**
   * The company declaration of this workload's active bindings (D6). A standalone workload that holds
   * no verified module actor selects only `activeCompanyIds`, never the tenant's whole company list,
   * and acts only in them even after its last declared binding is revoked. Only a verified module
   * subject may retain the tenant-wide rule of O73. An unreadable registry is `UNAVAILABLE` (O48), never "no declaration",
   * because an empty answer would unpin a workload whose owner really declared one.
   *
   * `transaction` carries the same meaning as on `readActiveWorkloadKeys` (O75), so a decision taken
   * inside an owner Action's transaction reads the declaration from that transaction.
   */
  readonly readCompanyDeclaration: (
    query: WorkloadBindingQuery,
    transaction?: CoreTransaction,
  ) => Effect.Effect<WorkloadCompanyDeclaration, AccessDecisionUnavailable>;
}

/** The runtime binds the workload registry through this service tag. */
export class AccessWorkloadBindingSource extends Context.Service<AccessWorkloadBindingSource, AccessWorkloadBindings>()(
  '@app/core-runtime/access/enforcement/workload-port/AccessWorkloadBindingSource',
) {}
