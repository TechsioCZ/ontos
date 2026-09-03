/* eslint-disable max-classes-per-file -- The closed replay error union and its contextual service form one boundary contract. */
import { Context, Schema } from 'effect';
import type { Effect } from 'effect';

const errorFields = { reason: Schema.String };

export class GatewayAssertionReplayError extends Schema.TaggedError<GatewayAssertionReplayError>()(
  'GatewayAssertionReplayError',
  errorFields,
) {}

export class GatewayAssertionRedemptionUnavailableError extends Schema.TaggedError<GatewayAssertionRedemptionUnavailableError>()(
  'GatewayAssertionRedemptionUnavailableError',
  errorFields,
) {}

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
    input: GatewayAssertionRedemptionInput,
  ) => Effect.Effect<void, GatewayAssertionRedemptionError, never>;
}

export class GatewayAssertionRedemptionService extends Context.Service<
  GatewayAssertionRedemptionService,
  GatewayAssertionRedemption
>()('@app/core-runtime/auth/GatewayAssertionRedemptionService') {}
