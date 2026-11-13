import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { Context, DateTime, Effect, Layer, Match, Option, Redacted, Result, Schema } from 'effect';
import { UrlParams } from 'effect/http';
import type { HttpClientRequest } from 'effect/http';
import { TestClock } from 'effect/testing';
import { describe, expect, it } from 'effect-rstest';

import { PaymentOperationIdSchema } from '../../shared/domain/payment-identifiers.ts';
import { ProviderCredentialStore } from '../../src/integrations/psp/credentials.ts';
import type {
  ProviderCredentialMaterial,
  ProviderCredentialStoreContract,
} from '../../src/integrations/psp/credentials.ts';
import { RawProviderNotificationSchema } from '../../src/integrations/psp/notification-envelope.ts';
import { ProviderHttp } from '../../src/integrations/psp/provider-http.ts';
import type { ProviderHttpContract, ProviderHttpResponse } from '../../src/integrations/psp/provider-http.ts';
import { deriveProviderCorrelation } from '../../src/integrations/psp/psp-correlation.ts';
import { GatewayProviderOutcomeUnknown } from '../../src/integrations/psp/psp-errors.ts';
import {
  GatewayCancelRequestSchema,
  GatewayCollectRequestSchema,
  GatewayExecutionTargetSchema,
  GatewayExpectedEffectSchema,
  GatewayLookupRequestSchema,
  GatewayLookupTargetSchema,
  GatewayRefundRequestSchema,
  ProviderObjectRefSchema,
} from '../../src/integrations/psp/psp-request.ts';
import type {
  GatewayExecutionTarget,
  GatewayExpectedEffect,
  GatewayLookupTarget,
} from '../../src/integrations/psp/psp-request.ts';
import type {
  PreparedProviderRequest,
  ProviderDispatchResponse,
  ProviderReplayRequest,
} from '../../src/integrations/psp/psp-result.ts';
import {
  StripePaymentService,
  StripePaymentServiceLive,
} from '../../src/integrations/stripe/stripe-payment.service.ts';
import { stripeEventEnvelope } from '../fixtures/stripe/stripe-events.ts';
import {
  STRIPE_FIXTURE_PAYMENT_INTENT_ID,
  STRIPE_FIXTURE_REFUND_ID,
  STRIPE_FIXTURE_SESSION_ID,
  stripeCheckoutSessionObject,
  stripePaidSessionExpireError,
  stripePaymentIntentObject,
  stripePaymentIntentSearchResult,
  stripeRefundObject,
  stripeResourceMissingError,
} from '../fixtures/stripe/stripe-objects.ts';

/**
 * #1154 #1155 #1156 #1158 Stripe adapter over a scripted ProviderHttp. Every request the adapter would
 * have sent is recorded, so the tests assert the exact bytes, headers and keys that reach Stripe.
 */

const COLLECT_OPERATION_ID = '3f1c2b7e-8a9d-4e6f-9b1a-2c3d4e5f6a7b';
const REFUND_OPERATION_ID = '6a0b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d';
const CANCEL_OPERATION_ID = '9c8b7a6d-5e4f-4321-8abc-def012345678';
/** Fixture keys with Stripe's environment prefixes; joined at runtime so no key-shaped literal is committed. */
const fixtureKeyOf = (kind: 'rk' | 'rkcs' | 'sk', mode: 'live' | 'test') =>
  [kind, mode, 'c17', 'fixture', 'not', 'a', 'real', 'key'].join('_');
const SANDBOX_KEY = fixtureKeyOf('sk', 'test');
const LIVE_KEY = fixtureKeyOf('sk', 'live');
const WEBHOOK_SECRET = 'whsec_c17_fixture_not_a_real_secret';
const PROVIDER_ACCOUNT_REF = 'pab_0123456789abcdef0123456789abcdef';
const RETURN_TOKEN = 'AAAAAAAAAAAAAAAAAAAAAA';
const ISSUED_AT_MS = Date.UTC(2026, 10, 12, 10, 0, 0);
const DAY_MS = 86_400_000;

const operationIdOf = (value: string) => Schema.decodeUnknownSync(PaymentOperationIdSchema)(value);
const COLLECT_CORRELATION = deriveProviderCorrelation(operationIdOf(COLLECT_OPERATION_ID));
const REFUND_CORRELATION = deriveProviderCorrelation(operationIdOf(REFUND_OPERATION_ID));

const targetOf = (environment: 'LIVE' | 'SANDBOX'): GatewayExecutionTarget =>
  Schema.decodeUnknownSync(GatewayExecutionTargetSchema)({
    binding: {
      _tag: 'GATEWAY_ACCOUNT',
      environment,
      providerAccountRef: PROVIDER_ACCOUNT_REF,
      providerFamily: 'STRIPE',
    },
    bindingId: '0b6c1f8e-2d4a-4b7c-9e1f-3a5b7c9d1e2f',
    credentialRevision: 1,
    credentialSecretRef: 'stripe-sandbox',
    legalEntityId: '5e2d1c0b-9a8f-4e7d-8c6b-5a4f3e2d1c0b',
    merchantIdentity: { _tag: 'STRIPE', accountId: 'acct_1C17Fixture' },
    notificationUrl: 'https://payments.example.test/notifications/stripe',
    returnUrl: Option.some('https://shop.example.test/return'),
    tenantId: '7a6b5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d',
  });

const SANDBOX_TARGET = targetOf('SANDBOX');

const [CollectExpectedSchema, RefundExpectedSchema, CancelExpectedSchema] = GatewayExpectedEffectSchema.members;
const collectExpected = Schema.decodeUnknownSync(CollectExpectedSchema)({
  _tag: 'COLLECT',
  amount: { amountMinor: 159_950, currency: 'CZK' },
  operationId: COLLECT_OPERATION_ID,
});
const refundExpected = Schema.decodeUnknownSync(RefundExpectedSchema)({
  _tag: 'REFUND',
  amount: { amountMinor: 50_000, currency: 'CZK' },
  operationId: REFUND_OPERATION_ID,
});
const cancelExpected = Schema.decodeUnknownSync(CancelExpectedSchema)({
  _tag: 'CANCEL_OR_VOID',
  operationId: CANCEL_OPERATION_ID,
  target: { amount: { amountMinor: 159_950, currency: 'CZK' }, operationId: COLLECT_OPERATION_ID },
});

const collectRequest = Schema.decodeUnknownSync(GatewayCollectRequestSchema)({
  amount: { amountMinor: 159_950, currency: 'CZK' },
  correlation: COLLECT_CORRELATION,
  issuedAt: DateTime.makeUnsafe(ISSUED_AT_MS),
  operationId: COLLECT_OPERATION_ID,
  payerContact: Option.none(),
  paymentId: '1d2c3b4a-5f6e-4d7c-8b9a-0f1e2d3c4b5a',
  returnToken: RETURN_TOKEN,
});

const refundRequest = Schema.decodeUnknownSync(GatewayRefundRequestSchema)({
  amount: { amountMinor: 50_000, currency: 'CZK' },
  correlation: REFUND_CORRELATION,
  operationId: REFUND_OPERATION_ID,
  providerTarget: { _tag: 'STRIPE_PAYMENT_INTENT', id: STRIPE_FIXTURE_PAYMENT_INTENT_ID },
  refundBasisKind: 'REFUNDABLE_ITEMS',
  targetOperationId: COLLECT_OPERATION_ID,
});

const cancelRequest = Schema.decodeUnknownSync(GatewayCancelRequestSchema)({
  operationId: CANCEL_OPERATION_ID,
  providerTarget: { _tag: 'STRIPE_CHECKOUT_SESSION', id: STRIPE_FIXTURE_SESSION_ID },
  targetOperationId: COLLECT_OPERATION_ID,
});

const openSession = stripeCheckoutSessionObject({
  orderReference: COLLECT_CORRELATION.orderReference,
  paymentIntent: null,
  paymentStatus: 'unpaid',
  status: 'open',
});

// ---------------------------------------------------------------------------------------------------
// Scripted ProviderHttp and credential store
// ---------------------------------------------------------------------------------------------------

interface Step {
  /** The mutate never answered (timeout or drop after the write). */
  readonly lost: boolean;
  readonly response: ProviderHttpResponse;
}

interface Recorded {
  readonly kind: 'mutate' | 'read';
  readonly request: HttpClientRequest.HttpClientRequest;
}

const respond = (status: number, bodyText: string): Step => ({ lost: false, response: { bodyText, status } });
const lostResponse: Step = { lost: true, response: { bodyText: '', status: 599 } };

const credentialOf = (secretKey: string): ProviderCredentialMaterial => ({
  _tag: 'STRIPE',
  secretKey: Redacted.make(secretKey),
  webhookSigningSecret: Redacted.make(WEBHOOK_SECRET),
});

const harness = (steps: readonly Step[], secretKey = SANDBOX_KEY) =>
  Effect.gen(function* harnessEffect() {
    const sent: Recorded[] = [];
    const answer = (kind: Recorded['kind'], request: HttpClientRequest.HttpClientRequest) => {
      const step = steps[sent.length] ?? respond(500, JSON.stringify({ error: { type: 'api_error' } }));
      sent.push({ kind, request });
      return step;
    };
    const http: ProviderHttpContract = {
      mutate: ({ operationId, request }) =>
        Effect.suspend(() => {
          const step = answer('mutate', request);
          return step.lost
            ? Effect.fail(
                new GatewayProviderOutcomeUnknown({
                  code: 'gateway_provider_outcome_unknown',
                  family: 'STRIPE',
                  operationId,
                  reason: 'provider_attempt_timed_out',
                }),
              )
            : Effect.succeed(step.response);
        }),
      read: ({ request }) => Effect.sync(() => answer('read', request).response),
    };
    const credentials: ProviderCredentialStoreContract = {
      resolve: () => Effect.succeed(credentialOf(secretKey)),
    };
    const context = yield* Layer.build(
      StripePaymentServiceLive.pipe(
        Layer.provide(
          Layer.mergeAll(Layer.succeed(ProviderHttp, http), Layer.succeed(ProviderCredentialStore, credentials)),
        ),
      ),
    );
    return { adapter: Context.get(context, StripePaymentService), sent };
  });

const bodyBytesOf = (request: HttpClientRequest.HttpClientRequest): Uint8Array =>
  Match.value(request.body).pipe(
    Match.tag('Uint8Array', (body) => body.body),
    Match.orElse(() => new Uint8Array()),
  );

const formOf = (bytes: Uint8Array) => [...new URLSearchParams(new TextDecoder().decode(bytes)).entries()];

const replayRequestOf = (prepared: PreparedProviderRequest, startsAtMs: number): ProviderReplayRequest => ({
  prepared,
  window: { expiresAt: DateTime.makeUnsafe(startsAtMs + DAY_MS), startsAt: DateTime.makeUnsafe(startsAtMs) },
});

const dispatchOutcomeOf = (response: ProviderDispatchResponse) =>
  Match.value(response).pipe(
    Match.tag('ACKNOWLEDGED', () => 'ACKNOWLEDGED'),
    Match.tag('REJECTED_BEFORE_EFFECT', () => 'REJECTED_BEFORE_EFFECT'),
    Match.exhaustive,
  );

const failureOf = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.map(Effect.result(effect), (result) => Option.getOrUndefined(Result.getFailure(result)));

// ---------------------------------------------------------------------------------------------------
// Collect
// ---------------------------------------------------------------------------------------------------

describe('#1154 Stripe Checkout Session collection', () => {
  it.effect('#1154 Stripe collection never saves or reuses a payment method', () =>
    Effect.gen(function* collectionBody() {
      const { adapter, sent } = yield* harness([respond(200, JSON.stringify(openSession))]);
      const prepared = yield* adapter.prepareCollect(SANDBOX_TARGET, collectRequest);
      const returnUrl = `https://shop.example.test/return?r=${RETURN_TOKEN}`;

      expect(formOf(prepared.body)).toEqual([
        ['mode', 'payment'],
        ['line_items[0][price_data][currency]', 'czk'],
        ['line_items[0][price_data][unit_amount]', '159950'],
        ['line_items[0][price_data][product_data][name]', 'Payment'],
        ['line_items[0][quantity]', '1'],
        ['payment_intent_data[capture_method]', 'automatic'],
        ['payment_intent_data[metadata][ontos_order_reference]', COLLECT_CORRELATION.orderReference],
        ['metadata[ontos_order_reference]', COLLECT_CORRELATION.orderReference],
        ['client_reference_id', COLLECT_OPERATION_ID],
        ['success_url', returnUrl],
        ['cancel_url', returnUrl],
        ['expires_at', String(ISSUED_AT_MS / 1000 + 86_400)],
      ]);
      const names = formOf(prepared.body).map(([name]) => name);
      for (const forbidden of ['customer', 'setup_future_usage', 'payment_method', 'off_session']) {
        expect(names.some((name) => name.includes(forbidden))).toBe(false);
      }
      expect(prepared).toMatchObject({
        endpointRef: 'stripe:POST:/v1/checkout/sessions',
        family: 'STRIPE',
        headers: [{ name: 'content-type', value: 'application/x-www-form-urlencoded' }],
        idempotencyKey: Option.some(COLLECT_CORRELATION.idempotencyKey),
        orderReference: COLLECT_CORRELATION.orderReference,
        replayWindowMs: Option.some(DAY_MS),
      });
      expect(JSON.stringify(prepared)).not.toContain(SANDBOX_KEY);

      const response = yield* adapter.send(SANDBOX_TARGET, prepared, collectExpected);
      expect(dispatchOutcomeOf(response)).toBe('ACKNOWLEDGED');
      expect(response.finding.finding).toBe('CUSTOMER_ACTION_REQUIRED');
      expect(Option.isSome(response.finding.customerAction)).toBe(true);
      expect(sent).toHaveLength(1);
      const [created] = sent;
      expect(created?.kind).toBe('mutate');
      expect(created?.request.url).toBe('https://api.stripe.com/v1/checkout/sessions');
      expect(created?.request.headers['idempotency-key']).toBe(COLLECT_CORRELATION.idempotencyKey);
      expect(created?.request.headers.authorization).toBe(`Bearer ${SANDBOX_KEY}`);
      expect(created === undefined ? undefined : bodyBytesOf(created.request)).toEqual(prepared.body);
    }),
  );

  it.effect('#1154 capture_method is explicitly automatic', () =>
    Effect.gen(function* captureAutomatic() {
      const { adapter } = yield* harness([]);
      const prepared = yield* adapter.prepareCollect(SANDBOX_TARGET, collectRequest);
      const fields = formOf(prepared.body);

      expect(fields).toContainEqual(['payment_intent_data[capture_method]', 'automatic']);
      expect(fields.filter(([name]) => name.includes('capture_method'))).toHaveLength(1);
    }),
  );

  it.effect('#1156 Preparation is pure: the same request gives the same bytes and hash', () =>
    Effect.gen(function* preparationPure() {
      const { adapter, sent } = yield* harness([]);
      const first = yield* adapter.prepareCollect(SANDBOX_TARGET, collectRequest);
      yield* TestClock.adjust('1 hour');
      const second = yield* adapter.prepareCollect(SANDBOX_TARGET, collectRequest);

      expect(second.body).toEqual(first.body);
      expect(second.requestHash).toBe(first.requestHash);
      expect(sent).toHaveLength(0);
    }),
  );

  it.effect('#1156 A collection without an enablement return URL is UNAVAILABLE before any send', () =>
    Effect.gen(function* noReturnUrl() {
      const { adapter, sent } = yield* harness([]);
      const error = yield* failureOf(
        adapter.prepareCollect({ ...SANDBOX_TARGET, returnUrl: Option.none() }, collectRequest),
      );

      expect(error).toMatchObject({ code: 'gateway_provider_unavailable', reason: 'return_url_unavailable' });
      expect(sent).toHaveLength(0);
    }),
  );

  it.effect('#1156 A refused create is REJECTED_BEFORE_EFFECT with NOT_EFFECTED evidence', () =>
    Effect.gen(function* createRefused() {
      const { adapter } = yield* harness([
        respond(400, JSON.stringify({ error: { code: 'parameter_invalid', type: 'invalid_request_error' } })),
      ]);
      const prepared = yield* adapter.prepareCollect(SANDBOX_TARGET, collectRequest);
      const response = yield* adapter.send(SANDBOX_TARGET, prepared, collectExpected);

      expect(dispatchOutcomeOf(response)).toBe('REJECTED_BEFORE_EFFECT');
      expect(response.finding.finding).toBe('NOT_EFFECTED');
      expect(response.finding.evidence.pipe(Option.map((evidence) => evidence.factKind))).toEqual(
        Option.some('COLLECTION_NOT_EFFECTED'),
      );
    }),
  );

  it.effect('#1158 An idempotency conflict or a 5xx-like status is OUTCOME_UNKNOWN, never a rejection', () =>
    Effect.gen(function* createAmbiguous() {
      for (const step of [
        respond(409, JSON.stringify({ error: { type: 'idempotency_error' } })),
        respond(400, JSON.stringify({ error: { type: 'idempotency_error' } })),
        respond(424, JSON.stringify({ error: { type: 'api_error' } })),
        respond(200, JSON.stringify({ unexpected: true })),
      ]) {
        const { adapter } = yield* harness([step]);
        const prepared = yield* adapter.prepareCollect(SANDBOX_TARGET, collectRequest);
        const error = yield* failureOf(adapter.send(SANDBOX_TARGET, prepared, collectExpected));

        expect(error).toMatchObject({ code: 'gateway_provider_outcome_unknown', operationId: COLLECT_OPERATION_ID });
      }
    }),
  );

  it.effect('#1155 Live key with a SANDBOX binding is UNAVAILABLE', () =>
    Effect.gen(function* liveKeySandboxBinding() {
      const { adapter, sent } = yield* harness([respond(200, JSON.stringify(openSession))], LIVE_KEY);
      const prepared = yield* adapter.prepareCollect(SANDBOX_TARGET, collectRequest);
      const sendError = yield* failureOf(adapter.send(SANDBOX_TARGET, prepared, collectExpected));
      const lookupError = yield* failureOf(
        adapter.lookup(
          SANDBOX_TARGET,
          Schema.decodeUnknownSync(GatewayLookupRequestSchema)({
            acknowledgedRefundBaseline: Option.none(),
            dispatchedAt: Option.none(),
            expected: collectExpected,
            target: {
              _tag: 'PROVIDER_OBJECT',
              ref: { _tag: 'STRIPE_CHECKOUT_SESSION', id: STRIPE_FIXTURE_SESSION_ID },
            },
          }),
        ),
      );

      for (const error of [sendError, lookupError]) {
        expect(error).toMatchObject({
          code: 'gateway_provider_unavailable',
          family: 'STRIPE',
          reason: 'credential_environment_mismatch',
        });
        expect(JSON.stringify(error)).not.toContain(LIVE_KEY);
      }
      expect(sent).toHaveLength(0);
    }),
  );

  it.effect('#1155 A SANDBOX binding admits secret, restricted and claimable-sandbox test keys', () =>
    Effect.gen(function* sandboxKeysAdmitted() {
      for (const kind of ['sk', 'rk', 'rkcs'] as const) {
        const { adapter, sent } = yield* harness(
          [respond(200, JSON.stringify(openSession))],
          fixtureKeyOf(kind, 'test'),
        );
        const prepared = yield* adapter.prepareCollect(SANDBOX_TARGET, collectRequest);
        const response = yield* adapter.send(SANDBOX_TARGET, prepared, collectExpected);

        expect(dispatchOutcomeOf(response)).toBe('ACKNOWLEDGED');
        expect(sent).toHaveLength(1);
      }
    }),
  );

  it.effect('#1155 A SANDBOX binding refuses every live key and unknown prefixes before any send', () =>
    Effect.gen(function* sandboxRefusesLiveKeys() {
      for (const secretKey of [
        fixtureKeyOf('sk', 'live'),
        fixtureKeyOf('rk', 'live'),
        fixtureKeyOf('rkcs', 'live'),
        ['pk', 'test', 'c17', 'fixture'].join('_'),
      ]) {
        const { adapter, sent } = yield* harness([respond(200, JSON.stringify(openSession))], secretKey);
        const prepared = yield* adapter.prepareCollect(SANDBOX_TARGET, collectRequest);
        const error = yield* failureOf(adapter.send(SANDBOX_TARGET, prepared, collectExpected));

        expect(error).toMatchObject({
          code: 'gateway_provider_unavailable',
          reason: 'credential_environment_mismatch',
        });
        expect(JSON.stringify(error)).not.toContain(secretKey);
        expect(sent).toHaveLength(0);
      }
    }),
  );

  it.effect('#1155 A LIVE binding refuses every test key, including the claimable-sandbox key', () =>
    Effect.gen(function* liveRefusesTestKeys() {
      const liveTarget = targetOf('LIVE');
      for (const kind of ['sk', 'rk', 'rkcs'] as const) {
        const { adapter, sent } = yield* harness(
          [respond(200, JSON.stringify(openSession))],
          fixtureKeyOf(kind, 'test'),
        );
        const prepared = yield* adapter.prepareCollect(liveTarget, collectRequest);
        const error = yield* failureOf(adapter.send(liveTarget, prepared, collectExpected));

        expect(error).toMatchObject({
          code: 'gateway_provider_unavailable',
          reason: 'credential_environment_mismatch',
        });
        expect(sent).toHaveLength(0);
      }
    }),
  );

  it.effect('#1155 A SANDBOX key with a LIVE binding is UNAVAILABLE as well', () =>
    Effect.gen(function* sandboxKeyLiveBinding() {
      const { adapter, sent } = yield* harness([respond(200, JSON.stringify(openSession))], SANDBOX_KEY);
      const liveTarget = targetOf('LIVE');
      const prepared = yield* adapter.prepareCollect(liveTarget, collectRequest);
      const error = yield* failureOf(adapter.send(liveTarget, prepared, collectExpected));

      expect(error).toMatchObject({ code: 'gateway_provider_unavailable', reason: 'credential_environment_mismatch' });
      expect(sent).toHaveLength(0);
    }),
  );
});

// ---------------------------------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------------------------------

describe('#1158 Stripe exact replay', () => {
  it.effect('#1158 Stripe lost create response is recovered by exact replay inside 24 h', () =>
    Effect.gen(function* lostCreateReplayed() {
      const { adapter, sent } = yield* harness([lostResponse, respond(200, JSON.stringify(openSession))]);
      yield* TestClock.setTime(ISSUED_AT_MS);
      const prepared = yield* adapter.prepareCollect(SANDBOX_TARGET, collectRequest);

      const lost = yield* failureOf(adapter.send(SANDBOX_TARGET, prepared, collectExpected));
      expect(lost).toMatchObject({ code: 'gateway_provider_outcome_unknown' });

      yield* TestClock.setTime(ISSUED_AT_MS + DAY_MS - 1);
      const response = yield* adapter.replay(SANDBOX_TARGET, replayRequestOf(prepared, ISSUED_AT_MS), collectExpected);

      expect(dispatchOutcomeOf(response)).toBe('ACKNOWLEDGED');
      expect(response.finding.finding).toBe('CUSTOMER_ACTION_REQUIRED');
      expect(sent).toHaveLength(2);
      const [original, replayed] = sent;
      expect(replayed?.request.url).toBe(original?.request.url);
      expect(replayed?.request.headers['idempotency-key']).toBe(original?.request.headers['idempotency-key']);
      expect(replayed?.request.headers['content-type']).toBe(original?.request.headers['content-type']);
      expect(replayed === undefined ? undefined : bodyBytesOf(replayed.request)).toEqual(prepared.body);
      expect(original === undefined ? undefined : bodyBytesOf(original.request)).toEqual(prepared.body);
    }),
  );

  it.effect('#1158 Replay outside the window is refused', () =>
    Effect.gen(function* replayOutsideWindow() {
      const { adapter, sent } = yield* harness([
        respond(200, JSON.stringify(openSession)),
        respond(200, JSON.stringify(openSession)),
      ]);
      const prepared = yield* adapter.prepareCollect(SANDBOX_TARGET, collectRequest);
      const replayRequest = replayRequestOf(prepared, ISSUED_AT_MS);

      for (const now of [ISSUED_AT_MS + DAY_MS, ISSUED_AT_MS + DAY_MS + 1, ISSUED_AT_MS - 1]) {
        yield* TestClock.setTime(now);
        const error = yield* failureOf(adapter.replay(SANDBOX_TARGET, replayRequest, collectExpected));
        expect(error).toMatchObject({
          capability: 'COLLECT',
          code: 'gateway_provider_unsupported',
          family: 'STRIPE',
          reason: 'replay_window_expired',
        });
      }
      expect(sent).toHaveLength(0);
    }),
  );

  it.effect('#1158 A replay of altered bytes is refused before any send', () =>
    Effect.gen(function* replayAltered() {
      const { adapter, sent } = yield* harness([respond(200, JSON.stringify(openSession))]);
      yield* TestClock.setTime(ISSUED_AT_MS);
      const prepared = yield* adapter.prepareCollect(SANDBOX_TARGET, collectRequest);
      const altered: PreparedProviderRequest = { ...prepared, body: utf8ToBytes('mode=payment&amount=1') };
      const error = yield* failureOf(
        adapter.replay(SANDBOX_TARGET, replayRequestOf(altered, ISSUED_AT_MS), collectExpected),
      );

      expect(error).toMatchObject({ code: 'gateway_provider_unavailable', reason: 'prepared_request_hash_mismatch' });
      expect(sent).toHaveLength(0);
    }),
  );
});

// ---------------------------------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------------------------------

const lookupRequest = (target: GatewayLookupTarget, expected: GatewayExpectedEffect) =>
  Schema.decodeUnknownSync(GatewayLookupRequestSchema)({
    acknowledgedRefundBaseline: Option.none(),
    dispatchedAt: Option.none(),
    expected,
    target,
  });
const lookupTargetOf = Schema.decodeUnknownSync(GatewayLookupTargetSchema);

describe('#1158 Stripe lookup', () => {
  it.effect('#1158 Search miss after the window is INDETERMINATE', () =>
    Effect.gen(function* searchMiss() {
      const { adapter, sent } = yield* harness([respond(200, JSON.stringify(stripePaymentIntentSearchResult([])))]);
      const findings = yield* adapter.lookup(
        SANDBOX_TARGET,
        lookupRequest(
          lookupTargetOf({ _tag: 'ORDER_REFERENCE', orderReference: COLLECT_CORRELATION.orderReference }),
          collectExpected,
        ),
      );

      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({
        evidence: Option.none(),
        finding: 'INDETERMINATE',
        target: { operationId: COLLECT_OPERATION_ID, operationKind: 'COLLECT' },
      });
      const [search] = sent;
      expect(search?.kind).toBe('read');
      expect(search?.request.url).toBe('https://api.stripe.com/v1/payment_intents/search');
      expect(
        Option.flatMap(Option.fromUndefinedOr(search), (read) => UrlParams.getFirst(read.request.urlParams, 'query')),
      ).toEqual(Option.some(`metadata['ontos_order_reference']:'${COLLECT_CORRELATION.orderReference}'`));
    }),
  );

  it.effect('#1158 A search hit with the order reference confirms the collection', () =>
    Effect.gen(function* searchHit() {
      const paid = stripePaymentIntentObject({
        orderReference: COLLECT_CORRELATION.orderReference,
        status: 'succeeded',
      });
      const { adapter } = yield* harness([respond(200, JSON.stringify(stripePaymentIntentSearchResult([paid])))]);
      const findings = yield* adapter.lookup(
        SANDBOX_TARGET,
        lookupRequest(
          lookupTargetOf({ _tag: 'ORDER_REFERENCE', orderReference: COLLECT_CORRELATION.orderReference }),
          collectExpected,
        ),
      );

      expect(findings.map((finding) => finding.finding)).toEqual(['EFFECT_CONFIRMED']);
    }),
  );

  it.effect('#1158 A session lookup expands the PaymentIntent; 404 is INDETERMINATE and 401 is UNAVAILABLE', () =>
    Effect.gen(function* sessionLookup() {
      const sessionTarget = lookupTargetOf({
        _tag: 'PROVIDER_OBJECT',
        ref: { _tag: 'STRIPE_CHECKOUT_SESSION', id: STRIPE_FIXTURE_SESSION_ID },
      });
      const { adapter, sent } = yield* harness([
        respond(404, JSON.stringify(stripeResourceMissingError)),
        respond(401, JSON.stringify({ error: { type: 'invalid_request_error' } })),
      ]);
      const missing = yield* adapter.lookup(SANDBOX_TARGET, lookupRequest(sessionTarget, collectExpected));
      const unauthorized = yield* failureOf(
        adapter.lookup(SANDBOX_TARGET, lookupRequest(sessionTarget, collectExpected)),
      );

      expect(missing.map((finding) => finding.finding)).toEqual(['INDETERMINATE']);
      expect(unauthorized).toMatchObject({
        code: 'gateway_provider_unavailable',
        reason: 'provider_authentication_failed',
      });
      expect(sent[0]?.request.url).toBe(`https://api.stripe.com/v1/checkout/sessions/${STRIPE_FIXTURE_SESSION_ID}`);
      expect(
        Option.flatMap(Option.fromUndefinedOr(sent[0]), (read) =>
          UrlParams.getFirst(read.request.urlParams, 'expand[]'),
        ),
      ).toEqual(Option.some('payment_intent'));
    }),
  );

  it.effect('#1158 A refund lookup reads the refund; a refund ref for a collection is Unsupported', () =>
    Effect.gen(function* refundLookup() {
      const refund = stripeRefundObject({ orderReference: REFUND_CORRELATION.orderReference, status: 'succeeded' });
      const { adapter, sent } = yield* harness([respond(200, JSON.stringify(refund))]);
      const refundTarget = lookupTargetOf({
        _tag: 'PROVIDER_OBJECT',
        ref: { _tag: 'STRIPE_REFUND', id: STRIPE_FIXTURE_REFUND_ID },
      });
      const findings = yield* adapter.lookup(SANDBOX_TARGET, lookupRequest(refundTarget, refundExpected));
      const mismatch = yield* failureOf(adapter.lookup(SANDBOX_TARGET, lookupRequest(refundTarget, collectExpected)));

      expect(findings.map((finding) => finding.finding)).toEqual(['EFFECT_CONFIRMED']);
      expect(mismatch).toMatchObject({ code: 'gateway_provider_unsupported', reason: 'stripe_lookup_target_mismatch' });
      expect(sent).toHaveLength(1);
    }),
  );

  it.effect('#1157 Stripe states the metadata order reference of an object read in the binding mode only', () =>
    Effect.gen(function* readOrderReference() {
      const refund = stripeRefundObject({ orderReference: REFUND_CORRELATION.orderReference, status: 'succeeded' });
      const live = stripePaymentIntentObject({
        livemode: true,
        orderReference: COLLECT_CORRELATION.orderReference,
        status: 'succeeded',
      });
      const { adapter, sent } = yield* harness([
        respond(200, JSON.stringify(refund)),
        respond(200, JSON.stringify(live)),
        respond(404, JSON.stringify(stripeResourceMissingError)),
      ]);
      const refOf = Schema.decodeUnknownSync(ProviderObjectRefSchema);
      const refundRef = refOf({ _tag: 'STRIPE_REFUND', id: STRIPE_FIXTURE_REFUND_ID });
      const intentRef = refOf({ _tag: 'STRIPE_PAYMENT_INTENT', id: STRIPE_FIXTURE_PAYMENT_INTENT_ID });
      expect(yield* adapter.readOrderReference(SANDBOX_TARGET, refundRef)).toEqual(
        Option.some(REFUND_CORRELATION.orderReference),
      );
      // A LIVE object read for a SANDBOX binding and a missing object state nothing.
      expect(yield* adapter.readOrderReference(SANDBOX_TARGET, intentRef)).toEqual(Option.none());
      expect(yield* adapter.readOrderReference(SANDBOX_TARGET, intentRef)).toEqual(Option.none());
      const gopayRef = refOf({ _tag: 'GOPAY_PAYMENT', id: '3000006529' });
      expect(yield* adapter.readOrderReference(SANDBOX_TARGET, gopayRef)).toEqual(Option.none());
      expect(sent.map((call) => call.request.url)).toEqual([
        `https://api.stripe.com/v1/refunds/${STRIPE_FIXTURE_REFUND_ID}`,
        `https://api.stripe.com/v1/payment_intents/${STRIPE_FIXTURE_PAYMENT_INTENT_ID}`,
        `https://api.stripe.com/v1/payment_intents/${STRIPE_FIXTURE_PAYMENT_INTENT_ID}`,
      ]);
    }),
  );
});

// ---------------------------------------------------------------------------------------------------
// Refund and cancel
// ---------------------------------------------------------------------------------------------------

describe('#1156 Stripe refund and cancel', () => {
  it.effect('#1156 A refund names the PaymentIntent, the amount and the order reference', () =>
    Effect.gen(function* refundBody() {
      const refund = stripeRefundObject({ orderReference: REFUND_CORRELATION.orderReference, status: 'pending' });
      const { adapter, sent } = yield* harness([respond(200, JSON.stringify(refund))]);
      const prepared = yield* adapter.prepareRefund(SANDBOX_TARGET, refundRequest);
      const response = yield* adapter.send(SANDBOX_TARGET, prepared, refundExpected);

      expect(formOf(prepared.body)).toEqual([
        ['payment_intent', STRIPE_FIXTURE_PAYMENT_INTENT_ID],
        ['amount', '50000'],
        ['metadata[ontos_order_reference]', REFUND_CORRELATION.orderReference],
      ]);
      expect(dispatchOutcomeOf(response)).toBe('ACKNOWLEDGED');
      expect(response.finding.finding).toBe('ACCEPTED_PENDING');
      expect(sent[0]?.request.url).toBe('https://api.stripe.com/v1/refunds');
      expect(sent[0]?.request.headers['idempotency-key']).toBe(REFUND_CORRELATION.idempotencyKey);
    }),
  );

  it.effect('#1156 A refund against a Checkout Session ref is UNAVAILABLE (needs the PaymentIntent)', () =>
    Effect.gen(function* refundSessionTarget() {
      const { adapter } = yield* harness([]);
      const error = yield* failureOf(
        adapter.prepareRefund(SANDBOX_TARGET, {
          ...refundRequest,
          providerTarget: cancelRequest.providerTarget,
        }),
      );

      expect(error).toMatchObject({
        code: 'gateway_provider_unavailable',
        reason: 'stripe_refund_target_not_payment_intent',
      });
    }),
  );

  it.effect('#1156 Expiring an open session confirms the cancel', () =>
    Effect.gen(function* expireOpen() {
      const expired = stripeCheckoutSessionObject({
        orderReference: COLLECT_CORRELATION.orderReference,
        paymentIntent: null,
        paymentStatus: 'unpaid',
        status: 'expired',
      });
      const { adapter, sent } = yield* harness([respond(200, JSON.stringify(expired))]);
      const prepared = yield* adapter.prepareCancel(SANDBOX_TARGET, cancelRequest);
      const response = yield* adapter.send(SANDBOX_TARGET, prepared, cancelExpected);

      expect(prepared.endpointRef).toBe(`stripe:POST:/v1/checkout/sessions/${STRIPE_FIXTURE_SESSION_ID}/expire`);
      expect(prepared.body).toHaveLength(0);
      expect(dispatchOutcomeOf(response)).toBe('ACKNOWLEDGED');
      expect(response.finding).toMatchObject({
        finding: 'EFFECT_CONFIRMED',
        target: { operationId: CANCEL_OPERATION_ID, operationKind: 'CANCEL_OR_VOID' },
      });
      // No PaymentIntent was ever created: the expired session also proves the collection not effected.
      expect(
        response.targetFinding.pipe(
          Option.map((found) => [
            found.target.operationId,
            found.finding,
            found.evidence.pipe(Option.map((evidence) => evidence.factKind)),
          ]),
        ),
      ).toEqual(Option.some([COLLECT_OPERATION_ID, 'NOT_EFFECTED', Option.some('COLLECTION_NOT_EFFECTED')]));
      expect(sent[0]?.request.headers['idempotency-key']).toBe(
        deriveProviderCorrelation(operationIdOf(CANCEL_OPERATION_ID)).idempotencyKey,
      );
    }),
  );

  it.effect('#1156 A "not open" expire is decided by lookup: a paid session is CANCEL_NOT_EFFECTED', () =>
    Effect.gen(function* expireNotOpen() {
      const paid = stripeCheckoutSessionObject({
        orderReference: COLLECT_CORRELATION.orderReference,
        paymentIntent: stripePaymentIntentObject({
          orderReference: COLLECT_CORRELATION.orderReference,
          status: 'succeeded',
        }),
        paymentStatus: 'paid',
        status: 'complete',
      });
      const { adapter, sent } = yield* harness([
        respond(400, JSON.stringify({ error: { type: 'invalid_request_error' } })),
        respond(200, JSON.stringify(paid)),
      ]);
      const prepared = yield* adapter.prepareCancel(SANDBOX_TARGET, cancelRequest);
      const response = yield* adapter.send(SANDBOX_TARGET, prepared, cancelExpected);

      expect(dispatchOutcomeOf(response)).toBe('REJECTED_BEFORE_EFFECT');
      expect(response.finding.finding).toBe('NOT_EFFECTED');
      expect(response.finding.evidence.pipe(Option.map((evidence) => evidence.factKind))).toEqual(
        Option.some('CANCEL_NOT_EFFECTED'),
      );
      // The same lookup proved the collection paid: that proof travels with the refused cancel.
      expect(
        response.targetFinding.pipe(
          Option.map((found) => [
            found.target.operationId,
            found.finding,
            found.evidence.pipe(Option.map((evidence) => evidence.factKind)),
          ]),
        ),
      ).toEqual(Option.some([COLLECT_OPERATION_ID, 'EFFECT_CONFIRMED', Option.some('COLLECTION_CONFIRMED')]));
      expect(sent.map((recorded) => recorded.kind)).toEqual(['mutate', 'read']);
    }),
  );

  it.effect('#1156 The real paid-session expire refusal (no error.code) is decided by lookup, never confirmed', () =>
    Effect.gen(function* expirePaidSandboxBody() {
      const paid = stripeCheckoutSessionObject({
        orderReference: COLLECT_CORRELATION.orderReference,
        paymentIntent: stripePaymentIntentObject({
          orderReference: COLLECT_CORRELATION.orderReference,
          status: 'succeeded',
        }),
        paymentStatus: 'paid',
        status: 'complete',
      });
      const { adapter, sent } = yield* harness([
        respond(400, JSON.stringify(stripePaidSessionExpireError)),
        respond(200, JSON.stringify(paid)),
      ]);
      const prepared = yield* adapter.prepareCancel(SANDBOX_TARGET, cancelRequest);
      const response = yield* adapter.send(SANDBOX_TARGET, prepared, cancelExpected);

      expect(Object.keys(stripePaidSessionExpireError.error)).not.toContain('code');
      expect(dispatchOutcomeOf(response)).toBe('REJECTED_BEFORE_EFFECT');
      expect(response.finding.finding).toBe('NOT_EFFECTED');
      expect(response.finding.evidence.pipe(Option.map((evidence) => evidence.factKind))).toEqual(
        Option.some('CANCEL_NOT_EFFECTED'),
      );
      expect(
        response.targetFinding.pipe(
          Option.map((found) => [
            found.target.operationId,
            found.finding,
            found.evidence.pipe(Option.map((evidence) => evidence.factKind)),
          ]),
        ),
      ).toEqual(Option.some([COLLECT_OPERATION_ID, 'EFFECT_CONFIRMED', Option.some('COLLECTION_CONFIRMED')]));
      expect(sent.map((recorded) => recorded.kind)).toEqual(['mutate', 'read']);
      expect(sent[1]?.request.url).toBe(`https://api.stripe.com/v1/checkout/sessions/${STRIPE_FIXTURE_SESSION_ID}`);
    }),
  );
});

// ---------------------------------------------------------------------------------------------------
// Notification
// ---------------------------------------------------------------------------------------------------

const SIGNED_AT_SECONDS = 1_762_992_000;

const notificationOf = (rawBody: Uint8Array, signature: string, providerAccountRef = PROVIDER_ACCOUNT_REF) =>
  Schema.decodeUnknownSync(RawProviderNotificationSchema)({
    environment: 'SANDBOX',
    family: 'STRIPE',
    headers: { contentType: Option.some('application/json'), stripeSignature: Option.some(signature) },
    providerAccountRef,
    query: { parentPaymentRef: Option.none(), paymentRef: Option.none() },
    rawBody,
    receivedAt: DateTime.makeUnsafe(SIGNED_AT_SECONDS * 1000),
    transportDeliveryRef: 'relay-delivery-1',
  });

const signatureOf = (rawBody: Uint8Array) => {
  const prefix = utf8ToBytes(`${SIGNED_AT_SECONDS}.`);
  const signed = new Uint8Array(prefix.length + rawBody.length);
  signed.set(prefix);
  signed.set(rawBody, prefix.length);
  return `t=${SIGNED_AT_SECONDS},v1=${bytesToHex(hmac(sha256, utf8ToBytes(WEBHOOK_SECRET), signed))}`;
};

describe('#1157 Stripe notification verification', () => {
  it.effect('#1157 A signed event addressed to this binding is verified with the binding secret', () =>
    Effect.gen(function* signedEvent() {
      const { adapter, sent } = yield* harness([]);
      yield* TestClock.setTime(SIGNED_AT_SECONDS * 1000 + 5000);
      const rawBody = utf8ToBytes(
        JSON.stringify(
          stripeEventEnvelope({
            object: stripePaymentIntentObject({
              orderReference: COLLECT_CORRELATION.orderReference,
              status: 'succeeded',
            }),
            type: 'payment_intent.succeeded',
          }),
        ),
      );
      const trigger = yield* adapter.verifyNotification(SANDBOX_TARGET, notificationOf(rawBody, signatureOf(rawBody)));
      const foreign = yield* failureOf(
        adapter.verifyNotification(
          SANDBOX_TARGET,
          notificationOf(rawBody, signatureOf(rawBody), 'pab_ffffffffffffffffffffffffffffffff'),
        ),
      );
      const tampered = yield* failureOf(
        adapter.verifyNotification(SANDBOX_TARGET, notificationOf(utf8ToBytes('{}'), signatureOf(rawBody))),
      );

      expect(trigger).toMatchObject({ actionable: true, authenticity: 'SIGNATURE_VERIFIED', family: 'STRIPE' });
      // The worker re-reads the signed object from the exact signed bytes, so an actionable event keeps them.
      expect(trigger.retainedBody).toEqual(rawBody);
      expect(foreign).toMatchObject({ code: 'gateway_notification_rejected', reason: 'BINDING_UNKNOWN' });
      expect(tampered).toMatchObject({ code: 'gateway_notification_rejected', reason: 'SIGNATURE_INVALID' });
      expect(sent).toHaveLength(0);
    }),
  );
});
