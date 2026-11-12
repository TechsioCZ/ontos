import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { Context, DateTime, Effect, Layer, Match, Option, Redacted, Result, Schema } from 'effect';
import { Hex } from 'effect/encoding';
import { HttpClient, HttpClientError, HttpClientResponse } from 'effect/http';
import type { HttpClientRequest } from 'effect/http';
import { TestClock } from 'effect/testing';
import { describe, expect, it } from 'effect-rstest';

import { GopayOAuthTokenLive } from '../../src/integrations/gopay/gopay-oauth-token.ts';
import { GopayPaymentService, GopayPaymentServiceLive } from '../../src/integrations/gopay/gopay-payment.service.ts';
import { GopayClientIdSchema, ProviderCredentialStore } from '../../src/integrations/psp/credentials.ts';
import { ProviderHttpLive } from '../../src/integrations/psp/provider-http-live.ts';
import { deriveProviderCorrelation } from '../../src/integrations/psp/psp-correlation.ts';
import {
  GatewayProviderOutcomeUnknown,
  GatewayProviderUnavailable,
  GatewayProviderUnsupported,
} from '../../src/integrations/psp/psp-errors.ts';
import { ProviderObjectRefSchema } from '../../src/integrations/psp/psp-request.ts';
import type {
  GatewayCancelRequest,
  GatewayCollectRequest,
  GatewayExecutionTarget,
  GatewayExpectedEffect,
  GatewayLookupRequest,
  GatewayRefundRequest,
  ProviderObjectRef,
} from '../../src/integrations/psp/psp-request.ts';
import { ProviderDispatchResponseSchema } from '../../src/integrations/psp/psp-result.ts';
import type { ProviderDispatchResponse, ProviderFindingResult } from '../../src/integrations/psp/psp-result.ts';
import { gopayExecutionTarget } from '../fixtures/gopay/execution-target.ts';
import {
  GOPAY_FIXTURE_GATEWAY_URL,
  GOPAY_FIXTURE_GOID,
  GOPAY_FIXTURE_PAYMENT_ID,
  GOPAY_FIXTURE_PAYMENT_SECRET,
  gopayConflictBody,
  gopayCreateResponseBody,
  gopayNotFoundBody,
  gopayPaymentBody,
} from '../fixtures/gopay/payment-responses.ts';
import { GOPAY_FIXTURE_REFUND_ID, gopayRefundBody, gopayRefundListBody } from '../fixtures/gopay/refund-responses.ts';

/**
 * GoPay Payments API v4 adapter against a recorded HttpClient (#1154, #1156, #1158, #1159). Each provider route
 * answers from its own script, and every request GoPay would have seen is recorded, so "never resent", "always
 * looked up" and "token reused" are counted, not assumed. Bodies are the documented v4 shapes (tests/fixtures/gopay).
 */

const SANDBOX = 'https://gw.sandbox.gopay.com/gp-gw/api/4.0';
const TOKEN_ROUTE = `POST ${SANDBOX}/oauth2/token`;
const CREATE_ROUTE = `POST ${SANDBOX}/eshops/${GOPAY_FIXTURE_GOID}/payments`;
const PAYMENT_ROUTE = `GET ${SANDBOX}/payments/${GOPAY_FIXTURE_PAYMENT_ID}`;
const CANCEL_ROUTE = `DELETE ${SANDBOX}/payments/${GOPAY_FIXTURE_PAYMENT_ID}`;
const REFUND_ROUTE = `POST ${SANDBOX}/payments/${GOPAY_FIXTURE_PAYMENT_ID}/refunds`;
const REFUND_LIST_ROUTE = `GET ${SANDBOX}/payments/${GOPAY_FIXTURE_PAYMENT_ID}/refunds`;
const REFUND_DETAIL_ROUTE = `GET ${SANDBOX}/refunds/${GOPAY_FIXTURE_REFUND_ID}`;

const CLIENT_ID = 'gopay-client-fixture';
const CLIENT_SECRET = 'gopay-secret-fixture-91c2';
const ACCESS_TOKEN = 'gopay-access-token-fixture';

const collectOperationId = '0f8b5c1e-3a2d-4c7b-9e1f-5a6b7c8d9e0f';
const refundOperationId = '6c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f';
const cancelOperationId = '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b';
const paymentId = '3f2e1d0c-9b8a-4f7e-8d6c-5b4a39281706';
const returnToken = 'AbCdEfGhIjKlMnOpQrSt_-';
const collectCorrelation = deriveProviderCorrelation(collectOperationId);
const { orderReference } = collectCorrelation;
const czk = (amountMinor: number) => ({ amountMinor, currency: 'CZK' as const });

const RespondStepSchema = Schema.TaggedStruct('Respond', { body: Schema.String, status: Schema.Finite });
const FailStepSchema = Schema.TaggedStruct('Fail', { code: Schema.String });
const StepSchema = Schema.Union([RespondStepSchema, FailStepSchema]);
type Step = typeof StepSchema.Type;

const respond = (status: number, body = '{}'): Step => RespondStepSchema.make({ body, status });
const fail = (code: string): Step => FailStepSchema.make({ code });
const noContent = respond(204, '');
const tokenResponse = (expiresIn = 900) =>
  respond(
    200,
    `{"token_type":"bearer","access_token":"${ACCESS_TOKEN}","scope":"payment:read payment:write","expires_in":${expiresIn}}`,
  );
const paymentIn = (state: string, amount = 10_000) =>
  respond(200, gopayPaymentBody({ amount, orderNumber: orderReference, state }));

interface SentRequest {
  readonly authorization: string;
  readonly body: string;
  readonly contentType: string;
  readonly route: string;
}

const bodyTextOf = (request: HttpClientRequest.HttpClientRequest): string =>
  Match.value(request.body).pipe(
    Match.tag('Uint8Array', ({ body }) => new TextDecoder().decode(body)),
    Match.orElse(() => ''),
  );

const runStep = (request: HttpClientRequest.HttpClientRequest, step: Step) =>
  Match.value(step).pipe(
    Match.tag('Fail', ({ code }) =>
      Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({
            cause: new TypeError('fetch failed', { cause: Object.assign(new Error(`socket ${code}`), { code }) }),
            request,
          }),
        }),
      ),
    ),
    Match.tag('Respond', ({ body, status }) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, new Response(status === 204 ? null : body, { status }))),
    ),
    Match.exhaustive,
  );

/** A GoPay gateway that answers each route from its own script (unscripted calls answer 599). */
const recordedGopay = (routes: Readonly<Record<string, readonly Step[]>>) =>
  Effect.gen(function* recordedGopayEffect() {
    const sent: SentRequest[] = [];
    const credentialResolutions: string[] = [];
    const client = HttpClient.make((request) => {
      const route = `${request.method} ${request.url}`;
      const attempt = sent.filter((entry) => entry.route === route).length;
      sent.push({
        authorization: request.headers.authorization ?? '',
        body: bodyTextOf(request),
        contentType: request.headers['content-type'] ?? '',
        route,
      });
      return runStep(request, routes[route]?.[attempt] ?? respond(599, 'unscripted'));
    });
    const credentials = Layer.succeed(ProviderCredentialStore, {
      resolve: ({ secretRef }) => {
        credentialResolutions.push(secretRef);
        return Effect.succeed({
          _tag: 'GOPAY' as const,
          clientId: GopayClientIdSchema.make(CLIENT_ID),
          clientSecret: Redacted.make(CLIENT_SECRET),
        });
      },
    });
    const transport = Layer.merge(
      ProviderHttpLive.pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, client))),
      credentials,
    );
    const context = yield* Layer.build(
      GopayPaymentServiceLive.pipe(Layer.provide(GopayOAuthTokenLive), Layer.provide(transport)),
    );
    const callsTo = (route: string) => sent.filter((entry) => entry.route === route);
    return { adapter: Context.get(context, GopayPaymentService), callsTo, credentialResolutions, sent };
  });

const target = gopayExecutionTarget();
const paymentRef: ProviderObjectRef = Schema.decodeUnknownSync(ProviderObjectRefSchema)({
  _tag: 'GOPAY_PAYMENT',
  id: GOPAY_FIXTURE_PAYMENT_ID,
});
const refundRef: ProviderObjectRef = Schema.decodeUnknownSync(ProviderObjectRefSchema)({
  _tag: 'GOPAY_REFUND',
  id: GOPAY_FIXTURE_REFUND_ID,
  paymentId: GOPAY_FIXTURE_PAYMENT_ID,
});

const payerContact = (email: string) =>
  Option.some({ email: Option.some(email), fullName: Option.none(), phone: Option.none() });

const collectRequestFor = (amountMinor: number): GatewayCollectRequest => ({
  amount: czk(amountMinor),
  correlation: collectCorrelation,
  issuedAt: DateTime.makeUnsafe('2026-11-12T10:00:00.000Z'),
  operationId: collectOperationId,
  payerContact: payerContact('payer@example.test'),
  paymentId,
  returnToken,
});
const collectRequest = collectRequestFor(10_000);
const collectExpectedFor = (amountMinor: number): GatewayExpectedEffect => ({
  _tag: 'COLLECT',
  amount: czk(amountMinor),
  operationId: collectOperationId,
});
const collectExpected = collectExpectedFor(10_000);

const refundRequest: GatewayRefundRequest = {
  amount: czk(4000),
  correlation: deriveProviderCorrelation(refundOperationId),
  operationId: refundOperationId,
  providerTarget: paymentRef,
  refundBasisKind: 'REFUNDABLE_ITEMS',
  targetOperationId: collectOperationId,
};
const refundExpected: GatewayExpectedEffect = { _tag: 'REFUND', amount: czk(4000), operationId: refundOperationId };

const cancelRequest: GatewayCancelRequest = {
  operationId: cancelOperationId,
  providerTarget: paymentRef,
  targetOperationId: collectOperationId,
};
const cancelExpected: GatewayExpectedEffect = {
  _tag: 'CANCEL_OR_VOID',
  operationId: cancelOperationId,
  target: { amount: czk(10_000), operationId: collectOperationId },
};

const dispatchedAt = DateTime.makeUnsafe('2026-11-12T10:00:00.000Z');
const lookupRequest = (expected: GatewayExpectedEffect, ref: ProviderObjectRef = paymentRef): GatewayLookupRequest => ({
  dispatchedAt: Option.some(dispatchedAt),
  expected,
  target: { _tag: 'PROVIDER_OBJECT', ref },
});

const dispatchOutcomeOf = (response: ProviderDispatchResponse) =>
  Match.value(response).pipe(
    Match.tag('ACKNOWLEDGED', () => 'ACKNOWLEDGED' as const),
    Match.tag('REJECTED_BEFORE_EFFECT', () => 'REJECTED_BEFORE_EFFECT' as const),
    Match.exhaustive,
  );

const factKindOf = (finding: ProviderFindingResult | undefined) =>
  Option.fromUndefinedOr(finding).pipe(
    Option.flatMap(({ evidence }) => evidence),
    Option.map(({ factKind }) => factKind),
  );

const encodeResponse = Schema.encodeSync(Schema.fromJsonString(ProviderDispatchResponseSchema));
const decodeJsonObject = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)));
const expectedBasicAuthorization = `Basic ${btoa([CLIENT_ID, CLIENT_SECRET].join(':'))}`;

describe('#1154 GoPay v4 collect', () => {
  it.effect('#1154 GoPay one-shot create never requests preauthorization or recurrence', () =>
    Effect.gen(function* oneShotCreate() {
      const gopay = yield* recordedGopay({
        [CREATE_ROUTE]: [respond(201, gopayCreateResponseBody(orderReference))],
        [TOKEN_ROUTE]: [tokenResponse()],
      });
      const prepared = yield* gopay.adapter.prepareCollect(target, collectRequest);
      // Preparation is pure: nothing reached GoPay and no credential was read.
      expect(gopay.sent).toHaveLength(0);
      expect(gopay.credentialResolutions).toHaveLength(0);

      const bodyText = new TextDecoder().decode(prepared.body);
      const body = decodeJsonObject(bodyText);
      expect(new Set(Object.keys(body))).toEqual(
        new Set(['amount', 'callback', 'currency', 'customer', 'order_number']),
      );
      for (const fragment of ['preauthorization', 'recurrence', 'order_description', 'first_name', 'phone', 'lang']) {
        expect(bodyText).not.toContain(fragment);
      }
      expect(body).toEqual({
        amount: 10_000,
        callback: {
          notification_url: 'https://payments.example.test/gopay/notify',
          return_url: `https://shop.example.test/return?r=${returnToken}`,
        },
        currency: 'CZK',
        customer: { email: 'payer@example.test' },
        order_number: orderReference,
      });
      expect(prepared).toMatchObject({
        endpointRef: `gopay:POST:/eshops/${GOPAY_FIXTURE_GOID}/payments`,
        family: 'GOPAY',
        headers: [
          { name: 'accept', value: 'application/json' },
          { name: 'content-type', value: 'application/json' },
        ],
        orderReference,
      });
      expect(Option.isNone(prepared.idempotencyKey)).toBe(true);
      expect(Option.isNone(prepared.replayWindowMs)).toBe(true);
      expect(prepared.requestHash).toBe(
        Hex.encode(
          sha256(
            concatBytes(
              utf8ToBytes(
                `gopay:POST:/eshops/${GOPAY_FIXTURE_GOID}/payments\naccept:application/json\ncontent-type:application/json\n\n`,
              ),
              prepared.body,
            ),
          ),
        ),
      );
      // The same input prepares the same bytes.
      expect((yield* gopay.adapter.prepareCollect(target, collectRequest)).requestHash).toBe(prepared.requestHash);

      const response = yield* gopay.adapter.send(target, prepared, collectExpected);
      expect(dispatchOutcomeOf(response)).toBe('ACKNOWLEDGED');
      expect(response.finding).toMatchObject({
        customerAction: Option.some({ redirectUrl: GOPAY_FIXTURE_GATEWAY_URL }),
        finding: 'CUSTOMER_ACTION_REQUIRED',
        providerRefs: [{ _tag: 'GOPAY_PAYMENT', id: GOPAY_FIXTURE_PAYMENT_ID }],
        target: { operationId: collectOperationId, operationKind: 'COLLECT' },
      });
      // The per-payment `payment_secret` is never kept in anything the adapter returns.
      expect(encodeResponse(response)).not.toContain(GOPAY_FIXTURE_PAYMENT_SECRET);
      const [create] = gopay.callsTo(CREATE_ROUTE);
      expect(gopay.callsTo(CREATE_ROUTE)).toHaveLength(1);
      expect(create?.body).toBe(bodyText);
      expect(create?.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
      expect(create?.contentType).toBe('application/json');
    }),
  );

  it.effect('#1156 GoPay exact money 1 599,50 CZK round trip', () =>
    Effect.gen(function* exactMoney() {
      const gopay = yield* recordedGopay({
        [CREATE_ROUTE]: [respond(201, gopayCreateResponseBody(orderReference, 159_950))],
        [PAYMENT_ROUTE]: [paymentIn('PAID', 159_950)],
        [TOKEN_ROUTE]: [tokenResponse()],
      });
      const prepared = yield* gopay.adapter.prepareCollect(target, collectRequestFor(159_950));
      expect(decodeJsonObject(new TextDecoder().decode(prepared.body)).amount).toBe(159_950);
      const created = yield* gopay.adapter.send(target, prepared, collectExpectedFor(159_950));
      expect(created.finding.finding).toBe('CUSTOMER_ACTION_REQUIRED');
      const [paid] = yield* gopay.adapter.lookup(target, lookupRequest(collectExpectedFor(159_950)));
      expect(paid?.finding).toBe('EFFECT_CONFIRMED');
      expect(paid?.evidence.pipe(Option.flatMap(({ observedAmount }) => observedAmount))).toEqual(
        Option.some(czk(159_950)),
      );
    }),
  );

  it.effect('#1154 A GoPay collect without a usable payer email is UNAVAILABLE before anything is prepared', () =>
    Effect.gen(function* noPayerEmail() {
      const gopay = yield* recordedGopay({});
      for (const contact of [
        Option.none(),
        Option.some({ email: Option.none(), fullName: Option.some('Payer Example'), phone: Option.none() }),
        payerContact(`${'a'.repeat(120)}@example.test`),
      ]) {
        const error = yield* Effect.flip(
          gopay.adapter.prepareCollect(target, { ...collectRequest, payerContact: contact }),
        );
        expect(Schema.is(GatewayProviderUnavailable)(error)).toBe(true);
        expect(error).toMatchObject({ family: 'GOPAY', reason: 'payer_contact_unavailable' });
      }
      expect(gopay.sent).toHaveLength(0);
    }),
  );

  it.effect('#1154 Response for another order or amount is a verification conflict', () =>
    Effect.gen(function* foreignOrder() {
      const gopay = yield* recordedGopay({
        [CREATE_ROUTE]: [
          respond(201, gopayCreateResponseBody('2025010199')),
          respond(201, gopayCreateResponseBody(orderReference, 9900)),
        ],
        [PAYMENT_ROUTE]: [respond(200, gopayPaymentBody({ orderNumber: '2025010199', state: 'PAID' }))],
        [TOKEN_ROUTE]: [tokenResponse()],
      });
      const prepared = yield* gopay.adapter.prepareCollect(target, collectRequest);
      const otherOrder = (yield* gopay.adapter.send(target, prepared, collectExpected)).finding;
      expect(otherOrder.finding).toBe('VERIFICATION_CONFLICT');
      expect(Option.isNone(otherOrder.evidence)).toBe(true);
      expect(Option.isNone(otherOrder.customerAction)).toBe(true);
      expect(otherOrder.providerRefs).toEqual([]);
      const otherAmount = (yield* gopay.adapter.send(target, prepared, collectExpected)).finding;
      expect(otherAmount.finding).toBe('VERIFICATION_CONFLICT');
      expect(Option.isNone(otherAmount.customerAction)).toBe(true);

      const [looked] = yield* gopay.adapter.lookup(target, lookupRequest(collectExpected));
      expect(looked?.finding).toBe('VERIFICATION_CONFLICT');
      expect(looked?.evidence).toEqual(Option.none());
    }),
  );

  it.effect('#1154 A create GoPay refuses with a 4xx is REJECTED_BEFORE_EFFECT with COLLECTION_NOT_EFFECTED', () =>
    Effect.gen(function* createRejected() {
      const gopay = yield* recordedGopay({
        [CREATE_ROUTE]: [respond(400, '{"code":400,"error":"BAD_REQUEST","message":"Invalid request parameter"}')],
        [TOKEN_ROUTE]: [tokenResponse()],
      });
      const prepared = yield* gopay.adapter.prepareCollect(target, collectRequest);
      const response = yield* gopay.adapter.send(target, prepared, collectExpected);
      expect(dispatchOutcomeOf(response)).toBe('REJECTED_BEFORE_EFFECT');
      expect(response.finding).toMatchObject({
        evidence: Option.some({
          factFamily: 'GATEWAY_OUTCOME',
          factKind: 'COLLECTION_NOT_EFFECTED',
          reason: Option.some('gopay_request_rejected'),
          sourceOccurrenceId: `gopay:dispatch_response:none:${collectOperationId}:COLLECTION_NOT_EFFECTED:10000`,
        }),
        finding: 'NOT_EFFECTED',
      });
    }),
  );

  it.effect('#1154 A collect without an enablement return URL is UNAVAILABLE before anything is sent', () =>
    Effect.gen(function* noReturnUrl() {
      const gopay = yield* recordedGopay({});
      const withoutReturn: GatewayExecutionTarget = { ...target, returnUrl: Option.none() };
      const error = yield* Effect.flip(gopay.adapter.prepareCollect(withoutReturn, collectRequest));
      expect(Schema.is(GatewayProviderUnavailable)(error)).toBe(true);
      expect(error).toMatchObject({ family: 'GOPAY', reason: 'return_url_unavailable' });
      expect(gopay.sent).toHaveLength(0);
    }),
  );
});

describe('#1158 GoPay mutations are sent once', () => {
  it.effect('#1158 Lost GoPay create response is OUTCOME_UNKNOWN and never resent', () =>
    Effect.gen(function* lostCreateResponse() {
      for (const lost of [fail('ECONNRESET'), respond(503, 'unavailable'), respond(201, '<html>gateway</html>')]) {
        const gopay = yield* recordedGopay({
          [CREATE_ROUTE]: [lost, respond(201, gopayCreateResponseBody(orderReference))],
          [TOKEN_ROUTE]: [tokenResponse()],
        });
        const prepared = yield* gopay.adapter.prepareCollect(target, collectRequest);
        const error = yield* Effect.flip(gopay.adapter.send(target, prepared, collectExpected));
        expect(Schema.is(GatewayProviderOutcomeUnknown)(error)).toBe(true);
        expect(error).toMatchObject({ family: 'GOPAY', operationId: collectOperationId });
        expect(error.reason).not.toContain(ACCESS_TOKEN);
        yield* TestClock.adjust('1 minute');
        expect(gopay.callsTo(CREATE_ROUTE)).toHaveLength(1);
      }
    }),
  );

  it.effect('#1158 Token is reused across operations of the same credential revision', () =>
    Effect.gen(function* tokenReuse() {
      const gopay = yield* recordedGopay({
        [CREATE_ROUTE]: [respond(201, gopayCreateResponseBody(orderReference))],
        [PAYMENT_ROUTE]: [paymentIn('PAID'), paymentIn('PAID'), paymentIn('PAID')],
        [TOKEN_ROUTE]: [tokenResponse(), tokenResponse(), tokenResponse()],
      });
      const prepared = yield* gopay.adapter.prepareCollect(target, collectRequest);
      yield* gopay.adapter.send(target, prepared, collectExpected);
      yield* gopay.adapter.lookup(target, lookupRequest(collectExpected));
      expect(gopay.callsTo(TOKEN_ROUTE)).toHaveLength(1);
      const [tokenCall] = gopay.callsTo(TOKEN_ROUTE);
      expect(tokenCall?.authorization).toBe(expectedBasicAuthorization);
      expect(tokenCall?.body).toBe('grant_type=client_credentials&scope=payment:read%20payment:write');
      expect(tokenCall?.contentType).toBe('application/x-www-form-urlencoded');

      // A rotated credential is a new revision of the same binding: it gets its own token.
      yield* gopay.adapter.lookup({ ...target, credentialRevision: 2 }, lookupRequest(collectExpected));
      expect(gopay.callsTo(TOKEN_ROUTE)).toHaveLength(2);

      // The token is dropped 60 s before GoPay's expires_in (900 s).
      yield* TestClock.adjust('841 seconds');
      yield* gopay.adapter.lookup(target, lookupRequest(collectExpected));
      expect(gopay.callsTo(TOKEN_ROUTE)).toHaveLength(3);
    }),
  );

  it.effect('#1158 A token GoPay refuses is dropped and the lookup is UNAVAILABLE', () =>
    Effect.gen(function* refusedToken() {
      const gopay = yield* recordedGopay({
        [PAYMENT_ROUTE]: [respond(401, '{"code":401,"error":"UNAUTHORIZED"}'), paymentIn('PAID')],
        [TOKEN_ROUTE]: [tokenResponse(), tokenResponse()],
      });
      const error = yield* Effect.flip(gopay.adapter.lookup(target, lookupRequest(collectExpected)));
      expect(Schema.is(GatewayProviderUnavailable)(error)).toBe(true);
      expect(error).toMatchObject({ reason: 'gopay_authorization_rejected' });

      const [finding] = yield* gopay.adapter.lookup(target, lookupRequest(collectExpected));
      expect(finding?.finding).toBe('EFFECT_CONFIRMED');
      expect(gopay.callsTo(TOKEN_ROUTE)).toHaveLength(2);
    }),
  );

  it.effect('#1158 A refused token request is UNAVAILABLE and nothing is created', () =>
    Effect.gen(function* tokenRefused() {
      const gopay = yield* recordedGopay({ [TOKEN_ROUTE]: [respond(401, '{"code":401,"error":"UNAUTHORIZED"}')] });
      const prepared = yield* gopay.adapter.prepareCollect(target, collectRequest);
      const error = yield* Effect.flip(gopay.adapter.send(target, prepared, collectExpected));
      expect(Schema.is(GatewayProviderUnavailable)(error)).toBe(true);
      expect(error).toMatchObject({ reason: 'gopay_token_rejected' });
      expect(gopay.callsTo(CREATE_ROUTE)).toHaveLength(0);
    }),
  );

  it.effect('#1158 GoPay lookup of a missing payment is INDETERMINATE, never NOT_EFFECTED', () =>
    Effect.gen(function* lookupMiss() {
      const gopay = yield* recordedGopay({
        [PAYMENT_ROUTE]: [respond(404, gopayNotFoundBody)],
        [TOKEN_ROUTE]: [tokenResponse()],
      });
      const findings = yield* gopay.adapter.lookup(target, lookupRequest(collectExpected));
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({ evidence: Option.none(), finding: 'INDETERMINATE' });
    }),
  );
});

/** One cancel: prepare, a single send (DELETE then the scripted lookups), and its result. */
const cancelCase = (deleteStep: Step, lookupSteps: readonly Step[]) =>
  Effect.gen(function* cancelCaseEffect() {
    const gopay = yield* recordedGopay({
      [CANCEL_ROUTE]: [deleteStep, noContent],
      [PAYMENT_ROUTE]: lookupSteps,
      [TOKEN_ROUTE]: [tokenResponse()],
    });
    const prepared = yield* gopay.adapter.prepareCancel(target, cancelRequest);
    const result = yield* Effect.result(gopay.adapter.send(target, prepared, cancelExpected));
    // Exactly one DELETE, whatever it answered.
    expect(gopay.callsTo(CANCEL_ROUTE)).toHaveLength(1);
    return { gopay, prepared, result };
  });

describe('#1159 GoPay v4 cancel of a pending payment', () => {
  it.effect('#1159 GoPay cancel 204 then lookup CANCELED is CANCEL_CONFIRMED and the collection not effected', () =>
    Effect.gen(function* cancelConfirmed() {
      const { gopay, prepared, result } = yield* cancelCase(noContent, [paymentIn('CANCELED')]);
      expect(prepared).toMatchObject({
        endpointRef: `gopay:DELETE:/payments/${GOPAY_FIXTURE_PAYMENT_ID}`,
        family: 'GOPAY',
        headers: [{ name: 'accept', value: 'application/json' }],
      });
      expect(prepared.body).toEqual(new Uint8Array());
      expect(gopay.adapter.capabilities.CANCEL_OR_VOID).toBe('SUPPORTED');
      const response = Result.getOrThrow(result);
      expect(dispatchOutcomeOf(response)).toBe('ACKNOWLEDGED');
      expect(response.finding).toMatchObject({
        finding: 'EFFECT_CONFIRMED',
        target: { operationId: cancelOperationId, operationKind: 'CANCEL_OR_VOID' },
      });
      expect(factKindOf(response.finding)).toEqual(Option.some('CANCEL_CONFIRMED'));
      const targetFinding = Option.getOrUndefined(response.targetFinding);
      expect(targetFinding?.target).toEqual({ operationId: collectOperationId, operationKind: 'COLLECT' });
      expect(factKindOf(targetFinding)).toEqual(Option.some('COLLECTION_NOT_EFFECTED'));
      expect(gopay.sent.map(({ route }) => route)).toEqual([TOKEN_ROUTE, CANCEL_ROUTE, PAYMENT_ROUTE]);
    }),
  );

  it.effect('#1159 GoPay cancel answers are decided by the lookup that follows them', () =>
    Effect.gen(function* cancelTable() {
      const cases = [
        // [DELETE, lookup state, dispatch outcome, cancel finding, cancel fact, target fact]
        [noContent, 'PAYMENT_METHOD_CHOSEN', 'ACKNOWLEDGED', 'INDETERMINATE', 'none', 'none'],
        [noContent, 'PAID', 'ACKNOWLEDGED', 'INDETERMINATE', 'none', 'COLLECTION_CONFIRMED'],
        [
          respond(409, gopayConflictBody),
          'PAYMENT_METHOD_CHOSEN',
          'REJECTED_BEFORE_EFFECT',
          'NOT_EFFECTED',
          'CANCEL_NOT_EFFECTED',
          'none',
        ],
        [
          respond(409, gopayConflictBody),
          'PAID',
          'REJECTED_BEFORE_EFFECT',
          'NOT_EFFECTED',
          'CANCEL_NOT_EFFECTED',
          'COLLECTION_CONFIRMED',
        ],
        [
          respond(409, gopayConflictBody),
          'REFUNDED',
          'REJECTED_BEFORE_EFFECT',
          'NOT_EFFECTED',
          'CANCEL_NOT_EFFECTED',
          'COLLECTION_CONFIRMED',
        ],
        [
          respond(409, gopayConflictBody),
          'CANCELED',
          'ACKNOWLEDGED',
          'EFFECT_CONFIRMED',
          'CANCEL_CONFIRMED',
          'COLLECTION_NOT_EFFECTED',
        ],
        [
          respond(409, gopayConflictBody),
          'TIMEOUTED',
          'ACKNOWLEDGED',
          'EFFECT_CONFIRMED',
          'CANCEL_CONFIRMED',
          'COLLECTION_NOT_EFFECTED',
        ],
        [respond(409, gopayConflictBody), 'CREATED', 'ACKNOWLEDGED', 'INDETERMINATE', 'none', 'none'],
      ] as const;
      for (const [deleteStep, state, outcome, finding, cancelFact, targetFact] of cases) {
        const { result } = yield* cancelCase(deleteStep, [paymentIn(state)]);
        const response = Result.getOrThrow(result);
        expect([state, dispatchOutcomeOf(response), response.finding.finding]).toEqual([state, outcome, finding]);
        expect([state, Option.getOrElse(factKindOf(response.finding), () => 'none')]).toEqual([state, cancelFact]);
        expect([
          state,
          Option.getOrElse(factKindOf(Option.getOrUndefined(response.targetFinding)), () => 'none'),
        ]).toEqual([state, targetFact]);
        if (cancelFact === 'CANCEL_NOT_EFFECTED') {
          expect(response.finding.evidence.pipe(Option.flatMap(({ reason }) => reason))).toEqual(
            Option.some('provider_cancel_rejected_state'),
          );
        }
      }
    }),
  );

  it.effect(
    '#1158 A GoPay cancel without a classifiable answer or confirming lookup is OUTCOME_UNKNOWN and never resent',
    () =>
      Effect.gen(function* cancelUnknown() {
        const cases = [
          [respond(404, gopayNotFoundBody), [], 'gopay_cancel_status_404_unclassified'],
          [fail('ECONNRESET'), [], 'provider_transport_failed'],
          [respond(500, '{}'), [], 'provider_server_error'],
          [noContent, [respond(401, '{"code":401}')], 'gopay_cancel_confirmation_unavailable'],
          [noContent, [respond(200, '{"id":"300000001"}')], 'gopay_cancel_confirmation_invalid'],
        ] as const;
        for (const [deleteStep, lookupSteps, reason] of cases) {
          const { gopay, result } = yield* cancelCase(deleteStep, lookupSteps);
          const error = Option.getOrUndefined(Result.getFailure(result));
          expect(Schema.is(GatewayProviderOutcomeUnknown)(error)).toBe(true);
          expect(error?.reason).toBe(reason);
          expect(gopay.callsTo(PAYMENT_ROUTE)).toHaveLength(lookupSteps.length);
        }
      }),
  );

  it.effect('#1159 A GoPay cancel names only a GoPay payment of this binding', () =>
    Effect.gen(function* cancelTarget() {
      const gopay = yield* recordedGopay({});
      const foreign = Schema.decodeUnknownSync(ProviderObjectRefSchema)({
        _tag: 'COMGATE_TRANSACTION',
        transId: 'AB12-CD34-EF56',
      });
      const error = yield* Effect.flip(
        gopay.adapter.prepareCancel(target, { ...cancelRequest, providerTarget: foreign }),
      );
      expect(error).toMatchObject({ family: 'GOPAY', reason: 'cancel_target_invalid' });
      const prepared = yield* gopay.adapter.prepareCancel(target, cancelRequest);
      // A cancel request is never sent as a collect or refund, and a refund request is never sent as a cancel.
      const mismatched = yield* Effect.flip(gopay.adapter.send(target, prepared, collectExpected));
      expect(mismatched).toMatchObject({ reason: 'expected_effect_mismatch' });
      expect(gopay.sent).toHaveLength(0);
    }),
  );
});

describe('#1156 GoPay v4 refund', () => {
  it.effect('#1156 GoPay refund response without completion evidence stays pending; SUCCESS confirms', () =>
    Effect.gen(function* refundStates() {
      const gopay = yield* recordedGopay({
        [REFUND_ROUTE]: [
          respond(201, gopayRefundBody({ amount: 4000, state: 'REQUESTED' })),
          respond(201, gopayRefundBody({ amount: 4000, state: 'SUCCESS', updated: '2026-11-12T10:01:00Z' })),
          respond(201, gopayRefundBody({ amount: 4000, state: 'FAILED' })),
          respond(201, gopayRefundBody({ amount: 3999, state: 'SUCCESS' })),
        ],
        [TOKEN_ROUTE]: [tokenResponse()],
      });
      const prepared = yield* gopay.adapter.prepareRefund(target, refundRequest);
      expect(new TextDecoder().decode(prepared.body)).toBe('{"amount":4000}');
      expect(prepared.endpointRef).toBe(`gopay:POST:/payments/${GOPAY_FIXTURE_PAYMENT_ID}/refunds`);

      const pending = yield* gopay.adapter.send(target, prepared, refundExpected);
      expect(dispatchOutcomeOf(pending)).toBe('ACKNOWLEDGED');
      expect(pending.finding.finding).toBe('ACCEPTED_PENDING');
      expect(factKindOf(pending.finding)).toEqual(Option.some('REFUND_PENDING'));
      expect(pending.finding.providerRefs).toEqual([paymentRef, refundRef]);
      expect(Option.getOrThrow(pending.finding.evidence)).toMatchObject({
        economicEffectKey: Option.some(`gopay-refund:${GOPAY_FIXTURE_PAYMENT_ID}:${refundOperationId}`),
        sourceOccurrenceId: `gopay:dispatch_response:${GOPAY_FIXTURE_REFUND_ID}:${refundOperationId}:REFUND_PENDING:4000`,
      });

      const confirmed = yield* gopay.adapter.send(target, prepared, refundExpected);
      expect([dispatchOutcomeOf(confirmed), confirmed.finding.finding]).toEqual(['ACKNOWLEDGED', 'EFFECT_CONFIRMED']);
      expect(factKindOf(confirmed.finding)).toEqual(Option.some('REFUND_CONFIRMED'));
      expect(Option.getOrThrow(confirmed.finding.evidence).providerOccurredAt).toEqual(
        Option.some(DateTime.makeUnsafe('2026-11-12T10:01:00.000Z')),
      );

      const failed = yield* gopay.adapter.send(target, prepared, refundExpected);
      expect([dispatchOutcomeOf(failed), failed.finding.finding]).toEqual(['REJECTED_BEFORE_EFFECT', 'NOT_EFFECTED']);
      expect(factKindOf(failed.finding)).toEqual(Option.some('REFUND_NOT_EFFECTED'));

      const mismatched = yield* gopay.adapter.send(target, prepared, refundExpected);
      expect(mismatched.finding.finding).toBe('VERIFICATION_CONFLICT');
      expect(Option.getOrThrow(mismatched.finding.evidence).discrepancy).toEqual(
        Option.some({ expected: czk(4000), observed: czk(3999) }),
      );
      const [refund] = gopay.callsTo(REFUND_ROUTE);
      expect(refund?.contentType).toBe('application/json');
      expect(gopay.callsTo(REFUND_LIST_ROUTE)).toHaveLength(0);
    }),
  );

  it.effect('#1156 A GoPay refund refused with 409 created nothing', () =>
    Effect.gen(function* refundConflict() {
      const gopay = yield* recordedGopay({
        [REFUND_ROUTE]: [respond(409, gopayConflictBody)],
        [TOKEN_ROUTE]: [tokenResponse()],
      });
      const prepared = yield* gopay.adapter.prepareRefund(target, refundRequest);
      const response = yield* gopay.adapter.send(target, prepared, refundExpected);
      expect([dispatchOutcomeOf(response), response.finding.finding]).toEqual([
        'REJECTED_BEFORE_EFFECT',
        'NOT_EFFECTED',
      ]);
      expect(factKindOf(response.finding)).toEqual(Option.some('REFUND_NOT_EFFECTED'));
    }),
  );

  it.effect('#1158 Lost GoPay refund response is OUTCOME_UNKNOWN, never resent, and resolved by the refund list', () =>
    Effect.gen(function* lostRefund() {
      const gopay = yield* recordedGopay({
        [PAYMENT_ROUTE]: [
          paymentIn('PARTIALLY_REFUNDED'),
          paymentIn('PARTIALLY_REFUNDED'),
          paymentIn('PARTIALLY_REFUNDED'),
        ],
        [REFUND_LIST_ROUTE]: [
          respond(
            200,
            gopayRefundListBody([
              { amount: 4000, created: '2026-11-10T09:00:00Z', id: '3050000001', state: 'SUCCESS' },
              { amount: 4000, created: '2026-11-12T10:00:30Z', state: 'SUCCESS' },
            ]),
          ),
          respond(
            200,
            gopayRefundListBody([
              { amount: 4000, created: '2026-11-12T10:00:30Z', state: 'SUCCESS' },
              { amount: 4000, created: '2026-11-12T10:00:40Z', id: '3050000002', state: 'SUCCESS' },
            ]),
          ),
          respond(200, '[]'),
        ],
        [REFUND_ROUTE]: [fail('ECONNRESET'), respond(201, gopayRefundBody({ amount: 4000, state: 'REQUESTED' }))],
        [TOKEN_ROUTE]: [tokenResponse()],
      });
      const prepared = yield* gopay.adapter.prepareRefund(target, refundRequest);
      const lost = yield* Effect.flip(gopay.adapter.send(target, prepared, refundExpected));
      expect(Schema.is(GatewayProviderOutcomeUnknown)(lost)).toBe(true);
      expect(gopay.callsTo(REFUND_ROUTE)).toHaveLength(1);

      // Exactly one refund of the amount created at or after the dispatch: that refund decides.
      const [one] = yield* gopay.adapter.lookup(target, lookupRequest(refundExpected));
      expect(one?.finding).toBe('EFFECT_CONFIRMED');
      expect(one?.providerRefs).toEqual([paymentRef, refundRef]);
      // Two candidates or none: INDETERMINATE, never NOT_EFFECTED.
      for (const _ of [0, 1]) {
        const [ambiguous] = yield* gopay.adapter.lookup(target, lookupRequest(refundExpected));
        expect(ambiguous).toMatchObject({ evidence: Option.none(), finding: 'INDETERMINATE' });
      }
      expect(gopay.callsTo(REFUND_ROUTE)).toHaveLength(1);
    }),
  );

  it.effect('#1156 A recorded GoPay refund id is looked up as its own refund resource', () =>
    Effect.gen(function* refundById() {
      const gopay = yield* recordedGopay({
        [REFUND_DETAIL_ROUTE]: [
          respond(200, gopayRefundBody({ amount: 4000, state: 'REQUESTED' })),
          respond(200, gopayRefundBody({ amount: 4000, state: 'SUCCESS', updated: null })),
          respond(200, gopayRefundBody({ amount: 4000, id: '3050999999', state: 'SUCCESS' })),
          respond(404, gopayNotFoundBody),
        ],
        [TOKEN_ROUTE]: [tokenResponse()],
      });
      const results = [];
      for (const _ of [0, 1, 2, 3]) {
        const [finding] = yield* gopay.adapter.lookup(target, lookupRequest(refundExpected, refundRef));
        results.push([finding?.finding, Option.getOrElse(factKindOf(finding), () => 'none')]);
      }
      expect(results).toEqual([
        ['ACCEPTED_PENDING', 'REFUND_PENDING'],
        ['EFFECT_CONFIRMED', 'REFUND_CONFIRMED'],
        // Another refund id than the one recorded never proves this refund.
        ['VERIFICATION_CONFLICT', 'none'],
        ['INDETERMINATE', 'none'],
      ]);
      expect(gopay.callsTo(PAYMENT_ROUTE)).toHaveLength(0);
      // A refund reference never answers for a collection.
      const notForCollect = yield* Effect.flip(gopay.adapter.lookup(target, lookupRequest(collectExpected, refundRef)));
      expect(Schema.is(GatewayProviderUnsupported)(notForCollect)).toBe(true);
    }),
  );

  it.effect('#1158 GoPay replay and order-reference lookup are UNSUPPORTED', () =>
    Effect.gen(function* replayUnsupported() {
      const gopay = yield* recordedGopay({});
      const prepared = yield* gopay.adapter.prepareCollect(target, collectRequest);
      const replayed = yield* Effect.flip(
        gopay.adapter.replay(
          target,
          {
            prepared,
            window: {
              expiresAt: DateTime.makeUnsafe('2026-11-13T10:00:00.000Z'),
              startsAt: DateTime.makeUnsafe('2026-11-12T10:00:00.000Z'),
            },
          },
          collectExpected,
        ),
      );
      expect(Schema.is(GatewayProviderUnsupported)(replayed)).toBe(true);
      expect(replayed).toMatchObject({ capability: 'COLLECT', reason: 'provider_replay_unsupported' });

      const cancelPrepared = yield* gopay.adapter.prepareCancel(target, cancelRequest);
      const cancelReplayed = yield* Effect.flip(
        gopay.adapter.replay(
          target,
          {
            prepared: cancelPrepared,
            window: {
              expiresAt: DateTime.makeUnsafe('2026-11-13T10:00:00.000Z'),
              startsAt: DateTime.makeUnsafe('2026-11-12T10:00:00.000Z'),
            },
          },
          cancelExpected,
        ),
      );
      expect(cancelReplayed).toMatchObject({ capability: 'CANCEL_OR_VOID', reason: 'provider_replay_unsupported' });

      const byOrder = yield* Effect.flip(
        gopay.adapter.lookup(target, {
          dispatchedAt: Option.none(),
          expected: collectExpected,
          target: { _tag: 'ORDER_REFERENCE', orderReference },
        }),
      );
      expect(Schema.is(GatewayProviderUnsupported)(byOrder)).toBe(true);
      expect(byOrder).toMatchObject({ reason: 'order_reference_lookup_unsupported' });
      expect(gopay.sent).toHaveLength(0);
    }),
  );

  it.effect('#1157 GoPay states the order number of a notified payment read through the binding', () =>
    Effect.gen(function* readOrderReference() {
      const own = yield* recordedGopay({
        [PAYMENT_ROUTE]: [paymentIn('PAID')],
        [TOKEN_ROUTE]: [tokenResponse()],
      });
      expect(yield* own.adapter.readOrderReference(target, paymentRef)).toEqual(Option.some(orderReference));
      expect(own.callsTo(PAYMENT_ROUTE)[0]?.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
      const foreign = yield* recordedGopay({
        [PAYMENT_ROUTE]: [respond(200, gopayPaymentBody({ orderNumber: '2025010199', state: 'PAID' }))],
        [TOKEN_ROUTE]: [tokenResponse()],
      });
      expect(yield* foreign.adapter.readOrderReference(target, paymentRef)).toEqual(Option.none());
      const missing = yield* recordedGopay({
        [PAYMENT_ROUTE]: [respond(404, gopayNotFoundBody)],
        [TOKEN_ROUTE]: [tokenResponse()],
      });
      expect(yield* missing.adapter.readOrderReference(target, paymentRef)).toEqual(Option.none());
      // Another family's object is never read through this binding.
      const other = yield* recordedGopay({});
      const comgateRef = Schema.decodeUnknownSync(ProviderObjectRefSchema)({
        _tag: 'COMGATE_TRANSACTION',
        transId: 'AB12-CD34-EF56',
      });
      expect(yield* other.adapter.readOrderReference(target, comgateRef)).toEqual(Option.none());
      expect(other.sent).toHaveLength(0);
    }),
  );
});
