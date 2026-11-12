import { Effect, Option, Schema } from 'effect';

import { PaymentAmountMinorSchema } from '../../../shared/domain/payment-money.ts';
import { GatewayOrderReferenceSchema } from '../psp/psp-correlation.ts';
import type { GatewayOrderReference } from '../psp/psp-correlation.ts';
import { GatewayProviderResponseInvalid } from '../psp/psp-errors.ts';
import type { GatewayProviderResponseInvalidError } from '../psp/psp-errors.ts';
import { ProviderObjectIdSchema } from '../psp/psp-request.ts';
import type { ProviderObjectId } from '../psp/psp-request.ts';

/**
 * Stripe API v1 wire schemas (#1154, #1156, #1158). Only the fields OntOS reads are declared; every
 * other key is stripped on decode. Field names follow the Stripe objects:
 * - Checkout Session: https://docs.stripe.com/api/checkout/sessions/object
 * - PaymentIntent: https://docs.stripe.com/api/payment_intents/object
 * - Refund: https://docs.stripe.com/api/refunds/object
 * - Charge: https://docs.stripe.com/api/charges/object
 * - Search result: https://docs.stripe.com/api/payment_intents/search
 * - Error: https://docs.stripe.com/api/errors
 * An unknown status value fails decoding (fail closed), it is never read as a known state.
 */

const stripeIdOf = (pattern: RegExp) => ProviderObjectIdSchema.check(Schema.isPattern(pattern));

export const StripeCheckoutSessionIdSchema = stripeIdOf(/^cs_[A-Za-z0-9_]{1,250}$/u);
export const StripePaymentIntentIdSchema = stripeIdOf(/^pi_[A-Za-z0-9_]{1,250}$/u);
/** Refund ids are `re_`; some payment methods report `pyr_` refunds. */
export const StripeRefundIdSchema = stripeIdOf(/^(?:re|pyr)_[A-Za-z0-9_]{1,250}$/u);
const StripeChargeIdSchema = stripeIdOf(/^(?:ch|py)_[A-Za-z0-9_]{1,250}$/u);

/** Stripe reports ISO 4217 codes in lower case (`czk`). */
const StripeCurrencySchema = Schema.String.check(Schema.isPattern(/^[a-z]{3}$/u));
const StripeUnixSecondsSchema = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
const StripeMetadataSchema = Schema.Record(Schema.String, Schema.String);

export const STRIPE_PAYMENT_INTENT_STATUSES = [
  'requires_payment_method',
  'requires_confirmation',
  'requires_action',
  'processing',
  'requires_capture',
  'canceled',
  'succeeded',
] as const;
const StripePaymentIntentStatusSchema = Schema.Literals(STRIPE_PAYMENT_INTENT_STATUSES);

export const StripePaymentIntentSchema = Schema.Struct({
  amount: PaymentAmountMinorSchema,
  amount_received: PaymentAmountMinorSchema,
  created: StripeUnixSecondsSchema,
  currency: StripeCurrencySchema,
  id: StripePaymentIntentIdSchema,
  livemode: Schema.Boolean,
  metadata: Schema.OptionFromOptionalNullOr(StripeMetadataSchema),
  object: Schema.Literal('payment_intent'),
  status: StripePaymentIntentStatusSchema,
});
export type StripePaymentIntent = typeof StripePaymentIntentSchema.Type;

export const STRIPE_CHECKOUT_SESSION_STATUSES = ['open', 'complete', 'expired'] as const;
export const STRIPE_CHECKOUT_PAYMENT_STATUSES = ['paid', 'unpaid', 'no_payment_required'] as const;

/**
 * `payment_intent` is an id, or the PaymentIntent object when the lookup asked for
 * `expand[]=payment_intent`, or null before the customer started paying.
 */
export const StripeCheckoutSessionSchema = Schema.Struct({
  amount_total: Schema.OptionFromOptionalNullOr(PaymentAmountMinorSchema),
  created: StripeUnixSecondsSchema,
  currency: Schema.OptionFromOptionalNullOr(StripeCurrencySchema),
  id: StripeCheckoutSessionIdSchema,
  livemode: Schema.Boolean,
  metadata: Schema.OptionFromOptionalNullOr(StripeMetadataSchema),
  mode: Schema.Literals(['payment', 'setup', 'subscription']),
  object: Schema.Literal('checkout.session'),
  payment_intent: Schema.OptionFromOptionalNullOr(
    Schema.Union([StripePaymentIntentIdSchema, StripePaymentIntentSchema]),
  ),
  payment_status: Schema.Literals(STRIPE_CHECKOUT_PAYMENT_STATUSES),
  status: Schema.OptionFromOptionalNullOr(Schema.Literals(STRIPE_CHECKOUT_SESSION_STATUSES)),
  url: Schema.OptionFromOptionalNullOr(Schema.String),
});
export type StripeCheckoutSession = typeof StripeCheckoutSessionSchema.Type;

const isExpandedPaymentIntent = Schema.is(StripePaymentIntentSchema);

/** The session's PaymentIntent object, when the lookup expanded it. */
export const stripeExpandedPaymentIntentOf = (session: StripeCheckoutSession): Option.Option<StripePaymentIntent> =>
  session.payment_intent.pipe(Option.filter(isExpandedPaymentIntent));

/** The session's PaymentIntent id, expanded or not; `None` before the customer started paying. */
export const stripePaymentIntentIdOf = (session: StripeCheckoutSession): Option.Option<ProviderObjectId> =>
  session.payment_intent.pipe(
    Option.map((paymentIntent) => (isExpandedPaymentIntent(paymentIntent) ? paymentIntent.id : paymentIntent)),
  );

export const STRIPE_REFUND_STATUSES = ['pending', 'requires_action', 'succeeded', 'failed', 'canceled'] as const;

/** The Refund object carries no `livemode` in every API version, so it is optional here and checked when present. */
export const StripeRefundSchema = Schema.Struct({
  amount: PaymentAmountMinorSchema,
  created: StripeUnixSecondsSchema,
  currency: StripeCurrencySchema,
  id: StripeRefundIdSchema,
  livemode: Schema.OptionFromOptionalKey(Schema.Boolean),
  metadata: Schema.OptionFromOptionalNullOr(StripeMetadataSchema),
  object: Schema.Literal('refund'),
  payment_intent: Schema.OptionFromOptionalNullOr(StripePaymentIntentIdSchema),
  status: Schema.OptionFromOptionalNullOr(Schema.Literals(STRIPE_REFUND_STATUSES)),
});
export type StripeRefund = typeof StripeRefundSchema.Type;

/** Only read from `charge.refunded` events to name the PaymentIntent whose refund must be looked up. */
export const StripeChargeSchema = Schema.Struct({
  amount_refunded: PaymentAmountMinorSchema,
  currency: StripeCurrencySchema,
  id: StripeChargeIdSchema,
  livemode: Schema.Boolean,
  metadata: Schema.OptionFromOptionalNullOr(StripeMetadataSchema),
  object: Schema.Literal('charge'),
  payment_intent: Schema.OptionFromOptionalNullOr(StripePaymentIntentIdSchema),
  refunded: Schema.Boolean,
  status: Schema.Literals(['succeeded', 'pending', 'failed']),
});

/** `GET /v1/payment_intents/search`. Eventually consistent: a miss proves nothing. */
export const StripePaymentIntentSearchResultSchema = Schema.Struct({
  data: Schema.Array(StripePaymentIntentSchema),
  has_more: Schema.Boolean,
  object: Schema.Literal('search_result'),
});
export type StripePaymentIntentSearchResult = typeof StripePaymentIntentSearchResultSchema.Type;

const errorText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));

/** Error body of any non-2xx answer. The message is deliberately not read (it can echo request data). */
export const StripeErrorResponseSchema = Schema.Struct({
  error: Schema.Struct({
    code: Schema.OptionFromOptionalNullOr(errorText),
    type: errorText,
  }),
});
export type StripeErrorResponse = typeof StripeErrorResponseSchema.Type;

/** Metadata key carrying `ProviderCorrelation.orderReference` on sessions and their PaymentIntents. */
export const STRIPE_ORDER_REFERENCE_METADATA_KEY = 'ontos_order_reference';

/** The OntOS order reference a Stripe object claims in its metadata; `None` when absent or malformed. */
export const stripeOrderReferenceOf = (
  metadata: Option.Option<Readonly<Record<string, string>>>,
): Option.Option<GatewayOrderReference> =>
  metadata.pipe(
    Option.flatMap((entries) => Option.fromNullishOr(entries[STRIPE_ORDER_REFERENCE_METADATA_KEY])),
    Option.flatMap(Schema.decodeUnknownOption(GatewayOrderReferenceSchema)),
  );

const responseInvalid = (reason: string): GatewayProviderResponseInvalidError =>
  new GatewayProviderResponseInvalid({ code: 'gateway_provider_response_invalid', family: 'STRIPE', reason });

const jsonDecoderOf =
  <A, I>(schema: Schema.Codec<A, I>, reason: string) =>
  (bodyText: string): Effect.Effect<A, GatewayProviderResponseInvalidError> =>
    Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(bodyText).pipe(
      Effect.catchTag('SchemaError', () => Effect.fail(responseInvalid(reason))),
    );

export const decodeStripeCheckoutSession = jsonDecoderOf(
  StripeCheckoutSessionSchema,
  'stripe_checkout_session_invalid',
);
export const decodeStripePaymentIntent = jsonDecoderOf(StripePaymentIntentSchema, 'stripe_payment_intent_invalid');
export const decodeStripeRefund = jsonDecoderOf(StripeRefundSchema, 'stripe_refund_invalid');
export const decodeStripePaymentIntentSearch = jsonDecoderOf(
  StripePaymentIntentSearchResultSchema,
  'stripe_payment_intent_search_invalid',
);

/** A non-2xx body that is not a Stripe error object is `None`; callers then classify by status only. */
export const decodeStripeError = (bodyText: string): Option.Option<StripeErrorResponse> =>
  Schema.decodeUnknownOption(Schema.fromJsonString(StripeErrorResponseSchema))(bodyText);
