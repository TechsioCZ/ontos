// Generated from the pinned UltraModern API client; adapted to foundation-only Layer composition.
import { Effect, makeEffectHttpApiClient } from '@modern-js/bff-effect/effect-client';
import { Context, Layer } from 'effect';
import { availabilityApi, availabilityApiContract, availabilityOperationContexts } from '../../shared/api.ts';

const foundationClient = makeEffectHttpApiClient(availabilityApi, {
  baseUrl: availabilityApiContract.apiPrefix,
  requestContext: { operationContext: availabilityOperationContexts.readiness },
});
type FoundationClient = Effect.Success<typeof foundationClient>;
/** Foundation transport is acquired once per composed Layer lifetime. */
export class AvailabilityFoundationClient extends Context.Service<AvailabilityFoundationClient, FoundationClient>()(
  '@app/availability/api/availability-client/AvailabilityFoundationClient',
) {}
export const AvailabilityFoundationClientLive = Layer.effect(AvailabilityFoundationClient, foundationClient);
/** This aggregate exposes readiness only; future business contracts retain their standalone clients. */
export const getAvailabilityReadiness = AvailabilityFoundationClient.pipe(
  Effect.flatMap((client) => client.foundation.readiness({})),
);
