import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { Context, DateTime, Effect, Layer, Match, Option, Redacted, Schema } from 'effect';
import { Hex } from 'effect/encoding';
import { HttpClient, HttpClientError, HttpClientResponse } from 'effect/http';
import type { HttpClientRequest } from 'effect/http';
import { TestClock } from 'effect/testing';
import { describe, expect, it } from 'effect-rstest';

import { gopayProviderObjectId } from '../../src/integrations/gopay/gopay-wire.ts';
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
import type {
  GatewayCollectRequest,
  GatewayExecutionTarget,
  GatewayExpectedEffect,
  GatewayLookupRequest,
  GatewayRefundRequest,
} from '../../src/integrations/psp/psp-request.ts';
import type { ProviderDispatchResponse, ProviderFindingResult } from '../../src/integrations/psp/psp-result.ts';
import { gopayExecutionTarget } from '../fixtures/gopay/execution-target.ts';
import {
  GOPAY_FIXTURE_GOID,
  GOPAY_FIXTURE_PAYMENT_ID,
  gopayCreateResponseBody,
  gopayInquiryResponseBody,
  gopayPaymentNotFoundBody,
} from '../fixtures/gopay/payment-responses.ts';
import { gopayRefundResponseBody, gopayTimestampedRefundHistoryBody } from '../fixtures/gopay/refund-responses.ts';

/**
 * GoPay adapter against a recorded HttpClient (#1154, #1156, #1158). Each provider route answers from
 * its own script, and every request GoPay would have seen is recorded, so "never resent" and "token
 * reused" are counted, not assumed. Bodies are the documented GoPay responses (tests/fixtures/gopay).
 */

const SANDBOX = 'https://gw.sandbox.gopay.com/api';
const TOKEN_ROUTE = `POST ${SANDBOX}/oauth2/token`;
const CREATE_ROUTE = `POST ${SANDBOX}/payments/payment`;
const PAYMENT_ROUTE = `GET ${SANDBOX}/payments/payment/${GOPAY_FIXTURE_PAYMENT_ID}`;
const REFUND_ROUTE = `POST ${SANDBOX}/payments/payment/${GOPAY_FIXTURE_PAYMENT_ID}/refund`;
const REFUND_HISTORY_ROUTE = `GET ${SANDBOX}/payments/payment/${GOPAY_FIXTURE_PAYMENT_ID}/refunds`;

const CLIENT_ID = 'gopay-client-fixture';
const CLIENT_SECRET = 'gopay-secret-fixture-91c2';
const ACCESS_TOKEN = 'gopay-access-token-fixture';

const collectOperationId = '0f8b5c1e-3a2d-4c7b-9e1f-5a6b7c8d9e0f';
const refundOperationId = '6c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f';
const cancelOperationId = '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b';
const paymentId = '3f2e1d0c-9b8a-4f7e-8d6c-5b4a39281706';
const returnToken = 'AbCdEfGhIjKlMnOpQrSt_-';
const collectCorrelation = deriveProviderCorrelation(collectOperationId);
const czk = (amountMinor: number) => ({ amountMinor, currency: 'CZK' as const });

const RespondStepSchema = Schema.TaggedStruct('Respond', { body: Schema.String, status: Schema.Finite });
const FailStepSchema = Schema.TaggedStruct('Fail', { code: Schema.String });
const StepSchema = Schema.Union([RespondStepSchema, FailStepSchema]);
type Step = typeof StepSchema.Type;

const respond = (status: number, body = '{}'): Step => RespondStepSchema.make({ body, status });
const fail = (code: string): Step => FailStepSchema.make({ code });
const tokenResponse = (expiresIn = 1800) =>
  respond(200, `{"token_type":"bearer","access_token":"${ACCESS_TOKEN}","expires_in":${expiresIn}}`);

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
      Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body, { status }))),
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

const collectRequest: GatewayCollectRequest = {
  amount: czk(10_000),
  correlation: collectCorrelation,
  issuedAt: DateTime.makeUnsafe('2026-11-12T10:00:00.000Z'),
  operationId: collectOperationId,
  payerContact: Option.some({
    email: Option.some('payer@example.test'),
    fullName: Option.some('Payer Example'),
    phone: Option.none(),
  }),
  paymentId,
  returnToken,
};
const collectExpected: GatewayExpectedEffect = {
  _tag: 'COLLECT',
  amount: czk(10_000),
  operationId: collectOperationId,
};

const refundRequest: GatewayRefundRequest = {
  amount: czk(4000),
  correlation: deriveProviderCorrelation(refundOperationId),
  operationId: refundOperationId,
  providerTarget: { _tag: 'GOPAY_PAYMENT', id: gopayProviderObjectId(Number(GOPAY_FIXTURE_PAYMENT_ID)) },
  refundBasisKind: 'REFUNDABLE_ITEMS',
  targetOperationId: collectOperationId,
};
const refundExpected: GatewayExpectedEffect = { _tag: 'REFUND', amount: czk(4000), operationId: refundOperationId };

const lookupRequest = (expected: GatewayExpectedEffect): GatewayLookupRequest => ({
  dispatchedAt: Option.some(DateTime.makeUnsafe('2026-11-12T10:00:00.000Z')),
  expected,
  target: { _tag: 'PROVIDER_OBJECT', ref: refundRequest.providerTarget },
});

const inquiryBody = (state: string, goid: string = GOPAY_FIXTURE_GOID) =>
  gopayInquiryResponseBody({ amount: 10_000, goid, orderNumber: collectCorrelation.orderReference, state });

const findingOf = (response: ProviderDispatchResponse): ProviderFindingResult => response.finding;

const dispatchOutcomeOf = (response: ProviderDispatchResponse) =>
  Match.value(response).pipe(
    Match.tag('ACKNOWLEDGED', () => 'ACKNOWLEDGED' as const),
    Match.tag('REJECTED_BEFORE_EFFECT', () => 'REJECTED_BEFORE_EFFECT' as const),
    Match.exhaustive,
  );

const decodeJsonObject = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)));

const expectedBasicAuthorization = `Basic ${btoa([CLIENT_ID, CLIENT_SECRET].join(':'))}`;

describe('#1154 GoPay collect', () => {
  it.effect('#1154 GoPay one-shot create never requests preauthorization or recurrence', () =>
    Effect.gen(function* oneShotCreate() {
      const gopay = yield* recordedGopay({
        [CREATE_ROUTE]: [respond(200, gopayCreateResponseBody(collectCorrelation.orderReference))],
        [TOKEN_ROUTE]: [tokenResponse()],
      });
      const prepared = yield* gopay.adapter.prepareCollect(target, collectRequest);
      // Preparation is pure: nothing reached GoPay and no credential was read.
      expect(gopay.sent).toHaveLength(0);
      expect(gopay.credentialResolutions).toHaveLength(0);

      const bodyText = new TextDecoder().decode(prepared.body);
      const body = decodeJsonObject(bodyText);
      expect(new Set(Object.keys(body))).toEqual(
        new Set(['amount', 'callback', 'currency', 'lang', 'order_number', 'payer', 'target']),
      );
      expect(bodyText).not.toContain('preauthorization');
      expect(bodyText).not.toContain('recurrence');
      expect(body).toMatchObject({
        amount: 10_000,
        callback: {
          notification_url: 'https://payments.example.test/gopay/notify',
          return_url: `https://shop.example.test/return?r=${returnToken}`,
        },
        currency: 'CZK',
        lang: 'CS',
        order_number: collectCorrelation.orderReference,
        payer: { contact: { email: 'payer@example.test' } },
        target: { goid: Number(GOPAY_FIXTURE_GOID), type: 'ACCOUNT' },
      });
      expect(prepared).toMatchObject({
        endpointRef: 'gopay:POST:/payments/payment',
        family: 'GOPAY',
        headers: [
          { name: 'accept', value: 'application/json' },
          { name: 'content-type', value: 'application/json' },
        ],
        orderReference: collectCorrelation.orderReference,
      });
      expect(Option.isNone(prepared.idempotencyKey)).toBe(true);
      expect(Option.isNone(prepared.replayWindowMs)).toBe(true);
      expect(prepared.requestHash).toBe(
        Hex.encode(
          sha256(
            concatBytes(
              utf8ToBytes('gopay:POST:/payments/payment\naccept:application/json\ncontent-type:application/json\n\n'),
              prepared.body,
            ),
          ),
        ),
      );
      // The same input prepares the same bytes.
      const again = yield* gopay.adapter.prepareCollect(target, collectRequest);
      expect(again.requestHash).toBe(prepared.requestHash);

      const response = yield* gopay.adapter.send(target, prepared, collectExpected);
      expect(dispatchOutcomeOf(response)).toBe('ACKNOWLEDGED');
      expect(findingOf(response)).toMatchObject({
        customerAction: Option.some({ redirectUrl: 'https://gw.sandbox.gopay.com/gw/v3/...' }),
        finding: 'CUSTOMER_ACTION_REQUIRED',
        providerRefs: [{ _tag: 'GOPAY_PAYMENT', id: GOPAY_FIXTURE_PAYMENT_ID }],
        target: { operationId: collectOperationId, operationKind: 'COLLECT' },
      });
      const [create] = gopay.callsTo(CREATE_ROUTE);
      expect(gopay.callsTo(CREATE_ROUTE)).toHaveLength(1);
      expect(create?.body).toBe(bodyText);
      expect(create?.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
      expect(create?.contentType).toBe('application/json');
    }),
  );

  it.effect('#1154 Response for a different goid is a verification conflict', () =>
    Effect.gen(function* differentGoid() {
      const foreignGoid = '8999999999';
      const gopay = yield* recordedGopay({
        [CREATE_ROUTE]: [
          respond(
            200,
            gopayCreateResponseBody(collectCorrelation.orderReference).replace(GOPAY_FIXTURE_GOID, foreignGoid),
          ),
        ],
        [PAYMENT_ROUTE]: [respond(200, inquiryBody('PAID', foreignGoid))],
        [TOKEN_ROUTE]: [tokenResponse()],
      });
      const prepared = yield* gopay.adapter.prepareCollect(target, collectRequest);
      const created = findingOf(yield* gopay.adapter.send(target, prepared, collectExpected));
      expect(created.finding).toBe('VERIFICATION_CONFLICT');
      expect(Option.isNone(created.evidence)).toBe(true);
      expect(Option.isNone(created.customerAction)).toBe(true);
      expect(created.providerRefs).toEqual([]);

      const [looked] = yield* gopay.adapter.lookup(target, lookupRequest(collectExpected));
      expect(looked?.finding).toBe('VERIFICATION_CONFLICT');
      expect(looked?.evidence).toEqual(Option.none());
    }),
  );

  it.effect('#1154 A create GoPay refuses with a 4xx is REJECTED_BEFORE_EFFECT with COLLECTION_NOT_EFFECTED', () =>
    Effect.gen(function* createRejected() {
      const gopay = yield* recordedGopay({
        [CREATE_ROUTE]: [respond(400, '{"errors":[{"error_code":110,"error_name":"INVALID"}]}')],
        [TOKEN_ROUTE]: [tokenResponse()],
      });
      const prepared = yield* gopay.adapter.prepareCollect(target, collectRequest);
      const response = yield* gopay.adapter.send(target, prepared, collectExpected);
      expect(dispatchOutcomeOf(response)).toBe('REJECTED_BEFORE_EFFECT');
      expect(findingOf(response)).toMatchObject({
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
      for (const lost of [fail('ECONNRESET'), respond(503, 'unavailable'), respond(200, '<html>gateway</html>')]) {
        const gopay = yield* recordedGopay({
          [CREATE_ROUTE]: [lost, respond(200, gopayCreateResponseBody(collectCorrelation.orderReference))],
          [TOKEN_ROUTE]: [tokenResponse()],
        });
        const prepared = yield* gopay.adapter.prepareCollect(target, collectRequest);
        const error = yield* Effect.flip(gopay.adapter.send(target, prepared, collectExpected));

        expect(Schema.is(GatewayProviderOutcomeUnknown)(error)).toBe(true);
        expect(error).toMatchObject({ family: 'GOPAY', operationId: collectOperationId });
        expect(JSON.stringify(error)).not.toContain(ACCESS_TOKEN);
        yield* TestClock.adjust('1 minute');
        expect(gopay.callsTo(CREATE_ROUTE)).toHaveLength(1);
      }
    }),
  );

  it.effect('#1158 Token is reused across operations of the same credential revision', () =>
    Effect.gen(function* tokenReuse() {
      const gopay = yield* recordedGopay({
        [CREATE_ROUTE]: [respond(200, gopayCreateResponseBody(collectCorrelation.orderReference))],
        [PAYMENT_ROUTE]: [
          respond(200, inquiryBody('PAID')),
          respond(200, inquiryBody('PAID')),
          respond(200, inquiryBody('PAID')),
        ],
        [TOKEN_ROUTE]: [tokenResponse(), tokenResponse(), tokenResponse()],
      });
      const prepared = yield* gopay.adapter.prepareCollect(target, collectRequest);
      yield* gopay.adapter.send(target, prepared, collectExpected);
      yield* gopay.adapter.lookup(target, lookupRequest(collectExpected));
      expect(gopay.callsTo(TOKEN_ROUTE)).toHaveLength(1);
      const [tokenCall] = gopay.callsTo(TOKEN_ROUTE);
      expect(tokenCall?.authorization).toBe(expectedBasicAuthorization);
      expect(tokenCall?.body).toBe('grant_type=client_credentials&scope=payment-all');
      expect(tokenCall?.contentType).toBe('application/x-www-form-urlencoded');

      // A rotated credential is a new revision of the same binding: it gets its own token.
      yield* gopay.adapter.lookup({ ...target, credentialRevision: 2 }, lookupRequest(collectExpected));
      expect(gopay.callsTo(TOKEN_ROUTE)).toHaveLength(2);

      // The token is dropped 60 s before GoPay's expires_in (1800 s).
      yield* TestClock.adjust('1741 seconds');
      yield* gopay.adapter.lookup(target, lookupRequest(collectExpected));
      expect(gopay.callsTo(TOKEN_ROUTE)).toHaveLength(3);
    }),
  );

  it.effect('#1158 A token GoPay refuses is dropped and the lookup is UNAVAILABLE', () =>
    Effect.gen(function* refusedToken() {
      const gopay = yield* recordedGopay({
        [PAYMENT_ROUTE]: [respond(401, '{"errors":[{"error_code":202}]}'), respond(200, inquiryBody('PAID'))],
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
      const gopay = yield* recordedGopay({ [TOKEN_ROUTE]: [respond(401, '{"errors":[{"error_code":202}]}')] });
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
        [PAYMENT_ROUTE]: [respond(404, gopayPaymentNotFoundBody)],
        [TOKEN_ROUTE]: [tokenResponse()],
      });
      const findings = yield* gopay.adapter.lookup(target, lookupRequest(collectExpected));
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({ evidence: Option.none(), finding: 'INDETERMINATE' });
    }),
  );
});

describe('#1156 GoPay refund and unsupported capabilities', () => {
  it.effect('#1156 GoPay refund sends the form amount; FAILED is NOT_EFFECTED', () =>
    Effect.gen(function* refundFailed() {
      const gopay = yield* recordedGopay({
        [REFUND_ROUTE]: [respond(200, gopayRefundResponseBody('FAILED'))],
        [TOKEN_ROUTE]: [tokenResponse()],
      });
      const prepared = yield* gopay.adapter.prepareRefund(target, refundRequest);
      expect(new TextDecoder().decode(prepared.body)).toBe('amount=4000');
      expect(prepared.endpointRef).toBe(`gopay:POST:/payments/payment/${GOPAY_FIXTURE_PAYMENT_ID}/refund`);

      const response = yield* gopay.adapter.send(target, prepared, refundExpected);
      expect(dispatchOutcomeOf(response)).toBe('REJECTED_BEFORE_EFFECT');
      expect(findingOf(response)).toMatchObject({
        evidence: Option.some({ factKind: 'REFUND_NOT_EFFECTED' }),
        finding: 'NOT_EFFECTED',
      });
      const [refund] = gopay.callsTo(REFUND_ROUTE);
      expect(refund?.body).toBe('amount=4000');
      expect(refund?.contentType).toBe('application/x-www-form-urlencoded');
      expect(gopay.callsTo(REFUND_HISTORY_ROUTE)).toHaveLength(0);
    }),
  );

  it.effect('#1156 An accepted GoPay refund is confirmed only by one matching refund-history entry', () =>
    Effect.gen(function* refundConfirmed() {
      const gopay = yield* recordedGopay({
        [PAYMENT_ROUTE]: [
          respond(200, inquiryBody('PARTIALLY_REFUNDED')),
          respond(200, inquiryBody('PARTIALLY_REFUNDED')),
        ],
        [REFUND_HISTORY_ROUTE]: [
          respond(
            200,
            gopayTimestampedRefundHistoryBody([
              { amount: 4000, dateRequested: '2026-11-12T11:00:00.000+0100', state: 'SUCCESS' },
            ]),
          ),
          respond(
            200,
            gopayTimestampedRefundHistoryBody([
              { amount: 4000, dateRequested: '2026-11-12T11:00:00.000+0100', state: 'REQUESTED' },
            ]),
          ),
        ],
        [REFUND_ROUTE]: [
          respond(200, gopayRefundResponseBody('FINISHED')),
          respond(200, gopayRefundResponseBody('ACCEPTED')),
        ],
        [TOKEN_ROUTE]: [tokenResponse()],
      });
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe('2026-11-12T09:59:00.000Z')));
      const prepared = yield* gopay.adapter.prepareRefund(target, refundRequest);

      const confirmed = findingOf(yield* gopay.adapter.send(target, prepared, refundExpected));
      expect(confirmed).toMatchObject({
        evidence: Option.some({ factFamily: 'REFUND_EXECUTION', factKind: 'REFUND_CONFIRMED' }),
        finding: 'EFFECT_CONFIRMED',
        target: { operationId: refundOperationId, operationKind: 'REFUND' },
      });

      const pending = findingOf(yield* gopay.adapter.send(target, prepared, refundExpected));
      expect(pending).toMatchObject({
        evidence: Option.some({ factKind: 'REFUND_PENDING' }),
        finding: 'ACCEPTED_PENDING',
      });
    }),
  );

  it.effect('#1156 GoPay cancel is UNSUPPORTED', () =>
    Effect.gen(function* cancelUnsupported() {
      const gopay = yield* recordedGopay({});
      const error = yield* Effect.flip(
        gopay.adapter.prepareCancel(target, {
          operationId: cancelOperationId,
          providerTarget: refundRequest.providerTarget,
          targetOperationId: collectOperationId,
        }),
      );
      expect(Schema.is(GatewayProviderUnsupported)(error)).toBe(true);
      expect(error).toMatchObject({
        capability: 'CANCEL_OR_VOID',
        family: 'GOPAY',
        reason: 'provider_cancel_unsupported',
      });
      expect(gopay.adapter.capabilities.CANCEL_OR_VOID).toBe('UNSUPPORTED');
      expect(gopay.sent).toHaveLength(0);
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

      const byOrder = yield* Effect.flip(
        gopay.adapter.lookup(target, {
          dispatchedAt: Option.none(),
          expected: collectExpected,
          target: { _tag: 'ORDER_REFERENCE', orderReference: collectCorrelation.orderReference },
        }),
      );
      expect(Schema.is(GatewayProviderUnsupported)(byOrder)).toBe(true);
      expect(byOrder).toMatchObject({ reason: 'order_reference_lookup_unsupported' });
      expect(gopay.sent).toHaveLength(0);
    }),
  );
});
