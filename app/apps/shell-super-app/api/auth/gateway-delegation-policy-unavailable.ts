import { Schema } from 'effect';

/** The module credential enrolment or the installed release could not be read; delegation fails closed. */
export class GatewayDelegationPolicyUnavailable extends Schema.TaggedError<GatewayDelegationPolicyUnavailable>()(
  'GatewayDelegationPolicyUnavailable',
  { cause: Schema.Defect() },
) {}
