import type {
  acquireDelegatedGatewayContext,
  GatewayDelegationRequest,
  GatewayDelegationSubject,
} from '@app/shared-contracts/gateway-context-server';
import { GatewayDelegationSourceError } from '@app/shared-contracts/gateway-context-server';
import { Effect } from 'effect';

export type DelegatedAcquire = typeof acquireDelegatedGatewayContext;
type IssuedContext = Effect.Success<ReturnType<DelegatedAcquire>>;

/** The Shell-issued context the shared delegated client returns to a module port. */
export const issuedDelegatedContext = (input: {
  readonly apiBaseUrl?: string;
  readonly compositionRevision: string;
  readonly token?: string;
}): IssuedContext => ({
  apiBaseUrl: input.apiBaseUrl ?? 'https://shell.example.test/owner-api',
  authorization: `Bearer ${input.token ?? 'owner-issued'}`,
  compositionRevision: input.compositionRevision,
  expiresAt: 2_000_000_000,
});

/**
 * An Originator subject, the shape asynchronous work passes to the delegated client. The synchronous ports
 * in these suites receive it only as an opaque subject. Production passes `{ _tag: 'Assertion', scope }`
 * from the request, and price-group-production-wiring.test.ts pins that call-site shape.
 */
export const originatorSubject = (compositionRevision: string, tenantId: string): GatewayDelegationSubject => ({
  _tag: 'Originator',
  actionInvocationId: '50000000-0000-4000-8000-000000000001',
  compositionRevision,
  tenantId,
});

/** Stands in for `acquireDelegatedGatewayContext`, recording each admitted request. */
export const fakeDelegatedAcquire =
  (issued: IssuedContext, requests: GatewayDelegationRequest[] = []): DelegatedAcquire =>
  (request) => {
    requests.push(request);
    return Effect.succeed(issued);
  };

/** Stands in for a Shell refusal of the delegated admission. */
export const failingDelegatedAcquire =
  (reason: string): DelegatedAcquire =>
  () =>
    Effect.fail(new GatewayDelegationSourceError({ reason }));
