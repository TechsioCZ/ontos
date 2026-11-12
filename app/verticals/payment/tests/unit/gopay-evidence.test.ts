import { describe, expect, it } from 'effect-rstest';
import { DateTime, Match, Option, Schema } from 'effect';

import { GOPAY_CAPABILITIES, gopayPayerContactUnavailable } from '../../src/integrations/gopay/gopay-capabilities.ts';
import {
  gopayOrderReferenceOf,
  mapGopayCancelAnswer,
  mapGopayCreateResponse,
  mapGopayLookup,
  mapGopayRefundResponse,
  matchGopayRefundList,
} from '../../src/integrations/gopay/gopay-evidence.ts';
import type { GopayCancelAnswer, GopayLookupResult } from '../../src/integrations/gopay/gopay-evidence.ts';
import { fromGopayAmount, toGopayAmount } from '../../src/integrations/gopay/gopay-money.ts';
import {
  GopayCreatePaymentRequestJsonSchema,
  GopayPaymentFromJsonSchema,
  GopayRefundFromJsonSchema,
  GopayRefundListFromJsonSchema,
  parseGopayId,
} from '../../src/integrations/gopay/gopay-wire.ts';
import { deriveProviderCorrelation } from '../../src/integrations/psp/psp-correlation.ts';
import { GatewayProviderUnavailable } from '../../src/integrations/psp/psp-errors.ts';
import type { GatewayExpectedEffect } from '../../src/integrations/psp/psp-request.ts';
import type { ProviderDispatchResponse, ProviderFindingResult } from '../../src/integrations/psp/psp-result.ts';
import {
  GOPAY_FIXTURE_PAYMENT_ID,
  GOPAY_FIXTURE_PAYMENT_SECRET,
  gopayCreateResponseBody,
  gopayPaymentBody,
} from '../fixtures/gopay/payment-responses.ts';
import { GOPAY_FIXTURE_REFUND_ID, gopayRefundBody, gopayRefundListBody } from '../fixtures/gopay/refund-responses.ts';
import type { GopayRefundFixture } from '../fixtures/gopay/refund-responses.ts';

/**
 * Pure GoPay Payments API v4 evidence mapping (#1156, #1158, #1159). Bodies are the documented v4 shapes
 * (tests/fixtures/gopay, https://api-docs.gopay.com/spec/en/payments.yaml).
 */

const collectOperationId = '0f8b5c1e-3a2d-4c7b-9e1f-5a6b7c8d9e0f';
const refundOperationId = '6c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f';
const cancelOperationId = '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b';
const { orderReference } = deriveProviderCorrelation(collectOperationId);
const czk = (amountMinor: number) => ({ amountMinor, currency: 'CZK' as const });
const paymentRef = Option.getOrThrow(parseGopayId(GOPAY_FIXTURE_PAYMENT_ID));
const refundId = Option.getOrThrow(parseGopayId(GOPAY_FIXTURE_REFUND_ID));
const observedAt = DateTime.makeUnsafe('2026-11-12T10:05:00.000Z');
const dispatchedAt = DateTime.makeUnsafe('2026-11-12T10:00:00.000Z');

const decodePayment = Schema.decodeUnknownSync(GopayPaymentFromJsonSchema);
const decodeRefund = Schema.decodeUnknownSync(GopayRefundFromJsonSchema);
const decodeRefundList = Schema.decodeUnknownSync(GopayRefundListFromJsonSchema);

const payment = (state: string, overrides: { amount?: number; currency?: string; orderNumber?: string } = {}) =>
  decodePayment(gopayPaymentBody({ ...overrides, orderNumber: overrides.orderNumber ?? orderReference, state }));

const collectExpected: GatewayExpectedEffect = {
  _tag: 'COLLECT',
  amount: czk(10_000),
  operationId: collectOperationId,
};
const refundExpected: GatewayExpectedEffect = { _tag: 'REFUND', amount: czk(4000), operationId: refundOperationId };
const cancelExpected: GatewayExpectedEffect = {
  _tag: 'CANCEL_OR_VOID',
  operationId: cancelOperationId,
  target: { amount: czk(10_000), operationId: collectOperationId },
};

const lookup = (expected: GatewayExpectedEffect, result: GopayLookupResult) =>
  mapGopayLookup({
    dispatchedAt: Option.some(dispatchedAt),
    expected,
    observedAt,
    origin: 'RECOVERY_LOOKUP',
    paymentRef,
    result,
  });

const paymentResult = (state: string, overrides: Parameters<typeof payment>[1] = {}): GopayLookupResult => ({
  _tag: 'PAYMENT',
  payment: payment(state, overrides),
});

const onlyFinding = (findings: readonly ProviderFindingResult[]): ProviderFindingResult => {
  expect(findings).toHaveLength(1);
  return Option.getOrThrow(Option.fromUndefinedOr(findings[0]));
};

const factKindOf = (finding: ProviderFindingResult | undefined) =>
  Option.fromUndefinedOr(finding).pipe(
    Option.flatMap(({ evidence }) => evidence),
    Option.map(({ factKind }) => factKind),
    Option.getOrElse(() => 'none'),
  );

const dispatchOutcome = (response: ProviderDispatchResponse) =>
  Match.value(response).pipe(
    Match.tag('ACKNOWLEDGED', () => 'ACKNOWLEDGED'),
    Match.tag('REJECTED_BEFORE_EFFECT', () => 'REJECTED_BEFORE_EFFECT'),
    Match.exhaustive,
  );

const refundList = (refunds: readonly GopayRefundFixture[]) => decodeRefundList(gopayRefundListBody(refunds));

/** The id of the refund `matchGopayRefundList` binds to a 40 CZK refund dispatched at `at`. */
const matchedRefundId = (
  refunds: readonly GopayRefundFixture[],
  at: Option.Option<DateTime.Utc> = Option.some(dispatchedAt),
) =>
  matchGopayRefundList({ dispatchedAt: at, expectedAmount: czk(4000), refunds: refundList(refunds) }).pipe(
    Option.map(({ id }) => id),
  );

/** The dispatch response of a 201 `Refund-Details` in `state` for a 40 CZK refund. */
const refundResponse = (state: string, amount = 4000) =>
  mapGopayRefundResponse({
    expected: { amount: czk(4000), operationId: refundOperationId },
    observedAt,
    paymentRef,
    refund: decodeRefund(gopayRefundBody({ amount, state })),
  });

describe('#1156 GoPay v4 evidence mapping', () => {
  it('#1156 REFUNDED is collection proven, never canceled; refund completion comes from the refund resource', () => {
    for (const state of ['REFUNDED', 'PARTIALLY_REFUNDED']) {
      const collection = onlyFinding(lookup(collectExpected, paymentResult(state)));
      expect(collection.finding).toBe('EFFECT_CONFIRMED');
      expect(factKindOf(collection)).toBe('COLLECTION_CONFIRMED');
      expect(collection.orderReference).toEqual(Option.some(orderReference));
      expect(collection.target).toEqual({ operationId: collectOperationId, operationKind: 'COLLECT' });
    }
    // A payment state alone never proves a refund.
    expect(onlyFinding(lookup(refundExpected, paymentResult('REFUNDED'))).finding).toBe('INDETERMINATE');

    const refund = onlyFinding(
      lookup(refundExpected, {
        _tag: 'REFUND',
        refund: decodeRefund(gopayRefundBody({ amount: 4000, state: 'SUCCESS', updated: '2026-11-12T10:00:30Z' })),
        refundRef: refundId,
      }),
    );
    expect(refund.finding).toBe('EFFECT_CONFIRMED');
    expect(refund.target).toEqual({ operationId: refundOperationId, operationKind: 'REFUND' });
    const evidence = Option.getOrThrow(refund.evidence);
    expect(evidence).toMatchObject({
      economicEffectKey: Option.some(`gopay-refund:${paymentRef}:${refundOperationId}`),
      factFamily: 'REFUND_EXECUTION',
      factKind: 'REFUND_CONFIRMED',
      observedAmount: Option.some(czk(4000)),
      observedAt,
      providerOccurredAt: Option.some(DateTime.makeUnsafe('2026-11-12T10:00:30.000Z')),
      providerRefs: [
        { _tag: 'GOPAY_PAYMENT', id: paymentRef },
        { _tag: 'GOPAY_REFUND', id: refundId, paymentId: paymentRef },
      ],
      sourceOccurrenceId: `gopay:recovery_lookup:${refundId}:${refundOperationId}:REFUND_CONFIRMED:4000`,
    });
  });

  it('#1156 PAID with a different amount or currency is a discrepancy', () => {
    const finding = onlyFinding(lookup(collectExpected, paymentResult('PAID', { amount: 9900 })));
    expect(finding.finding).toBe('VERIFICATION_CONFLICT');
    const evidence = Option.getOrThrow(finding.evidence);
    expect(evidence.factKind).toBe('COLLECTION_CONFIRMED');
    expect(evidence.observedAmount).toEqual(Option.some(czk(9900)));
    expect(evidence.discrepancy).toEqual(Option.some({ expected: czk(10_000), observed: czk(9900) }));

    const matching = onlyFinding(lookup(collectExpected, paymentResult('PAID')));
    expect(matching.finding).toBe('EFFECT_CONFIRMED');
    expect(Option.getOrThrow(matching.evidence).discrepancy).toEqual(Option.none());
    expect(Option.getOrThrow(matching.evidence).economicEffectKey).toEqual(Option.some(paymentRef));

    const euro = onlyFinding(lookup(collectExpected, paymentResult('PAID', { currency: 'EUR' })));
    expect(euro.finding).toBe('VERIFICATION_CONFLICT');
    expect(Option.getOrThrow(euro.evidence).observedAmount).toEqual(
      Option.some({ amountMinor: 10_000, currency: 'EUR' }),
    );
    // Pending or ended states of another amount never state evidence.
    const pendingMismatch = onlyFinding(lookup(collectExpected, paymentResult('CANCELED', { amount: 9900 })));
    expect([pendingMismatch.finding, pendingMismatch.evidence]).toEqual(['VERIFICATION_CONFLICT', Option.none()]);
  });

  it('#1154 AUTHORIZED is a verification conflict', () => {
    const finding = onlyFinding(lookup(collectExpected, paymentResult('AUTHORIZED')));
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
      const result = onlyFinding(lookup(collectExpected, paymentResult(state)));
      expect([state, result.finding, factKindOf(result)]).toEqual([state, finding, factKind]);
    }
  });

  it('#1158 Lookup miss is never NOT_EFFECTED', () => {
    for (const expected of [collectExpected, refundExpected, cancelExpected]) {
      const finding = onlyFinding(lookup(expected, { _tag: 'NOT_FOUND' }));
      expect(finding.finding).toBe('INDETERMINATE');
      expect(finding.evidence).toEqual(Option.none());
      expect(finding.target.operationId).toBe(expected.operationId);
    }
    const emptyList = onlyFinding(
      lookup(refundExpected, { _tag: 'REFUND_LIST', payment: payment('PAID'), refunds: refundList([]) }),
    );
    expect([emptyList.finding, emptyList.evidence]).toEqual(['INDETERMINATE', Option.none()]);
  });

  it('#1156 A payment of another id or order is a verification conflict for every named operation', () => {
    const otherId: GopayLookupResult = {
      _tag: 'PAYMENT',
      payment: decodePayment(gopayPaymentBody({ id: '300000002', orderNumber: orderReference, state: 'PAID' })),
    };
    expect(lookup(collectExpected, otherId).map(({ finding }) => finding)).toEqual(['VERIFICATION_CONFLICT']);
    expect(lookup(cancelExpected, otherId).map(({ finding, target }) => [finding, target.operationKind])).toEqual([
      ['VERIFICATION_CONFLICT', 'CANCEL_OR_VOID'],
      ['VERIFICATION_CONFLICT', 'COLLECT'],
    ]);
    const otherOrder = paymentResult('PAID', { orderNumber: '2025010199' });
    expect(lookup(cancelExpected, otherOrder).every(({ evidence }) => Option.isNone(evidence))).toBe(true);
    expect(gopayOrderReferenceOf(payment('PAID'))).toEqual(Option.some(orderReference));
    expect(gopayOrderReferenceOf(payment('PAID', { orderNumber: '2025010199' }))).toEqual(Option.none());
  });

  it('#1159 A cancel lookup reports the cancel and its collection target', () => {
    const cases = [
      ['CANCELED', 'EFFECT_CONFIRMED', 'CANCEL_CONFIRMED', 'COLLECTION_NOT_EFFECTED'],
      ['TIMEOUTED', 'EFFECT_CONFIRMED', 'CANCEL_CONFIRMED', 'COLLECTION_NOT_EFFECTED'],
      ['PAYMENT_METHOD_CHOSEN', 'NOT_EFFECTED', 'CANCEL_NOT_EFFECTED', 'COLLECTION_PENDING'],
      ['PAID', 'NOT_EFFECTED', 'CANCEL_NOT_EFFECTED', 'COLLECTION_CONFIRMED'],
      ['PARTIALLY_REFUNDED', 'NOT_EFFECTED', 'CANCEL_NOT_EFFECTED', 'COLLECTION_CONFIRMED'],
      ['CREATED', 'INDETERMINATE', 'none', 'COLLECTION_PENDING'],
      ['AUTHORIZED', 'VERIFICATION_CONFLICT', 'none', 'none'],
    ] as const;
    for (const [state, cancelFinding, cancelFact, targetFact] of cases) {
      const [cancel, collection] = lookup(cancelExpected, paymentResult(state));
      expect([state, cancel?.target.operationKind, cancel?.finding, factKindOf(cancel)]).toEqual([
        state,
        'CANCEL_OR_VOID',
        cancelFinding,
        cancelFact,
      ]);
      expect([state, collection?.target.operationKind, factKindOf(collection)]).toEqual([state, 'COLLECT', targetFact]);
    }
    const [rejected] = lookup(cancelExpected, paymentResult('PAID'));
    expect(Option.getOrThrow(rejected?.evidence ?? Option.none())).toMatchObject({
      economicEffectKey: Option.none(),
      factFamily: 'GATEWAY_OUTCOME',
      reason: Option.some('provider_cancel_rejected_state'),
      sourceOccurrenceId: `gopay:recovery_lookup:${paymentRef}:${cancelOperationId}:CANCEL_NOT_EFFECTED:10000`,
    });
    // The collection target's amount is checked by the cancel as well.
    const [mismatched] = lookup(cancelExpected, paymentResult('CANCELED', { amount: 9900 }));
    expect([mismatched?.finding, mismatched?.evidence]).toEqual(['VERIFICATION_CONFLICT', Option.none()]);
  });

  it('#1156 Cancel after confirmed collection does not erase the effect', () => {
    const answer = (cancelAnswer: GopayCancelAnswer, state: string) => {
      const result = paymentResult(state);
      return mapGopayCancelAnswer({
        answer: cancelAnswer,
        expected: cancelExpected,
        findings: lookup(cancelExpected, result),
        paymentRef,
        state: Option.some(payment(state).state),
      });
    };
    const refusedPaid = answer('CANCEL_REFUSED', 'PAID');
    expect(dispatchOutcome(refusedPaid)).toBe('REJECTED_BEFORE_EFFECT');
    expect(factKindOf(refusedPaid.finding)).toBe('CANCEL_NOT_EFFECTED');
    const target = Option.getOrUndefined(refusedPaid.targetFinding);
    expect([target?.finding, factKindOf(target)]).toEqual(['EFFECT_CONFIRMED', 'COLLECTION_CONFIRMED']);

    // A 204 contradicted by the lookup never confirms the cancel, and still keeps the collection proof.
    const acceptedPaid = answer('CANCEL_ACCEPTED', 'PAID');
    expect([dispatchOutcome(acceptedPaid), acceptedPaid.finding.finding]).toEqual(['ACKNOWLEDGED', 'INDETERMINATE']);
    expect(factKindOf(Option.getOrUndefined(acceptedPaid.targetFinding))).toBe('COLLECTION_CONFIRMED');
    const acceptedTimedOut = answer('CANCEL_ACCEPTED', 'TIMEOUTED');
    expect(acceptedTimedOut.finding.finding).toBe('INDETERMINATE');

    // A pending target is not kept: it proves nothing the collection's own record lacks.
    expect(answer('CANCEL_REFUSED', 'PAYMENT_METHOD_CHOSEN').targetFinding).toEqual(Option.none());
    const missed = mapGopayCancelAnswer({
      answer: 'CANCEL_REFUSED',
      expected: cancelExpected,
      findings: lookup(cancelExpected, { _tag: 'NOT_FOUND' }),
      paymentRef,
      state: Option.none(),
    });
    expect([dispatchOutcome(missed), missed.finding.finding, missed.targetFinding]).toEqual([
      'ACKNOWLEDGED',
      'INDETERMINATE',
      Option.none(),
    ]);
  });

  it('#1158 A lost GoPay refund is matched in the refund list only by one dated refund after the dispatch', () => {
    const prior = { amount: 4000, created: '2026-11-10T09:00:00Z', id: '3050000001', state: 'SUCCESS' };
    const ours = { amount: 4000, created: '2026-11-12T10:00:00Z', state: 'REQUESTED' };
    expect(
      matchedRefundId([
        prior,
        { amount: 2500, created: '2026-11-12T10:01:00Z', id: '3050000003', state: 'SUCCESS' },
        ours,
      ]),
    ).toEqual(Option.some(GOPAY_FIXTURE_REFUND_ID));
    expect(matchedRefundId([prior, ours], Option.none())).toEqual(Option.none());
    expect(matchedRefundId([ours, { ...ours, id: '3050000002' }])).toEqual(Option.none());
    expect(matchedRefundId([prior])).toEqual(Option.none());
    // An instant without a zone cannot be placed relative to the dispatch: nothing is matched.
    expect(matchedRefundId([{ ...ours, created: '2026-11-12' }])).toEqual(Option.none());
    expect(matchedRefundId([{ ...ours, created: '2026-11-12T10:00:00+01:00' }])).toEqual(Option.none());
  });

  it('#1156 Create response is verified against the dispatch and never keeps the payment secret', () => {
    const expected = { amount: czk(10_000), operationId: collectOperationId };
    const created = decodePayment(gopayCreateResponseBody(orderReference));
    expect(Object.keys(created)).not.toContain('payment_secret');
    expect(Object.values(created)).not.toContain(GOPAY_FIXTURE_PAYMENT_SECRET);
    const response = mapGopayCreateResponse({ expected, observedAt, payment: created });
    expect(dispatchOutcome(response)).toBe('ACKNOWLEDGED');
    expect(response.finding.finding).toBe('CUSTOMER_ACTION_REQUIRED');
    expect(Option.getOrThrow(response.finding.evidence).sourceOccurrenceId).toBe(
      `gopay:dispatch_response:${paymentRef}:${collectOperationId}:COLLECTION_PENDING:10000`,
    );

    const otherOrder = mapGopayCreateResponse({
      expected,
      observedAt,
      payment: decodePayment(gopayCreateResponseBody('2025010199')),
    });
    expect([otherOrder.finding.finding, otherOrder.finding.evidence, otherOrder.finding.providerRefs]).toEqual([
      'VERIFICATION_CONFLICT',
      Option.none(),
      [],
    ]);
    const paidOnCreate = mapGopayCreateResponse({ expected, observedAt, payment: payment('PAID') });
    expect(paidOnCreate.finding.finding).toBe('EFFECT_CONFIRMED');
    const noGatewayUrl = decodePayment(gopayCreateResponseBody(orderReference).replace(/"gw_url": "[^"]*",/u, ''));
    expect(mapGopayCreateResponse({ expected, observedAt, payment: noGatewayUrl }).finding.finding).toBe(
      'VERIFICATION_CONFLICT',
    );
  });

  it('#1156 Refund response REQUESTED is pending, SUCCESS confirmed and FAILED not effected', () => {
    expect([
      dispatchOutcome(refundResponse('REQUESTED')),
      refundResponse('REQUESTED').finding.finding,
      factKindOf(refundResponse('REQUESTED').finding),
    ]).toEqual(['ACKNOWLEDGED', 'ACCEPTED_PENDING', 'REFUND_PENDING']);
    expect([dispatchOutcome(refundResponse('SUCCESS')), factKindOf(refundResponse('SUCCESS').finding)]).toEqual([
      'ACKNOWLEDGED',
      'REFUND_CONFIRMED',
    ]);
    expect([dispatchOutcome(refundResponse('FAILED')), factKindOf(refundResponse('FAILED').finding)]).toEqual([
      'REJECTED_BEFORE_EFFECT',
      'REFUND_NOT_EFFECTED',
    ]);
    expect(refundResponse('REQUESTED', 3999).finding).toMatchObject({
      evidence: Option.none(),
      finding: 'VERIFICATION_CONFLICT',
    });
    expect(() => decodeRefund(gopayRefundBody({ amount: 4000, state: 'ACCEPTED' }))).toThrow();
  });

  it('#1159 GoPay cancel is a supported capability; a collect without a payer email is typed UNAVAILABLE', () => {
    expect(GOPAY_CAPABILITIES).toEqual({
      CANCEL_OR_VOID: 'SUPPORTED',
      COLLECT: 'SUPPORTED',
      NOTIFICATION: 'SUPPORTED',
      REFUND: 'SUPPORTED',
      RETRIEVE: 'SUPPORTED',
    });
    const failure = gopayPayerContactUnavailable();
    expect(Schema.is(GatewayProviderUnavailable)(failure)).toBe(true);
    expect([failure.family, failure.reason]).toEqual(['GOPAY', 'payer_contact_unavailable']);
  });

  it('#1156 GoPay money is exact minor units and the create body has no preauthorization', () => {
    expect(toGopayAmount(czk(159_950))).toEqual({ amount: 159_950, currency: 'CZK' });
    expect(fromGopayAmount({ amount: 159_950, currency: 'EUR' })).toEqual({ amountMinor: 159_950, currency: 'EUR' });
    expect(() => decodePayment(gopayCreateResponseBody(orderReference).replace('10000', '100.5'))).toThrow();
    // A numeric or path-like id is never accepted as a GoPay id.
    expect(() => decodePayment(gopayCreateResponseBody(orderReference).replace('"300000001"', '300000001'))).toThrow();
    expect(parseGopayId('300000001/refunds')).toEqual(Option.none());
    expect(parseGopayId('0300000001')).toEqual(Option.none());

    const body = Schema.encodeSync(GopayCreatePaymentRequestJsonSchema)({
      amount: 159_950,
      callback: {
        notification_url: 'https://payments.example.test/gopay/notify',
        return_url: 'https://shop.example.test/return?r=AAAAAAAAAAAAAAAAAAAAAA',
      },
      currency: 'CZK',
      customer: { email: 'payer@example.test' },
      order_number: orderReference,
    });
    for (const fragment of ['preauthorization', 'recurrence', 'order_description', 'first_name', 'phone_number']) {
      expect(body).not.toContain(fragment);
    }
    expect(body).toContain(`"order_number":"${orderReference}"`);
    expect(body).toContain('"amount":159950');
  });
});
