import { NodeCrypto } from '@effect/platform-node';
import { ConfigProvider, Context, Effect, Layer, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { paymentProductionOwnerPortsLive } from '../../api/payment-production-layers.ts';
import { GatewayCredentialSecretRefSchema } from '../../shared/domain/psp-configuration.ts';
import { ComgatePaymentService } from '../../src/integrations/comgate/comgate-payment.service.ts';
import { GopayPaymentService } from '../../src/integrations/gopay/gopay-payment.service.ts';
import { ProviderCredentialStore } from '../../src/integrations/psp/credentials.ts';
import { GatewayProviderAdaptersLive } from '../../src/integrations/psp/gateway-adapters-live.ts';
import { gatewayBindingServiceForTransaction } from '../../src/integrations/psp/gateway-binding-live.ts';
import { GatewayProviderAdapters } from '../../src/integrations/psp/psp-adapter.ts';
import { GatewayProviderUnavailable } from '../../src/integrations/psp/psp-errors.ts';
import { providerReplayEvidenceForTransaction } from '../../src/integrations/psp/replay-guarantee-live.ts';
import { StripePaymentService } from '../../src/integrations/stripe/stripe-payment.service.ts';
import { GatewayBindingPort } from '../../src/ports/gateway-binding-port.ts';
import { PaymentProviderReplayEvidencePort } from '../../src/ports/provider-replay-evidence-port.ts';
import { gatewayProviderServicesLive, providerSeamLive } from '../../src/worker-host/entry.ts';

/**
 * #1146 production assembly: the composition roots wire the live C17 gateway ports, not the C16
 * placeholders, and nothing in them reads `ONTOS_PAYMENT_PROVIDER_CREDENTIALS` while the layers build.
 * Without the variable every gateway call is a typed UNAVAILABLE and the rest of Payment keeps running.
 */

const withoutProviderCredentials = ConfigProvider.layer(ConfigProvider.fromUnknown({}));

/** The worker host's provider services together with the adapter registry over them. */
const workerGatewayLive = GatewayProviderAdaptersLive.pipe(Layer.provideMerge(gatewayProviderServicesLive));

describe('#1146 C17 production assembly', () => {
  it.effect('#1146 Production layers provide real gateway ports', () =>
    Effect.gen(function* realGatewayPorts() {
      // Action and Read service factories bind Payment's own Gateway Enablement to their transaction.
      const owners = yield* Layer.build(paymentProductionOwnerPortsLive.pipe(Layer.provide(NodeCrypto.layer)));
      expect(Context.get(owners, GatewayBindingPort)).toBe(gatewayBindingServiceForTransaction);
      // The recovery Action reads C17's retained dispatch ledger in its own transaction.
      expect(yield* PaymentProviderReplayEvidencePort).toBe(providerReplayEvidenceForTransaction);

      // The worker host maps each family to exactly its own live provider service.
      const worker = yield* Layer.build(workerGatewayLive);
      const adapters = Context.get(worker, GatewayProviderAdapters);
      const resolved = yield* Effect.all(
        [adapters.forFamily('COMGATE'), adapters.forFamily('GOPAY'), adapters.forFamily('STRIPE')],
        { concurrency: 1 },
      );
      expect(resolved).toEqual([
        Context.get(worker, ComgatePaymentService),
        Context.get(worker, GopayPaymentService),
        Context.get(worker, StripePaymentService),
      ]);
      expect(resolved.map((adapter) => adapter.family)).toEqual(['COMGATE', 'GOPAY', 'STRIPE']);
    }).pipe(Effect.scoped, Effect.provide(withoutProviderCredentials)),
  );

  it.effect('#1146 The layers build without ONTOS_PAYMENT_PROVIDER_CREDENTIALS and gateways are unavailable', () =>
    Effect.gen(function* buildsWithoutCredentials() {
      yield* Layer.build(workerGatewayLive);
      yield* Layer.build(paymentProductionOwnerPortsLive.pipe(Layer.provide(NodeCrypto.layer)));
      const seam = yield* Layer.build(providerSeamLive);
      const secretRef = Schema.decodeUnknownSync(GatewayCredentialSecretRefSchema)('stripe.main');
      const failure = yield* Context.get(seam, ProviderCredentialStore)
        .resolve({ family: 'STRIPE', secretRef })
        .pipe(Effect.flip);
      expect(Schema.is(GatewayProviderUnavailable)(failure)).toBe(true);
      expect(failure).toMatchObject({ family: 'STRIPE', reason: 'credentials_unavailable' });
    }).pipe(Effect.scoped, Effect.provide(withoutProviderCredentials)),
  );
});
