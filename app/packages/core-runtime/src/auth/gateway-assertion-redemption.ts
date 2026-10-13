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

export type GatewayAssertionRedemptionError = GatewayAssertionReplayError | GatewayAssertionRedemptionUnavailableError;

export interface GatewayAssertionRedemption {
  /**
   * Records an assertion's first redemption, keyed by (issuer, audience, jti). A replay result means
   * that key was already recorded or has expired; the gateway verifier treats an already-recorded key
   * as a permitted reuse until the assertion expires.
   */
  readonly consume: (input: GatewayAssertionRedemptionInput) => Effect.Effect<void, GatewayAssertionRedemptionError>;
}

export class GatewayAssertionRedemptionService extends Context.Service<
  GatewayAssertionRedemptionService,
  GatewayAssertionRedemption
>()('@app/core-runtime/auth/gateway-assertion-redemption/GatewayAssertionRedemptionService') {}
