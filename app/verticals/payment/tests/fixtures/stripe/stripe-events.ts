/**
 * Stripe snapshot webhook events for unit tests (#1157). The envelope follows the Event object of
 * https://docs.stripe.com/api/events/object (`id`, `object: "event"`, `api_version`, `created`, `data.object`,
 * `livemode`, `pending_webhooks`, `request`, `type`); the wrapped objects come from `stripe-objects.ts`.
 *
 * Event type names: `checkout.session.completed`, `checkout.session.async_payment_succeeded|failed`,
 * `refund.*` and `charge.refunded` were read on https://docs.stripe.com/checkout/fulfillment and
 * https://docs.stripe.com/api/events/types. UNVERIFIED in this change: `checkout.session.expired` and the
 * `payment_intent.*` names were not re-read on the event-types page (plan §11, map-provider-docs).
 * `balance.available`, `payout.paid`, `invoice.paid` and `customer.created` are used only as unmapped types.
 */

export interface StripeEventFixture {
  readonly id?: string;
  readonly livemode?: boolean;
  readonly object: unknown;
  readonly type: string;
}

export const STRIPE_FIXTURE_EVENT_ID = 'evt_1NG8Du2eZvKYlo2CUI79vXWy';
export const STRIPE_FIXTURE_EVENT_CREATED = 1_762_934_460;

export const stripeEventEnvelope = (fixture: StripeEventFixture) => ({
  api_version: '2026-10-28.endive',
  created: STRIPE_FIXTURE_EVENT_CREATED,
  data: { object: fixture.object },
  id: fixture.id ?? STRIPE_FIXTURE_EVENT_ID,
  livemode: fixture.livemode ?? false,
  object: 'event',
  pending_webhooks: 1,
  request: { id: null, idempotency_key: null },
  type: fixture.type,
});

/** `balance.available` object of https://docs.stripe.com/api/balance/balance_object. */
export const stripeBalanceObject = {
  available: [{ amount: 666_670, currency: 'czk', source_types: { card: 666_670 } }],
  livemode: false,
  object: 'balance',
  pending: [{ amount: 0, currency: 'czk', source_types: { card: 0 } }],
};

/** `payout.paid` object of https://docs.stripe.com/api/payouts/object. */
export const stripePayoutObject = {
  amount: 1100,
  arrival_date: 1_680_652_800,
  automatic: false,
  currency: 'czk',
  id: 'po_1OaFDbEcg9tTZuTgNYmX0PKB',
  livemode: false,
  metadata: {},
  object: 'payout',
  status: 'paid',
};

/** `invoice.paid` object (abridged) of https://docs.stripe.com/api/invoices/object. */
export const stripeInvoiceObject = {
  amount_paid: 159_950,
  currency: 'czk',
  customer: 'cus_NeZwdNtLEOXuvB',
  id: 'in_1MtHbELkdIwHu7ixl4OzzPMv',
  livemode: false,
  object: 'invoice',
  status: 'paid',
};

/** `customer.created` object (abridged) of https://docs.stripe.com/api/customers/object. */
export const stripeCustomerObject = {
  email: null,
  id: 'cus_NffrFeUfNV2Hib',
  livemode: false,
  object: 'customer',
};
