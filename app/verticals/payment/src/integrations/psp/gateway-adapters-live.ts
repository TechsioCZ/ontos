import { Effect, Layer, Match } from 'effect';

import { ComgatePaymentService, ComgatePaymentServiceLive } from '../comgate/comgate-payment.service.ts';
import { GopayPaymentService, GopayPaymentServiceLive } from '../gopay/gopay-payment.service.ts';
import { StripePaymentService, StripePaymentServiceLive } from '../stripe/stripe-payment.service.ts';
import { GatewayProviderAdapters } from './psp-adapter.ts';
import type { GatewayProviderAdaptersContract } from './psp-adapter.ts';

/** Exactly one adapter per gateway family; there is no cross-family fallback. */
export const GatewayProviderAdaptersLive = Layer.effect(
  GatewayProviderAdapters,
  Effect.gen(function* makeGatewayProviderAdapters() {
    const comgate = yield* ComgatePaymentService;
    const gopay = yield* GopayPaymentService;
    const stripe = yield* StripePaymentService;
    return {
      forFamily: (family) =>
        Effect.succeed(
          Match.value(family).pipe(
            Match.when('COMGATE', () => comgate),
            Match.when('GOPAY', () => gopay),
            Match.when('STRIPE', () => stripe),
            Match.exhaustive,
          ),
        ),
    } satisfies GatewayProviderAdaptersContract;
  }),
);

/**
 * The three provider services. They require `ProviderHttp` and `ProviderCredentialStore`; GoPay also
 * requires the per-process `GopayOAuthToken` cache, which composition roots build once from
 * `GopayOAuthTokenLive` over the same HTTP seam and credential store.
 */
export const GatewayProviderServicesLive = Layer.mergeAll(
  ComgatePaymentServiceLive,
  GopayPaymentServiceLive,
  StripePaymentServiceLive,
);
