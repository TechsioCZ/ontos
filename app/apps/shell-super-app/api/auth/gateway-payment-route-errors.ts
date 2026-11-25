import { Predicate, Schema } from 'effect';

export const PaymentRouteWorkloadSchema = Schema.Literals([
  'payment.provider-notification-ingress',
  'payment.provider-reconciliation',
]);
export type PaymentRouteWorkload = typeof PaymentRouteWorkloadSchema.Type;
/** Unknown, cross-tenant and cross-provider binding keys share the same not_found response. */
const PaymentRouteScopeErrorSchema = Schema.TaggedStruct('PaymentRouteScopeError', {
  cause: Schema.optionalKey(Schema.Defect()),
  code: Schema.Literals(['forbidden', 'not_found', 'unavailable']),
});
export type PaymentRouteScopeError = typeof PaymentRouteScopeErrorSchema.Type;
const scopeError = (code: PaymentRouteScopeError['code'], cause: unknown): PaymentRouteScopeError =>
  cause === undefined
    ? PaymentRouteScopeErrorSchema.make({ code })
    : PaymentRouteScopeErrorSchema.make({ cause, code });
export const forbidden = (cause?: unknown) =>
  scopeError(Predicate.isTagged(cause, 'PrincipalResolverUnavailableError') ? 'unavailable' : 'forbidden', cause);
export const notFound = (cause?: unknown) => scopeError('not_found', cause);
export const unavailable = (cause?: unknown) => scopeError('unavailable', cause);
