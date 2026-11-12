import { describe, expect, it } from 'effect-rstest';
import { DateTime, Effect, Option, Schema } from 'effect';
import { TestClock } from 'effect/testing';

import { mapGopayLookup } from '../../src/integrations/gopay/gopay-evidence.ts';
import { verifyGopayNotification } from '../../src/integrations/gopay/gopay-notification.ts';
import { GopayPaymentFromJsonSchema, parseGopayId } from '../../src/integrations/gopay/gopay-wire.ts';
import type { RawProviderNotification } from '../../src/integrations/psp/notification-envelope.ts';
import { deriveProviderCorrelation } from '../../src/integrations/psp/psp-correlation.ts';
import { GOPAY_FIXTURE_ACCOUNT_REF, gopayExecutionTarget } from '../fixtures/gopay/execution-target.ts';
import { GOPAY_FIXTURE_PAYMENT_ID, gopayPaymentBody } from '../fixtures/gopay/payment-responses.ts';

/**
 * GoPay sends an unsigned HTTP GET with an empty body and `?id=<payment id>` to `notification_url` (Payments API v4,
 * https://api-docs.gopay.com/llms-full.txt "Return URL and notification URL").
 */

const operationId = '0f8b5c1e-3a2d-4c7b-9e1f-5a6b7c8d9e0f';
const { orderReference } = deriveProviderCorrelation(operationId);
const target = gopayExecutionTarget();
const verifiedInstant = DateTime.makeUnsafe('2026-11-12T10:05:00.000Z');

const notification = (overrides: Partial<RawProviderNotification> = {}): RawProviderNotification => ({
  environment: 'SANDBOX',
  family: 'GOPAY',
  headers: { contentType: Option.none(), stripeSignature: Option.none() },
  providerAccountRef: GOPAY_FIXTURE_ACCOUNT_REF,
  query: { parentPaymentRef: Option.none(), paymentRef: Option.some(GOPAY_FIXTURE_PAYMENT_ID) },
  rawBody: new Uint8Array(),
  receivedAt: DateTime.makeUnsafe('2026-11-12T10:04:59.000Z'),
  transportDeliveryRef: 'relay-delivery-0001',
  ...overrides,
});

const verifyAt = (raw: RawProviderNotification) =>
  Effect.gen(function* verifyAtFixedClock() {
    yield* TestClock.setTime(DateTime.toEpochMillis(verifiedInstant));
    return yield* verifyGopayNotification(target, raw);
  });

const rejectionOf = (raw: RawProviderNotification) =>
  verifyAt(raw).pipe(
    Effect.flip,
    Effect.map((failure) => failure.reason),
  );

describe('#1157 GoPay notification', () => {
  it.effect('#1157 GoPay notification triggers lookup only', () =>
    Effect.gen(function* lookupOnlyTrigger() {
      const trigger = yield* verifyAt(notification());
      const paymentRef = Option.getOrThrow(parseGopayId(GOPAY_FIXTURE_PAYMENT_ID));
      expect(trigger).toEqual({
        actionable: true,
        authenticity: 'LOOKUP_REQUIRED',
        claimedStatus: Option.none(),
        deliveryIdentity: `gopay:${GOPAY_FIXTURE_PAYMENT_ID}:relay-delivery-0001`,
        family: 'GOPAY',
        providerEventAt: Option.none(),
        providerOccurrenceId: Option.none(),
        providerRefs: [{ _tag: 'GOPAY_PAYMENT', id: paymentRef }],
        retainedBody: new Uint8Array(0),
        signedObject: Option.none(),
        verifiedAt: verifiedInstant,
      });
    }),
  );

  it.effect('#1157 A malformed or absent id is rejected as MALFORMED', () =>
    Effect.gen(function* malformedIds() {
      const query = (paymentRef: Option.Option<string>, parentPaymentRef: Option.Option<string> = Option.none()) =>
        notification({ query: { parentPaymentRef, paymentRef } });
      const reasons = yield* Effect.all([
        rejectionOf(query(Option.none())),
        rejectionOf(query(Option.some('abc'))),
        rejectionOf(query(Option.some('0123'))),
        rejectionOf(query(Option.some('-5'))),
        rejectionOf(query(Option.some('300000001 '))),
        rejectionOf(query(Option.some('300000001/refunds'))),
        rejectionOf(query(Option.some(GOPAY_FIXTURE_PAYMENT_ID), Option.some('x1'))),
        rejectionOf(notification({ rawBody: new TextEncoder().encode('state=PAID') })),
        // The delivery identity would exceed the stored 200-character bound.
        rejectionOf(notification({ transportDeliveryRef: 'r'.repeat(200) })),
      ]);
      expect(reasons).toEqual(Array.from({ length: 9 }, () => 'MALFORMED'));
    }),
  );

  it.effect('#1157 A notification addressed to another binding or environment is rejected', () =>
    Effect.gen(function* foreignBinding() {
      const reasons = yield* Effect.all([
        rejectionOf(notification({ providerAccountRef: `pab_${'b2'.repeat(16)}` })),
        rejectionOf(notification({ family: 'STRIPE' })),
        rejectionOf(notification({ environment: 'LIVE' })),
      ]);
      expect(reasons).toEqual(['BINDING_UNKNOWN', 'BINDING_UNKNOWN', 'ENVIRONMENT_MISMATCH']);
    }),
  );

  it.effect('#1157 A recurring payment notification is stored but not actionable', () =>
    Effect.gen(function* recurringNotification() {
      const trigger = yield* verifyAt(
        notification({
          query: { parentPaymentRef: Option.some('300000000'), paymentRef: Option.some(GOPAY_FIXTURE_PAYMENT_ID) },
        }),
      );
      expect(trigger.actionable).toBe(false);
      expect(trigger.authenticity).toBe('LOOKUP_REQUIRED');
    }),
  );

  it.effect('#1156 Notification for another merchant is not submitted', () =>
    Effect.gen(function* foreignMerchant() {
      const trigger = yield* verifyAt(notification());
      expect(trigger.providerRefs).toEqual([{ _tag: 'GOPAY_PAYMENT', id: GOPAY_FIXTURE_PAYMENT_ID }]);
      // v4 payments carry no GoID: a payment of another eshop shows up as an order this operation never sent.
      const foreignPayment = Schema.decodeUnknownSync(GopayPaymentFromJsonSchema)(
        gopayPaymentBody({ orderNumber: '2025010199', state: 'PAID' }),
      );
      const findings = mapGopayLookup({
        dispatchedAt: Option.none(),
        expected: { _tag: 'COLLECT', amount: { amountMinor: 10_000, currency: 'CZK' }, operationId },
        observedAt: trigger.verifiedAt,
        origin: 'NOTIFICATION_LOOKUP',
        paymentRef: foreignPayment.id,
        result: { _tag: 'PAYMENT', payment: foreignPayment },
      });
      const own = mapGopayLookup({
        dispatchedAt: Option.none(),
        expected: { _tag: 'COLLECT', amount: { amountMinor: 10_000, currency: 'CZK' }, operationId },
        observedAt: trigger.verifiedAt,
        origin: 'NOTIFICATION_LOOKUP',
        paymentRef: foreignPayment.id,
        result: {
          _tag: 'PAYMENT',
          payment: Schema.decodeUnknownSync(GopayPaymentFromJsonSchema)(
            gopayPaymentBody({ orderNumber: orderReference, state: 'PAID' }),
          ),
        },
      });
      expect(own.map(({ finding }) => finding)).toEqual(['EFFECT_CONFIRMED']);
      expect(findings.map((finding) => [finding.finding, finding.evidence, finding.orderReference])).toEqual([
        ['VERIFICATION_CONFLICT', Option.none(), Option.none()],
      ]);
    }),
  );
});
