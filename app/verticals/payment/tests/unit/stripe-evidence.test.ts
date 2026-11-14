import { describe, expect, it } from 'effect-rstest';
import { Array as Arr, DateTime, Effect, Option, Result, Schema } from 'effect';

import { PaymentOperationIdSchema } from '../../shared/domain/payment-identifiers.ts';
import type { GatewayEnvironment } from '../../shared/domain/psp-vocabulary.ts';
import { deriveProviderCorrelation } from '../../src/integrations/psp/psp-correlation.ts';
import { GatewayExpectedEffectSchema } from '../../src/integrations/psp/psp-request.ts';
import type { GatewayExpectedEffect } from '../../src/integrations/psp/psp-request.ts';
import type { ProviderFindingResult } from '../../src/integrations/psp/psp-result.ts';
import { STRIPE_CAPABILITIES } from '../../src/integrations/stripe/stripe-capabilities.ts';
import {
  mapStripeCheckoutSession,
  mapStripeExpireResponse,
  mapStripeLookupMiss,
  mapStripePaymentIntent,
  mapStripePaymentIntentSearch,
  mapStripeRefund,
} from '../../src/integrations/stripe/stripe-evidence.ts';
import { fromStripeAmount, toStripeFormAmount } from '../../src/integrations/stripe/stripe-money.ts';
import {
  decodeStripeCheckoutSession,
  decodeStripeError,
  decodeStripePaymentIntent,
  decodeStripePaymentIntentSearch,
  decodeStripeRefund,
} from '../../src/integrations/stripe/stripe-wire.ts';
import {
  STRIPE_FIXTURE_PAYMENT_INTENT_ID,
  STRIPE_FIXTURE_REFUND_ID,
  STRIPE_FIXTURE_SESSION_ID,
  stripeCheckoutSessionObject,
  stripePaymentIntentObject,
  stripePaymentIntentSearchResult,
  stripeRefundObject,
  stripeResourceMissingError,
} from '../fixtures/stripe/stripe-objects.ts';

const COLLECT_OPERATION_ID = '3f1c2b7e-8a9d-4e6f-9b1a-2c3d4e5f6a7b';
const REFUND_OPERATION_ID = '6a0b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d';
const CANCEL_OPERATION_ID = '9c8b7a6d-5e4f-4321-8abc-def012345678';
const OTHER_OPERATION_ID = '11111111-2222-4333-8444-555555555555';

const orderReferenceOf = (operationId: string) =>
  deriveProviderCorrelation(Schema.decodeUnknownSync(PaymentOperationIdSchema)(operationId)).orderReference;

const COLLECT_REFERENCE = orderReferenceOf(COLLECT_OPERATION_ID);
const REFUND_REFERENCE = orderReferenceOf(REFUND_OPERATION_ID);

const [CollectExpectedSchema, RefundExpectedSchema, CancelExpectedSchema] = GatewayExpectedEffectSchema.members;

const collectExpected = Schema.decodeUnknownSync(CollectExpectedSchema)({
  _tag: 'COLLECT',
  amount: { amountMinor: 159_950, currency: 'CZK' },
  operationId: COLLECT_OPERATION_ID,
});
const cancelExpected = Schema.decodeUnknownSync(CancelExpectedSchema)({
  _tag: 'CANCEL_OR_VOID',
  operationId: CANCEL_OPERATION_ID,
  target: { amount: { amountMinor: 159_950, currency: 'CZK' }, operationId: COLLECT_OPERATION_ID },
});
const refundExpected = Schema.decodeUnknownSync(RefundExpectedSchema)({
  _tag: 'REFUND',
  amount: { amountMinor: 50_000, currency: 'CZK' },
  operationId: REFUND_OPERATION_ID,
});

const observedAt = DateTime.makeUnsafe('2026-11-12T10:00:00.000Z');

const contextOf = <Expected extends GatewayExpectedEffect>(
  expected: Expected,
  environment: GatewayEnvironment = 'SANDBOX',
) => ({ environment, expected, observedAt, origin: 'RECOVERY_LOOKUP' as const });

const jsonText = <A>(value: A): string => Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(value);

const firstOf = (findings: readonly ProviderFindingResult[]): ProviderFindingResult =>
  Option.getOrThrow(Arr.head(findings));

const summary = (finding: ProviderFindingResult) => ({
  factKind: finding.evidence.pipe(Option.map((evidence) => evidence.factKind)),
  finding: finding.finding,
  operationId: finding.target.operationId,
});

describe('#1156 Stripe evidence mapping', () => {
  it('#1156 Stripe money is lower-case czk integer minor units and keeps any reported currency', () => {
    expect(toStripeFormAmount({ amountMinor: 159_950, currency: 'CZK' })).toEqual({
      currency: 'czk',
      minorUnits: '159950',
    });
    expect(fromStripeAmount(159_950, 'czk')).toEqual(Option.some({ amountMinor: 159_950, currency: 'CZK' }));
    expect(fromStripeAmount(159_950, 'eur')).toEqual(Option.some({ amountMinor: 159_950, currency: 'EUR' }));
    expect(Option.isNone(fromStripeAmount(1599.5, 'czk'))).toBe(true);
    expect(STRIPE_CAPABILITIES.CANCEL_OR_VOID).toBe('SUPPORTED');
  });

  it.effect('#1156 Succeeded PaymentIntent with the exact amount is COLLECTION_CONFIRMED', () =>
    Effect.gen(function* succeededPaymentIntent() {
      const session = yield* decodeStripeCheckoutSession(
        jsonText(
          stripeCheckoutSessionObject({
            orderReference: COLLECT_REFERENCE,
            paymentIntent: stripePaymentIntentObject({ orderReference: COLLECT_REFERENCE, status: 'succeeded' }),
            paymentStatus: 'paid',
            status: 'complete',
          }),
        ),
      );
      const finding = firstOf(yield* mapStripeCheckoutSession(session, contextOf(collectExpected)));
      expect(finding.finding).toBe('EFFECT_CONFIRMED');
      expect(finding.orderReference).toEqual(Option.some(COLLECT_REFERENCE));
      const evidence = Option.getOrThrow(finding.evidence);
      expect(evidence.factKind).toBe('COLLECTION_CONFIRMED');
      expect(evidence.factFamily).toBe('GATEWAY_OUTCOME');
      expect(evidence.observedAmount).toEqual(Option.some({ amountMinor: 159_950, currency: 'CZK' }));
      expect(evidence.observedAt).toEqual(observedAt);
      expect(evidence.economicEffectKey).toEqual(Option.some(STRIPE_FIXTURE_PAYMENT_INTENT_ID));
      expect(evidence.sourceOccurrenceId).toBe(
        `stripe:RECOVERY_LOOKUP:${STRIPE_FIXTURE_PAYMENT_INTENT_ID}:${COLLECT_OPERATION_ID}:COLLECTION_CONFIRMED:159950`,
      );
      expect(finding.providerRefs).toEqual([
        { _tag: 'STRIPE_CHECKOUT_SESSION', id: STRIPE_FIXTURE_SESSION_ID },
        { _tag: 'STRIPE_PAYMENT_INTENT', id: STRIPE_FIXTURE_PAYMENT_INTENT_ID },
      ]);
    }),
  );

  it.effect('#1156 A different amount or currency is a discrepancy, never a confirmation', () =>
    Effect.gen(function* amountMismatch() {
      for (const variant of [
        { amountReceived: 159_900, currency: 'czk' },
        { amountReceived: 159_950, currency: 'eur' },
      ]) {
        const paymentIntent = yield* decodeStripePaymentIntent(
          jsonText(stripePaymentIntentObject({ ...variant, orderReference: COLLECT_REFERENCE, status: 'succeeded' })),
        );
        const finding = firstOf(yield* mapStripePaymentIntent(paymentIntent, contextOf(collectExpected)));
        expect(finding.finding).toBe('VERIFICATION_CONFLICT');
        const evidence = Option.getOrThrow(finding.evidence);
        expect(evidence.discrepancy).toEqual(
          Option.some({
            expected: { amountMinor: 159_950, currency: 'CZK' },
            observed: { amountMinor: variant.amountReceived, currency: variant.currency.toUpperCase() },
          }),
        );
      }
    }),
  );

  it.effect('#1156 requires_capture is a verification conflict', () =>
    Effect.gen(function* requiresCapture() {
      const paymentIntent = yield* decodeStripePaymentIntent(
        jsonText(stripePaymentIntentObject({ orderReference: COLLECT_REFERENCE, status: 'requires_capture' })),
      );
      const findings = yield* mapStripePaymentIntent(paymentIntent, contextOf(collectExpected));
      expect(findings.map(summary)).toEqual([
        { factKind: Option.none(), finding: 'VERIFICATION_CONFLICT', operationId: COLLECT_OPERATION_ID },
      ]);
    }),
  );

  it.effect('#1156 Canceled PaymentIntent and an expired session without a paid PaymentIntent are not effected', () =>
    Effect.gen(function* notEffected() {
      const canceled = yield* decodeStripePaymentIntent(
        jsonText(stripePaymentIntentObject({ orderReference: COLLECT_REFERENCE, status: 'canceled' })),
      );
      const expiredWithout = yield* decodeStripeCheckoutSession(
        jsonText(
          stripeCheckoutSessionObject({
            orderReference: COLLECT_REFERENCE,
            paymentIntent: null,
            paymentStatus: 'unpaid',
            status: 'expired',
          }),
        ),
      );
      const expiredUnpaid = yield* decodeStripeCheckoutSession(
        jsonText(
          stripeCheckoutSessionObject({
            orderReference: COLLECT_REFERENCE,
            paymentIntent: stripePaymentIntentObject({
              orderReference: COLLECT_REFERENCE,
              status: 'requires_payment_method',
            }),
            paymentStatus: 'unpaid',
            status: 'expired',
          }),
        ),
      );
      for (const findings of [
        yield* mapStripePaymentIntent(canceled, contextOf(collectExpected)),
        yield* mapStripeCheckoutSession(expiredWithout, contextOf(collectExpected)),
        yield* mapStripeCheckoutSession(expiredUnpaid, contextOf(collectExpected)),
      ]) {
        expect(findings.map(summary)).toEqual([
          {
            factKind: Option.some('COLLECTION_NOT_EFFECTED'),
            finding: 'NOT_EFFECTED',
            operationId: COLLECT_OPERATION_ID,
          },
        ]);
      }
    }),
  );

  it.effect('#1158 An expired session whose PaymentIntent was not expanded proves nothing', () =>
    Effect.gen(function* expiredUnexpanded() {
      const session = yield* decodeStripeCheckoutSession(
        jsonText(
          stripeCheckoutSessionObject({
            orderReference: COLLECT_REFERENCE,
            paymentIntent: STRIPE_FIXTURE_PAYMENT_INTENT_ID,
            paymentStatus: 'unpaid',
            status: 'expired',
          }),
        ),
      );
      const findings = yield* mapStripeCheckoutSession(session, contextOf(collectExpected));
      expect(findings.map(summary)).toEqual([
        { factKind: Option.none(), finding: 'INDETERMINATE', operationId: COLLECT_OPERATION_ID },
      ]);
    }),
  );

  it.effect('#1154 An open session is customer action with its hosted url', () =>
    Effect.gen(function* openSession() {
      const session = yield* decodeStripeCheckoutSession(
        jsonText(
          stripeCheckoutSessionObject({
            orderReference: COLLECT_REFERENCE,
            paymentIntent: null,
            paymentStatus: 'unpaid',
            status: 'open',
          }),
        ),
      );
      const finding = firstOf(yield* mapStripeCheckoutSession(session, contextOf(collectExpected)));
      expect(finding.finding).toBe('CUSTOMER_ACTION_REQUIRED');
      expect(Option.isSome(finding.customerAction)).toBe(true);
      expect(Option.isNone(finding.evidence)).toBe(true);
    }),
  );

  it.effect('#1156 A session of another operation or without the order reference is never confirmed', () =>
    Effect.gen(function* foreignSession() {
      for (const orderReference of [orderReferenceOf(OTHER_OPERATION_ID), undefined]) {
        const session = yield* decodeStripeCheckoutSession(
          jsonText(
            stripeCheckoutSessionObject({
              orderReference,
              paymentIntent: stripePaymentIntentObject({ status: 'succeeded' }),
              paymentStatus: 'paid',
              status: 'complete',
            }),
          ),
        );
        const findings = yield* mapStripeCheckoutSession(session, contextOf(collectExpected));
        expect(findings.map(summary)).toEqual([
          { factKind: Option.none(), finding: 'VERIFICATION_CONFLICT', operationId: COLLECT_OPERATION_ID },
        ]);
        expect(firstOf(findings).orderReference).toEqual(Option.none());
      }
    }),
  );

  it.effect('#1157 livemode mismatch is rejected for lookups', () =>
    Effect.gen(function* livemodeMismatch() {
      const paymentIntent = yield* decodeStripePaymentIntent(
        jsonText(stripePaymentIntentObject({ livemode: true, orderReference: COLLECT_REFERENCE, status: 'succeeded' })),
      );
      const result = yield* Effect.result(mapStripePaymentIntent(paymentIntent, contextOf(collectExpected)));
      expect(Result.isFailure(result)).toBe(true);
      expect(Result.getFailure(result).pipe(Option.map((error) => error.reason))).toEqual(
        Option.some('stripe_livemode_mismatch'),
      );
      const live = yield* mapStripePaymentIntent(paymentIntent, contextOf(collectExpected, 'LIVE'));
      expect(firstOf(live).finding).toBe('EFFECT_CONFIRMED');
    }),
  );

  it.effect('#1158 PaymentIntent search miss is INDETERMINATE', () =>
    Effect.gen(function* searchMiss() {
      const empty = yield* decodeStripePaymentIntentSearch(jsonText(stripePaymentIntentSearchResult([])));
      const foreignOnly = yield* decodeStripePaymentIntentSearch(
        jsonText(
          stripePaymentIntentSearchResult([
            stripePaymentIntentObject({ orderReference: orderReferenceOf(OTHER_OPERATION_ID), status: 'canceled' }),
          ]),
        ),
      );
      for (const result of [empty, foreignOnly]) {
        const findings = yield* mapStripePaymentIntentSearch(result, contextOf(collectExpected));
        expect(findings.map(summary)).toEqual([
          { factKind: Option.none(), finding: 'INDETERMINATE', operationId: COLLECT_OPERATION_ID },
        ]);
      }
      const hit = yield* decodeStripePaymentIntentSearch(
        jsonText(
          stripePaymentIntentSearchResult([
            stripePaymentIntentObject({ orderReference: COLLECT_REFERENCE, status: 'succeeded' }),
          ]),
        ),
      );
      const found = firstOf(yield* mapStripePaymentIntentSearch(hit, contextOf(collectExpected)));
      expect(found.finding).toBe('EFFECT_CONFIRMED');
      expect(found.orderReference).toEqual(Option.some(COLLECT_REFERENCE));
    }),
  );

  it('#1158 A 404 is INDETERMINATE and the error body is decoded without its message', () => {
    expect(mapStripeLookupMiss(refundExpected).map(summary)).toEqual([
      { factKind: Option.none(), finding: 'INDETERMINATE', operationId: REFUND_OPERATION_ID },
    ]);
    expect(decodeStripeError(jsonText(stripeResourceMissingError))).toEqual(
      Option.some({ error: { code: Option.some('resource_missing'), type: 'invalid_request_error' } }),
    );
    expect(Option.isNone(decodeStripeError('<html>Bad gateway</html>'))).toBe(true);
  });

  it.effect('#1156 An unknown provider status fails decoding instead of mapping', () =>
    Effect.gen(function* unknownStatus() {
      const result = yield* Effect.result(
        decodeStripePaymentIntent(jsonText(stripePaymentIntentObject({ status: 'requires_unknown' }))),
      );
      expect(Result.isFailure(result)).toBe(true);
    }),
  );

  it.effect('#1156 Cancel of an already paid session is CANCEL_NOT_EFFECTED plus COLLECTION_CONFIRMED', () =>
    Effect.gen(function* cancelAlreadyPaid() {
      const session = yield* decodeStripeCheckoutSession(
        jsonText(
          stripeCheckoutSessionObject({
            orderReference: COLLECT_REFERENCE,
            paymentIntent: stripePaymentIntentObject({ orderReference: COLLECT_REFERENCE, status: 'succeeded' }),
            paymentStatus: 'paid',
            status: 'complete',
          }),
        ),
      );
      const findings = yield* mapStripeCheckoutSession(session, contextOf(cancelExpected));
      expect(findings.map(summary)).toEqual([
        { factKind: Option.some('CANCEL_NOT_EFFECTED'), finding: 'NOT_EFFECTED', operationId: CANCEL_OPERATION_ID },
        {
          factKind: Option.some('COLLECTION_CONFIRMED'),
          finding: 'EFFECT_CONFIRMED',
          operationId: COLLECT_OPERATION_ID,
        },
      ]);
    }),
  );

  it.effect(
    '#1156 Expire response confirms the cancel and, without a PaymentIntent, the collection is not effected',
    () =>
      Effect.gen(function* expireResponse() {
        const session = yield* decodeStripeCheckoutSession(
          jsonText(
            stripeCheckoutSessionObject({
              orderReference: COLLECT_REFERENCE,
              paymentIntent: null,
              paymentStatus: 'unpaid',
              status: 'expired',
            }),
          ),
        );
        const findings = yield* mapStripeExpireResponse(session, {
          ...contextOf(cancelExpected),
          origin: 'DISPATCH_RESPONSE',
        });
        expect(findings.map(summary)).toEqual([
          { factKind: Option.some('CANCEL_CONFIRMED'), finding: 'EFFECT_CONFIRMED', operationId: CANCEL_OPERATION_ID },
          {
            factKind: Option.some('COLLECTION_NOT_EFFECTED'),
            finding: 'NOT_EFFECTED',
            operationId: COLLECT_OPERATION_ID,
          },
        ]);
      }),
  );
});

const refundFinding = (status: string, extra: { readonly amount?: number } = {}) =>
  Effect.gen(function* mapRefundFixture() {
    const refund = yield* decodeStripeRefund(
      jsonText(stripeRefundObject({ ...extra, orderReference: REFUND_REFERENCE, status })),
    );
    const finding = firstOf(yield* mapStripeRefund(refund, contextOf(refundExpected)));
    return finding;
  });

describe('#1156 Stripe refund mapping', () => {
  it.effect('#1156 Refund statuses map to pending, confirmed and not effected', () =>
    Effect.gen(function* refundStatuses() {
      const cases = [
        ['pending', 'ACCEPTED_PENDING', 'REFUND_PENDING'],
        ['requires_action', 'ACCEPTED_PENDING', 'REFUND_PENDING'],
        ['succeeded', 'EFFECT_CONFIRMED', 'REFUND_CONFIRMED'],
        ['failed', 'NOT_EFFECTED', 'REFUND_NOT_EFFECTED'],
        ['canceled', 'NOT_EFFECTED', 'REFUND_NOT_EFFECTED'],
      ] as const;
      for (const [status, finding, factKind] of cases) {
        const result = yield* refundFinding(status);
        expect(summary(result)).toEqual({ factKind: Option.some(factKind), finding, operationId: REFUND_OPERATION_ID });
        const evidence = Option.getOrThrow(result.evidence);
        expect(evidence.factFamily).toBe('REFUND_EXECUTION');
        expect(evidence.economicEffectKey).toEqual(Option.some(STRIPE_FIXTURE_REFUND_ID));
      }
    }),
  );

  it.effect('#1156 Refund succeeded then failed is a new occurrence', () =>
    Effect.gen(function* succeededThenFailed() {
      const succeeded = Option.getOrThrow((yield* refundFinding('succeeded')).evidence);
      const failed = Option.getOrThrow((yield* refundFinding('failed')).evidence);
      expect(succeeded.factKind).toBe('REFUND_CONFIRMED');
      expect(failed.factKind).toBe('REFUND_NOT_EFFECTED');
      expect(failed.sourceOccurrenceId).not.toBe(succeeded.sourceOccurrenceId);
      expect(failed.sourceOccurrenceId).toBe(
        `stripe:RECOVERY_LOOKUP:${STRIPE_FIXTURE_REFUND_ID}:${REFUND_OPERATION_ID}:REFUND_NOT_EFFECTED:50000`,
      );
      expect(failed.economicEffectKey).toEqual(succeeded.economicEffectKey);
      expect(failed.sourceRevision).toBe(0);
    }),
  );

  it.effect('#1156 Refund amount mismatch is a verification conflict', () =>
    Effect.gen(function* refundMismatch() {
      const result = yield* refundFinding('succeeded', { amount: 40_000 });
      expect(result.finding).toBe('VERIFICATION_CONFLICT');
      expect(Option.isSome(Option.getOrThrow(result.evidence).discrepancy)).toBe(true);
    }),
  );

  it.effect('#1156 Refund of another operation is a verification conflict without evidence', () =>
    Effect.gen(function* foreignRefund() {
      const refund = yield* decodeStripeRefund(
        jsonText(stripeRefundObject({ orderReference: orderReferenceOf(OTHER_OPERATION_ID), status: 'succeeded' })),
      );
      const findings = yield* mapStripeRefund(refund, contextOf(refundExpected));
      expect(findings.map(summary)).toEqual([
        { factKind: Option.none(), finding: 'VERIFICATION_CONFLICT', operationId: REFUND_OPERATION_ID },
      ]);
    }),
  );

  it.effect('#1157 Refund livemode mismatch is rejected when Stripe reports it', () =>
    Effect.gen(function* refundLivemode() {
      const refund = yield* decodeStripeRefund(
        jsonText(stripeRefundObject({ livemode: true, orderReference: REFUND_REFERENCE, status: 'succeeded' })),
      );
      const result = yield* Effect.result(mapStripeRefund(refund, contextOf(refundExpected)));
      expect(Result.isFailure(result)).toBe(true);
    }),
  );
});
