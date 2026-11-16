import { describe, expect, it } from 'effect-rstest';
import { Cause, ConfigProvider, Effect, Layer, Match, Redacted, Schema } from 'effect';
import { TestClock } from 'effect/testing';

import type { PaymentGatewayProviderFamilySchema } from '../../shared/domain/payment-vocabulary.ts';
import { GatewayCredentialSecretRefSchema } from '../../shared/domain/psp-configuration.ts';
import { ProviderCredentialStore } from '../../src/integrations/psp/credentials.ts';
import type { ProviderCredentialMaterial } from '../../src/integrations/psp/credentials.ts';
import { ProviderCredentialStoreLive } from '../../src/integrations/psp/credentials-live.ts';

const CREDENTIALS_VARIABLE = 'ONTOS_PAYMENT_PROVIDER_CREDENTIALS';

const GOPAY_SECRET = 'gopay-client-secret-value-1';
const STRIPE_SECRET_KEY = 'stripe-secret-key-fixture-1';
const STRIPE_WEBHOOK_SECRET = 'stripe-webhook-fixture-1';
const COMGATE_SECRET = 'comgate-secret-value-1';

const gopayRef = Schema.decodeUnknownSync(GatewayCredentialSecretRefSchema)('gopay.main');
const stripeRef = Schema.decodeUnknownSync(GatewayCredentialSecretRefSchema)('stripe.main');
const comgateRef = Schema.decodeUnknownSync(GatewayCredentialSecretRefSchema)('comgate.main');
const unknownRef = Schema.decodeUnknownSync(GatewayCredentialSecretRefSchema)('absent.ref');

const gopayEntry = { clientId: 'gopay-client-id', clientSecret: GOPAY_SECRET, family: 'GOPAY' };
const stripeEntry = {
  family: 'STRIPE',
  secretKey: STRIPE_SECRET_KEY,
  webhookSigningSecret: STRIPE_WEBHOOK_SECRET,
};
const comgateEntry = { family: 'COMGATE', secret: COMGATE_SECRET };

const encodeDocument = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const withVariable = (value: string) =>
  ConfigProvider.layer(ConfigProvider.fromUnknown({ [CREDENTIALS_VARIABLE]: value }));
const withDocument = (document: Readonly<Record<string, Schema.Json>>) => withVariable(encodeDocument(document));
const withoutVariable = ConfigProvider.layer(ConfigProvider.fromUnknown({}));

const resolve = (family: typeof PaymentGatewayProviderFamilySchema.Type, secretRef: typeof gopayRef) =>
  Effect.gen(function* resolveCredential() {
    const store = yield* ProviderCredentialStore;
    return yield* store.resolve({ family, secretRef });
  });

const secretsOf = (material: ProviderCredentialMaterial) =>
  Match.value(material).pipe(
    Match.tagsExhaustive({
      COMGATE: ({ secret }) => [Redacted.value(secret)],
      GOPAY: ({ clientId, clientSecret }) => [clientId, Redacted.value(clientSecret)],
      STRIPE: ({ secretKey, webhookSigningSecret }) => [
        Redacted.value(secretKey),
        Redacted.value(webhookSigningSecret),
      ],
    }),
  );

const ALL_SECRETS = [GOPAY_SECRET, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, COMGATE_SECRET];

describe('#1155 PSP provider credential store', () => {
  it.effect('the Layer builds when the credential variable is absent', () =>
    Effect.gen(function* layerBuildsWithoutVariable() {
      const failure = yield* resolve('GOPAY', gopayRef).pipe(Effect.flip);
      expect(failure).toMatchObject({
        code: 'gateway_provider_unavailable',
        family: 'GOPAY',
        reason: 'credentials_unavailable',
      });
    }).pipe(Effect.provide(ProviderCredentialStoreLive), Effect.provide(withoutVariable)),
  );

  it.effect('#1155 Missing credential configuration is UNAVAILABLE for that operation only', () =>
    Effect.gen(function* missingConfigurationIsPerOperation() {
      const missing = yield* resolve('STRIPE', stripeRef).pipe(Effect.provide(withoutVariable), Effect.flip);
      expect(missing).toMatchObject({ family: 'STRIPE', reason: 'credentials_unavailable' });

      // The failure is not remembered: the next operation with configuration succeeds at once.
      const resolved = yield* resolve('STRIPE', stripeRef).pipe(
        Effect.provide(withDocument({ [stripeRef]: stripeEntry })),
      );
      expect(secretsOf(resolved)).toEqual([STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET]);

      const unknown = yield* resolve('STRIPE', unknownRef).pipe(
        Effect.provide(withDocument({ [stripeRef]: stripeEntry })),
        Effect.flip,
      );
      expect(unknown).toMatchObject({ family: 'STRIPE', reason: 'credential_ref_unknown' });

      const malformed = yield* resolve('COMGATE', comgateRef).pipe(
        Effect.provide(withVariable('{"comgate.main":')),
        Effect.flip,
      );
      expect(malformed).toMatchObject({ family: 'COMGATE', reason: 'credentials_malformed' });
    }).pipe(Effect.provide(ProviderCredentialStoreLive)),
  );

  it.effect('#1154 A healthy GoPay operation does not require unrelated Stripe/Comgate credentials', () =>
    Effect.gen(function* gopayWithoutOtherFamilies() {
      const material = yield* resolve('GOPAY', gopayRef);
      expect(secretsOf(material)).toEqual(['gopay-client-id', GOPAY_SECRET]);
    }).pipe(
      Effect.provide(ProviderCredentialStoreLive),
      Effect.provide(withDocument({ [gopayRef]: gopayEntry, [stripeRef]: 'not an entry' })),
    ),
  );

  it.effect('#1158 A malformed GoPay entry leaves Stripe resolution working', () =>
    Effect.gen(function* malformedGopayLeavesStripe() {
      const gopay = yield* resolve('GOPAY', gopayRef).pipe(Effect.flip);
      expect(gopay).toMatchObject({ family: 'GOPAY', reason: 'credential_entry_invalid' });

      const stripe = yield* resolve('STRIPE', stripeRef);
      expect(secretsOf(stripe)).toEqual([STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET]);
      const comgate = yield* resolve('COMGATE', comgateRef);
      expect(secretsOf(comgate)).toEqual([COMGATE_SECRET]);
    }).pipe(
      Effect.provide(ProviderCredentialStoreLive),
      Effect.provide(
        withDocument({
          [comgateRef]: comgateEntry,
          [gopayRef]: { clientId: 'gopay-client-id', family: 'GOPAY' },
          [stripeRef]: stripeEntry,
        }),
      ),
    ),
  );

  it.effect('an entry of another family, an extra field or an empty secret is an invalid entry', () =>
    Effect.gen(function* invalidEntries() {
      const wrongFamily = yield* resolve('GOPAY', stripeRef).pipe(Effect.flip);
      expect(wrongFamily).toMatchObject({ family: 'GOPAY', reason: 'credential_entry_invalid' });

      const extra = yield* resolve('COMGATE', comgateRef).pipe(Effect.flip);
      expect(extra).toMatchObject({ family: 'COMGATE', reason: 'credential_entry_invalid' });

      const empty = yield* resolve('GOPAY', gopayRef).pipe(Effect.flip);
      expect(empty).toMatchObject({ family: 'GOPAY', reason: 'credential_entry_invalid' });
    }).pipe(
      Effect.provide(ProviderCredentialStoreLive),
      Effect.provide(
        withDocument({
          [comgateRef]: { ...comgateEntry, merchant: 'extra' },
          [gopayRef]: { ...gopayEntry, clientSecret: '' },
          [stripeRef]: stripeEntry,
        }),
      ),
    ),
  );

  it.effect('secrets never appear in error text', () =>
    Effect.gen(function* secretsStayHidden() {
      const failures = yield* Effect.forEach(
        [
          withDocument({ [gopayRef]: { ...gopayEntry, family: 'STRIPE' } }),
          withDocument({ [gopayRef]: { clientSecret: GOPAY_SECRET, family: 'GOPAY' } }),
          withVariable(`{"${gopayRef}": {"clientSecret": "${GOPAY_SECRET}", "family": "GOPAY",}`),
          withDocument({ [comgateRef]: comgateEntry, [stripeRef]: stripeEntry }),
        ],
        (configuration) => resolve('GOPAY', gopayRef).pipe(Effect.provide(configuration), Effect.flip),
      );
      for (const failure of failures) {
        const text = `${Cause.pretty(Cause.fail(failure))} ${JSON.stringify(failure)} ${failure.reason}`;
        for (const secret of ALL_SECRETS) {
          expect(text).not.toContain(secret);
        }
      }
      const material = yield* resolve('STRIPE', stripeRef).pipe(
        Effect.provide(withDocument({ [stripeRef]: stripeEntry })),
      );
      const shown = JSON.stringify(material);
      for (const secret of ALL_SECRETS) {
        expect(shown).not.toContain(secret);
      }
    }).pipe(Effect.provide(ProviderCredentialStoreLive)),
  );

  it.effect('a rotated entry is picked up once the short cache window passes', () =>
    Effect.gen(function* rotationAfterCacheWindow() {
      const rotated = { ...comgateEntry, secret: 'comgate-secret-value-2' };
      const first = yield* resolve('COMGATE', comgateRef).pipe(
        Effect.provide(withDocument({ [comgateRef]: comgateEntry })),
      );
      expect(secretsOf(first)).toEqual([COMGATE_SECRET]);

      const cached = yield* resolve('COMGATE', comgateRef).pipe(
        Effect.provide(withDocument({ [comgateRef]: rotated })),
      );
      expect(secretsOf(cached)).toEqual([COMGATE_SECRET]);

      yield* TestClock.adjust('61 seconds');
      const refreshed = yield* resolve('COMGATE', comgateRef).pipe(
        Effect.provide(withDocument({ [comgateRef]: rotated })),
      );
      expect(secretsOf(refreshed)).toEqual(['comgate-secret-value-2']);
    }).pipe(Effect.provide(ProviderCredentialStoreLive)),
  );

  it.effect('building the Layer never reads the credential variable', () =>
    Effect.gen(function* layerConstructionIsLazy() {
      const context = yield* Layer.build(ProviderCredentialStoreLive).pipe(Effect.provide(withVariable('not json')));
      expect(context).toBeDefined();
    }).pipe(Effect.scoped),
  );
});
