import {
  ActionPermissionDenied,
  ModuleStateDeniedError,
  OperationContextDenied,
  OperationContextInvalid,
  ReadPermissionDenied,
} from '@app/core-runtime';
import { Crypto, Effect, Schema } from 'effect';

import { CustomerPortalOwnSessionSchema } from '../../../shared/portal-auth/own-session.ts';
import type { CustomerPortalOwnSession } from '../../../shared/portal-auth/own-session.ts';
import type { admitCustomerAccount } from '../session/http.ts';

/** The receiving deployment of every portal self-service read and Action: this Customer Context unit. */
export const OWN_PORTAL_AUDIENCE = 'commerce-customer-context';

type Admission = Effect.Success<ReturnType<typeof admitCustomerAccount>>;
/** A portal session the route admitted from its cookie: the account, its customer authority and the workload. */
export type AdmittedPortalCustomer = Extract<Admission, { readonly state: 'authenticated' }>;

/**
 * The admitted session's own account, exactly as the route admitted it: the binding, the customer principal and the
 * Party its customer authority resolved, and the provider subject of the live session. This is the only source of the
 * Party a portal read or Action addresses.
 */
export const ownSessionOf = Effect.fn('CustomerOwnPortal.session')(function* ownSessionOf<Failure>(
  current: AdmittedPortalCustomer,
  unavailable: () => Failure,
) {
  const session: CustomerPortalOwnSession = yield* Schema.decodeEffect(CustomerPortalOwnSessionSchema)({
    authBindingId: current.customerAuthority.authBindingId,
    customerPrincipalId: current.customerAuthority.principalId,
    partyId: current.customerAuthority.partyId,
    providerSubjectId: current.session.providerSubjectId,
  }).pipe(Effect.mapError(unavailable));
  return session;
});

/** Refusals the route answers with its 403: the gate, the owner rule, the trusted scope or the module state. */
export const isOwnPortalRefusal = Schema.is(
  Schema.Union([
    ActionPermissionDenied,
    ModuleStateDeniedError,
    OperationContextDenied,
    OperationContextInvalid,
    ReadPermissionDenied,
  ]),
);

/**
 * One portal request's correlation and idempotency key. The storefronts send no idempotency key on these routes, and
 * none of their inputs makes a replay safe (a password change has no stable input at all), so each request is its own
 * invocation: a retried request is decided and run again, exactly as before, and never answered from a stored one.
 */
export const ownPortalTransport = Effect.fn('CustomerOwnPortal.transport')(function* ownPortalTransport<Failure>(
  unavailable: () => Failure,
) {
  const crypto = yield* Crypto.Crypto;
  const correlationId = yield* crypto.randomUUIDv4().pipe(Effect.mapError(unavailable));
  const idempotencyKey = yield* crypto.randomUUIDv4().pipe(Effect.mapError(unavailable));
  return { correlationId, idempotencyKey };
});
