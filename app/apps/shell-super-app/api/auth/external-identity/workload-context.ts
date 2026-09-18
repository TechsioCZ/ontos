import type { TrustedPrincipalContext } from '@app/core-runtime';
import { Context, Effect } from 'effect';

import type { ExternalIdentityWorkloadOperation } from './configuration.ts';

/**
 * Request scoped projection of the already authenticated Shell workload and
 * the binding that the handler is about to admit. The Commerce adapter reads
 * this context only for the duration of one provider call; it is never cached
 * or shared between requests.
 */
export interface ExternalIdentityHttpWorkloadContextValue {
  readonly authenticationRef: string;
  readonly binding?: {
    readonly authBindingId: string;
    readonly bindingRevision: number;
    readonly principalId: string;
  };
  readonly operation: ExternalIdentityWorkloadOperation;
  readonly principal: TrustedPrincipalContext;
  readonly providerSubjectId: string;
  readonly targetAudience?: string;
  readonly targetAuthenticationNamespaceId?: string;
}

export class ExternalIdentityHttpWorkloadContext extends Context.Service<
  ExternalIdentityHttpWorkloadContext,
  ExternalIdentityHttpWorkloadContextValue
>()('@app/shell-super-app/api/auth/external-identity/workload-context/ExternalIdentityHttpWorkloadContext') {}

export const provideExternalIdentityHttpWorkload = <Value, Failure, Requirements>(
  value: ExternalIdentityHttpWorkloadContextValue,
  effect: Effect.Effect<Value, Failure, Requirements>,
): Effect.Effect<Value, Failure, Exclude<Requirements, ExternalIdentityHttpWorkloadContext>> =>
  effect.pipe(Effect.provideContext(Context.make(ExternalIdentityHttpWorkloadContext, value)));
