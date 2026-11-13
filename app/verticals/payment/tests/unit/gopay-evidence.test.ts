import { describe, expect, it } from 'effect-rstest';
import { DateTime, Match, Option, Schema } from 'effect';

import { GOPAY_CAPABILITIES, gopayCancelUnsupported } from '../../src/integrations/gopay/gopay-capabilities.ts';
import {
  gopayCancelUnsupportedEvidence,
  gopayVerifiedOrderReference,
  mapGopayCreateResponse,
  mapGopayLookup,
  mapGopayRefundResponse,
  matchGopayRefundHistory,
} from '../../src/integrations/gopay/gopay-evidence.ts';
import type { GopayLookupResult } from '../../src/integrations/gopay/gopay-evidence.ts';
import { fromGopayAmount, toGopayAmount } from '../../src/integrations/gopay/gopay-money.ts';
import {
  GopayCreatePaymentRequestJsonSchema,
  GopayErrorResponseFromJsonSchema,
  GopayPaymentFromJsonSchema,
  GopayRefundHistoryFromJsonSchema,
  GopayRefundResponseFromJsonSchema,
  gopayProviderObjectId,
} from '../../src/integrations/gopay/gopay-wire.ts';
import { deriveProviderCorrelation } from '../../src/integrations/psp/psp-correlation.ts';
import type { GatewayExpectedEffect, GatewayLookupRequest } from '../../src/integrations/psp/psp-request.ts';
import { GatewayProviderUnsupported } from '../../src/integrations/psp/psp-errors.ts';
import type { ProviderDispatchResponse, ProviderFindingResult } from '../../src/integrations/psp/psp-result.ts';
import { gopayExecutionTarget } from '../fixtures/gopay/execution-target.ts';
import {
  GOPAY_FIXTURE_GOID,
  GOPAY_FIXTURE_PAYMENT_ID,
  gopayCreateResponseBody,
  gopayInquiryResponseBody,
  gopayPaymentNotFoundBody,
} from '../fixtures/gopay/payment-responses.ts';
import {
  gopayDocumentedRefundHistoryBody,
  gopayRefundResponseBody,
  gopayTimestampedRefundHistoryBody,
} from '../fixtures/gopay/refund-responses.ts';

const collectOperationId = '0f8b5c1e-3a2d-4c7b-9e1f-5a6b7c8d9e0f';
const refundOperationId = '6c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f';
const cancelOperationId = '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b';
const { orderReference } = deriveProviderCorrelation(collectOperationId);
const czk = (amountMinor: number) => ({ amountMinor, currency: 'CZK' as const });
const paymentRef = gopayProviderObjectId(Number(GOPAY_FIXTURE_PAYMENT_ID));
const observedAt = DateTime.makeUnsafe('2026-11-12T10:05:00.000Z');
const dispatchedAt = DateTime.makeUnsafe('2026-11-12T10:00:00.000Z');
const target = gopayExecutionTarget();

const decodePayment = Schema.decodeUnknownSync(GopayPaymentFromJsonSchema);
const decodeHistory = Schema.decodeUnknownSync(GopayRefundHistoryFromJsonSchema);

const inquiry = (state: string, overrides: { amount?: number; goid?: string; orderNumber?: string } = {}) =>
  decodePayment(
    gopayInquiryResponseBody({
      amount: overrides.amount ?? 10_000,
      goid: overrides.goid ?? GOPAY_FIXTURE_GOID,
      orderNumber: overrides.orderNumber ?? orderReference,
      state,
    }),
  );

const lookupRequest = (expected: GatewayExpectedEffect): GatewayLookupRequest => ({
  dispatchedAt: Option.some(dispatchedAt),
  expected,
  target: { _tag: 'PROVIDER_OBJECT', ref: { _tag: 'GOPAY_PAYMENT', id: paymentRef } },
});
const collectExpected: GatewayExpectedEffect = {
  _tag: 'COLLECT',
  amount: czk(10_000),
  operationId: collectOperationId,
};
const refundExpected: GatewayExpectedEffect = { _tag: 'REFUND', amount: czk(4000), operationId: refundOperationId };

const lookup = (request: GatewayLookupRequest, result: GopayLookupResult) =>
  mapGopayLookup({ observedAt, origin: 'RECOVERY_LOOKUP', paymentRef, request, result, target });

const found = (state: string, refunds: Option.Option<string> = Option.none()): GopayLookupResult => ({
  _tag: 'FOUND',
  payment: inquiry(state),
  refunds: refunds.pipe(Option.map(decodeHistory)),
});

const onlyFinding = (findings: readonly ProviderFindingResult[]): ProviderFindingResult => {
  expect(findings).toHaveLength(1);
  const [finding] = findings;
  if (finding === undefined) {
    throw new Error('expected one finding');
  }
  return finding;
};

const factKindOf = (finding: ProviderFindingResult) =>
  finding.evidence.pipe(
    Option.map((evidence) => evidence.factKind),
    Option.getOrUndefined,
  );

const dispatchOutcome = (response: ProviderDispatchResponse) =>
  Match.value(response).pipe(
    Match.tag('ACKNOWLEDGED', () => 'ACKNOWLEDGED'),
    Match.tag('REJECTED_BEFORE_EFFECT', () => 'REJECTED_BEFORE_EFFECT'),
    Match.exhaustive,
  );

const timestampedHistory = (entries: readonly { amount: number; dateRequested: string; state: string }[]) =>
  Option.some(gopayTimestampedRefundHistoryBody(entries));

describe('#1156 GoPay evidence mapping', () => {
  it('#1156 REFUNDED is collection proven plus refund evidence, never canceled', () => {
    for (const state of ['REFUNDED', 'PARTIALLY_REFUNDED']) {
      const collection = onlyFinding(lookup(lookupRequest(collectExpected), found(state)));
      expect(collection.finding).toBe('EFFECT_CONFIRMED');
      expect(factKindOf(collection)).toBe('COLLECTION_CONFIRMED');
      expect(collection.orderReference).toEqual(Option.some(orderReference));
      expect(collection.target).toEqual({ operationId: collectOperationId, operationKind: 'COLLECT' });
    }

    const history = timestampedHistory([
      { amount: 4000, dateRequested: '2026-11-12T11:00:30.000+0100', state: 'SUCCESS' },
    ]);
    const refund = onlyFinding(lookup(lookupRequest(refundExpected), found('PARTIALLY_REFUNDED', history)));
    expect(refund.finding).toBe('EFFECT_CONFIRMED');
    expect(refund.target).toEqual({ operationId: refundOperationId, operationKind: 'REFUND' });
    expect(refund.orderReference).toEqual(Option.none());
    const evidence = Option.getOrThrow(refund.evidence);
    expect(evidence.factKind).toBe('REFUND_CONFIRMED');
    expect(evidence.factFamily).toBe('REFUND_EXECUTION');
    expect(evidence.observedAmount).toEqual(Option.some(czk(4000)));
    expect(evidence.observedAt).toEqual(observedAt);
    expect(evidence.economicEffectKey).toEqual(Option.some(`gopay-refund:${paymentRef}:${refundOperationId}`));
    expect(evidence.sourceOccurrenceId).toBe(
      `gopay:recovery_lookup:${paymentRef}:${refundOperationId}:REFUND_CONFIRMED:4000`,
    );
    expect(evidence.providerOccurredAt).toEqual(Option.some(DateTime.makeUnsafe('2026-11-12T10:00:30.000Z')));

    const canceledKinds = new Set(['CANCEL_CONFIRMED', 'CANCEL_NOT_EFFECTED', 'COLLECTION_NOT_EFFECTED']);
    for (const finding of [refund, ...lookup(lookupRequest(collectExpected), found('REFUNDED'))]) {
      expect(canceledKinds.has(factKindOf(finding) ?? '')).toBe(false);
      expect(finding.finding).not.toBe('NOT_EFFECTED');
    }
  });

  it('#1156 PAID with a different amount is a discrepancy', () => {
    const finding = onlyFinding(
      lookup(lookupRequest(collectExpected), {
        _tag: 'FOUND',
        payment: inquiry('PAID', { amount: 9900 }),
        refunds: Option.none(),
      }),
    );
    expect(finding.finding).toBe('VERIFICATION_CONFLICT');
    const evidence = Option.getOrThrow(finding.evidence);
    expect(evidence.factKind).toBe('COLLECTION_CONFIRMED');
    expect(evidence.observedAmount).toEqual(Option.some(czk(9900)));
    expect(evidence.discrepancy).toEqual(Option.some({ expected: czk(10_000), observed: czk(9900) }));

    const matching = onlyFinding(lookup(lookupRequest(collectExpected), found('PAID')));
    expect(matching.finding).toBe('EFFECT_CONFIRMED');
    expect(Option.getOrThrow(matching.evidence).discrepancy).toEqual(Option.none());
    expect(Option.getOrThrow(matching.evidence).economicEffectKey).toEqual(Option.some(paymentRef));

    const euro = decodePayment(
      gopayInquiryResponseBody({
        amount: 10_000,
        goid: GOPAY_FIXTURE_GOID,
        orderNumber: orderReference,
        state: 'PAID',
      }).replace('"CZK"', '"EUR"'),
    );
    const euroFinding = onlyFinding(
      lookup(lookupRequest(collectExpected), { _tag: 'FOUND', payment: euro, refunds: Option.none() }),
    );
    expect(euroFinding.finding).toBe('VERIFICATION_CONFLICT');
    expect(Option.getOrThrow(euroFinding.evidence).observedAmount).toEqual(
      Option.some({ amountMinor: 10_000, currency: 'EUR' }),
    );
  });

  it('#1156 AUTHORIZED is a verification conflict', () => {
    const finding = onlyFinding(lookup(lookupRequest(collectExpected), found('AUTHORIZED')));
    expect(finding.finding).toBe('VERIFICATION_CONFLICT');
    expect(finding.evidence).toEqual(Option.none());
  });

  it('#1156 GoPay states map to the documented collection facts', () => {
    const cases = [
      ['CREATED', 'CUSTOMER_ACTION_REQUIRED', 'COLLECTION_PENDING'],
      ['PAYMENT_METHOD_CHOSEN', 'ACCEPTED_PENDING', 'COLLECTION_PENDING'],
      ['PAID', 'EFFECT_CONFIRMED', 'COLLECTION_CONFIRMED'],
      ['CANCELED', 'NOT_EFFECTED', 'COLLECTION_NOT_EFFECTED'],
      ['TIMEOUTED', 'NOT_EFFECTED', 'COLLECTION_NOT_EFFECTED'],
    ] as const;
    for (const [state, finding, factKind] of cases) {
      const result = onlyFinding(lookup(lookupRequest(collectExpected), found(state)));
      expect([state, result.finding, factKindOf(result)]).toEqual([state, finding, factKind]);
    }
    const created = onlyFinding(lookup(lookupRequest(collectExpected), found('CREATED')));
    expect(created.customerAction).toEqual(Option.some({ redirectUrl: 'https://gw.sandbox.gopay.com/gw/v3/...' }));
  });

  it('#1158 Lookup miss is never NOT_EFFECTED', () => {
    expect(Schema.decodeUnknownSync(GopayErrorResponseFromJsonSchema)(gopayPaymentNotFoundBody).errors).toEqual([
      { error_code: 'PAYMENT_NOT_FOUND' },
    ]);
    const cancelExpected: GatewayExpectedEffect = {
      _tag: 'CANCEL_OR_VOID',
      operationId: cancelOperationId,
      target: { amount: czk(10_000), operationId: collectOperationId },
    };
    for (const expected of [collectExpected, refundExpected, cancelExpected]) {
      const finding = onlyFinding(lookup(lookupRequest(expected), { _tag: 'NOT_FOUND' }));
      expect(finding.finding).toBe('INDETERMINATE');
      expect(finding.evidence).toEqual(Option.none());
    }
    const refundWithoutHistory = onlyFinding(lookup(lookupRequest(refundExpected), found('PAID')));
    expect(refundWithoutHistory.finding).toBe('INDETERMINATE');
    const refundEmptyHistory = onlyFinding(lookup(lookupRequest(refundExpected), found('PAID', Option.some('[]'))));
    expect(refundEmptyHistory.finding).toBe('INDETERMINATE');
  });

  it('#1156 Cancel lookup reports only the collection target', () => {
    const finding = onlyFinding(
      lookup(
        lookupRequest({
          _tag: 'CANCEL_OR_VOID',
          operationId: cancelOperationId,
          target: { amount: czk(10_000), operationId: collectOperationId },
        }),
        found('PAID'),
      ),
    );
    expect(finding.target).toEqual({ operationId: collectOperationId, operationKind: 'COLLECT' });
    expect(finding.finding).toBe('EFFECT_CONFIRMED');
  });

  it('#1156 Ambiguous refund history gives INDETERMINATE', () => {
    const history = (entries: readonly { amount: number; dateRequested: string; state: string }[]) =>
      decodeHistory(gopayTimestampedRefundHistoryBody(entries));
    const match = (body: ReturnType<typeof history>, at: Option.Option<DateTime.Utc> = Option.some(dispatchedAt)) =>
      matchGopayRefundHistory({ dispatchedAt: at, expectedAmount: czk(4000), history: body, paymentRef });

    const twoCandidates = history([
      { amount: 4000, dateRequested: '2026-11-12T10:01:00.000Z', state: 'SUCCESS' },
      { amount: 4000, dateRequested: '2026-11-12T10:02:00.000Z', state: 'SUCCESS' },
    ]);
    expect(match(twoCandidates)).toEqual(Option.none());

    const priorAndOurs = history([
      { amount: 4000, dateRequested: '2026-11-10T09:00:00.000Z', state: 'SUCCESS' },
      { amount: 2500, dateRequested: '2026-11-12T10:01:00.000Z', state: 'SUCCESS' },
      { amount: 4000, dateRequested: '2026-11-12T10:00:00.000Z', state: 'SUCCESS' },
    ]);
    expect(Option.map(match(priorAndOurs), (entry) => entry.date_requested)).toEqual(
      Option.some('2026-11-12T10:00:00.000Z'),
    );
    expect(match(priorAndOurs, Option.none())).toEqual(Option.none());

    const requested = history([{ amount: 4000, dateRequested: '2026-11-12T10:01:00.000Z', state: 'REQUESTED' }]);
    expect(match(requested)).toEqual(Option.none());
    const failed = history([{ amount: 4000, dateRequested: '2026-11-12T10:01:00.000Z', state: 'FAILED' }]);
    expect(match(failed)).toEqual(Option.none());

    const documented = decodeHistory(gopayDocumentedRefundHistoryBody);
    expect(
      matchGopayRefundHistory({
        dispatchedAt: Option.some(DateTime.makeUnsafe('2024-04-05T08:00:00.000Z')),
        expectedAmount: czk(20_000),
        history: documented,
        paymentRef,
      }),
    ).toEqual(Option.none());
    expect(
      matchGopayRefundHistory({
        dispatchedAt: Option.some(DateTime.makeUnsafe('2024-04-03T08:00:00.000Z')),
        expectedAmount: czk(20_000),
        history: documented,
        paymentRef,
      }).pipe(Option.map((entry) => entry.state)),
    ).toEqual(Option.some('SUCCESS'));

    const ambiguousFinding = onlyFinding(
      lookup(
        lookupRequest(refundExpected),
        found(
          'PARTIALLY_REFUNDED',
          timestampedHistory([
            { amount: 4000, dateRequested: '2026-11-12T10:01:00.000Z', state: 'SUCCESS' },
            { amount: 4000, dateRequested: '2026-11-12T10:03:00.000Z', state: 'SUCCESS' },
          ]),
        ),
      ),
    );
    expect(ambiguousFinding.finding).toBe('INDETERMINATE');
    expect(ambiguousFinding.evidence).toEqual(Option.none());
  });

  it('#1156 Create response is verified against the dispatch and the binding', () => {
    const expected = { amount: czk(10_000), operationId: collectOperationId };
    const response = mapGopayCreateResponse({
      expected,
      observedAt,
      payment: decodePayment(gopayCreateResponseBody(orderReference)),
      target,
    });
    expect(dispatchOutcome(response)).toBe('ACKNOWLEDGED');
    expect(response.finding.finding).toBe('CUSTOMER_ACTION_REQUIRED');
    expect(response.finding.customerAction).toEqual(
      Option.some({ redirectUrl: 'https://gw.sandbox.gopay.com/gw/v3/...' }),
    );
    expect(Option.getOrThrow(response.finding.evidence).sourceOccurrenceId).toBe(
      `gopay:dispatch_response:${paymentRef}:${collectOperationId}:COLLECTION_PENDING:10000`,
    );

    const otherOrder = mapGopayCreateResponse({
      expected,
      observedAt,
      payment: decodePayment(gopayCreateResponseBody('123456')),
      target,
    });
    expect(otherOrder.finding.finding).toBe('VERIFICATION_CONFLICT');
    expect(otherOrder.finding.evidence).toEqual(Option.none());
    expect(otherOrder.finding.providerRefs).toEqual([]);

    const otherMerchant = mapGopayCreateResponse({
      expected,
      observedAt,
      payment: decodePayment(gopayCreateResponseBody(orderReference)),
      target: gopayExecutionTarget('8123456780'),
    });
    expect(otherMerchant.finding.finding).toBe('VERIFICATION_CONFLICT');
    expect(otherMerchant.finding.evidence).toEqual(Option.none());
  });

  it('#1156 Refund response FAILED is not effected and ACCEPTED or FINISHED is pending', () => {
    const decodeRefund = Schema.decodeUnknownSync(GopayRefundResponseFromJsonSchema);
    const map = (result: string) =>
      mapGopayRefundResponse({
        expected: { amount: czk(4000), operationId: refundOperationId },
        observedAt,
        origin: 'DISPATCH_RESPONSE',
        paymentRef,
        response: decodeRefund(gopayRefundResponseBody(result)),
      });
    const failed = map('FAILED');
    expect(dispatchOutcome(failed)).toBe('REJECTED_BEFORE_EFFECT');
    expect(failed.finding.finding).toBe('NOT_EFFECTED');
    expect(factKindOf(failed.finding)).toBe('REFUND_NOT_EFFECTED');
    for (const result of ['ACCEPTED', 'FINISHED']) {
      const pending = map(result);
      expect(dispatchOutcome(pending)).toBe('ACKNOWLEDGED');
      expect(pending.finding.finding).toBe('ACCEPTED_PENDING');
      const evidence = Option.getOrThrow(pending.finding.evidence);
      expect(evidence.factKind).toBe('REFUND_PENDING');
      expect(evidence.observedAmount).toEqual(Option.none());
      expect(evidence.economicEffectKey).toEqual(Option.some(`gopay-refund:${paymentRef}:${refundOperationId}`));
    }
    expect(() => decodeRefund(gopayRefundResponseBody('REFUNDED'))).toThrow();
  });

  it('#1156 GoPay cancel is UNSUPPORTED with local not-effected evidence', () => {
    expect(GOPAY_CAPABILITIES.CANCEL_OR_VOID).toBe('UNSUPPORTED');
    const failure = gopayCancelUnsupported();
    expect(Schema.is(GatewayProviderUnsupported)(failure)).toBe(true);
    expect([failure.capability, failure.family, failure.reason]).toEqual([
      'CANCEL_OR_VOID',
      'GOPAY',
      'provider_cancel_unsupported',
    ]);
    const evidence = gopayCancelUnsupportedEvidence({
      observedAt,
      operationId: cancelOperationId,
      providerTarget: Option.some({ _tag: 'GOPAY_PAYMENT', id: paymentRef }),
    });
    expect(evidence.factKind).toBe('CANCEL_NOT_EFFECTED');
    expect(evidence.reason).toEqual(Option.some('provider_cancel_unsupported'));
    expect(evidence.sourceOccurrenceId).toBe(`gopay:local:${cancelOperationId}:CANCEL_NOT_EFFECTED`);
  });

  it('#1156 GoPay money is exact minor units and the create body has no preauthorization', () => {
    expect(toGopayAmount(czk(159_950))).toEqual({ amount: 159_950, currency: 'CZK' });
    expect(fromGopayAmount({ amount: 159_950, currency: 'EUR' })).toEqual({ amountMinor: 159_950, currency: 'EUR' });
    expect(() => decodePayment(gopayCreateResponseBody(orderReference).replace('10000', '100.5'))).toThrow();

    const body = Schema.encodeSync(GopayCreatePaymentRequestJsonSchema)({
      amount: 159_950,
      callback: {
        notification_url: 'https://payments.example.test/gopay/notify',
        return_url: 'https://shop.example.test/return?r=AAAAAAAAAAAAAAAAAAAAAA',
      },
      currency: 'CZK',
      lang: 'CS',
      order_number: orderReference,
      target: { goid: Number(GOPAY_FIXTURE_GOID), type: 'ACCOUNT' },
    });
    expect(body).not.toContain('preauthorization');
    expect(body).not.toContain('recurrence');
    expect(body).toContain(`"order_number":"${orderReference}"`);
  });

  it('#1156 The lookup-verified order number is exposed only for the binding merchant', () => {
    expect(gopayVerifiedOrderReference(target, inquiry('PAID'))).toEqual(Option.some(orderReference));
    expect(gopayVerifiedOrderReference(target, inquiry('PAID', { goid: '8123456780' }))).toEqual(Option.none());
    expect(gopayVerifiedOrderReference(target, inquiry('PAID', { orderNumber: '123456' }))).toEqual(Option.none());
  });
});
