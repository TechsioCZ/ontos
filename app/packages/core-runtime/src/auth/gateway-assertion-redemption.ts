import { Context } from 'effect';
import type { Effect } from 'effect';

import type { GatewayAssertionRedemptionUnavailableError } from './gateway-assertion-redemption-unavailable-error.ts';
import type { GatewayAssertionReplayError } from './gateway-assertion-replay-error.ts';

export { GatewayAssertionRedemptionUnavailableError } from './gateway-assertion-redemption-unavailable-error.ts';
export { GatewayAssertionReplayError } from './gateway-assertion-replay-error.ts';

export interface GatewayAssertionRedemptionInput {
  readonly audience: string;
  readonly expiresAtEpochSeconds: number;
  readonly issuer: string;
  readonly jti: string;
}

export type GatewayAssertionRedemptionError =
  | GatewayAssertionReplayError
  | GatewayAssertionRedemptionUnavailableError;

export interface GatewayAssertionRedemption {
  readonly consume: (
    input: GatewayAssertionRedemptionInput
  ) => Effect.Effect<void, GatewayAssertionRedemptionError>;
}

export class GatewayAssertionRedemptionService extends Context.Service<
  GatewayAssertionRedemptionService,
  GatewayAssertionRedemption
>()(
  '@app/core-runtime/auth/gateway-assertion-redemption/GatewayAssertionRedemptionService'
) {}
