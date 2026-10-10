// Generated from the pinned UltraModern API client; adapted to foundation-only Layer composition.
import { Effect, makeEffectHttpApiClient } from '@modern-js/bff-effect/effect-client';
import { Context, Layer } from 'effect';
import { taxApi, taxApiContract, taxOperationContexts } from '../../shared/api.ts';

// <generated-action-http-client-exports>
export * from './correct-tax-rule-revision-action-client.ts';
export * from './create-tax-rule-action-client.ts';
export * from './create-tax-rule-revision-action-client.ts';
export * from './declare-seller-vat-regime-action-client.ts';
export * from './end-tax-rule-revision-action-client.ts';
export * from './finalize-order-tax-action-client.ts';
// </generated-action-http-client-exports>
export * from './tax-correction-preview-client.ts';

const foundationClient = makeEffectHttpApiClient(taxApi, {
  baseUrl: taxApiContract.apiPrefix,
  requestContext: { operationContext: taxOperationContexts.readiness },
});
type FoundationClient = Effect.Success<typeof foundationClient>;
/** Foundation transport is acquired once per composed Layer lifetime. */
export class TaxFoundationClient extends Context.Service<TaxFoundationClient, FoundationClient>()(
  '@app/tax/api/tax-client/TaxFoundationClient',
) {}
export const TaxFoundationClientLive = Layer.effect(TaxFoundationClient, foundationClient);
/** This aggregate exposes readiness only; future business contracts retain their standalone clients. */
export const getTaxReadiness = TaxFoundationClient.pipe(Effect.flatMap((client) => client.foundation.readiness({})));
