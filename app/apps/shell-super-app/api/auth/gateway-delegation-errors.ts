import { Predicate, Schema } from 'effect';

export class GatewayDelegationError extends Schema.TaggedError<GatewayDelegationError>()('GatewayDelegationError', {
  cause: Schema.optionalKey(Schema.Defect()),
  /**
   * `module_not_installed`: the module the call is for is not installed (or not active) for the subject's tenant.
   * Every other refusal (an unknown or retired module credential, another release, a subject not admitted) is
   * `forbidden`.
   */
  code: Schema.Literals([
    'authentication_required',
    'forbidden',
    'module_not_installed',
    'unavailable',
    'reload_required',
  ]),
}) {}
export const delegationUnavailable = (cause?: unknown) => new GatewayDelegationError({ cause, code: 'unavailable' });
export const delegationForbidden = (cause?: unknown) =>
  new GatewayDelegationError({
    cause,
    code: Predicate.isTagged(cause, 'PrincipalResolverUnavailableError') ? 'unavailable' : 'forbidden',
  });
