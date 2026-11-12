import { DateTime, Effect, Match, Option, Schema } from 'effect';

import { PaymentSourceOccurrenceIdSchema } from '../../../shared/domain/payment-identifiers.ts';
import type { GatewayEnvironment } from '../../../shared/domain/psp-vocabulary.ts';
import type { VerifiedNotificationTrigger } from '../psp/notification-envelope.ts';
import type { GatewayOrderReference } from '../psp/psp-correlation.ts';
import { GatewayNotificationRejected } from '../psp/psp-errors.ts';
import type { GatewayNotificationRejectedError, GatewayNotificationRejectionReason } from '../psp/psp-errors.ts';
import type { ProviderObjectId, ProviderObjectRef } from '../psp/psp-request.ts';
import {
  StripeChargeSchema,
  StripeCheckoutSessionSchema,
  StripePaymentIntentSchema,
  StripeRefundSchema,
  stripeOrderReferenceOf,
  stripePaymentIntentIdOf,
} from './stripe-wire.ts';

/**
 * Stripe webhook event decoding and routing (#1157), plan §4 Stripe "Webhook". Runs only on a body whose
 * `Stripe-Signature` was already verified (stripe-webhook-signature.ts), so the trigger is
 * SIGNATURE_VERIFIED. The snapshot envelope `{id, type, created, livemode, data.object}` is decoded with
 * Schema (https://docs.stripe.com/api/events/object); `livemode` must match the binding environment.
 *
 * Only the mapped event types are actionable. Every other type (invoice.*, customer.*, subscription,
 * balance, payout and other settlement events, disputes, thin events) is `actionable: false`: the capture
 * Action stores it as IGNORED and acknowledges it, nothing is submitted and no operation is created, and
 * invoice/customer events never become OntOS Billing. A signed object is a trigger, not proof: the
 * processor re-reads it through lookup before a collection is confirmed.
 */

/**
 * Mapped event types. `checkout.session.expired` and the `payment_intent.*` names were not re-verified on
 * https://docs.stripe.com/api/events/types in this change (plan §11); a misspelled name would only make the
 * event IGNORED, never actionable.
 */
const STRIPE_CHECKOUT_SESSION_EVENT_TYPES = [
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'checkout.session.expired',
] as const;
const STRIPE_PAYMENT_INTENT_EVENT_TYPES = [
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  'payment_intent.canceled',
  'payment_intent.processing',
] as const;
const STRIPE_REFUND_EVENT_TYPES = ['refund.created', 'refund.updated', 'refund.failed'] as const;
const STRIPE_CHARGE_EVENT_TYPES = ['charge.refunded'] as const;

export const STRIPE_MAPPED_EVENT_TYPES = [
  ...STRIPE_CHECKOUT_SESSION_EVENT_TYPES,
  ...STRIPE_PAYMENT_INTENT_EVENT_TYPES,
  ...STRIPE_REFUND_EVENT_TYPES,
  ...STRIPE_CHARGE_EVENT_TYPES,
] as const;

const StripeEventTypeSchema = Schema.Literals(STRIPE_MAPPED_EVENT_TYPES);

const StripeEventEnvelopeSchema = Schema.Struct({
  created: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  data: Schema.Struct({ object: Schema.Json }),
  id: Schema.String.check(Schema.isPattern(/^evt_[A-Za-z0-9_]{1,250}$/u)),
  livemode: Schema.Boolean,
  type: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
});

export interface StripeEventInput {
  /** Environment of the binding the notification was addressed to. */
  readonly environment: GatewayEnvironment;
  /** The exact signed body bytes. */
  readonly rawBody: Uint8Array;
  readonly verifiedAt: DateTime.Utc;
}

const rejected = (reason: GatewayNotificationRejectionReason): GatewayNotificationRejectedError =>
  new GatewayNotificationRejected({ code: 'gateway_notification_rejected', family: 'STRIPE', reason });

const decodeOr =
  <A, I>(schema: Schema.Codec<A, I>) =>
  (input: Schema.Json | string): Effect.Effect<A, GatewayNotificationRejectedError> =>
    Schema.decodeUnknownEffect(schema)(input).pipe(
      Effect.catchTag('SchemaError', () => Effect.fail(rejected('MALFORMED'))),
    );

const requireLivemode = (
  environment: GatewayEnvironment,
  livemode: boolean,
): Effect.Effect<void, GatewayNotificationRejectedError> =>
  livemode === (environment === 'LIVE') ? Effect.void : Effect.fail(rejected('ENVIRONMENT_MISMATCH'));

interface SignedObjectRoute {
  readonly actionable: boolean;
  readonly claimedStatus: Option.Option<string>;
  readonly providerRefs: readonly ProviderObjectRef[];
}

const IGNORED_ROUTE: SignedObjectRoute = { actionable: false, claimedStatus: Option.none(), providerRefs: [] };

const paymentIntentRefsOf = (paymentIntentId: Option.Option<ProviderObjectId>): readonly ProviderObjectRef[] =>
  Option.match(paymentIntentId, {
    onNone: () => [],
    onSome: (id) => [{ _tag: 'STRIPE_PAYMENT_INTENT', id }],
  });

/** Only `mode=payment` sessions are OntOS collections; setup and subscription sessions are ignored. */
const routeCheckoutSession = Effect.fn('StripeEvent.routeCheckoutSession')(function* routeCheckoutSession(
  object: Schema.Json,
  environment: GatewayEnvironment,
) {
  const session = yield* decodeOr(StripeCheckoutSessionSchema)(object);
  yield* requireLivemode(environment, session.livemode);
  if (session.mode !== 'payment') {
    return IGNORED_ROUTE;
  }
  const route: SignedObjectRoute = {
    actionable: true,
    claimedStatus: Option.some(`${Option.getOrElse(session.status, () => 'none')}:${session.payment_status}`),
    providerRefs: [
      { _tag: 'STRIPE_CHECKOUT_SESSION', id: session.id },
      ...paymentIntentRefsOf(stripePaymentIntentIdOf(session)),
    ],
  };
  return route;
});

const routePaymentIntent = Effect.fn('StripeEvent.routePaymentIntent')(function* routePaymentIntent(
  object: Schema.Json,
  environment: GatewayEnvironment,
) {
  const paymentIntent = yield* decodeOr(StripePaymentIntentSchema)(object);
  yield* requireLivemode(environment, paymentIntent.livemode);
  const route: SignedObjectRoute = {
    actionable: true,
    claimedStatus: Option.some(paymentIntent.status),
    providerRefs: paymentIntentRefsOf(Option.some(paymentIntent.id)),
  };
  return route;
});

const routeRefund = Effect.fn('StripeEvent.routeRefund')(function* routeRefund(
  object: Schema.Json,
  environment: GatewayEnvironment,
) {
  const refund = yield* decodeOr(StripeRefundSchema)(object);
  if (Option.isSome(refund.livemode)) {
    yield* requireLivemode(environment, refund.livemode.value);
  }
  const route: SignedObjectRoute = {
    actionable: true,
    claimedStatus: refund.status,
    providerRefs: [{ _tag: 'STRIPE_REFUND', id: refund.id }, ...paymentIntentRefsOf(refund.payment_intent)],
  };
  return route;
});

/** `charge.refunded` names only the PaymentIntent; the processor looks its refunds up. */
const routeChargeRefunded = Effect.fn('StripeEvent.routeChargeRefunded')(function* routeChargeRefunded(
  object: Schema.Json,
  environment: GatewayEnvironment,
) {
  const charge = yield* decodeOr(StripeChargeSchema)(object);
  yield* requireLivemode(environment, charge.livemode);
  const route: SignedObjectRoute = {
    actionable: true,
    claimedStatus: Option.some(charge.refunded ? 'refunded' : 'partially_refunded'),
    providerRefs: paymentIntentRefsOf(charge.payment_intent),
  };
  return route;
});

const isCheckoutSessionEvent = Schema.is(Schema.Literals(STRIPE_CHECKOUT_SESSION_EVENT_TYPES));
const isPaymentIntentEvent = Schema.is(Schema.Literals(STRIPE_PAYMENT_INTENT_EVENT_TYPES));
const isRefundEvent = Schema.is(Schema.Literals(STRIPE_REFUND_EVENT_TYPES));

const routeSignedObject = (
  type: (typeof STRIPE_MAPPED_EVENT_TYPES)[number],
  object: Schema.Json,
  environment: GatewayEnvironment,
): Effect.Effect<SignedObjectRoute, GatewayNotificationRejectedError> =>
  Match.value(type).pipe(
    Match.when(isCheckoutSessionEvent, () => routeCheckoutSession(object, environment)),
    Match.when(isPaymentIntentEvent, () => routePaymentIntent(object, environment)),
    Match.when(isRefundEvent, () => routeRefund(object, environment)),
    Match.orElse(() => routeChargeRefunded(object, environment)),
  );

/** Strict UTF-8: a body whose bytes do not survive a decode/encode round trip is not text. */
const decodeUtf8 = (bytes: Uint8Array): Effect.Effect<string, GatewayNotificationRejectedError> => {
  const text = new TextDecoder('utf-8').decode(bytes);
  const roundTrip = new TextEncoder().encode(text);
  const identical = roundTrip.length === bytes.length && roundTrip.every((byte, index) => byte === bytes[index]);
  return identical ? Effect.succeed(text) : Effect.fail(rejected('MALFORMED'));
};

/** `stripe:evt:<eventId>`: the delivery identity and source occurrence of one signed event. */
const eventOccurrenceOf = (eventId: string) => `stripe:evt:${eventId}`;

/**
 * Decodes and routes one signature-verified Stripe event. Rejections: MALFORMED (not UTF-8 JSON, not a
 * snapshot envelope, or a mapped type whose object does not decode) and ENVIRONMENT_MISMATCH (`livemode`
 * of the envelope or object differs from the binding environment).
 */
export const decodeStripeEvent = Effect.fn('StripeEvent.decodeStripeEvent')(function* decodeStripeEvent(
  input: StripeEventInput,
) {
  const text = yield* decodeUtf8(input.rawBody);
  const envelope = yield* decodeOr(Schema.fromJsonString(StripeEventEnvelopeSchema))(text);
  yield* requireLivemode(input.environment, envelope.livemode);
  const route = yield* Option.match(Schema.decodeUnknownOption(StripeEventTypeSchema)(envelope.type), {
    onNone: () => Effect.succeed(IGNORED_ROUTE),
    onSome: (type) => routeSignedObject(type, envelope.data.object, input.environment),
  });
  const occurrence = eventOccurrenceOf(envelope.id);
  const occurrenceId = yield* decodeOr(PaymentSourceOccurrenceIdSchema)(occurrence);
  const trigger: VerifiedNotificationTrigger = {
    actionable: route.actionable,
    authenticity: 'SIGNATURE_VERIFIED',
    claimedStatus: route.claimedStatus.pipe(Option.filter((status) => status.length > 0 && status.length <= 100)),
    deliveryIdentity: occurrence,
    family: 'STRIPE',
    providerEventAt: DateTime.make(envelope.created * 1000),
    providerOccurrenceId: route.actionable ? Option.some(occurrenceId) : Option.none(),
    providerRefs: route.providerRefs,
    signedObject: route.actionable ? Option.some(envelope.data.object) : Option.none(),
    verifiedAt: input.verifiedAt,
  };
  return trigger;
});

const SignedObjectMetadataSchema = Schema.Struct({
  metadata: Schema.OptionFromOptionalNullOr(Schema.Record(Schema.String, Schema.String)),
});

/**
 * The order reference a signed Checkout Session or PaymentIntent claims (`metadata.ontos_order_reference`).
 * It is a correlation candidate only: the processor reads the ledger by it inside the same binding and
 * then accepts the lookup-verified `ProviderFindingResult.orderReference`, never this claim alone.
 */
export const stripeSignedObjectOrderReference = (signedObject: Schema.Json): Option.Option<GatewayOrderReference> =>
  Schema.decodeUnknownOption(SignedObjectMetadataSchema)(signedObject).pipe(
    Option.flatMap(({ metadata }) => stripeOrderReferenceOf(metadata)),
  );
