import { Effect, Exit, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { deriveProviderCorrelation } from '../../src/integrations/psp/psp-correlation.ts';
import { ProviderObjectRefSchema } from '../../src/integrations/psp/psp-request.ts';
import {
  makeTestDatabaseFromClient,
  testDatabaseClients,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import {
  collectInput,
  makeTestScope,
  newPaymentInput,
  paymentTestRelations,
  withPersistence,
} from './database-fixture.ts';
import { stripeEventEnvelope } from '../fixtures/stripe/stripe-events.ts';
import {
  STRIPE_FIXTURE_PAYMENT_INTENT_ID,
  stripeCheckoutSessionObject,
  stripePaymentIntentObject,
  stripeRefundObject,
} from '../fixtures/stripe/stripe-objects.ts';
import {
  credentialConfig,
  dropAfterWrite,
  recordedGatewayAdapters,
  respond,
} from '../support/psp-conformance-provider.fixture.ts';
import type { CredentialDocument, RouteScript } from '../support/psp-conformance-provider.fixture.ts';
import {
  capturedStripeNotification,
  deliverExecution,
  dispatchStateOf,
  evidenceOf,
  nativeBindingFor,
  nativeCollectionFor,
  nativeHarnessOf,
  nativeRefundFor,
  processNotification,
} from '../support/psp-native-gateway.fixture.ts';

/**
 * #1159 level 3 (native owner boundary). Boundary of every test in this file: the production gateway executor and
 * notification processor with the real C17 scoped routines (binding resolver, dispatch ledger, evidence and
 * notification stores) on native PostgreSQL, one Core-scoped runtime transaction per legal-entity step, and the
 * production adapters, `ProviderHttpLive` and `ProviderCredentialStoreLive` over a recorded HttpClient.
 *
 * Not this boundary (named per test): the Outbox claim loop (a delivery is run directly), the capture Action (its
 * stored row is inserted as it writes it; the Action itself is `psp-capture-postgres`), and the remote A8 hop
 * (Shell gateway + A8 client; issuance is the Shell native suite `payment-self-registered-workload-probe`). The
 * provider answers are documented bodies, not a provider sandbox (level 4 is NOT RUN without credentials, N13).
 */

const STRIPE_API = 'https://api.stripe.com';
const STRIPE_CREATE = `POST ${STRIPE_API}/v1/checkout/sessions`;
const STRIPE_REFUNDS = `POST ${STRIPE_API}/v1/refunds`;
const STRIPE_INTENT = `GET ${STRIPE_API}/v1/payment_intents/${STRIPE_FIXTURE_PAYMENT_INTENT_ID}`;
const STRIPE_SECRET_REF = 'stripe.native.conformance';
const GOPAY_SECRET_REF = 'gopay.native.conformance';
const STRIPE_AMOUNT = 159_950;
const RECEIVED_AT = '2026-11-12T09:00:00.000Z';

/** Joined at runtime so no key-shaped literal is committed; the prefix selects the SANDBOX environment. */
const stripeEntry = {
  family: 'STRIPE',
  secretKey: ['sk', 'test', 'c17', 'native', 'not', 'a', 'key'].join('_'),
  webhookSigningSecret: 'whsec_c17_native_not_a_secret',
};

const intentRef = Schema.decodeUnknownSync(ProviderObjectRefSchema)({
  _tag: 'STRIPE_PAYMENT_INTENT',
  id: STRIPE_FIXTURE_PAYMENT_INTENT_ID,
});

/** Production adapters over one recorded script, under the given credential document. */
const nativeHarness = Effect.gen(function* nativeHarnessEffect() {
  const { runtime: runtimeClient } = yield* testDatabaseClients;
  const database = yield* makeTestDatabaseFromClient(runtimeClient, paymentTestRelations);
  return nativeHarnessOf(database, runtimeClient, yield* makeTestScope);
});

const adaptersOver = (routes: RouteScript, credentials: CredentialDocument) =>
  recordedGatewayAdapters(routes).pipe(Effect.provide(credentialConfig(credentials)));

it.live(
  '#1157 #1158 #1159 L3-8 boundary executor+processor+ledger routines: lost Stripe create, then a notification, then a refund on the notified PaymentIntent',
  () =>
    Effect.scoped(
      Effect.gen(function* lostCreateNotificationRefund() {
        const credentials = { [STRIPE_SECRET_REF]: stripeEntry };
        const harness = yield* nativeHarness;
        const binding = yield* nativeBindingFor(harness, 'STRIPE', STRIPE_SECRET_REF);
        const collect = yield* nativeCollectionFor(harness, binding, STRIPE_AMOUNT);
        const { orderReference } = deriveProviderCorrelation(collect.operationId);

        // 1. The create reaches Stripe, but the connection drops after the write: the outcome is unknown.
        const createStep = yield* adaptersOver({ [STRIPE_CREATE]: [dropAfterWrite] }, credentials);
        const created = yield* deliverExecution(harness, collect, createStep.adapters).pipe(
          Effect.provide(credentialConfig(credentials)),
        );
        expect(Exit.isSuccess(created)).toBe(false);
        expect(yield* dispatchStateOf(harness, collect.operationId)).toEqual(
          Option.some(['OUTCOME_UNKNOWN', null, null]),
        );
        expect(createStep.callsTo(STRIPE_CREATE)).toHaveLength(1);
        const [sentCreate] = createStep.callsTo(STRIPE_CREATE);
        expect(sentCreate?.headers['idempotency-key']).toBe(
          deriveProviderCorrelation(collect.operationId).idempotencyKey,
        );

        // 2. Stripe's signed payment_intent.succeeded is captured (row as the capture Action writes it) and processed:
        //    the order reference correlates it to the unknown dispatch, and the PaymentIntent is re-read by lookup.
        const notificationId = yield* capturedStripeNotification(harness, binding, {
          body: JSON.stringify(
            stripeEventEnvelope({
              id: 'evt_c17_native_lost_create',
              object: stripePaymentIntentObject({ orderReference, status: 'succeeded' }),
              type: 'payment_intent.succeeded',
            }),
          ),
          eventId: 'evt_c17_native_lost_create',
          receivedAt: RECEIVED_AT,
          refs: [intentRef],
        });
        const lookupStep = yield* adaptersOver(
          {
            [STRIPE_INTENT]: [
              respond(200, JSON.stringify(stripePaymentIntentObject({ orderReference, status: 'succeeded' }))),
            ],
          },
          credentials,
        );
        const processed = yield* processNotification(harness, notificationId, lookupStep.adapters).pipe(
          Effect.provide(credentialConfig(credentials)),
        );
        expect(processed.result).toBe(`SETTLED ${collect.operationId} SUBMITTED [ACCEPTED]`);
        expect(processed.statements.map(({ factKind, operationId }) => [operationId, factKind])).toEqual([
          [collect.operationId, 'COLLECTION_CONFIRMED'],
        ]);
        // Only the lookup read reached Stripe; the notification never caused a mutation.
        expect(lookupStep.sent.map(({ route }) => route)).toEqual([STRIPE_INTENT]);
        expect(yield* dispatchStateOf(harness, collect.operationId)).toEqual(
          Option.some(['ACKNOWLEDGED', null, `STRIPE_PAYMENT_INTENT:${STRIPE_FIXTURE_PAYMENT_INTENT_ID}`]),
        );

        // 3. A later REFUND of the collection names the PaymentIntent the notification proved, with the exact amount.
        const refund = yield* nativeRefundFor(harness, binding, collect, 50_000);
        const refundStep = yield* adaptersOver(
          {
            [STRIPE_REFUNDS]: [
              respond(
                200,
                JSON.stringify(
                  stripeRefundObject({
                    orderReference: deriveProviderCorrelation(refund.operationId).orderReference,
                    status: 'pending',
                  }),
                ),
              ),
            ],
          },
          credentials,
        );
        const refunded = yield* deliverExecution(harness, refund, refundStep.adapters).pipe(
          Effect.provide(credentialConfig(credentials)),
        );
        expect(Exit.isSuccess(refunded)).toBe(true);
        expect(refundStep.sent.map(({ route }) => route)).toEqual([STRIPE_REFUNDS]);
        const form = new URLSearchParams(refundStep.sent[0]?.body ?? '');
        expect([form.get('payment_intent'), form.get('amount')]).toEqual([STRIPE_FIXTURE_PAYMENT_INTENT_ID, '50000']);
        expect((yield* dispatchStateOf(harness, refund.operationId)).pipe(Option.map(([state]) => state))).toEqual(
          Option.some('ACKNOWLEDGED'),
        );
        // Exactly one collection mutation was ever sent: no blind resend and no competing new collection.
        expect(createStep.callsTo(STRIPE_CREATE)).toHaveLength(1);
        expect(refundStep.callsTo(STRIPE_CREATE)).toEqual([]);
      }),
    ),
);

it.live(
  '#1154 #1158 #1159 L3-11 boundary executor+ledger routines+live credential store: a broken GoPay credential leaves Stripe and a non-gateway Payment working',
  () =>
    Effect.scoped(
      Effect.gen(function* brokenGopayCredential() {
        // The GoPay entry has no client secret; the Stripe entry is valid.
        const credentials = {
          [GOPAY_SECRET_REF]: { clientId: 'gopay-client-native', family: 'GOPAY' },
          [STRIPE_SECRET_REF]: stripeEntry,
        };
        const harness = yield* nativeHarness;
        const gopayBinding = yield* nativeBindingFor(harness, 'GOPAY', GOPAY_SECRET_REF);
        const stripeBinding = yield* nativeBindingFor(harness, 'STRIPE', STRIPE_SECRET_REF);
        const gopay = yield* nativeCollectionFor(harness, gopayBinding, 10_000);
        const stripe = yield* nativeCollectionFor(harness, stripeBinding, STRIPE_AMOUNT);
        const provider = yield* adaptersOver(
          {
            [STRIPE_CREATE]: [
              respond(
                200,
                JSON.stringify(
                  stripeCheckoutSessionObject({
                    orderReference: deriveProviderCorrelation(stripe.operationId).orderReference,
                    paymentIntent: null,
                    paymentStatus: 'unpaid',
                    status: 'open',
                  }),
                ),
              ),
            ],
          },
          credentials,
        );

        const gopayExit = yield* deliverExecution(harness, gopay, provider.adapters).pipe(
          Effect.provide(credentialConfig(credentials)),
        );
        const stripeExit = yield* deliverExecution(harness, stripe, provider.adapters).pipe(
          Effect.provide(credentialConfig(credentials)),
        );

        // GoPay: the credential never resolves, so nothing reaches GoPay and no provider effect is claimed.
        expect(provider.sent.filter(({ route }) => route.includes('gopay.com'))).toEqual([]);
        expect(Exit.isSuccess(gopayExit)).toBe(true);
        expect((yield* dispatchStateOf(harness, gopay.operationId)).pipe(Option.map(([state]) => state))).toEqual(
          Option.some('REJECTED_BEFORE_EFFECT'),
        );
        expect((yield* evidenceOf(harness, gopay.paymentId)).map(([, factKind]) => factKind)).not.toContain(
          'COLLECTION_CONFIRMED',
        );
        // Stripe: its own binding and credential suffice; GoPay is not a dependency and nothing is rerouted.
        expect(Exit.isSuccess(stripeExit)).toBe(true);
        expect((yield* dispatchStateOf(harness, stripe.operationId)).pipe(Option.map(([state]) => state))).toEqual(
          Option.some('ACKNOWLEDGED'),
        );
        expect(provider.sent.map(({ route }) => route)).toEqual([STRIPE_CREATE]);

        // A non-gateway (bank transfer) Payment in the same scope is created and collected without any provider.
        const bankInput = yield* newPaymentInput(harness.scope, 25_000);
        const bank = yield* withPersistence(harness.database, harness.scope, (persistence) =>
          persistence.insertPayment({
            ...bankInput,
            executionBinding: { _tag: 'BANK_ACCOUNTING_RECEIPT' },
            method: 'BANK_TRANSFER_ADVANCE',
          }),
        );
        const bankCollect = yield* collectInput(
          harness.scope,
          { amountMinor: 25_000, paymentId: bank.record.paymentId },
          'collect-1',
        );
        const bankOperation = yield* withPersistence(harness.database, harness.scope, (persistence) =>
          persistence.insertOperation({ ...bankCollect, binding: { _tag: 'BANK_ACCOUNTING_RECEIPT' } }),
        );
        expect(bankOperation.record.outcome).toBe('PENDING');
        expect(yield* dispatchStateOf(harness, bankOperation.record.operationId)).toEqual(Option.none());
        expect(provider.sent).toHaveLength(1);
      }),
    ),
);
