import { Match, Option, Schema } from 'effect';

import { PaymentAmountMinorSchema, PaymentPositiveAmountMinorSchema } from '../../../shared/domain/payment-money.ts';
import { GatewayHttpsUrlSchema } from '../../../shared/domain/psp-configuration.ts';
import type { GatewayMerchantIdentity } from '../../../shared/domain/psp-configuration.ts';
import { GatewayOrderReferenceSchema } from '../psp/psp-correlation.ts';
import { ProviderObjectIdSchema } from '../psp/psp-request.ts';
import type { ProviderObjectId } from '../psp/psp-request.ts';

/**
 * GoPay REST wire shapes (https://doc.gopay.com/, sections "Payment creation", "Payment inquiry",
 * "Payment refund", "History of refunds", "Error"). Every response is decoded through these schemas;
 * nothing is cast. Unknown response fields (payer, payment_instrument, additional_params, ...) are
 * ignored on decode and never interpreted.
 */

/** A GoPay integer identifier (payment id, GoID). Only exact safe integers are accepted. */
const GopayIntegerIdSchema = Schema.Finite.check(
  Schema.isInt(),
  Schema.isBetween({ maximum: Number.MAX_SAFE_INTEGER, minimum: 1 }),
);

/** GoPay payment id as returned in JSON (`"id": 3123456789`). */
export const GopayPaymentIdSchema = GopayIntegerIdSchema;
export type GopayPaymentId = typeof GopayPaymentIdSchema.Type;

/** GoID of the merchant account (`target.goid`). */
export const GopayGoidSchema = GopayIntegerIdSchema;
export type GopayGoid = typeof GopayGoidSchema.Type;

/** An upper-case ISO 4217 code as GoPay reports it. Any currency decodes; Launch money is checked later. */
const GopayCurrencyCodeSchema = Schema.String.check(Schema.isPattern(/^[A-Z]{3}$/u));

/** GoPay payment `state` enum ("Payment states and expiration"). */
export const GOPAY_PAYMENT_STATES = [
  'CREATED',
  'PAYMENT_METHOD_CHOSEN',
  'PAID',
  'AUTHORIZED',
  'CANCELED',
  'TIMEOUTED',
  'REFUNDED',
  'PARTIALLY_REFUNDED',
] as const;
export const GopayPaymentStateSchema = Schema.Literals(GOPAY_PAYMENT_STATES);

/** `target` of a payment: always a GoPay account identified by its GoID. */
export const GopayPaymentTargetSchema = Schema.Struct({
  goid: GopayGoidSchema,
  type: Schema.Literal('ACCOUNT'),
});

/**
 * The payment object returned by `POST /payments/payment` (state CREATED) and by
 * `GET /payments/payment/{id}`. `order_number` is kept as provider text: it is compared with the
 * OntOS order reference after decoding, never trusted as one.
 */
export const GopayPaymentSchema = Schema.Struct({
  amount: PaymentAmountMinorSchema,
  currency: GopayCurrencyCodeSchema,
  gw_url: Schema.optionalKey(Schema.String),
  id: GopayPaymentIdSchema,
  order_number: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  state: GopayPaymentStateSchema,
  sub_state: Schema.optionalKey(Schema.String),
  target: GopayPaymentTargetSchema,
});
export type GopayPayment = typeof GopayPaymentSchema.Type;

/** JSON text codec of a payment response body. */
export const GopayPaymentFromJsonSchema = Schema.fromJsonString(GopayPaymentSchema);

const contactText = (maximumLength: number) =>
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maximumLength));

/**
 * Body of `POST /payments/payment` for a one-time standard payment. The shape has no
 * `preauthorization`, `recurrence`, `order_description` or `items` field, so a direct-capture
 * standard payment is the only request it can express (#1154).
 */
export const GopayCreatePaymentRequestSchema = Schema.Struct({
  amount: PaymentPositiveAmountMinorSchema,
  callback: Schema.Struct({
    notification_url: GatewayHttpsUrlSchema,
    return_url: GatewayHttpsUrlSchema,
  }),
  currency: Schema.Literal('CZK'),
  lang: Schema.Literal('CS'),
  order_number: GatewayOrderReferenceSchema,
  payer: Schema.optionalKey(
    Schema.Struct({
      contact: Schema.Struct({
        email: Schema.optionalKey(contactText(254)),
        first_name: Schema.optionalKey(contactText(200)),
        last_name: Schema.optionalKey(contactText(200)),
        phone_number: Schema.optionalKey(contactText(40)),
      }),
    }),
  ),
  target: GopayPaymentTargetSchema,
});
export type GopayCreatePaymentRequest = typeof GopayCreatePaymentRequestSchema.Type;

/** JSON text codec of the create body (the client encodes with it to get the exact request bytes). */
export const GopayCreatePaymentRequestJsonSchema = Schema.fromJsonString(GopayCreatePaymentRequestSchema);

/** `result` of `POST /payments/payment/{id}/refund`. */
export const GOPAY_REFUND_RESULTS = ['ACCEPTED', 'FINISHED', 'FAILED'] as const;
export const GopayRefundResultSchema = Schema.Literals(GOPAY_REFUND_RESULTS);

/** Refund response `{id, result}`. `id` is the payment id: GoPay returns no refund identifier. */
export const GopayRefundResponseSchema = Schema.Struct({
  id: GopayPaymentIdSchema,
  result: GopayRefundResultSchema,
});
export type GopayRefundResponse = typeof GopayRefundResponseSchema.Type;
export const GopayRefundResponseFromJsonSchema = Schema.fromJsonString(GopayRefundResponseSchema);

/** Refund history `state` enum ("Refund state"). */
export const GOPAY_REFUND_STATES = ['SUCCESS', 'FAILED', 'REQUESTED'] as const;
export const GopayRefundStateSchema = Schema.Literals(GOPAY_REFUND_STATES);

/**
 * A refund history date as provider text. The documentation types it as a date (`2024-04-04`); an
 * instant with a UTC offset may also appear. It is deliberately not decoded to an instant here: a
 * day-only value has no zone, so gopay-evidence.ts places it relative to the dispatch explicitly.
 */
const GopayRefundDateTextSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64));

/** One entry of `GET /payments/payment/{id}/refunds`. Entries carry no refund identifier. */
export const GopayRefundHistoryEntrySchema = Schema.Struct({
  amount: PaymentAmountMinorSchema,
  currency: GopayCurrencyCodeSchema,
  date_last_change: Schema.optionalKey(GopayRefundDateTextSchema),
  date_requested: GopayRefundDateTextSchema,
  id: GopayPaymentIdSchema,
  state: GopayRefundStateSchema,
});
export type GopayRefundHistoryEntry = typeof GopayRefundHistoryEntrySchema.Type;

export const GopayRefundHistorySchema = Schema.Array(GopayRefundHistoryEntrySchema);
export type GopayRefundHistory = typeof GopayRefundHistorySchema.Type;
export const GopayRefundHistoryFromJsonSchema = Schema.fromJsonString(GopayRefundHistorySchema);

/** One error of a GoPay error body. `error_code` is documented as integer but shown as a string in examples. */
export const GopayErrorSchema = Schema.Struct({
  error_code: Schema.Union([Schema.Finite, Schema.String]),
  error_name: Schema.optionalKey(Schema.String),
  scope: Schema.optionalKey(Schema.String),
});

/**
 * Error body, e.g. `{"result":"FAILED","errors":[{"error_code":"PAYMENT_NOT_FOUND"}]}` for an archived
 * payment (doc "Payment data archivation"). Classification of an error body is the client's job; an
 * error body is never evidence that an effect did not happen.
 */
export const GopayErrorResponseSchema = Schema.Struct({
  errors: Schema.Array(GopayErrorSchema).check(Schema.isMinLength(1)),
});
export const GopayErrorResponseFromJsonSchema = Schema.fromJsonString(GopayErrorResponseSchema);

/** The OntOS provider object id of a GoPay payment id. */
export const gopayProviderObjectId = (paymentId: GopayPaymentId): ProviderObjectId =>
  ProviderObjectIdSchema.make(`${paymentId}`);

/** Strictly an unsigned base-10 integer without a leading zero, as GoPay ids are rendered. */
const GopayIdTextSchema = Schema.String.check(Schema.isPattern(/^[1-9][0-9]{0,15}$/u)).pipe(
  Schema.decodeTo(Schema.FiniteFromString.pipe(Schema.decodeTo(GopayIntegerIdSchema))),
);

/** Parses a GoPay id from text (notification `?id=`, a stored provider object id); anything else is None. */
export const parseGopayId = (text: string): Option.Option<number> =>
  Schema.decodeUnknownOption(GopayIdTextSchema)(text);

/** The GoID of a GOPAY merchant identity as GoPay renders it; None for another family or a non-canonical GoID. */
export const gopayGoidOf = (identity: GatewayMerchantIdentity): Option.Option<GopayGoid> =>
  Match.value(identity).pipe(
    Match.tag('GOPAY', ({ goid }) => parseGopayId(goid)),
    Match.orElse(() => Option.none()),
  );
