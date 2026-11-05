import { Predicate, Schema } from 'effect';

export class GatewayDelegationError extends Schema.TaggedError<GatewayDelegationError>()('GatewayDelegationError', {
  cause: Schema.optionalKey(Schema.Defect()),
  code: Schema.Literals(['authentication_required', 'forbidden', 'unavailable', 'reload_required']),
}) {}
export const delegationUnavailable = (cause?: unknown) => new GatewayDelegationError({ cause, code: 'unavailable' });
export const delegationForbidden = (cause?: unknown) =>
  new GatewayDelegationError({
    cause,
    code: Predicate.isTagged(cause, 'PrincipalResolverUnavailableError') ? 'unavailable' : 'forbidden',
  });
