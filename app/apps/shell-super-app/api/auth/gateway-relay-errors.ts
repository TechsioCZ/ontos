import { Predicate, Schema } from 'effect';

export class GatewayRelayError extends Schema.TaggedError<GatewayRelayError>()('GatewayRelayError', {
  cause: Schema.optionalKey(Schema.Defect()),
  code: Schema.Literals(['authentication_required', 'forbidden', 'unavailable', 'reload_required']),
}) {}
export const relayUnavailable = (cause?: unknown) => new GatewayRelayError({ cause, code: 'unavailable' });
export const relayForbidden = (cause?: unknown) =>
  new GatewayRelayError({
    cause,
    code: Predicate.isTagged(cause, 'PrincipalResolverUnavailableError') ? 'unavailable' : 'forbidden',
  });
