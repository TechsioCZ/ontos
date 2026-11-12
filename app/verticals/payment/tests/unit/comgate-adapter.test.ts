import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'effect-rstest';
import { Context, DateTime, Effect, Layer, Match, Option, Redacted, Result, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import type { HttpClientRequest } from 'effect/http';

import {
  ComgatePaymentService,
  ComgatePaymentServiceLive,
} from '../../src/integrations/comgate/comgate-payment.service.ts';
import { ProviderCredentialStore } from '../../src/integrations/psp/credentials.ts';
import { ProviderHttp } from '../../src/integrations/psp/provider-http.ts';
import type { ProviderHttpResponse } from '../../src/integrations/psp/provider-http.ts';
import { deriveProviderCorrelation } from '../../src/integrations/psp/psp-correlation.ts';
import { GatewayProviderOutcomeUnknown, GatewayProviderUnavailable } from '../../src/integrations/psp/psp-errors.ts';
import type {
  GatewayProviderOutcomeUnknownError,
  GatewayProviderUnavailableError,
} from '../../src/integrations/psp/psp-errors.ts';
import {
  GatewayCancelRequestSchema,
  GatewayCollectRequestSchema,
  GatewayExecutionTargetSchema,
  GatewayRefundRequestSchema,
  ProviderObjectRefSchema,
} from '../../src/integrations/psp/psp-request.ts';
import type {
  GatewayExpectedEffect,
  GatewayLookupRequest,
  GatewayPayerContact,
} from '../../src/integrations/psp/psp-request.ts';
import type { ProviderDispatchResponse, ProviderFindingResult } from '../../src/integrations/psp/psp-result.ts';

/**
 * Comgate adapter (#1154, #1156, #1158) over a recorded ProviderHttp: every request the provider
 * would have seen is recorded, and each scripted step answers one call. Response bodies are the
 * documented shapes of https://apidoc.comgate.cz/en/api/rest/ (tests/fixtures/comgate/README.md).
 */

const fixtureDir = new URL('../fixtures/comgate/', import.meta.url);
const fixtureText = (name: string) => readFileSync(new URL(name, fixtureDir), 'utf-8');
type JsonObject = Readonly<Record<string, typeof Schema.Json.Type>>;
const decodeJsonObject = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)));

const SECRET = 'comgate-shop-secret-under-test';
const MERCHANT_ID = '123456';
const TRANS_ID = 'AB12-CD34-EF56';
const collectOperationId = '0f8b5c1e-3a2d-4c7b-9e1f-5a6b7c8d9e0f';
const cancelOperationId = '2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d';
const refundOperationId = '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b';
const collectCorrelation = deriveProviderCorrelation(collectOperationId);
const amount = { amountMinor: 10_000, currency: 'CZK' as const };
const transactionRef = Schema.decodeUnknownSync(ProviderObjectRefSchema)({
  _tag: 'COMGATE_TRANSACTION',
  transId: TRANS_ID,
});

const target = Schema.decodeUnknownSync(GatewayExecutionTargetSchema)({
  binding: {
    _tag: 'GATEWAY_ACCOUNT',
    environment: 'SANDBOX',
    providerAccountRef: `pab_${'1'.repeat(32)}`,
    providerFamily: 'COMGATE',
  },
  bindingId: '7d3e9a10-55b2-4f6c-8a1d-2b3c4d5e6f70',
  credentialRevision: 1,
  credentialSecretRef: 'comgate.sandbox',
  legalEntityId: '3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f',
  merchantIdentity: { _tag: 'COMGATE', merchantId: MERCHANT_ID },
  notificationUrl: 'https://example.test/notify',
  returnUrl: Option.some('https://shop.example.test/payment/return'),
  tenantId: '4d5e6f7a-8b9c-4d0e-9f1a-2b3c4d5e6f7a',
});

const contact: GatewayPayerContact = {
  email: Option.some('payer@example.test'),
  fullName: Option.some('Test Payer'),
  phone: Option.none(),
};

const collectRequest = (payerContact: Option.Option<GatewayPayerContact>) =>
  Schema.decodeUnknownSync(GatewayCollectRequestSchema)({
    amount,
    correlation: collectCorrelation,
    issuedAt: DateTime.makeUnsafe('2026-11-12T10:00:00.000Z'),
    operationId: collectOperationId,
    payerContact,
    paymentId: '5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b',
    returnToken: 'AbCdEfGhIjKlMnOpQrStUv',
  });

const refundRequest = Schema.decodeUnknownSync(GatewayRefundRequestSchema)({
  amount,
  correlation: deriveProviderCorrelation(refundOperationId),
  operationId: refundOperationId,
  providerTarget: transactionRef,
  refundBasisKind: 'REFUNDABLE_ITEMS',
  targetOperationId: collectOperationId,
});

const cancelRequest = Schema.decodeUnknownSync(GatewayCancelRequestSchema)({
  operationId: cancelOperationId,
  providerTarget: transactionRef,
  targetOperationId: collectOperationId,
});

const collect: GatewayExpectedEffect = { _tag: 'COLLECT', amount, operationId: collectOperationId };
const refund: GatewayExpectedEffect = { _tag: 'REFUND', amount, operationId: refundOperationId };
const cancel: GatewayExpectedEffect = {
  _tag: 'CANCEL_OR_VOID',
  operationId: cancelOperationId,
  target: { amount, operationId: collectOperationId },
};

const paidStatusBody = (overrides: JsonObject = {}) =>
  JSON.stringify({
    ...decodeJsonObject(fixtureText('status-paid.json')),
    refId: collectCorrelation.orderReference,
    test: 'true',
    ...overrides,
  });

/* ------------------------------------------------------------------------------------------------ */
/* Recorded ProviderHttp                                                                             */
/* ------------------------------------------------------------------------------------------------ */

type MutateStep = Effect.Effect<
  ProviderHttpResponse,
  GatewayProviderOutcomeUnknownError | GatewayProviderUnavailableError
>;
type ReadStep = Effect.Effect<ProviderHttpResponse, GatewayProviderUnavailableError>;

const respond = (status: number, bodyText: string): ReadStep => Effect.succeed({ bodyText, status });

interface RecordedCall {
  readonly kind: 'mutate' | 'read';
  readonly request: HttpClientRequest.HttpClientRequest;
}

const unscripted: ReadStep = respond(599, 'unscripted');

const recordedAdapter = (script: { readonly mutate?: readonly MutateStep[]; readonly read?: readonly ReadStep[] }) =>
  Effect.gen(function* recordedAdapterEffect() {
    const calls: RecordedCall[] = [];
    const mutateSteps = [...(script.mutate ?? [])];
    const readSteps = [...(script.read ?? [])];
    const http = Layer.succeed(ProviderHttp, {
      mutate: ({ request }) => {
        calls.push({ kind: 'mutate', request });
        return mutateSteps.shift() ?? unscripted;
      },
      read: ({ request }) => {
        calls.push({ kind: 'read', request });
        return readSteps.shift() ?? unscripted;
      },
    });
    const credentials = Layer.succeed(ProviderCredentialStore, {
      resolve: () => Effect.succeed({ _tag: 'COMGATE' as const, secret: Redacted.make(SECRET) }),
    });
    const context = yield* Layer.build(
      ComgatePaymentServiceLive.pipe(Layer.provide(Layer.mergeAll(http, credentials))),
    );
    return { adapter: Context.get(context, ComgatePaymentService), calls };
  });

const bodyJson = (bytes: Uint8Array): JsonObject => decodeJsonObject(new TextDecoder().decode(bytes));

const basicCredentials = `${MERCHANT_ID}:${SECRET}`;
const expectedAuthorization = `Basic ${Buffer.from(basicCredentials).toString('base64')}`;

const outcome = <A, E>(effect: Effect.Effect<A, E>) =>
  effect.pipe(
    Effect.result,
    Effect.map((result) =>
      Result.isSuccess(result)
        ? { ok: true as const, value: result.success }
        : { error: result.failure, ok: false as const },
    ),
  );

const dispatchKind = (response: ProviderDispatchResponse) =>
  Match.value(response).pipe(
    Match.tag('ACKNOWLEDGED', () => 'ACKNOWLEDGED' as const),
    Match.tag('REJECTED_BEFORE_EFFECT', () => 'REJECTED_BEFORE_EFFECT' as const),
    Match.exhaustive,
  );

const factKindOf = (finding: ProviderFindingResult | undefined) =>
  Option.fromUndefinedOr(finding).pipe(
    Option.flatMap((value) => value.evidence),
    Option.map((evidence) => evidence.factKind),
  );

const findingFor = (findings: readonly ProviderFindingResult[], operationId: string) =>
  findings.find((finding) => finding.target.operationId === operationId);

/* ------------------------------------------------------------------------------------------------ */
/* Tests                                                                                             */
/* ------------------------------------------------------------------------------------------------ */

describe('#1154 Comgate collect', () => {
  it.effect('#1154 Comgate create never requests preauthorization', () =>
    Effect.gen(function* createIsOneShot() {
      const { adapter, calls } = yield* recordedAdapter({ mutate: [respond(200, fixtureText('create-success.json'))] });
      const prepared = yield* adapter.prepareCollect(target, collectRequest(Option.some(contact)));
      const body = bodyJson(prepared.body);

      expect(body).toEqual({
        curr: 'CZK',
        email: 'payer@example.test',
        fullName: 'Test Payer',
        label: 'Payment',
        method: 'ALL',
        price: 10_000,
        refId: collectCorrelation.orderReference,
        test: true,
        url_cancelled: 'https://shop.example.test/payment/return?r=AbCdEfGhIjKlMnOpQrStUv',
        url_paid: 'https://shop.example.test/payment/return?r=AbCdEfGhIjKlMnOpQrStUv',
        url_pending: 'https://shop.example.test/payment/return?r=AbCdEfGhIjKlMnOpQrStUv',
      });
      for (const forbidden of ['preauth', 'initRecurring', 'verification']) {
        expect(Object.keys(body)).not.toContain(forbidden);
      }
      expect(prepared.endpointRef).toBe('comgate:POST:/v2.0/payment.json');
      expect(prepared.idempotencyKey).toEqual(Option.none());
      expect(prepared.replayWindowMs).toEqual(Option.none());
      expect(prepared.orderReference).toBe(collectCorrelation.orderReference);
      expect(JSON.stringify(prepared.headers)).not.toContain(SECRET);
      expect(prepared.headers.map((header) => header.name)).not.toContain('authorization');

      const again = yield* adapter.prepareCollect(target, collectRequest(Option.some(contact)));
      expect(again.requestHash).toBe(prepared.requestHash);

      const response = yield* adapter.send(target, prepared, collect);
      expect(dispatchKind(response)).toBe('ACKNOWLEDGED');
      expect(response.finding.finding).toBe('CUSTOMER_ACTION_REQUIRED');
      expect(response.finding.customerAction).toEqual(
        Option.some({ redirectUrl: 'https://payments.comgate.cz/client/instructions/index?id=AB12-CD34-EF56' }),
      );
      expect(response.finding.providerRefs).toEqual([transactionRef]);

      expect(calls).toHaveLength(1);
      const [call] = calls;
      expect(call?.kind).toBe('mutate');
      expect(call?.request.method).toBe('POST');
      expect(call?.request.url).toBe('https://payments.comgate.cz/v2.0/payment.json');
      expect(call?.request.headers.authorization).toBe(expectedAuthorization);
    }),
  );

  it.effect('#1154 Missing payer contact is UNAVAILABLE before send', () =>
    Effect.gen(function* missingContact() {
      const { adapter, calls } = yield* recordedAdapter({});
      const withoutEmailOrPhone: GatewayPayerContact = { ...contact, email: Option.none() };
      const withoutName: GatewayPayerContact = { ...contact, fullName: Option.none() };
      for (const payerContact of [Option.none(), Option.some(withoutEmailOrPhone), Option.some(withoutName)]) {
        const result = yield* outcome(adapter.prepareCollect(target, collectRequest(payerContact)));
        expect(result).toMatchObject({
          error: { _tag: 'GatewayProviderUnavailable', family: 'COMGATE', reason: 'payer_contact_unavailable' },
          ok: false,
        });
      }
      expect(calls).toHaveLength(0);
    }),
  );

  it.effect('#1158 Lost Comgate create response is OUTCOME_UNKNOWN', () =>
    Effect.gen(function* lostCreate() {
      const lost = Effect.fail(
        new GatewayProviderOutcomeUnknown({
          code: 'gateway_provider_outcome_unknown',
          family: 'COMGATE',
          operationId: collectOperationId,
          reason: 'provider_attempt_timed_out',
        }),
      );
      const { adapter, calls } = yield* recordedAdapter({
        mutate: [lost, respond(200, 'not json'), respond(200, JSON.stringify({ code: 0, message: 'OK' }))],
      });
      const prepared = yield* adapter.prepareCollect(target, collectRequest(Option.some(contact)));

      for (const reason of [
        'provider_attempt_timed_out',
        'comgate_create_response_unreadable',
        'comgate_create_success_incomplete',
      ]) {
        const result = yield* outcome(adapter.send(target, prepared, collect));
        expect(result).toMatchObject({ error: { _tag: 'GatewayProviderOutcomeUnknown', reason }, ok: false });
      }
      expect(calls.map((call) => call.kind)).toEqual(['mutate', 'mutate', 'mutate']);

      const replayed = yield* outcome(
        adapter.replay(
          target,
          {
            prepared,
            window: {
              expiresAt: DateTime.makeUnsafe('2026-11-13T10:00:00.000Z'),
              startsAt: DateTime.makeUnsafe('2026-11-12T10:00:00.000Z'),
            },
          },
          collect,
        ),
      );
      expect(replayed).toMatchObject({
        error: { _tag: 'GatewayProviderUnsupported', reason: 'comgate_replay_unsupported' },
        ok: false,
      });
      expect(calls).toHaveLength(3);
    }),
  );

  it.effect('#1158 Comgate rejection code is REJECTED_BEFORE_EFFECT and a tampered request is never sent', () =>
    Effect.gen(function* rejectedAndTampered() {
      const { adapter, calls } = yield* recordedAdapter({ mutate: [respond(400, fixtureText('create-error.json'))] });
      const prepared = yield* adapter.prepareCollect(target, collectRequest(Option.some(contact)));

      const rejected = yield* adapter.send(target, prepared, collect);
      expect(dispatchKind(rejected)).toBe('REJECTED_BEFORE_EFFECT');
      expect(factKindOf(rejected.finding)).toEqual(Option.some('COLLECTION_NOT_EFFECTED'));

      const tampered = { ...prepared, body: new TextEncoder().encode('{"preauth":true}') };
      const refused = yield* outcome(adapter.send(target, tampered, collect));
      expect(refused).toMatchObject({
        error: { _tag: 'GatewayProviderUnavailable', reason: 'comgate_prepared_request_hash_mismatch' },
        ok: false,
      });
      const misrouted = yield* outcome(adapter.send(target, prepared, refund));
      expect(misrouted).toMatchObject({
        error: { _tag: 'GatewayProviderUnavailable', reason: 'comgate_prepared_request_route_mismatch' },
        ok: false,
      });
      expect(calls).toHaveLength(1);
    }),
  );
});

describe('#1156 Comgate refund and cancel', () => {
  it.effect('#1156 Comgate refund is pending only', () =>
    Effect.gen(function* refundPending() {
      const { adapter, calls } = yield* recordedAdapter({ mutate: [respond(200, fixtureText('result-ok.json'))] });
      const prepared = yield* adapter.prepareRefund(target, refundRequest);
      expect(bodyJson(prepared.body)).toEqual({
        amount: 10_000,
        refId: deriveProviderCorrelation(refundOperationId).orderReference,
        test: true,
        transId: TRANS_ID,
      });
      expect(prepared.endpointRef).toBe('comgate:POST:/v2.0/refund.json');

      const response = yield* adapter.send(target, prepared, refund);
      expect(dispatchKind(response)).toBe('ACKNOWLEDGED');
      expect(response.finding.finding).toBe('ACCEPTED_PENDING');
      expect(factKindOf(response.finding)).toEqual(Option.some('REFUND_PENDING'));
      expect(response.finding.evidence.pipe(Option.flatMap((evidence) => evidence.economicEffectKey))).toEqual(
        Option.some(`comgate-refund:${TRANS_ID}:${refundOperationId}`),
      );

      // A SANDBOX refund never appears in a statement (production only): nothing is called.
      const looked = yield* adapter.lookup(target, {
        dispatchedAt: Option.some(DateTime.makeUnsafe('2026-04-01T10:00:00.000Z')),
        expected: refund,
        target: { _tag: 'PROVIDER_OBJECT', ref: transactionRef },
      });
      expect(looked.map((finding) => [finding.finding, Option.isNone(finding.evidence)])).toEqual([
        ['INDETERMINATE', true],
      ]);
      expect(calls.map((call) => `${call.kind}:${call.request.method}:${call.request.url}`)).toEqual([
        'mutate:POST:https://payments.comgate.cz/v2.0/refund.json',
      ]);
    }),
  );

  it.effect('#1156 Cancel of a paid transaction is CANCEL_NOT_EFFECTED with collection evidence', () =>
    Effect.gen(function* cancelPaid() {
      const { adapter, calls } = yield* recordedAdapter({
        mutate: [respond(200, fixtureText('result-1400.json'))],
        read: [respond(200, paidStatusBody()), respond(200, paidStatusBody())],
      });
      const prepared = yield* adapter.prepareCancel(target, cancelRequest);
      expect(prepared.endpointRef).toBe(`comgate:DELETE:/v2.0/payment/transId/${TRANS_ID}.json`);
      expect(prepared.body).toHaveLength(0);

      const response = yield* adapter.send(target, prepared, cancel);
      expect(dispatchKind(response)).toBe('REJECTED_BEFORE_EFFECT');
      expect(response.finding.target.operationId).toBe(cancelOperationId);
      expect(response.finding.finding).toBe('NOT_EFFECTED');
      expect(factKindOf(response.finding)).toEqual(Option.some('CANCEL_NOT_EFFECTED'));
      // The confirming lookup proved the collection paid: that proof travels with the refused cancel.
      const proven = Option.getOrUndefined(response.targetFinding);
      expect([proven?.target.operationId, proven?.finding, factKindOf(proven)]).toEqual([
        collectOperationId,
        'EFFECT_CONFIRMED',
        Option.some('COLLECTION_CONFIRMED'),
      ]);

      const findings = yield* adapter.lookup(target, {
        dispatchedAt: Option.none(),
        expected: cancel,
        target: { _tag: 'PROVIDER_OBJECT', ref: transactionRef },
      });
      expect(factKindOf(findingFor(findings, cancelOperationId))).toEqual(Option.some('CANCEL_NOT_EFFECTED'));
      const collection = findingFor(findings, collectOperationId);
      expect(collection?.finding).toBe('EFFECT_CONFIRMED');
      expect(factKindOf(collection)).toEqual(Option.some('COLLECTION_CONFIRMED'));
      expect(Option.fromUndefinedOr(collection).pipe(Option.flatMap((found) => found.orderReference))).toEqual(
        Option.some(collectCorrelation.orderReference),
      );

      expect(calls.map((call) => `${call.kind}:${call.request.method}`)).toEqual([
        'mutate:DELETE',
        'read:GET',
        'read:GET',
      ]);
    }),
  );

  it.effect('#1156 Accepted cancel is confirmed only by a CANCELLED lookup', () =>
    Effect.gen(function* cancelConfirmed() {
      const { adapter } = yield* recordedAdapter({
        mutate: [respond(200, fixtureText('result-ok.json')), respond(200, fixtureText('result-1400.json'))],
        read: [respond(200, paidStatusBody({ status: 'CANCELLED' })), respond(404, fixtureText('status-error.json'))],
      });
      const prepared = yield* adapter.prepareCancel(target, cancelRequest);

      const confirmed = yield* adapter.send(target, prepared, cancel);
      expect(dispatchKind(confirmed)).toBe('ACKNOWLEDGED');
      expect(factKindOf(confirmed.finding)).toEqual(Option.some('CANCEL_CONFIRMED'));

      const missed = yield* outcome(adapter.send(target, prepared, cancel));
      expect(missed).toMatchObject({
        error: { _tag: 'GatewayProviderOutcomeUnknown', reason: 'comgate_cancel_not_changeable_unconfirmed' },
        ok: false,
      });
    }),
  );

  it.effect('#1156 A foreign provider ref is never acted on', () =>
    Effect.gen(function* foreignRef() {
      const { adapter, calls } = yield* recordedAdapter({});
      const foreign = { ...cancelRequest, providerTarget: { _tag: 'GOPAY_PAYMENT' as const, id: TRANS_ID } };
      const result = yield* outcome(
        adapter.prepareCancel(target, Schema.decodeUnknownSync(GatewayCancelRequestSchema)(foreign)),
      );
      expect(result).toMatchObject({
        error: { _tag: 'GatewayProviderUnsupported', reason: 'comgate_foreign_provider_ref' },
        ok: false,
      });
      expect(calls).toHaveLength(0);
    }),
  );
});

describe('#1158 Comgate lookup', () => {
  it.effect('#1158 Lookup miss is INDETERMINATE and ORDER_REFERENCE is unsupported', () =>
    Effect.gen(function* lookupMiss() {
      const { adapter, calls } = yield* recordedAdapter({
        read: [respond(404, 'Not Found'), respond(200, fixtureText('status-error.json')), respond(401, '')],
      });
      const byTransaction: GatewayLookupRequest = {
        dispatchedAt: Option.none(),
        expected: collect,
        target: { _tag: 'PROVIDER_OBJECT', ref: transactionRef },
      };

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const findings = yield* adapter.lookup(target, byTransaction);
        expect(findings.map((finding) => [finding.finding, Option.isNone(finding.evidence)])).toEqual([
          ['INDETERMINATE', true],
        ]);
      }
      const unauthorized = yield* outcome(adapter.lookup(target, byTransaction));
      expect(unauthorized).toMatchObject({
        error: { _tag: 'GatewayProviderUnavailable', reason: 'comgate_authentication_rejected' },
        ok: false,
      });

      const byOrderReference = yield* outcome(
        adapter.lookup(target, {
          dispatchedAt: Option.none(),
          expected: collect,
          target: { _tag: 'ORDER_REFERENCE', orderReference: collectCorrelation.orderReference },
        }),
      );
      expect(byOrderReference).toMatchObject({
        error: { _tag: 'GatewayProviderUnsupported', reason: 'comgate_order_reference_lookup_unsupported' },
        ok: false,
      });
      expect(calls).toHaveLength(3);
      expect(calls.every((call) => call.request.headers.authorization === expectedAuthorization)).toBe(true);
    }),
  );

  it.effect('#1157 Comgate states the refId of a notified transaction only for the binding merchant and mode', () =>
    Effect.gen(function* readOrderReference() {
      const { adapter, calls } = yield* recordedAdapter({
        read: [
          respond(200, paidStatusBody()),
          respond(200, paidStatusBody({ test: 'false' })),
          respond(200, paidStatusBody({ merchant: '999999' })),
          respond(404, 'Not Found'),
        ],
      });
      expect(yield* adapter.readOrderReference(target, transactionRef)).toEqual(
        Option.some(collectCorrelation.orderReference),
      );
      // Another mode, another merchant and a miss state nothing.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        expect(yield* adapter.readOrderReference(target, transactionRef)).toEqual(Option.none());
      }
      const gopayRef = Schema.decodeUnknownSync(ProviderObjectRefSchema)({ _tag: 'GOPAY_PAYMENT', id: '3000006529' });
      expect(yield* adapter.readOrderReference(target, gopayRef)).toEqual(Option.none());
      expect(calls).toHaveLength(4);
      expect(calls.every((call) => call.request.headers.authorization === expectedAuthorization)).toBe(true);
    }),
  );
});

/* ------------------------------------------------------------------------------------------------ */
/* Refund proof from the production settlement statement (plan D-P2)                                */
/* ------------------------------------------------------------------------------------------------ */

const liveTarget = Schema.decodeUnknownSync(GatewayExecutionTargetSchema)({
  ...Schema.encodeSync(GatewayExecutionTargetSchema)(target),
  binding: {
    _tag: 'GATEWAY_ACCOUNT',
    environment: 'LIVE',
    providerAccountRef: `pab_${'1'.repeat(32)}`,
    providerFamily: 'COMGATE',
  },
  credentialSecretRef: 'comgate.live',
});

const secondRefundOperationId = '6c5b4a39-2817-4f06-8e5d-4c3b2a190807';
const refundReference = deriveProviderCorrelation(refundOperationId).orderReference;
const secondRefundReference = deriveProviderCorrelation(secondRefundOperationId).orderReference;
const secondRefund: GatewayExpectedEffect = { _tag: 'REFUND', amount, operationId: secondRefundOperationId };

/** Documented transferList / singleTransfer examples and the official monthly sample's refund row (fixtures README). */
const decodeJsonArray = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Array(Schema.Record(Schema.String, Schema.Json))),
);
const firstOf = (name: string): JsonObject => decodeJsonArray(fixtureText(name))[0] ?? {};
const documentedPaymentRow = (): JsonObject => firstOf('single-transfer.json');
const refundRow = (overrides: JsonObject = {}) => ({
  ...decodeJsonObject(fixtureText('statement-refund-row.json')),
  'ID od klienta': refundReference,
  'Potvrzená částka': '-100,00',
  ...overrides,
});
const transfersBody = (...ids: readonly number[]) =>
  JSON.stringify(ids.map((transferId) => ({ ...firstOf('transfer-list.json'), transferId })));
const rowsBody = (...rows: readonly JsonObject[]) => JSON.stringify(rows);
const noContent = respond(204, '');

const DISPATCHED_AT = DateTime.makeUnsafe('2026-04-09T12:48:30.000Z');
/** 2026-04-11 10:00 Prague: the statements of 04-09 and 04-10 are readable. */
const NOW_MS = Date.UTC(2026, 3, 11, 8, 0, 0);

const statementLookup = (expected: GatewayExpectedEffect, dispatchedAt = Option.some(DISPATCHED_AT)) => ({
  dispatchedAt,
  expected,
  target: { _tag: 'PROVIDER_OBJECT' as const, ref: transactionRef },
});

const transferListUrl = (date: string) => `https://payments.comgate.cz/v2.0/transferList/date/${date}.json`;
const singleTransferUrl = (id: number) => `https://payments.comgate.cz/v2.0/singleTransfer/transferId/${id}.json`;

const evidenceOf = (findings: readonly ProviderFindingResult[]) =>
  Option.getOrUndefined(Option.fromUndefinedOr(findings[0]).pipe(Option.flatMap((finding) => finding.evidence)));

/** One lookup's reads: an empty first day, then one transfer with `rows`. */
const statementScenario = (...rows: readonly JsonObject[]) => [
  noContent,
  respond(200, transfersBody(1_234_567)),
  respond(200, rowsBody(...rows)),
];

describe('#1156 Comgate refund proof from the settlement statement', () => {
  it.effect('#1156 A statement row with the refund refId, amount and merchant is REFUND_CONFIRMED', () =>
    Effect.gen(function* confirmedFromStatement() {
      yield* TestClock.setTime(NOW_MS);
      const { adapter, calls } = yield* recordedAdapter({
        read: [
          noContent,
          respond(200, transfersBody(1_234_567)),
          respond(
            200,
            rowsBody(
              documentedPaymentRow(),
              refundRow({ Merchant: '999999', 'Potvrzená částka': '-55,00' }),
              refundRow(),
            ),
          ),
        ],
      });
      const findings = yield* adapter.lookup(liveTarget, statementLookup(refund));

      expect(findings.map((finding) => [finding.target.operationId, finding.finding])).toEqual([
        [refundOperationId, 'EFFECT_CONFIRMED'],
      ]);
      const evidence = evidenceOf(findings);
      expect(evidence?.factKind).toBe('REFUND_CONFIRMED');
      expect(evidence?.factFamily).toBe('REFUND_EXECUTION');
      expect(evidence?.sourceOccurrenceId).toBe(
        `comgate:statement:1234567:${refundOperationId}:REFUND_CONFIRMED:10000`,
      );
      expect(evidence?.economicEffectKey).toEqual(Option.some(`comgate-refund:${TRANS_ID}:${refundOperationId}`));
      expect(evidence?.observedAmount).toEqual(Option.some(amount));
      expect(evidence?.discrepancy).toEqual(Option.none());
      // `Datum založení` 2026-04-09 14:48:30 Prague (CEST) is 12:48:30 UTC.
      expect(evidence?.providerOccurredAt).toEqual(Option.some(DateTime.makeUnsafe('2026-04-09T12:48:30.000Z')));
      expect(evidence?.observedAt).toEqual(DateTime.makeUnsafe(NOW_MS));

      expect(calls.map((call) => `${call.kind}:${call.request.method}:${call.request.url}`)).toEqual([
        `read:GET:${transferListUrl('2026-04-09')}`,
        `read:GET:${transferListUrl('2026-04-10')}`,
        `read:GET:${singleTransferUrl(1_234_567)}`,
      ]);
      // #1157: every statement read goes through the original binding's merchant authorization.
      expect(calls.every((call) => call.request.headers.authorization === expectedAuthorization)).toBe(true);
    }),
  );

  it.effect('#1159 Two refunds of the same amount on one payment are told apart by their refId', () =>
    Effect.gen(function* twoEqualRefunds() {
      yield* TestClock.setTime(NOW_MS);
      const statement = [
        noContent,
        respond(200, transfersBody(1_234_567)),
        respond(200, rowsBody(refundRow(), refundRow({ 'ID od klienta': secondRefundReference }))),
      ];
      const { adapter } = yield* recordedAdapter({ read: [...statement, ...statement] });

      const first = evidenceOf(yield* adapter.lookup(liveTarget, statementLookup(refund)));
      const second = evidenceOf(yield* adapter.lookup(liveTarget, statementLookup(secondRefund)));

      expect([first?.factKind, second?.factKind]).toEqual(['REFUND_CONFIRMED', 'REFUND_CONFIRMED']);
      expect(first?.sourceOccurrenceId).toBe(`comgate:statement:1234567:${refundOperationId}:REFUND_CONFIRMED:10000`);
      expect(second?.sourceOccurrenceId).toBe(
        `comgate:statement:1234567:${secondRefundOperationId}:REFUND_CONFIRMED:10000`,
      );
      expect(first?.economicEffectKey).not.toEqual(second?.economicEffectKey);
    }),
  );

  it.effect('#1158 A refund missing from the statement is INDETERMINATE, never NOT_EFFECTED', () =>
    Effect.gen(function* notInStatement() {
      yield* TestClock.setTime(NOW_MS);
      // A row with a random or local refund id, or with the payment's own refId, proves nothing.
      const { adapter } = yield* recordedAdapter({
        read: [
          noContent,
          respond(200, transfersBody(1_234_567)),
          respond(
            200,
            rowsBody(
              documentedPaymentRow(),
              refundRow({ 'ID od klienta': 'f'.repeat(32) }),
              refundRow({ 'ID od klienta': collectCorrelation.orderReference }),
              refundRow({ 'ID od klienta': refundOperationId }),
            ),
          ),
        ],
      });
      const findings = yield* adapter.lookup(liveTarget, statementLookup(refund));
      expect(findings.map((finding) => [finding.finding, Option.isNone(finding.evidence)])).toEqual([
        ['INDETERMINATE', true],
      ]);
    }),
  );

  it.effect('#1156 Another amount, currency, a credit row or two rows are a verification conflict', () =>
    Effect.gen(function* conflicts() {
      yield* TestClock.setTime(NOW_MS);
      const { adapter } = yield* recordedAdapter({
        read: [
          ...statementScenario(refundRow({ 'Potvrzená částka': '-50,00' })),
          ...statementScenario(refundRow({ Měna: 'EUR' })),
          ...statementScenario(refundRow({ 'Potvrzená částka': '100,00' })),
          ...statementScenario(refundRow(), refundRow()),
        ],
      });

      const lowerAmount = yield* adapter.lookup(liveTarget, statementLookup(refund));
      expect(lowerAmount[0]?.finding).toBe('VERIFICATION_CONFLICT');
      expect(evidenceOf(lowerAmount)?.discrepancy).toEqual(
        Option.some({ expected: amount, observed: { amountMinor: 5000, currency: 'CZK' } }),
      );

      const otherCurrency = yield* adapter.lookup(liveTarget, statementLookup(refund));
      expect(otherCurrency[0]?.finding).toBe('VERIFICATION_CONFLICT');
      expect(evidenceOf(otherCurrency)?.observedAmount).toEqual(Option.some({ amountMinor: 10_000, currency: 'EUR' }));

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const findings = yield* adapter.lookup(liveTarget, statementLookup(refund));
        expect(findings.map((finding) => [finding.finding, Option.isNone(finding.evidence)])).toEqual([
          ['VERIFICATION_CONFLICT', true],
        ]);
      }
    }),
  );

  it.effect('#1156 SANDBOX, an unknown dispatch time and an unreadable day make no statement call', () =>
    Effect.gen(function* noCall() {
      // 2026-04-09 23:59:59 Prague: the dispatch day's statement is not readable before the next morning.
      yield* TestClock.setTime(Date.UTC(2026, 3, 9, 21, 59, 59));
      const { adapter, calls } = yield* recordedAdapter({});
      for (const [bindingTarget, dispatchedAt] of [
        [target, Option.some(DISPATCHED_AT)],
        [liveTarget, Option.none()],
        [liveTarget, Option.some(DISPATCHED_AT)],
      ] as const) {
        const findings = yield* adapter.lookup(bindingTarget, statementLookup(refund, dispatchedAt));
        expect(findings.map((finding) => [finding.finding, Option.isNone(finding.evidence)])).toEqual([
          ['INDETERMINATE', true],
        ]);
      }
      expect(calls).toHaveLength(0);
    }),
  );

  it.effect('#1156 Statement dates are Europe/Prague dates and bounded to 24 per lookup', () =>
    Effect.gen(function* pragueDates() {
      // Dispatched 2026-04-09 22:30 UTC = 04-10 00:30 Prague; now 04-11 00:30 Prague: only 04-10 is read.
      yield* TestClock.setTime(Date.UTC(2026, 3, 10, 22, 30, 0));
      const boundary = yield* recordedAdapter({ read: [noContent] });
      yield* boundary.adapter.lookup(
        liveTarget,
        statementLookup(refund, Option.some(DateTime.makeUnsafe('2026-04-09T22:30:00.000Z'))),
      );
      expect(boundary.calls.map((call) => call.request.url)).toEqual([transferListUrl('2026-04-10')]);

      // Months later: dispatch date + 23 days at most, then nothing.
      yield* TestClock.setTime(Date.UTC(2026, 10, 12, 8, 0, 0));
      const bounded = yield* recordedAdapter({ read: Array.from({ length: 30 }, () => noContent) });
      const findings = yield* bounded.adapter.lookup(
        liveTarget,
        statementLookup(refund, Option.some(DateTime.makeUnsafe('2026-01-01T10:00:00.000Z'))),
      );
      expect(findings[0]?.finding).toBe('INDETERMINATE');
      expect(bounded.calls).toHaveLength(24);
      expect(bounded.calls[0]?.request.url).toBe(transferListUrl('2026-01-01'));
      expect(bounded.calls[23]?.request.url).toBe(transferListUrl('2026-01-24'));
    }),
  );

  it.effect('#1158 A transport or credential failure of a statement read is UNAVAILABLE', () =>
    Effect.gen(function* statementUnavailable() {
      yield* TestClock.setTime(NOW_MS);
      const dropped = Effect.fail(
        new GatewayProviderUnavailable({
          code: 'gateway_provider_unavailable',
          family: 'COMGATE',
          reason: 'provider_transport_failed',
        }),
      );
      const { adapter, calls } = yield* recordedAdapter({
        read: [
          dropped,
          noContent,
          respond(200, transfersBody(1_234_567)),
          dropped,
          respond(401, ''),
          respond(404, 'Not Found'),
          respond(200, 'not json'),
        ],
      });
      const results: unknown[] = [];
      for (let attempt = 0; attempt < 5; attempt += 1) {
        results.push(yield* outcome(adapter.lookup(liveTarget, statementLookup(refund))));
      }
      expect(results).toMatchObject([
        { error: { _tag: 'GatewayProviderUnavailable', reason: 'provider_transport_failed' }, ok: false },
        { error: { _tag: 'GatewayProviderUnavailable', reason: 'provider_transport_failed' }, ok: false },
        { error: { _tag: 'GatewayProviderUnavailable', reason: 'comgate_authentication_rejected' }, ok: false },
        { error: { _tag: 'GatewayProviderUnavailable', reason: 'comgate_statement_status_unexpected' }, ok: false },
        { error: { _tag: 'GatewayProviderResponseInvalid', reason: 'comgate_transfer_list_invalid' }, ok: false },
      ]);
      expect(calls.every((call) => call.kind === 'read' && call.request.method === 'GET')).toBe(true);
    }),
  );
});
