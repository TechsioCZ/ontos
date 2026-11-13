/**
 * #1159 level-2 conformance cases, one entry per Launch gateway family. Each entry states the documented
 * provider answers (tests/fixtures/{gopay,stripe,comgate}, cited there by URL) for the capability matrix:
 * create, retrieve, cancel, refund, notification, lost response, lookup miss, amount mismatch and foreign
 * merchant. The conformance test runs every entry through the same `GatewayProviderAdapter` contract.
 *
 * Every value is synthetic or a documentation example. Nothing here is sandbox evidence.
 */
import { readFileSync } from 'node:fs';

import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { DateTime, Option, Schema } from 'effect';

import type {
  PaymentGatewayProviderFamilySchema,
  PaymentRefundBasisKind,
} from '../../shared/domain/payment-vocabulary.ts';
import { gopayProviderObjectId } from '../../src/integrations/gopay/gopay-wire.ts';
import { RawProviderNotificationSchema } from '../../src/integrations/psp/notification-envelope.ts';
import type { RawProviderNotification } from '../../src/integrations/psp/notification-envelope.ts';
import { deriveProviderCorrelation } from '../../src/integrations/psp/psp-correlation.ts';
import type { GatewayNotificationRejectionReason } from '../../src/integrations/psp/psp-errors.ts';
import {
  GatewayCancelRequestSchema,
  GatewayCollectRequestSchema,
  GatewayExecutionTargetSchema,
  GatewayRefundRequestSchema,
  ProviderObjectRefSchema,
} from '../../src/integrations/psp/psp-request.ts';
import type {
  GatewayCancelRequest,
  GatewayCollectRequest,
  GatewayExecutionTarget,
  GatewayExpectedEffect,
  GatewayRefundBaseline,
  GatewayRefundRequest,
  ProviderObjectRef,
} from '../../src/integrations/psp/psp-request.ts';
import { gopayExecutionTarget, GOPAY_FIXTURE_ACCOUNT_REF } from '../fixtures/gopay/execution-target.ts';
import {
  GOPAY_FIXTURE_GOID,
  GOPAY_FIXTURE_PAYMENT_ID,
  gopayCreateResponseBody,
  gopayInquiryResponseBody,
  gopayPaymentNotFoundBody,
} from '../fixtures/gopay/payment-responses.ts';
import {
  gopayBankPartialRefundHistoryBody,
  gopayEmptyRefundHistoryBody,
  gopayRefundHistoryBody,
  gopayRefundResponseBody,
} from '../fixtures/gopay/refund-responses.ts';
import { stripeBalanceObject, stripeEventEnvelope, stripePayoutObject } from '../fixtures/stripe/stripe-events.ts';
import {
  STRIPE_FIXTURE_PAYMENT_INTENT_ID,
  STRIPE_FIXTURE_REFUND_ID,
  STRIPE_FIXTURE_SESSION_ID,
  stripeCheckoutSessionObject,
  stripePaymentIntentObject,
  stripeRefundObject,
  stripeResourceMissingError,
} from '../fixtures/stripe/stripe-objects.ts';
import { dropAfterWrite, respond } from './psp-conformance-provider.fixture.ts';
import type { CredentialDocument, RouteScript } from './psp-conformance-provider.fixture.ts';

export const COLLECT_OPERATION_ID = '0f8b5c1e-3a2d-4c7b-9e1f-5a6b7c8d9e0f';
export const REFUND_OPERATION_ID = '6c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f';
export const CANCEL_OPERATION_ID = '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b';
const PAYMENT_ID = '3f2e1d0c-9b8a-4f7e-8d6c-5b4a39281706';
const RETURN_TOKEN = 'AbCdEfGhIjKlMnOpQrSt_-';
/** The executor fixes `issuedAt` before prepare; the worker clock runs from here. */
export const CONFORMANCE_CLOCK_MS = Date.UTC(2026, 10, 12, 9, 59, 0);
const ISSUED_AT = DateTime.makeUnsafe(CONFORMANCE_CLOCK_MS);
const HOUR_MS = 3_600_000;

export const collectCorrelation = deriveProviderCorrelation(COLLECT_OPERATION_ID);
const refundCorrelation = deriveProviderCorrelation(REFUND_OPERATION_ID);
const czk = (amountMinor: number) => ({ amountMinor, currency: 'CZK' as const });

/** The provider answers a family gives to one conformance case. */
export interface FamilyScripts {
  readonly cancel: Option.Option<RouteScript>;
  readonly create: RouteScript;
  readonly lookupForeignMerchant: RouteScript;
  readonly lookupMismatch: RouteScript;
  readonly lookupMiss: RouteScript;
  readonly lookupPaid: RouteScript;
  readonly lostCreate: RouteScript;
  readonly refundAccepted: RouteScript;
  readonly unavailableCreate: RouteScript;
}

export interface FamilyNotifications {
  readonly expectedAuthenticity: 'LOOKUP_REQUIRED' | 'SHARED_SECRET_VERIFIED' | 'SIGNATURE_VERIFIED';
  readonly foreignMerchant: RawProviderNotification;
  readonly foreignMerchantReason: GatewayNotificationRejectionReason;
  readonly invalid: RawProviderNotification;
  readonly invalidReason: GatewayNotificationRejectionReason;
  /** Provider settlement / balance deliveries the family can send; empty when it sends none (plan N15). */
  readonly settlement: readonly RawProviderNotification[];
  readonly valid: RawProviderNotification;
  /** The Effect clock instant the notification is verified at. */
  readonly verifiedAtMs: number;
  readonly wrongEnvironment: RawProviderNotification;
}

/**
 * How a refund's completion is proven by the provider's own completion source: the ref the recovery lookup
 * addresses, the binding it runs through, the documented answers and the clock. `sandboxSource` is false when the
 * source does not exist for test-mode payments (Comgate settlement statements, plan D-P2): there a sandbox
 * lookup makes no call and stays INDETERMINATE, so completion can only be shown on a real production refund.
 */
export interface FamilyRefundCompletion {
  /** The baseline the acknowledged refund dispatch committed before its send (GoPay); None for other families. */
  readonly acknowledgedRefundBaseline: Option.Option<GatewayRefundBaseline>;
  readonly atMs: number;
  readonly confirmed: RouteScript;
  /** The provider requests the confirming lookup makes, in order. */
  readonly confirmedRoutes: readonly string[];
  readonly lookupRef: ProviderObjectRef;
  readonly sandboxSource: boolean;
  readonly target: GatewayExecutionTarget;
}

export interface FamilyConformance {
  readonly amount: ReturnType<typeof czk>;
  readonly cancelRequest: GatewayCancelRequest;
  readonly collectRequest: GatewayCollectRequest;
  /** The provider route the create mutation is sent to. */
  readonly createRoute: string;
  readonly credentials: CredentialDocument;
  readonly family: typeof PaymentGatewayProviderFamilySchema.Type;
  /** Fragments a one-shot direct collection body must never contain (manual capture, saved method, recurrence). */
  readonly forbiddenCollectFragments: readonly string[];
  /** A provider object of another family that this adapter must never act on. */
  readonly foreignFamilyRef: ProviderObjectRef;
  readonly notifications: FamilyNotifications;
  readonly paymentRef: ProviderObjectRef;
  readonly refundAmount: ReturnType<typeof czk>;
  readonly refundCompletion: FamilyRefundCompletion;
  readonly refundRequest: (basis: PaymentRefundBasisKind) => GatewayRefundRequest;
  /** The provider route the refund mutation is sent to. */
  readonly refundRoute: string;
  readonly scripts: FamilyScripts;
  readonly target: GatewayExecutionTarget;
}

const collectExpectedOf = (amount: ReturnType<typeof czk>): GatewayExpectedEffect => ({
  _tag: 'COLLECT',
  amount,
  operationId: COLLECT_OPERATION_ID,
});
export const collectExpected = (conformance: FamilyConformance) => collectExpectedOf(conformance.amount);
export const refundExpected = (conformance: FamilyConformance): GatewayExpectedEffect => ({
  _tag: 'REFUND',
  amount: conformance.refundAmount,
  operationId: REFUND_OPERATION_ID,
});
export const cancelExpected = (conformance: FamilyConformance): GatewayExpectedEffect => ({
  _tag: 'CANCEL_OR_VOID',
  operationId: CANCEL_OPERATION_ID,
  target: { amount: conformance.amount, operationId: COLLECT_OPERATION_ID },
});

const collectRequestOf = (
  amount: ReturnType<typeof czk>,
  payerContact: Option.Option<{ readonly email: string; readonly fullName: Option.Option<string> }>,
) =>
  Schema.decodeUnknownSync(GatewayCollectRequestSchema)({
    amount,
    correlation: collectCorrelation,
    issuedAt: ISSUED_AT,
    operationId: COLLECT_OPERATION_ID,
    payerContact: payerContact.pipe(
      Option.map(({ email, fullName }) => ({
        email: Option.some(email),
        fullName,
        phone: Option.none(),
      })),
    ),
    paymentId: PAYMENT_ID,
    returnToken: RETURN_TOKEN,
  });

const refundRequestOf =
  (amount: ReturnType<typeof czk>, providerTarget: ProviderObjectRef) =>
  (basis: PaymentRefundBasisKind): GatewayRefundRequest =>
    Schema.decodeUnknownSync(GatewayRefundRequestSchema)({
      amount,
      correlation: refundCorrelation,
      operationId: REFUND_OPERATION_ID,
      providerTarget,
      refundBasisKind: basis,
      targetOperationId: COLLECT_OPERATION_ID,
    });

const cancelRequestOf = (providerTarget: ProviderObjectRef) =>
  Schema.decodeUnknownSync(GatewayCancelRequestSchema)({
    operationId: CANCEL_OPERATION_ID,
    providerTarget,
    targetOperationId: COLLECT_OPERATION_ID,
  });

const refOf = (encoded: typeof ProviderObjectRefSchema.Encoded) =>
  Schema.decodeUnknownSync(ProviderObjectRefSchema)(encoded);

const notificationOf = (encoded: typeof RawProviderNotificationSchema.Encoded) =>
  Schema.decodeUnknownSync(RawProviderNotificationSchema)(encoded);

const FOREIGN_ACCOUNT_REF = `pab_${'f'.repeat(32)}`;

// -------------------------------------------------------------------------------------------------
// GoPay (https://doc.gopay.com)
// -------------------------------------------------------------------------------------------------

const GOPAY_API = 'https://gw.sandbox.gopay.com/api';
const GOPAY_TOKEN = `POST ${GOPAY_API}/oauth2/token`;
const GOPAY_CREATE = `POST ${GOPAY_API}/payments/payment`;
const GOPAY_PAYMENT = `GET ${GOPAY_API}/payments/payment/${GOPAY_FIXTURE_PAYMENT_ID}`;
const GOPAY_REFUND = `POST ${GOPAY_API}/payments/payment/${GOPAY_FIXTURE_PAYMENT_ID}/refund`;
const GOPAY_REFUND_HISTORY = `GET ${GOPAY_API}/payments/payment/${GOPAY_FIXTURE_PAYMENT_ID}/refunds`;
const gopayToken = respond(
  200,
  '{"token_type":"bearer","access_token":"gopay-access-token-fixture","expires_in":1800}',
);
const gopayInquiry = (state: string, overrides: { readonly amount?: number; readonly goid?: string } = {}) =>
  respond(
    200,
    gopayInquiryResponseBody({
      amount: overrides.amount ?? 10_000,
      goid: overrides.goid ?? GOPAY_FIXTURE_GOID,
      orderNumber: collectCorrelation.orderReference,
      state,
    }),
  );
const gopayRef = refOf({ _tag: 'GOPAY_PAYMENT', id: gopayProviderObjectId(Number(GOPAY_FIXTURE_PAYMENT_ID)) });
const gopayTarget = gopayExecutionTarget();
const gopayCallback = (overrides: Partial<typeof RawProviderNotificationSchema.Encoded> = {}) =>
  notificationOf({
    environment: 'SANDBOX',
    family: 'GOPAY',
    headers: { contentType: Option.none(), stripeSignature: Option.none() },
    providerAccountRef: GOPAY_FIXTURE_ACCOUNT_REF,
    query: { parentPaymentRef: Option.none(), paymentRef: Option.some(GOPAY_FIXTURE_PAYMENT_ID) },
    rawBody: new Uint8Array(),
    receivedAt: DateTime.makeUnsafe(CONFORMANCE_CLOCK_MS),
    transportDeliveryRef: 'relay-delivery-gopay-1',
    ...overrides,
  });

const GOPAY: FamilyConformance = {
  amount: czk(10_000),
  cancelRequest: cancelRequestOf(gopayRef),
  collectRequest: collectRequestOf(
    czk(10_000),
    Option.some({ email: 'payer@example.test', fullName: Option.some('Payer Example') }),
  ),
  createRoute: GOPAY_CREATE,
  credentials: {
    [gopayTarget.credentialSecretRef]: {
      clientId: 'gopay-client-fixture',
      clientSecret: 'gopay-secret-fixture-c17',
      family: 'GOPAY',
    },
  },
  family: 'GOPAY',
  forbiddenCollectFragments: ['preauthorization', 'recurrence', 'recurrent'],
  foreignFamilyRef: refOf({ _tag: 'COMGATE_TRANSACTION', transId: 'AB12-CD34-EF56' }),
  notifications: {
    expectedAuthenticity: 'LOOKUP_REQUIRED',
    foreignMerchant: gopayCallback({ providerAccountRef: FOREIGN_ACCOUNT_REF }),
    foreignMerchantReason: 'BINDING_UNKNOWN',
    // GoPay callbacks are unsigned by design: the only verification is the id shape and a later lookup.
    invalid: gopayCallback({
      query: { parentPaymentRef: Option.none(), paymentRef: Option.some('not-a-payment-id') },
    }),
    invalidReason: 'MALFORMED',
    settlement: [],
    valid: gopayCallback(),
    verifiedAtMs: CONFORMANCE_CLOCK_MS + 5000,
    wrongEnvironment: gopayCallback({ environment: 'LIVE' }),
  },
  paymentRef: gopayRef,
  refundAmount: czk(4000),
  // GoPay refunds have no id of their own and history rows carry only a day: the one row that is new since the
  // baseline the acknowledged dispatch committed before its send, with the exact amount in state SUCCESS, confirms
  // (real v3 sandbox history of the 2026-11-13 bank-transfer refund).
  refundCompletion: {
    acknowledgedRefundBaseline: Option.some({ rowIds: [] }),
    atMs: CONFORMANCE_CLOCK_MS + HOUR_MS,
    confirmed: {
      [GOPAY_PAYMENT]: [gopayInquiry('PARTIALLY_REFUNDED')],
      [GOPAY_REFUND_HISTORY]: [respond(200, gopayBankPartialRefundHistoryBody)],
      [GOPAY_TOKEN]: [gopayToken],
    },
    confirmedRoutes: [GOPAY_TOKEN, GOPAY_PAYMENT, GOPAY_REFUND_HISTORY],
    lookupRef: gopayRef,
    sandboxSource: true,
    target: gopayTarget,
  },
  refundRequest: refundRequestOf(czk(4000), gopayRef),
  refundRoute: GOPAY_REFUND,
  scripts: {
    cancel: Option.none(),
    create: {
      [GOPAY_CREATE]: [respond(200, gopayCreateResponseBody(collectCorrelation.orderReference))],
      [GOPAY_TOKEN]: [gopayToken],
    },
    lookupForeignMerchant: {
      [GOPAY_PAYMENT]: [gopayInquiry('PAID', { goid: '8123456780' })],
      [GOPAY_TOKEN]: [gopayToken],
    },
    lookupMismatch: { [GOPAY_PAYMENT]: [gopayInquiry('PAID', { amount: 9900 })], [GOPAY_TOKEN]: [gopayToken] },
    lookupMiss: { [GOPAY_PAYMENT]: [respond(404, gopayPaymentNotFoundBody)], [GOPAY_TOKEN]: [gopayToken] },
    lookupPaid: { [GOPAY_PAYMENT]: [gopayInquiry('PAID')], [GOPAY_TOKEN]: [gopayToken] },
    lostCreate: { [GOPAY_CREATE]: [dropAfterWrite], [GOPAY_TOKEN]: [gopayToken] },
    refundAccepted: {
      [GOPAY_PAYMENT]: [gopayInquiry('PARTIALLY_REFUNDED')],
      [GOPAY_REFUND]: [respond(200, gopayRefundResponseBody(GOPAY_FIXTURE_PAYMENT_ID, 'ACCEPTED'))],
      // Each prepare reads the pre-dispatch baseline; the read after the accepted send finds the new row REQUESTED.
      [GOPAY_REFUND_HISTORY]: [
        respond(200, gopayEmptyRefundHistoryBody),
        respond(200, gopayEmptyRefundHistoryBody),
        respond(200, gopayRefundHistoryBody([{ amount: 4000, id: '4493293835', state: 'REQUESTED' }])),
      ],
      [GOPAY_TOKEN]: [gopayToken],
    },
    unavailableCreate: { [GOPAY_CREATE]: [respond(503, '{"errors":[]}')], [GOPAY_TOKEN]: [gopayToken] },
  },
  target: gopayTarget,
};

// -------------------------------------------------------------------------------------------------
// Stripe (https://docs.stripe.com/api)
// -------------------------------------------------------------------------------------------------

const STRIPE_API = 'https://api.stripe.com';
const STRIPE_CREATE = `POST ${STRIPE_API}/v1/checkout/sessions`;
const STRIPE_EXPIRE = `POST ${STRIPE_API}/v1/checkout/sessions/${STRIPE_FIXTURE_SESSION_ID}/expire`;
const STRIPE_PAYMENT_INTENT = `GET ${STRIPE_API}/v1/payment_intents/${STRIPE_FIXTURE_PAYMENT_INTENT_ID}`;
const STRIPE_REFUNDS = `POST ${STRIPE_API}/v1/refunds`;
/** Joined at runtime so no key-shaped literal is committed; the prefix selects the SANDBOX environment. */
const STRIPE_FIXTURE_KEY = ['sk', 'test', 'c17', 'conformance', 'not', 'a', 'key'].join('_');
const STRIPE_WEBHOOK_SECRET = 'whsec_c17_conformance_not_a_secret';
const STRIPE_ACCOUNT_REF = `pab_${'0123456789abcdef'.repeat(2)}`;
const STRIPE_SIGNED_AT_SECONDS = Math.floor(CONFORMANCE_CLOCK_MS / 1000);
const stripeIntentRef = refOf({ _tag: 'STRIPE_PAYMENT_INTENT', id: STRIPE_FIXTURE_PAYMENT_INTENT_ID });
const stripeSessionRef = refOf({ _tag: 'STRIPE_CHECKOUT_SESSION', id: STRIPE_FIXTURE_SESSION_ID });
const stripeTarget = Schema.decodeUnknownSync(GatewayExecutionTargetSchema)({
  binding: {
    _tag: 'GATEWAY_ACCOUNT',
    environment: 'SANDBOX',
    providerAccountRef: STRIPE_ACCOUNT_REF,
    providerFamily: 'STRIPE',
  },
  bindingId: '0b6c1f8e-2d4a-4b7c-9e1f-3a5b7c9d1e2f',
  credentialRevision: 1,
  credentialSecretRef: 'stripe.sandbox.conformance',
  legalEntityId: '5e2d1c0b-9a8f-4e7d-8c6b-5a4f3e2d1c0b',
  merchantIdentity: { _tag: 'STRIPE', accountId: 'acct_1C17Conformance' },
  notificationUrl: 'https://payments.example.test/notifications/stripe',
  returnUrl: Option.some('https://shop.example.test/return'),
  tenantId: '7a6b5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d',
});
const stripeIntent = (overrides: { readonly amountReceived?: number; readonly livemode?: boolean } = {}) =>
  respond(
    200,
    JSON.stringify(
      stripePaymentIntentObject({
        ...overrides,
        orderReference: collectCorrelation.orderReference,
        status: 'succeeded',
      }),
    ),
  );
const stripeSignature = (rawBody: Uint8Array) => {
  const prefix = utf8ToBytes(`${STRIPE_SIGNED_AT_SECONDS}.`);
  const signed = new Uint8Array(prefix.length + rawBody.length);
  signed.set(prefix);
  signed.set(rawBody, prefix.length);
  return `t=${STRIPE_SIGNED_AT_SECONDS},v1=${bytesToHex(hmac(sha256, utf8ToBytes(STRIPE_WEBHOOK_SECRET), signed))}`;
};
const stripeEvent = (
  event: Parameters<typeof stripeEventEnvelope>[0],
  overrides: {
    readonly environment?: 'LIVE' | 'SANDBOX';
    readonly providerAccountRef?: string;
    readonly signedBody?: Uint8Array;
  } = {},
) => {
  const rawBody = utf8ToBytes(JSON.stringify(stripeEventEnvelope(event)));
  return notificationOf({
    environment: overrides.environment ?? 'SANDBOX',
    family: 'STRIPE',
    headers: {
      contentType: Option.some('application/json'),
      stripeSignature: Option.some(stripeSignature(overrides.signedBody ?? rawBody)),
    },
    providerAccountRef: overrides.providerAccountRef ?? STRIPE_ACCOUNT_REF,
    query: { parentPaymentRef: Option.none(), paymentRef: Option.none() },
    rawBody,
    receivedAt: DateTime.makeUnsafe(STRIPE_SIGNED_AT_SECONDS * 1000),
    transportDeliveryRef: 'relay-delivery-stripe-1',
  });
};
const stripeSucceeded = {
  object: stripePaymentIntentObject({ orderReference: collectCorrelation.orderReference, status: 'succeeded' }),
  type: 'payment_intent.succeeded',
};

const STRIPE: FamilyConformance = {
  amount: czk(159_950),
  cancelRequest: cancelRequestOf(stripeSessionRef),
  collectRequest: collectRequestOf(czk(159_950), Option.none()),
  createRoute: STRIPE_CREATE,
  credentials: {
    [stripeTarget.credentialSecretRef]: {
      family: 'STRIPE',
      secretKey: STRIPE_FIXTURE_KEY,
      webhookSigningSecret: STRIPE_WEBHOOK_SECRET,
    },
  },
  family: 'STRIPE',
  forbiddenCollectFragments: [
    'setup_future_usage',
    'capture_method=manual',
    'mode=subscription',
    'mode=setup',
    'off_session',
    'saved_payment_method',
    'customer=',
  ],
  foreignFamilyRef: gopayRef,
  notifications: {
    expectedAuthenticity: 'SIGNATURE_VERIFIED',
    foreignMerchant: stripeEvent(stripeSucceeded, { providerAccountRef: FOREIGN_ACCOUNT_REF }),
    foreignMerchantReason: 'BINDING_UNKNOWN',
    invalid: stripeEvent(stripeSucceeded, { signedBody: utf8ToBytes('{}') }),
    invalidReason: 'SIGNATURE_INVALID',
    settlement: [
      stripeEvent({ object: stripeBalanceObject, type: 'balance.available' }),
      stripeEvent({ object: stripePayoutObject, type: 'payout.paid' }),
    ],
    valid: stripeEvent(stripeSucceeded),
    verifiedAtMs: STRIPE_SIGNED_AT_SECONDS * 1000 + 5000,
    wrongEnvironment: stripeEvent(stripeSucceeded, { environment: 'LIVE' }),
  },
  paymentRef: stripeIntentRef,
  refundAmount: czk(50_000),
  // The Refund object is retrieved by its id; `succeeded` is the completion.
  refundCompletion: {
    acknowledgedRefundBaseline: Option.none(),
    atMs: CONFORMANCE_CLOCK_MS + HOUR_MS,
    confirmed: {
      [`GET ${STRIPE_API}/v1/refunds/${STRIPE_FIXTURE_REFUND_ID}`]: [
        respond(
          200,
          JSON.stringify(stripeRefundObject({ orderReference: refundCorrelation.orderReference, status: 'succeeded' })),
        ),
      ],
    },
    confirmedRoutes: [`GET ${STRIPE_API}/v1/refunds/${STRIPE_FIXTURE_REFUND_ID}`],
    lookupRef: refOf({ _tag: 'STRIPE_REFUND', id: STRIPE_FIXTURE_REFUND_ID }),
    sandboxSource: true,
    target: stripeTarget,
  },
  refundRequest: refundRequestOf(czk(50_000), stripeIntentRef),
  refundRoute: STRIPE_REFUNDS,
  scripts: {
    cancel: Option.some({
      [STRIPE_EXPIRE]: [
        respond(
          200,
          JSON.stringify(
            stripeCheckoutSessionObject({
              orderReference: collectCorrelation.orderReference,
              paymentIntent: null,
              paymentStatus: 'unpaid',
              status: 'expired',
            }),
          ),
        ),
      ],
    }),
    create: {
      [STRIPE_CREATE]: [
        respond(
          200,
          JSON.stringify(
            stripeCheckoutSessionObject({
              orderReference: collectCorrelation.orderReference,
              paymentIntent: null,
              paymentStatus: 'unpaid',
              status: 'open',
            }),
          ),
        ),
      ],
    },
    // Stripe objects carry no merchant id: an object of the other environment is the foreign account answer.
    lookupForeignMerchant: { [STRIPE_PAYMENT_INTENT]: [stripeIntent({ livemode: true })] },
    lookupMismatch: { [STRIPE_PAYMENT_INTENT]: [stripeIntent({ amountReceived: 159_900 })] },
    lookupMiss: { [STRIPE_PAYMENT_INTENT]: [respond(404, JSON.stringify(stripeResourceMissingError))] },
    lookupPaid: { [STRIPE_PAYMENT_INTENT]: [stripeIntent()] },
    lostCreate: { [STRIPE_CREATE]: [dropAfterWrite] },
    refundAccepted: {
      [STRIPE_REFUNDS]: [
        respond(
          200,
          JSON.stringify(stripeRefundObject({ orderReference: refundCorrelation.orderReference, status: 'pending' })),
        ),
      ],
    },
    unavailableCreate: { [STRIPE_CREATE]: [respond(503, '{"error":{"type":"api_error"}}')] },
  },
  target: stripeTarget,
};

// -------------------------------------------------------------------------------------------------
// Comgate (https://apidoc.comgate.cz/en/api/rest/)
// -------------------------------------------------------------------------------------------------

const comgateFixture = (name: string) => readFileSync(new URL(`../fixtures/comgate/${name}`, import.meta.url), 'utf-8');
type JsonObject = Readonly<Record<string, typeof Schema.Json.Type>>;
const comgateJson = (name: string): JsonObject =>
  Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)))(comgateFixture(name));
const COMGATE_API = 'https://payments.comgate.cz';
const COMGATE_TRANS_ID = 'AB12-CD34-EF56';
const COMGATE_CREATE = `POST ${COMGATE_API}/v2.0/payment.json`;
const COMGATE_STATUS = `GET ${COMGATE_API}/v2.0/payment/transId/${COMGATE_TRANS_ID}.json`;
const COMGATE_CANCEL = `DELETE ${COMGATE_API}/v2.0/payment/transId/${COMGATE_TRANS_ID}.json`;
const COMGATE_REFUND = `POST ${COMGATE_API}/v2.0/refund.json`;
/** The conformance dispatch instant is 2026-11-12 (Prague); its statement is readable from the next morning. */
const COMGATE_TRANSFER_LIST = `GET ${COMGATE_API}/v2.0/transferList/date/2026-11-12.json`;
const COMGATE_SINGLE_TRANSFER = `GET ${COMGATE_API}/v2.0/singleTransfer/transferId/1234567.json`;
const comgateJsonArrayFirst = (name: string): JsonObject =>
  Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.Record(Schema.String, Schema.Json))))(
    comgateFixture(name),
  )[0] ?? {};
const COMGATE_SECRET = 'comgate-shop-secret-c17-conformance';
const COMGATE_ACCOUNT_REF = `pab_${'1'.repeat(32)}`;
const comgateRef = refOf({ _tag: 'COMGATE_TRANSACTION', transId: COMGATE_TRANS_ID });
const comgateTarget = Schema.decodeUnknownSync(GatewayExecutionTargetSchema)({
  binding: {
    _tag: 'GATEWAY_ACCOUNT',
    environment: 'SANDBOX',
    providerAccountRef: COMGATE_ACCOUNT_REF,
    providerFamily: 'COMGATE',
  },
  bindingId: '7d3e9a10-55b2-4f6c-8a1d-2b3c4d5e6f70',
  credentialRevision: 1,
  credentialSecretRef: 'comgate.sandbox.conformance',
  legalEntityId: '3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f',
  merchantIdentity: { _tag: 'COMGATE', merchantId: '123456' },
  notificationUrl: 'https://payments.example.test/notifications/comgate',
  returnUrl: Option.some('https://shop.example.test/payment/return'),
  tenantId: '4d5e6f7a-8b9c-4d0e-9f1a-2b3c4d5e6f7a',
});
const comgateStatus = (overrides: JsonObject = {}) =>
  respond(
    200,
    JSON.stringify({
      ...comgateJson('status-paid.json'),
      refId: collectCorrelation.orderReference,
      test: 'true',
      ...overrides,
    }),
  );
const comgatePush = (overrides: JsonObject = {}, environment: 'LIVE' | 'SANDBOX' = 'SANDBOX') =>
  notificationOf({
    environment,
    family: 'COMGATE',
    headers: { contentType: Option.some('application/json'), stripeSignature: Option.none() },
    providerAccountRef: COMGATE_ACCOUNT_REF,
    query: { parentPaymentRef: Option.none(), paymentRef: Option.none() },
    rawBody: utf8ToBytes(
      JSON.stringify({
        ...comgateJson('push.json'),
        refId: collectCorrelation.orderReference,
        secret: COMGATE_SECRET,
        test: 'true',
        transId: COMGATE_TRANS_ID,
        ...overrides,
      }),
    ),
    receivedAt: DateTime.makeUnsafe(CONFORMANCE_CLOCK_MS),
    transportDeliveryRef: 'relay-delivery-comgate-1',
  });

const COMGATE: FamilyConformance = {
  amount: czk(10_000),
  cancelRequest: cancelRequestOf(comgateRef),
  collectRequest: collectRequestOf(
    czk(10_000),
    Option.some({ email: 'payer@example.test', fullName: Option.some('Test Payer') }),
  ),
  createRoute: COMGATE_CREATE,
  credentials: { [comgateTarget.credentialSecretRef]: { family: 'COMGATE', secret: COMGATE_SECRET } },
  family: 'COMGATE',
  forbiddenCollectFragments: ['preauth', 'initRecurring', 'verification'],
  foreignFamilyRef: stripeIntentRef,
  notifications: {
    expectedAuthenticity: 'SHARED_SECRET_VERIFIED',
    foreignMerchant: comgatePush({ merchant: '654321' }),
    foreignMerchantReason: 'MERCHANT_MISMATCH',
    invalid: comgatePush({ secret: `${COMGATE_SECRET}-forged` }),
    invalidReason: 'SECRET_MISMATCH',
    settlement: [],
    valid: comgatePush(),
    verifiedAtMs: CONFORMANCE_CLOCK_MS + 5000,
    wrongEnvironment: comgatePush({}, 'LIVE'),
  },
  paymentRef: comgateRef,
  refundAmount: czk(4000),
  // No refund status API: the production settlement statement of the dispatch day is the only completion source.
  refundCompletion: {
    acknowledgedRefundBaseline: Option.none(),
    atMs: CONFORMANCE_CLOCK_MS + 25 * HOUR_MS,
    confirmed: {
      [COMGATE_SINGLE_TRANSFER]: [
        respond(
          200,
          JSON.stringify([
            {
              ...comgateJson('statement-refund-row.json'),
              'ID od klienta': refundCorrelation.orderReference,
              Merchant: '123456',
              'Potvrzená částka': '-40,00',
            },
          ]),
        ),
      ],
      [COMGATE_TRANSFER_LIST]: [respond(200, JSON.stringify([{ ...comgateJsonArrayFirst('transfer-list.json') }]))],
    },
    confirmedRoutes: [COMGATE_TRANSFER_LIST, COMGATE_SINGLE_TRANSFER],
    lookupRef: comgateRef,
    sandboxSource: false,
    target: Schema.decodeUnknownSync(GatewayExecutionTargetSchema)({
      ...Schema.encodeSync(GatewayExecutionTargetSchema)(comgateTarget),
      binding: { ...comgateTarget.binding, environment: 'LIVE' },
    }),
  },
  refundRequest: refundRequestOf(czk(4000), comgateRef),
  refundRoute: COMGATE_REFUND,
  scripts: {
    cancel: Option.some({
      [COMGATE_CANCEL]: [respond(200, comgateFixture('result-ok.json'))],
      [COMGATE_STATUS]: [comgateStatus({ status: 'CANCELLED' })],
    }),
    create: { [COMGATE_CREATE]: [respond(200, comgateFixture('create-success.json'))] },
    lookupForeignMerchant: { [COMGATE_STATUS]: [comgateStatus({ merchant: '654321' })] },
    lookupMismatch: { [COMGATE_STATUS]: [comgateStatus({ price: '9900' })] },
    lookupMiss: { [COMGATE_STATUS]: [respond(404, 'Not Found')] },
    lookupPaid: { [COMGATE_STATUS]: [comgateStatus()] },
    lostCreate: { [COMGATE_CREATE]: [dropAfterWrite] },
    refundAccepted: { [COMGATE_REFUND]: [respond(200, comgateFixture('result-ok.json'))] },
    unavailableCreate: { [COMGATE_CREATE]: [respond(503, 'Service Unavailable')] },
  },
  target: comgateTarget,
};

/** The three Launch gateway families, in a fixed order. */
export const CONFORMANCE_FAMILIES: readonly FamilyConformance[] = [GOPAY, STRIPE, COMGATE];
