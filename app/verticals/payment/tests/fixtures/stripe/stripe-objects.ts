/**
 * Stripe API v1 objects for unit tests (#1154, #1156, #1158). Shapes follow the example objects of the
 * Stripe API reference, read 2026-11-12 (API version shown on the pages: `2026-10-28.endive`):
 * - Checkout Session: https://docs.stripe.com/api/checkout/sessions/object
 * - PaymentIntent: https://docs.stripe.com/api/payment_intents/object
 * - Refund: https://docs.stripe.com/api/refunds/object (its example carries no `livemode`)
 * - Charge: https://docs.stripe.com/api/charges/object
 * - PaymentIntent search result: https://docs.stripe.com/api/payment_intents/search
 * Ids keep the documented prefixes; amounts are CZK minor units and `metadata.ontos_order_reference` is set
 * per test. Fields OntOS does not read (`client_secret`, `customer`, `payment_method_types`, ...) are kept
 * to prove that decoding strips them. No value identifies a real account.
 */

export const STRIPE_FIXTURE_SESSION_ID = 'cs_test_a1b2c3d4e5f6g7h8i9j0';
export const STRIPE_FIXTURE_PAYMENT_INTENT_ID = 'pi_3MtwBwLkdIwHu7ix28a3tqPa';
export const STRIPE_FIXTURE_REFUND_ID = 're_1Nispe2eZvKYlo2Cd31jOCgZ';
const STRIPE_FIXTURE_CHARGE_ID = 'ch_3MmlLrLkdIwHu7ix0snN0B15';
const CREATED = 1_762_934_400;

export interface StripePaymentIntentFixture {
  readonly amount?: number;
  readonly amountReceived?: number;
  readonly currency?: string;
  readonly id?: string;
  readonly livemode?: boolean;
  readonly orderReference?: string | undefined;
  readonly status: string;
}

export const stripePaymentIntentObject = (fixture: StripePaymentIntentFixture) => ({
  amount: fixture.amount ?? 159_950,
  amount_capturable: 0,
  amount_received: fixture.amountReceived ?? (fixture.status === 'succeeded' ? (fixture.amount ?? 159_950) : 0),
  automatic_payment_methods: { enabled: true },
  canceled_at: null,
  cancellation_reason: null,
  capture_method: 'automatic',
  confirmation_method: 'automatic',
  created: CREATED,
  currency: fixture.currency ?? 'czk',
  customer: null,
  description: null,
  id: fixture.id ?? STRIPE_FIXTURE_PAYMENT_INTENT_ID,
  last_payment_error: null,
  latest_charge: null,
  livemode: fixture.livemode ?? false,
  metadata: fixture.orderReference === undefined ? {} : { ontos_order_reference: fixture.orderReference },
  next_action: null,
  object: 'payment_intent',
  payment_method: null,
  payment_method_types: ['card'],
  receipt_email: null,
  setup_future_usage: null,
  status: fixture.status,
});

export interface StripeCheckoutSessionFixture {
  readonly livemode?: boolean;
  readonly mode?: string;
  readonly orderReference?: string | undefined;
  /** A PaymentIntent id, an expanded PaymentIntent object, or null. */
  readonly paymentIntent: ReturnType<typeof stripePaymentIntentObject> | string | null;
  readonly paymentStatus: string;
  readonly status: string;
}

export const stripeCheckoutSessionObject = (fixture: StripeCheckoutSessionFixture) => ({
  amount_subtotal: 159_950,
  amount_total: 159_950,
  cancel_url: 'https://shop.example.test/return?r=AAAAAAAAAAAAAAAAAAAAAA',
  client_reference_id: null,
  created: CREATED,
  currency: 'czk',
  customer: null,
  customer_creation: 'if_required',
  expires_at: CREATED + 86_400,
  id: STRIPE_FIXTURE_SESSION_ID,
  livemode: fixture.livemode ?? false,
  metadata: fixture.orderReference === undefined ? {} : { ontos_order_reference: fixture.orderReference },
  mode: fixture.mode ?? 'payment',
  object: 'checkout.session',
  payment_intent: fixture.paymentIntent,
  payment_method_types: ['card'],
  payment_status: fixture.paymentStatus,
  status: fixture.status,
  success_url: 'https://shop.example.test/return?r=AAAAAAAAAAAAAAAAAAAAAA',
  url:
    fixture.status === 'open'
      ? 'https://checkout.stripe.com/c/pay/cs_test_a1b2c3d4e5f6g7h8i9j0#fidkdWxOYHwnPyd1blpxYHZxWjA0'
      : null,
});

export interface StripeRefundFixture {
  readonly amount?: number;
  readonly currency?: string;
  readonly livemode?: boolean;
  readonly orderReference?: string | undefined;
  readonly status: string;
}

const refundObjectWithoutLivemode = (fixture: StripeRefundFixture) => ({
  amount: fixture.amount ?? 50_000,
  balance_transaction: 'txn_1Nispe2eZvKYlo2CYezqFhEx',
  charge: STRIPE_FIXTURE_CHARGE_ID,
  created: CREATED,
  currency: fixture.currency ?? 'czk',
  destination_details: { card: { reference_status: 'pending', reference_type: 'acquirer_reference_number' } },
  id: STRIPE_FIXTURE_REFUND_ID,
  metadata: fixture.orderReference === undefined ? {} : { ontos_order_reference: fixture.orderReference },
  object: 'refund',
  payment_intent: STRIPE_FIXTURE_PAYMENT_INTENT_ID,
  reason: null,
  receipt_number: null,
  source_transfer_reversal: null,
  status: fixture.status,
  transfer_reversal: null,
});

export const stripeRefundObject = (fixture: StripeRefundFixture) => {
  const refund = refundObjectWithoutLivemode(fixture);
  return fixture.livemode === undefined ? refund : { ...refund, livemode: fixture.livemode };
};

export const stripeChargeObject = (fixture: { readonly livemode?: boolean; readonly refunded: boolean }) => ({
  amount: 159_950,
  amount_captured: 159_950,
  amount_refunded: fixture.refunded ? 159_950 : 50_000,
  balance_transaction: 'txn_3MmlLrLkdIwHu7ix0uke3Ezy',
  captured: true,
  created: CREATED,
  currency: 'czk',
  customer: null,
  id: STRIPE_FIXTURE_CHARGE_ID,
  livemode: fixture.livemode ?? false,
  metadata: {},
  object: 'charge',
  paid: true,
  payment_intent: STRIPE_FIXTURE_PAYMENT_INTENT_ID,
  refunded: fixture.refunded,
  status: 'succeeded',
});

export const stripePaymentIntentSearchResult = (data: readonly ReturnType<typeof stripePaymentIntentObject>[]) => ({
  data,
  has_more: false,
  next_page: null,
  object: 'search_result',
  url: '/v1/payment_intents/search',
});

/** Error body shape of https://docs.stripe.com/api/errors (the 404 example of a missing resource). */
export const stripeResourceMissingError = {
  error: {
    code: 'resource_missing',
    doc_url: 'https://stripe.com/docs/error-codes/resource-missing',
    message: "No such checkout.session: 'cs_test_a1b2c3d4e5f6g7h8i9j0'",
    param: 'session',
    type: 'invalid_request_error',
  },
};
