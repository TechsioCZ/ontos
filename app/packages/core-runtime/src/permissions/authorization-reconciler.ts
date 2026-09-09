import { Context } from 'effect';
import type { Effect } from 'effect';
import type { AuthorizationMutationReconciliationUnavailable } from './authorization-mutation-reconciliation-error.ts';

export { AuthorizationMutationReconciliationUnavailable } from './authorization-mutation-reconciliation-error.ts';

export interface AuthorizationMutationReconciliationSummary {
  readonly examined: number;
  readonly repaired: number;
  readonly stillIndeterminate: number;
}

export interface AuthorizationMutationReconcilerService {
  readonly reconcile: (input: {
    readonly limit: number;
    readonly tenantId?: string;
  }) => Effect.Effect<
    AuthorizationMutationReconciliationSummary,
    AuthorizationMutationReconciliationUnavailable
  >;
}

export class AuthorizationMutationReconciler extends Context.Service<
  AuthorizationMutationReconciler,
  AuthorizationMutationReconcilerService
>()('@app/core-runtime/permissions/authorization-reconciler/AuthorizationMutationReconciler') {}
