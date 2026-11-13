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
 * The one question the gate asks the workload registry: what this actor may run right now and in which
 * companies (O73, D6). The scope is the trusted request scope, so the reader answers only this tenant's rows.
 */
export interface WorkloadBindingQuery {
  readonly principalId: PrincipalId;
  readonly scope: OperationalScope;
  readonly tenantId: TenantId;
}

/**
 * The registered authority of one workload, read in one consistent read (O73, D6). A workload runs the carriers
 * that declare one of `workloadKeys` and acts only in `activeCompanyIds`, on its direct calls and as the subject of
 * a module call alike. Company authority is always a registration, never its absence: a workload with no active
 * registration acts in no company, and revoking a registration or the binding that carries it only removes one.
 *
 * A workload with no registration is therefore left with exactly the carriers that name no company. Today those are
 * five, all `legalEntityScope: 'forbidden'` and none answering a company: `core.identity-provider`'s two Actions
 * (`reserve-principal-binding`, `activate-principal-binding`) and its three reads in
 * `auth/external-identity/read.ts`. Two further carriers are `optional`, so their caller chooses whether to name a
 * company — `commerce.storefront-client`'s `start-portal-enrollment` and `claim-portal-enrollment-transition`. The
 * gate cannot fence those by scope alone, so each one checks the company of the record it acts on against this set
 * in its own preflight, before anything is written.
 */
export interface WorkloadAuthority {
  /** Every company an active registration of an active binding names right now, each an active company of this tenant. */
  readonly activeCompanyIds: ReadonlySet<LegalEntityId>;
  /** The workload keys of this actor's active bindings. */
  readonly workloadKeys: ReadonlySet<string>;
}

/**
 * The gate's read of the registered workload identities (O73). An unreadable registry is
 * `UNAVAILABLE` (O48), never "no bindings": an empty set would refuse a workload that really holds
 * one, which is a denial the caller could not distinguish from a missing binding.
 */
export interface AccessWorkloadBindings {
  /**
   * The keys and registered companies of this actor, read together in one transaction so a binding revoked
   * between two reads can never pair a stale key with a current company. `transaction` is a transaction the caller
   * already owns (O75): a workload decided inside an owner Action's transaction reads from that transaction. A
   * caller with no transaction leaves it out and the read opens one of its own in the request's scope.
   */
  readonly readWorkloadAuthority: (
    query: WorkloadBindingQuery,
    transaction?: CoreTransaction,
  ) => Effect.Effect<WorkloadAuthority, AccessDecisionUnavailable>;
}

/** The runtime binds the workload registry through this service tag. */
export class AccessWorkloadBindingSource extends Context.Service<AccessWorkloadBindingSource, AccessWorkloadBindings>()(
  '@app/core-runtime/access/enforcement/workload-port/AccessWorkloadBindingSource',
) {}
