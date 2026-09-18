import { Context, Effect } from 'effect';

export { ExternalIdentityHttpWorkloadContext, provideExternalIdentityHttpWorkload } from './workload-context.ts';
export type { ExternalIdentityHttpWorkloadContextValue } from './workload-context.ts';

export class ExternalIdentityHttpCorrelationId extends Context.Service<ExternalIdentityHttpCorrelationId, string>()(
  '@app/shell-super-app/api/auth/external-identity/request-context/ExternalIdentityHttpCorrelationId',
) {}

export const provideExternalIdentityHttpCorrelation = <Value, Failure, Requirements>(
  value: string,
  effect: Effect.Effect<Value, Failure, Requirements>,
): Effect.Effect<Value, Failure, Exclude<Requirements, ExternalIdentityHttpCorrelationId>> =>
  effect.pipe(Effect.provideContext(Context.make(ExternalIdentityHttpCorrelationId, value)));

/**
 * Request scoped projection of the already authenticated Shell workload and
 * the binding that the handler is about to admit.  The Commerce adapter reads
 * this context only for the duration of one provider call; it is never cached
 * or shared between requests.
 */
