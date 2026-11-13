import { readFileSync } from 'node:fs';

import type { OutboxPayload } from '@app/payment/outbox/payment-core-operation-requested-v1';
import { DateTime, Effect, Exit, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { deriveProviderCorrelation } from '../../src/integrations/psp/psp-correlation.ts';
import { ProviderObjectRefSchema } from '../../src/integrations/psp/psp-request.ts';
import { pspPayerContactPersistenceForTransaction } from '../../src/persistence/psp-payer-contact-persistence.ts';
import type { PaymentPayerContact } from '../../shared/domain/payment-payer-contact.ts';
import { installOperationalScope } from '../../../../packages/core-runtime/src/db/scoped-transaction.ts';
import {
  makeTestDatabaseFromClient,
  testDatabaseClients,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import {
  collectInput,
  inScope,
  makeTestScope,
  newPaymentInput,
  operationalScopeOf,
  paymentTestRelations,
  withPersistence,
} from './database-fixture.ts';
import { stripeEventEnvelope } from '../fixtures/stripe/stripe-events.ts';
import {
  GOPAY_FIXTURE_GOID,
  GOPAY_FIXTURE_PAYMENT_ID,
  gopayConflictBody,
  gopayCreateResponseBody,
  gopayPaymentBody,
} from '../fixtures/gopay/payment-responses.ts';
import { GOPAY_FIXTURE_REFUND_ID, gopayRefundBody } from '../fixtures/gopay/refund-responses.ts';
import {
  STRIPE_FIXTURE_PAYMENT_INTENT_ID,
  STRIPE_FIXTURE_SESSION_ID,
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
  dispatchRecordOf,
  dispatchStateOf,
  evidenceOf,
  NATIVE_RETURN_URL,
  nativeAccountFor,
  nativeBindingFor,
  nativeCancellationFor,
  nativeConfigureEnablement,
  nativeCollectionFor,
  nativeHarnessOf,
  nativeRefundFor,
  nativeRetireBinding,
  processNotification,
  reprepareDispatch,
} from '../support/psp-native-gateway.fixture.ts';
import type { NativeBinding, NativeFamily, NativeHarness } from '../support/psp-native-gateway.fixture.ts';

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
const STRIPE_EXPIRE = `POST ${STRIPE_API}/v1/checkout/sessions/${STRIPE_FIXTURE_SESSION_ID}/expire`;
const STRIPE_SECRET_REF = 'stripe.native.conformance';
const GOPAY_SECRET_REF = 'gopay.native.conformance';
/** GoPay Payments API v4 (https://api-docs.gopay.com/llms-full.txt), sandbox root. */
const GOPAY_API = 'https://gw.sandbox.gopay.com/gp-gw/api/4.0';
const GOPAY_TOKEN = `POST ${GOPAY_API}/oauth2/token`;
const GOPAY_CREATE = `POST ${GOPAY_API}/eshops/${GOPAY_FIXTURE_GOID}/payments`;
const GOPAY_PAYMENT = `GET ${GOPAY_API}/payments/${GOPAY_FIXTURE_PAYMENT_ID}`;
const GOPAY_CANCEL = `DELETE ${GOPAY_API}/payments/${GOPAY_FIXTURE_PAYMENT_ID}`;
const GOPAY_REFUND = `POST ${GOPAY_API}/payments/${GOPAY_FIXTURE_PAYMENT_ID}/refunds`;
const GOPAY_AMOUNT = 10_000;
const COMGATE_SECRET_REF = 'comgate.native.conformance';
const COMGATE_SECRET = 'comgate-shop-secret-c17-native';
const COMGATE_API = 'https://payments.comgate.cz';
const COMGATE_TRANS_ID = 'AB12-CD34-EF56';
const COMGATE_CREATE = `POST ${COMGATE_API}/v2.0/payment.json`;
const COMGATE_STATUS = `GET ${COMGATE_API}/v2.0/payment/transId/${COMGATE_TRANS_ID}.json`;
const COMGATE_CANCEL = `DELETE ${COMGATE_API}/v2.0/payment/transId/${COMGATE_TRANS_ID}.json`;
const COMGATE_REFUND = `POST ${COMGATE_API}/v2.0/refund.json`;
const COMGATE_AMOUNT = 10_000;
const STRIPE_AMOUNT = 159_950;
const RECEIVED_AT = '2026-11-12T09:00:00.000Z';

/** Joined at runtime so no key-shaped literal is committed; the prefix selects the SANDBOX environment. */
const stripeEntry = {
  family: 'STRIPE',
  secretKey: ['sk', 'test', 'c17', 'native', 'not', 'a', 'key'].join('_'),
  webhookSigningSecret: 'whsec_c17_native_not_a_secret',
};

const gopayEntry = { clientId: 'gopay-client-native', clientSecret: 'gopay-secret-native-c17', family: 'GOPAY' };
const comgateEntry = { family: 'COMGATE', secret: COMGATE_SECRET };
const gopayToken = respond(
  200,
  '{"token_type":"bearer","access_token":"gopay-access-token-native","scope":"payment:read payment:write","expires_in":900}',
);

const comgateFixture = (name: string) => readFileSync(new URL(`../fixtures/comgate/${name}`, import.meta.url), 'utf-8');
/** The documented Comgate status answer for the collection with order reference `refId`. */
const comgateStatus = (refId: string, status: string) =>
  respond(
    200,
    JSON.stringify({
      ...Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)))(
        comgateFixture('status-paid.json'),
      ),
      refId,
      status,
      test: 'true',
    }),
  );

/**
 * The payer contact each family's collection Action input must carry (plan D-P3): Comgate a full name and an email,
 * GoPay only an email (v4 `customer.email`), Stripe none.
 */
const PAYER_CONTACTS = {
  COMGATE: Option.some<PaymentPayerContact>({ email: 'payer@example.test', fullName: 'Test Payer' }),
  GOPAY: Option.some<PaymentPayerContact>({ email: 'payer@example.test' }),
  STRIPE: Option.none<PaymentPayerContact>(),
} as const satisfies Record<NativeFamily, Option.Option<PaymentPayerContact>>;

/**
 * A gateway COLLECT whose payer contact is stored exactly as the collection Action stores it: the production
 * insert-only persistence in a Core-scoped runtime transaction. The executor then reads it through
 * `psp_read_operation_for_execution`; the Action path itself is `start-payment-collection-payer-contact-postgres`.
 */
const contactedCollectionFor = Effect.fn('PspGatewayChainTest.contactedCollection')(function* contactedCollectionFor(
  harness: NativeHarness,
  binding: NativeBinding,
  amountMinor: number,
) {
  const collect = yield* nativeCollectionFor(harness, binding, amountMinor);
  const contact = PAYER_CONTACTS[binding.executionBinding.providerFamily];
  if (Option.isSome(contact)) {
    yield* harness.database.transaction((transaction) =>
      installOperationalScope(transaction, operationalScopeOf(harness.scope)).pipe(
        Effect.flatMap((scoped) =>
          pspPayerContactPersistenceForTransaction(scoped).rememberForCollect(collect.operationId, contact.value),
        ),
      ),
    );
  }
  return collect;
});

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

/** One Stripe Checkout create of `collect`, answered with an open session; the sent form and the dispatch binding. */
const stripeCollection = Effect.fn('PspGatewayChainTest.stripeCollection')(function* stripeCollection(
  harness: NativeHarness,
  collect: OutboxPayload,
  credentials: CredentialDocument,
) {
  const step = yield* adaptersOver(
    {
      [STRIPE_CREATE]: [
        respond(
          200,
          JSON.stringify(
            stripeCheckoutSessionObject({
              orderReference: deriveProviderCorrelation(collect.operationId).orderReference,
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
  const exit = yield* deliverExecution(harness, collect, step.adapters).pipe(
    Effect.provide(credentialConfig(credentials)),
  );
  const dispatched = yield* inScope(
    harness.runtimeClient,
    harness.scope,
    harness.runtimeClient.unsafe<{ readonly binding_id: string; readonly state: string }>(
      'select binding_id::text, state from payment.psp_provider_dispatches where operation_id = $1',
      [collect.operationId],
    ),
  );
  const form = new URLSearchParams(step.callsTo(STRIPE_CREATE)[0]?.body ?? '');
  return {
    dispatch: dispatched.map((row) => [row.binding_id, row.state] as const),
    exit,
    returnUrls: [form.get('success_url'), form.get('cancel_url')].map((url) => url?.split('?')[0]),
    routes: step.sent.map(({ route }) => route),
  };
});

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
        const gopay = yield* contactedCollectionFor(harness, gopayBinding, 10_000);
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

        // The GoPay collect carries its payer email, so only the broken credential can stop it.
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

it.live(
  "#1155 #1159 L3-12 boundary executor+resolver routine+production Stripe adapter: an existing Payment collects under its original binding with that binding's return URL after disablement and after account replacement",
  () =>
    Effect.scoped(
      Effect.gen(function* originalBindingReturnUrl() {
        const credentials = { [STRIPE_SECRET_REF]: stripeEntry };
        const harness = yield* nativeHarness;
        const original: NativeBinding = yield* nativeBindingFor(harness, 'STRIPE', STRIPE_SECRET_REF);
        // Another Customer Configuration of the same scope enables the same binding with its own return URL.
        yield* nativeConfigureEnablement(harness, original, {
          customerConfigurationId: 'customer-configuration-2',
          enabled: true,
          returnUrl: 'https://other-shop.example.test/return',
        });
        const afterDisablement = yield* nativeCollectionFor(harness, original, STRIPE_AMOUNT);
        const afterReplacement = yield* nativeCollectionFor(harness, original, STRIPE_AMOUNT);

        // (a) Disablement: the Customer Configuration no longer offers the binding to new intents.
        yield* nativeConfigureEnablement(harness, original, {
          enabled: false,
          expectedRevision: 1,
          returnUrl: NATIVE_RETURN_URL,
        });
        const disabled = yield* stripeCollection(harness, afterDisablement, credentials);
        expect(Exit.isSuccess(disabled.exit)).toBe(true);
        expect(disabled.routes).toEqual([STRIPE_CREATE]);
        expect(disabled.returnUrls).toEqual([NATIVE_RETURN_URL, NATIVE_RETURN_URL]);
        expect(disabled.dispatch).toEqual([[original.bindingId, 'ACKNOWLEDGED']]);

        // (b) Account replacement: the original binding is retired and the enablement now names another account
        //     with another return URL. The existing Payment still collects under the original binding with the
        //     return URL that binding had for its own Customer Configuration.
        yield* nativeRetireBinding(harness, original);
        const replacement = yield* nativeAccountFor(harness, 'STRIPE', STRIPE_SECRET_REF);
        yield* nativeConfigureEnablement(harness, replacement, {
          enabled: true,
          expectedRevision: 2,
          returnUrl: 'https://shop.example.test/replacement-return',
        });
        const replaced = yield* stripeCollection(harness, afterReplacement, credentials);
        expect(Exit.isSuccess(replaced.exit)).toBe(true);
        expect(replaced.routes).toEqual([STRIPE_CREATE]);
        expect(replaced.returnUrls).toEqual([NATIVE_RETURN_URL, NATIVE_RETURN_URL]);
        expect(replaced.dispatch).toEqual([[original.bindingId, 'ACKNOWLEDGED']]);
      }),
    ),
);

/** The ledger's evidence rows of `operationId` as [fact kind, submission state]. */
const evidenceFor = (harness: NativeHarness, paymentId: string, operationId: string) =>
  evidenceOf(harness, paymentId).pipe(
    Effect.map((rows) => rows.filter(([id]) => id === operationId).map(([, factKind, state]) => [factKind, state])),
  );

/** One scripted COLLECT delivery through the production executor; returns the provider calls it made. */
const collectThrough = Effect.fn('PspGatewayChainTest.collectThrough')(function* collectThrough(
  harness: NativeHarness,
  collect: OutboxPayload,
  routes: RouteScript,
  credentials: CredentialDocument,
) {
  const step = yield* adaptersOver(routes, credentials);
  const exit = yield* deliverExecution(harness, collect, step.adapters).pipe(
    Effect.provide(credentialConfig(credentials)),
  );
  expect(Exit.isSuccess(exit)).toBe(true);
  return step;
});

it.live(
  '#1156 #1158 #1159 boundary executor+ledger routines+production Stripe adapter: a body-less Checkout Session expire is prepared with its replay record, sent once and confirmed',
  () =>
    Effect.scoped(
      Effect.gen(function* stripeCancel() {
        const credentials = { [STRIPE_SECRET_REF]: stripeEntry };
        const harness = yield* nativeHarness;
        const binding = yield* nativeBindingFor(harness, 'STRIPE', STRIPE_SECRET_REF);
        const collect = yield* nativeCollectionFor(harness, binding, STRIPE_AMOUNT);
        const collected = yield* stripeCollection(harness, collect, credentials);
        expect(collected.dispatch).toEqual([[binding.bindingId, 'ACKNOWLEDGED']]);

        const cancel = yield* nativeCancellationFor(harness, binding, collect);
        const cancelStep = yield* adaptersOver(
          {
            [STRIPE_EXPIRE]: [
              respond(
                200,
                JSON.stringify(
                  stripeCheckoutSessionObject({
                    orderReference: deriveProviderCorrelation(collect.operationId).orderReference,
                    paymentIntent: null,
                    paymentStatus: 'unpaid',
                    status: 'expired',
                  }),
                ),
              ),
            ],
          },
          credentials,
        );
        const cancelled = yield* deliverExecution(harness, cancel, cancelStep.adapters).pipe(
          Effect.provide(credentialConfig(credentials)),
        );
        expect(Exit.isSuccess(cancelled)).toBe(true);

        // The expire request has no body; it carries the cancel's own idempotency key.
        expect(cancelStep.sent.map(({ route }) => route)).toEqual([STRIPE_EXPIRE]);
        expect(cancelStep.sent[0]?.body).toBe('');
        expect(cancelStep.sent[0]?.headers['idempotency-key']).toBe(
          deriveProviderCorrelation(cancel.operationId).idempotencyKey,
        );
        expect((yield* dispatchStateOf(harness, cancel.operationId)).pipe(Option.map(([state]) => state))).toEqual(
          Option.some('ACKNOWLEDGED'),
        );
        expect(yield* evidenceFor(harness, cancel.paymentId, cancel.operationId)).toEqual([
          ['CANCEL_CONFIRMED', 'PENDING_SUBMISSION'],
        ]);
        // The same expire answer proved that the collection was never effected (#1156 target finding).
        expect(yield* evidenceFor(harness, cancel.paymentId, collect.operationId)).toEqual([
          ['COLLECTION_NOT_EFFECTED', 'PENDING_SUBMISSION'],
        ]);

        // The exact replay record: the empty body, the non-secret headers, the key hash and the 24 h window.
        const record = yield* dispatchRecordOf(harness, cancel.operationId).pipe(Effect.flatMap(Effect.fromOption));
        expect(record.requestBody).toEqual(new Uint8Array());
        expect(record.requestHeaders).toEqual([{ name: 'content-type', value: 'application/x-www-form-urlencoded' }]);
        expect(record.idempotencyKeyHash).toMatch(/^[a-f0-9]{64}$/u);
        expect(
          Option.all([
            Option.fromUndefinedOr(record.replayStartsAt),
            Option.fromUndefinedOr(record.replayExpiresAt),
          ]).pipe(Option.map(([starts, expires]) => DateTime.toEpochMillis(expires) - DateTime.toEpochMillis(starts))),
        ).toEqual(Option.some(86_400_000));

        // The same request again is the existing row; a changed request under the same operation is a conflict.
        const storedHash = yield* Effect.fromOption(Option.fromUndefinedOr(record.requestHash));
        expect(yield* reprepareDispatch(harness, record, storedHash)).toBe('EXISTING');
        expect(yield* reprepareDispatch(harness, record, 'f'.repeat(64))).toBe('CONFLICT request_mismatch');

        // A redelivery of the answered cancel sends nothing.
        const again = yield* adaptersOver({}, credentials);
        const redelivered = yield* deliverExecution(harness, cancel, again.adapters).pipe(
          Effect.provide(credentialConfig(credentials)),
        );
        expect(Exit.isSuccess(redelivered)).toBe(true);
        expect(again.sent).toEqual([]);
      }),
    ),
);

it.live(
  '#1156 #1158 #1159 boundary executor+ledger routines+production Comgate adapter: a transaction-id DELETE cancel is prepared, sent once and confirmed by the status lookup',
  () =>
    Effect.scoped(
      Effect.gen(function* comgateCancel() {
        const credentials = { [COMGATE_SECRET_REF]: comgateEntry };
        const harness = yield* nativeHarness;
        const binding = yield* nativeBindingFor(harness, 'COMGATE', COMGATE_SECRET_REF);
        const collect = yield* contactedCollectionFor(harness, binding, COMGATE_AMOUNT);
        const created = yield* collectThrough(
          harness,
          collect,
          { [COMGATE_CREATE]: [respond(200, comgateFixture('create-success.json'))] },
          credentials,
        );
        // The caller's contact reached the Comgate create, read from the stored row, not from the Outbox payload.
        const createBody = Schema.decodeUnknownSync(
          Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
        )(created.callsTo(COMGATE_CREATE)[0]?.body ?? '');
        expect([createBody.fullName, createBody.email]).toEqual(['Test Payer', 'payer@example.test']);
        expect(collect).not.toHaveProperty('payerContact');
        expect(yield* dispatchStateOf(harness, collect.operationId)).toEqual(
          Option.some(['ACKNOWLEDGED', null, `COMGATE_TRANSACTION:${COMGATE_TRANS_ID}`]),
        );

        const cancel = yield* nativeCancellationFor(harness, binding, collect);
        const cancelStep = yield* adaptersOver(
          {
            [COMGATE_CANCEL]: [respond(200, comgateFixture('result-ok.json'))],
            [COMGATE_STATUS]: [
              comgateStatus(deriveProviderCorrelation(collect.operationId).orderReference, 'CANCELLED'),
            ],
          },
          credentials,
        );
        const cancelled = yield* deliverExecution(harness, cancel, cancelStep.adapters).pipe(
          Effect.provide(credentialConfig(credentials)),
        );
        expect(Exit.isSuccess(cancelled)).toBe(true);
        expect(cancelStep.sent.map(({ route }) => route)).toEqual([COMGATE_CANCEL, COMGATE_STATUS]);
        expect((yield* dispatchStateOf(harness, cancel.operationId)).pipe(Option.map(([state]) => state))).toEqual(
          Option.some('ACKNOWLEDGED'),
        );
        expect(yield* evidenceFor(harness, cancel.paymentId, cancel.operationId)).toEqual([
          ['CANCEL_CONFIRMED', 'PENDING_SUBMISSION'],
        ]);
        // Comgate never replays: no stored request bytes and no replay window.
        const record = yield* dispatchRecordOf(harness, cancel.operationId).pipe(Effect.flatMap(Effect.fromOption));
        expect([record.requestBody, record.replayStartsAt, record.idempotencyKeyHash]).toEqual([
          undefined,
          undefined,
          undefined,
        ]);
        expect(yield* reprepareDispatch(harness, record, 'f'.repeat(64))).toBe('CONFLICT request_mismatch');
      }),
    ),
);

/** A GoPay COLLECT acknowledged by its 201 create answer, with the payer email the v4 create requires. */
const gopayCollection = Effect.fn('PspGatewayChainTest.gopayCollection')(function* gopayCollection(
  harness: NativeHarness,
  collect: OutboxPayload,
  credentials: CredentialDocument,
) {
  const { orderReference } = deriveProviderCorrelation(collect.operationId);
  const step = yield* collectThrough(
    harness,
    collect,
    { [GOPAY_CREATE]: [respond(201, gopayCreateResponseBody(orderReference))], [GOPAY_TOKEN]: [gopayToken] },
    credentials,
  );
  expect(step.sent.map(({ route }) => route)).toEqual([GOPAY_TOKEN, GOPAY_CREATE]);
  const body = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)))(
    step.callsTo(GOPAY_CREATE)[0]?.body ?? '',
  );
  expect(body.customer).toEqual({ email: 'payer@example.test' });
  expect(body.order_number).toBe(orderReference);
  expect(yield* dispatchStateOf(harness, collect.operationId)).toEqual(
    Option.some(['ACKNOWLEDGED', null, `GOPAY_PAYMENT:${GOPAY_FIXTURE_PAYMENT_ID}`]),
  );
  return orderReference;
});

it.live(
  '#1156 #1159 L3-14 boundary executor+ledger routines+production GoPay adapter: a GoPay v4 cancel is sent once and decided by the lookup (204 CANCELED confirmed; 409 PAYMENT_METHOD_CHOSEN or PAID not effected)',
  () =>
    Effect.scoped(
      Effect.gen(function* gopayCancel() {
        const credentials = { [GOPAY_SECRET_REF]: gopayEntry };
        const harness = yield* nativeHarness;
        const binding = yield* nativeBindingFor(harness, 'GOPAY', GOPAY_SECRET_REF);

        // (a) 204, then the lookup through the same binding shows CANCELED.
        const collect = yield* contactedCollectionFor(harness, binding, GOPAY_AMOUNT);
        const orderReference = yield* gopayCollection(harness, collect, credentials);
        const cancel = yield* nativeCancellationFor(harness, binding, collect);
        const cancelStep = yield* adaptersOver(
          {
            [GOPAY_CANCEL]: [respond(204, '')],
            [GOPAY_PAYMENT]: [respond(200, gopayPaymentBody({ orderNumber: orderReference, state: 'CANCELED' }))],
            [GOPAY_TOKEN]: [gopayToken],
          },
          credentials,
        );
        const cancelled = yield* deliverExecution(harness, cancel, cancelStep.adapters).pipe(
          Effect.provide(credentialConfig(credentials)),
        );
        expect(Exit.isSuccess(cancelled)).toBe(true);
        expect(cancelStep.sent.map(({ route }) => route)).toEqual([GOPAY_TOKEN, GOPAY_CANCEL, GOPAY_PAYMENT]);
        expect(cancelStep.callsTo(GOPAY_CANCEL)[0]?.body).toBe('');
        expect((yield* dispatchStateOf(harness, cancel.operationId)).pipe(Option.map(([state]) => state))).toEqual(
          Option.some('ACKNOWLEDGED'),
        );
        expect(yield* evidenceFor(harness, cancel.paymentId, cancel.operationId)).toEqual([
          ['CANCEL_CONFIRMED', 'PENDING_SUBMISSION'],
        ]);
        expect(yield* evidenceFor(harness, cancel.paymentId, collect.operationId)).toEqual([
          ['COLLECTION_NOT_EFFECTED', 'PENDING_SUBMISSION'],
        ]);
        // GoPay never replays: no stored request bytes and no replay window; a redelivery sends nothing.
        const record = yield* dispatchRecordOf(harness, cancel.operationId).pipe(Effect.flatMap(Effect.fromOption));
        expect([record.requestBody, record.replayStartsAt, record.idempotencyKeyHash]).toEqual([
          undefined,
          undefined,
          undefined,
        ]);
        const again = yield* adaptersOver({}, credentials);
        expect(
          Exit.isSuccess(
            yield* deliverExecution(harness, cancel, again.adapters).pipe(
              Effect.provide(credentialConfig(credentials)),
            ),
          ),
        ).toBe(true);
        expect(again.sent).toEqual([]);

        // (b) 409 because the payer already chose a method: the cancel is not effected, the collection stays open.
        const chosen = yield* contactedCollectionFor(harness, binding, GOPAY_AMOUNT);
        const chosenOrder = yield* gopayCollection(harness, chosen, credentials);
        const refused = yield* nativeCancellationFor(harness, binding, chosen);
        const refusedStep = yield* adaptersOver(
          {
            [GOPAY_CANCEL]: [respond(409, gopayConflictBody)],
            [GOPAY_PAYMENT]: [
              respond(200, gopayPaymentBody({ orderNumber: chosenOrder, state: 'PAYMENT_METHOD_CHOSEN' })),
            ],
            [GOPAY_TOKEN]: [gopayToken],
          },
          credentials,
        );
        const refusedExit = yield* deliverExecution(harness, refused, refusedStep.adapters).pipe(
          Effect.provide(credentialConfig(credentials)),
        );
        expect(Exit.isSuccess(refusedExit)).toBe(true);
        expect(refusedStep.callsTo(GOPAY_CANCEL)).toHaveLength(1);
        expect((yield* dispatchStateOf(harness, refused.operationId)).pipe(Option.map(([state]) => state))).toEqual(
          Option.some('REJECTED_BEFORE_EFFECT'),
        );
        expect(yield* evidenceFor(harness, refused.paymentId, refused.operationId)).toEqual([
          ['CANCEL_NOT_EFFECTED', 'PENDING_SUBMISSION'],
        ]);
        // A pending collection proves nothing new: no evidence is kept for it, and it stays acknowledged.
        expect(yield* evidenceFor(harness, refused.paymentId, chosen.operationId)).toEqual([]);
        expect((yield* dispatchStateOf(harness, chosen.operationId)).pipe(Option.map(([state]) => state))).toEqual(
          Option.some('ACKNOWLEDGED'),
        );

        // (c) 409 because the payment is already paid: the cancel is not effected and the lookup proves the
        // collection; returning the funds needs its own REFUND.
        const paid = yield* contactedCollectionFor(harness, binding, GOPAY_AMOUNT);
        const paidOrder = yield* gopayCollection(harness, paid, credentials);
        const tooLate = yield* nativeCancellationFor(harness, binding, paid);
        const tooLateStep = yield* adaptersOver(
          {
            [GOPAY_CANCEL]: [respond(409, gopayConflictBody)],
            [GOPAY_PAYMENT]: [respond(200, gopayPaymentBody({ orderNumber: paidOrder, state: 'PAID' }))],
            [GOPAY_TOKEN]: [gopayToken],
          },
          credentials,
        );
        expect(
          Exit.isSuccess(
            yield* deliverExecution(harness, tooLate, tooLateStep.adapters).pipe(
              Effect.provide(credentialConfig(credentials)),
            ),
          ),
        ).toBe(true);
        expect(tooLateStep.sent.map(({ route }) => route)).toEqual([GOPAY_TOKEN, GOPAY_CANCEL, GOPAY_PAYMENT]);
        expect((yield* dispatchStateOf(harness, tooLate.operationId)).pipe(Option.map(([state]) => state))).toEqual(
          Option.some('REJECTED_BEFORE_EFFECT'),
        );
        expect(yield* evidenceFor(harness, tooLate.paymentId, tooLate.operationId)).toEqual([
          ['CANCEL_NOT_EFFECTED', 'PENDING_SUBMISSION'],
        ]);
        expect(yield* evidenceFor(harness, tooLate.paymentId, paid.operationId)).toEqual([
          ['COLLECTION_CONFIRMED', 'PENDING_SUBMISSION'],
        ]);
      }),
    ),
);

it.live(
  '#1156 #1158 #1159 boundary executor+ledger routines+production GoPay and Comgate adapters: a refund is prepared, sent once and recorded as pending',
  () =>
    Effect.scoped(
      Effect.gen(function* gopayComgateRefund() {
        const credentials = { [COMGATE_SECRET_REF]: comgateEntry, [GOPAY_SECRET_REF]: gopayEntry };
        const harness = yield* nativeHarness;

        // GoPay: refund of 40 CZK on the acknowledged payment; the 201 refund resource names the refund by its id.
        const gopayBinding = yield* nativeBindingFor(harness, 'GOPAY', GOPAY_SECRET_REF);
        const gopayCollect = yield* contactedCollectionFor(harness, gopayBinding, GOPAY_AMOUNT);
        yield* gopayCollection(harness, gopayCollect, credentials);
        const gopayRefund = yield* nativeRefundFor(harness, gopayBinding, gopayCollect, 4000);
        const gopayStep = yield* collectThrough(
          harness,
          gopayRefund,
          {
            [GOPAY_REFUND]: [respond(201, gopayRefundBody({ amount: 4000, state: 'REQUESTED' }))],
            [GOPAY_TOKEN]: [gopayToken],
          },
          credentials,
        );
        expect(gopayStep.sent.map(({ route }) => route)).toEqual([GOPAY_TOKEN, GOPAY_REFUND]);
        expect(gopayStep.callsTo(GOPAY_REFUND)[0]?.body).toBe('{"amount":4000}');
        expect((yield* dispatchStateOf(harness, gopayRefund.operationId)).pipe(Option.map(([state]) => state))).toEqual(
          Option.some('ACKNOWLEDGED'),
        );
        const refundRecord = yield* dispatchRecordOf(harness, gopayRefund.operationId).pipe(
          Effect.flatMap(Effect.fromOption),
        );
        expect([refundRecord.providerPaymentRef, refundRecord.providerRefundRef]).toEqual([
          `GOPAY_PAYMENT:${GOPAY_FIXTURE_PAYMENT_ID}`,
          `GOPAY_REFUND:${GOPAY_FIXTURE_PAYMENT_ID}:${GOPAY_FIXTURE_REFUND_ID}`,
        ]);
        expect(yield* evidenceFor(harness, gopayRefund.paymentId, gopayRefund.operationId)).toEqual([
          ['REFUND_PENDING', 'PENDING_SUBMISSION'],
        ]);

        // Comgate: refund of 40 CZK on the acknowledged transaction; Comgate documents no completion (N10).
        const comgateBinding = yield* nativeBindingFor(harness, 'COMGATE', COMGATE_SECRET_REF);
        const comgateCollect = yield* contactedCollectionFor(harness, comgateBinding, COMGATE_AMOUNT);
        yield* collectThrough(
          harness,
          comgateCollect,
          { [COMGATE_CREATE]: [respond(200, comgateFixture('create-success.json'))] },
          credentials,
        );
        const comgateRefund = yield* nativeRefundFor(harness, comgateBinding, comgateCollect, 4000);
        const comgateStep = yield* collectThrough(
          harness,
          comgateRefund,
          { [COMGATE_REFUND]: [respond(200, comgateFixture('result-ok.json'))] },
          credentials,
        );
        expect(comgateStep.sent.map(({ route }) => route)).toEqual([COMGATE_REFUND]);
        expect(
          (yield* dispatchStateOf(harness, comgateRefund.operationId)).pipe(Option.map(([state]) => state)),
        ).toEqual(Option.some('ACKNOWLEDGED'));
        expect(yield* evidenceFor(harness, comgateRefund.paymentId, comgateRefund.operationId)).toEqual([
          ['REFUND_PENDING', 'PENDING_SUBMISSION'],
        ]);
      }),
    ),
);
