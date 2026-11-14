import { describe, expect, it } from 'effect-rstest';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { DateTime, Effect, Option, Result, Schema } from 'effect';

import type { GatewayEnvironment } from '../../shared/domain/psp-vocabulary.ts';
import {
  decodeStripeEvent,
  stripeRetainedBodyOf,
  stripeSignedObjectOrderReference,
} from '../../src/integrations/stripe/stripe-event.ts';
import {
  STRIPE_FIXTURE_EVENT_CREATED,
  STRIPE_FIXTURE_EVENT_ID,
  stripeBalanceObject,
  stripeCustomerObject,
  stripeEventEnvelope,
  stripeInvoiceObject,
  stripePayoutObject,
} from '../fixtures/stripe/stripe-events.ts';
import {
  STRIPE_FIXTURE_PAYMENT_INTENT_ID,
  STRIPE_FIXTURE_REFUND_ID,
  STRIPE_FIXTURE_SESSION_ID,
  stripeChargeObject,
  stripeCheckoutSessionObject,
  stripePaymentIntentObject,
  stripeRefundObject,
} from '../fixtures/stripe/stripe-objects.ts';
import type { StripeEventFixture } from '../fixtures/stripe/stripe-events.ts';

const ORDER_REFERENCE = '3f1c2b7e8a9d4e6f9b1a2c3d4e5f6a7b';
const verifiedAt = DateTime.makeUnsafe('2026-11-12T10:00:05.000Z');

const bodyOf = (fixture: StripeEventFixture): Uint8Array =>
  new TextEncoder().encode(Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(stripeEventEnvelope(fixture)));

const decode = (fixture: StripeEventFixture, environment: GatewayEnvironment = 'SANDBOX') =>
  decodeStripeEvent({ environment, rawBody: bodyOf(fixture), verifiedAt });

const rejectionOf = (rawBody: Uint8Array, environment: GatewayEnvironment = 'SANDBOX') =>
  Effect.result(decodeStripeEvent({ environment, rawBody, verifiedAt })).pipe(
    Effect.map((result) => Result.getFailure(result).pipe(Option.map((error) => error.reason))),
  );

const paidSession = stripeCheckoutSessionObject({
  orderReference: ORDER_REFERENCE,
  paymentIntent: STRIPE_FIXTURE_PAYMENT_INTENT_ID,
  paymentStatus: 'paid',
  status: 'complete',
});

describe('#1157 Stripe event decoding and routing', () => {
  it.effect('#1157 Mapped checkout event becomes an actionable signed trigger', () =>
    Effect.gen(function* checkoutCompleted() {
      const trigger = yield* decode({ object: paidSession, type: 'checkout.session.completed' });
      expect(trigger.actionable).toBe(true);
      expect(trigger.authenticity).toBe('SIGNATURE_VERIFIED');
      expect(trigger.family).toBe('STRIPE');
      expect(trigger.deliveryIdentity).toBe(`stripe:evt:${STRIPE_FIXTURE_EVENT_ID}`);
      expect(trigger.providerOccurrenceId).toEqual(Option.some(`stripe:evt:${STRIPE_FIXTURE_EVENT_ID}`));
      expect(trigger.providerEventAt).toEqual(Option.some(DateTime.makeUnsafe(STRIPE_FIXTURE_EVENT_CREATED * 1000)));
      expect(trigger.verifiedAt).toEqual(verifiedAt);
      expect(trigger.claimedStatus).toEqual(Option.some('complete:paid'));
      expect(trigger.providerRefs).toEqual([
        { _tag: 'STRIPE_CHECKOUT_SESSION', id: STRIPE_FIXTURE_SESSION_ID },
        { _tag: 'STRIPE_PAYMENT_INTENT', id: STRIPE_FIXTURE_PAYMENT_INTENT_ID },
      ]);
      expect(trigger.signedObject.pipe(Option.flatMap(stripeSignedObjectOrderReference))).toEqual(
        Option.some(ORDER_REFERENCE),
      );
    }),
  );

  it.effect('#1157 PaymentIntent, refund and charge.refunded events route to their provider objects', () =>
    Effect.gen(function* otherMappedTypes() {
      const paymentIntent = yield* decode({
        object: stripePaymentIntentObject({ orderReference: ORDER_REFERENCE, status: 'succeeded' }),
        type: 'payment_intent.succeeded',
      });
      expect(paymentIntent.actionable).toBe(true);
      expect(paymentIntent.claimedStatus).toEqual(Option.some('succeeded'));
      expect(paymentIntent.providerRefs).toEqual([
        { _tag: 'STRIPE_PAYMENT_INTENT', id: STRIPE_FIXTURE_PAYMENT_INTENT_ID },
      ]);

      const refund = yield* decode({ object: stripeRefundObject({ status: 'failed' }), type: 'refund.failed' });
      expect(refund.actionable).toBe(true);
      expect(refund.claimedStatus).toEqual(Option.some('failed'));
      expect(refund.providerRefs).toEqual([
        { _tag: 'STRIPE_REFUND', id: STRIPE_FIXTURE_REFUND_ID },
        { _tag: 'STRIPE_PAYMENT_INTENT', id: STRIPE_FIXTURE_PAYMENT_INTENT_ID },
      ]);

      const charge = yield* decode({ object: stripeChargeObject({ refunded: false }), type: 'charge.refunded' });
      expect(charge.actionable).toBe(true);
      expect(charge.claimedStatus).toEqual(Option.some('partially_refunded'));
      expect(charge.providerRefs).toEqual([{ _tag: 'STRIPE_PAYMENT_INTENT', id: STRIPE_FIXTURE_PAYMENT_INTENT_ID }]);
    }),
  );

  it.effect('#1157 Unmapped event type is captured as IGNORED and acknowledged', () =>
    Effect.gen(function* unmappedType() {
      const trigger = yield* decode({ object: { id: 'seti_1', object: 'setup_intent' }, type: 'setup_intent.created' });
      expect(trigger.actionable).toBe(false);
      // Nothing reads an IGNORED event again, so the capture keeps none of its bytes.
      expect(stripeRetainedBodyOf(trigger, utf8ToBytes('{"id":"evt"}'))).toEqual(new Uint8Array(0));
      expect(trigger.deliveryIdentity).toBe(`stripe:evt:${STRIPE_FIXTURE_EVENT_ID}`);
      expect(trigger.providerOccurrenceId).toEqual(Option.none());
      expect(trigger.signedObject).toEqual(Option.none());
      expect(trigger.providerRefs).toEqual([]);
    }),
  );

  it.effect('#1156 Settlement/balance events never create an operation', () =>
    Effect.gen(function* settlementEvents() {
      for (const fixture of [
        { object: stripeBalanceObject, type: 'balance.available' },
        { object: stripePayoutObject, type: 'payout.paid' },
        { object: stripeInvoiceObject, type: 'invoice.paid' },
        { object: stripeCustomerObject, type: 'customer.created' },
      ]) {
        const trigger = yield* decode(fixture);
        expect(trigger.actionable).toBe(false);
        expect(trigger.providerOccurrenceId).toEqual(Option.none());
        expect(trigger.providerRefs).toEqual([]);
        expect(trigger.signedObject).toEqual(Option.none());
      }
    }),
  );

  it.effect('#1157 A non-payment Checkout Session is ignored', () =>
    Effect.gen(function* subscriptionSession() {
      const trigger = yield* decode({
        object: stripeCheckoutSessionObject({
          mode: 'subscription',
          paymentIntent: null,
          paymentStatus: 'paid',
          status: 'complete',
        }),
        type: 'checkout.session.completed',
      });
      expect(trigger.actionable).toBe(false);
    }),
  );

  it.effect('#1157 livemode mismatch is rejected', () =>
    Effect.gen(function* livemodeMismatch() {
      expect(
        yield* rejectionOf(bodyOf({ livemode: true, object: paidSession, type: 'checkout.session.completed' })),
      ).toEqual(Option.some('ENVIRONMENT_MISMATCH'));
      expect(
        yield* rejectionOf(
          bodyOf({ livemode: false, object: paidSession, type: 'checkout.session.completed' }),
          'LIVE',
        ),
      ).toEqual(Option.some('ENVIRONMENT_MISMATCH'));
      const liveObjectInTestEvent = stripePaymentIntentObject({ livemode: true, status: 'succeeded' });
      expect(yield* rejectionOf(bodyOf({ object: liveObjectInTestEvent, type: 'payment_intent.succeeded' }))).toEqual(
        Option.some('ENVIRONMENT_MISMATCH'),
      );
      expect(
        yield* rejectionOf(bodyOf({ livemode: true, object: stripeBalanceObject, type: 'balance.available' })),
      ).toEqual(Option.some('ENVIRONMENT_MISMATCH'));
    }),
  );

  it.effect('#1157 Malformed envelopes and mapped objects are rejected', () =>
    Effect.gen(function* malformed() {
      const encoder = new TextEncoder();
      for (const rawBody of [
        encoder.encode('not json'),
        encoder.encode('{"id":"evt_1","type":"checkout.session.completed"}'),
        new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]),
        bodyOf({ object: { id: 'cs_test_1', object: 'checkout.session' }, type: 'checkout.session.completed' }),
        bodyOf({ id: 'not-an-event-id', object: paidSession, type: 'checkout.session.completed' }),
      ]) {
        expect(yield* rejectionOf(rawBody)).toEqual(Option.some('MALFORMED'));
      }
    }),
  );
});
