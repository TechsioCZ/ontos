import { Data } from 'effect';

export class GatewayDelegationExchangeUnavailable extends Data.TaggedError('GatewayDelegationExchangeUnavailable')<{
  readonly cause: unknown;
  readonly reason: string;
}> {}
