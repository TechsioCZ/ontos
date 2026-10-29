import { Data } from 'effect';

export class GatewayRelayExchangeUnavailable extends Data.TaggedError('GatewayRelayExchangeUnavailable')<{
  readonly cause: unknown;
  readonly reason: string;
}> {}
