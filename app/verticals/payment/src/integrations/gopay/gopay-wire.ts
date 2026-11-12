import { Match, Option, Schema } from 'effect';

import { PaymentAmountMinorSchema, PaymentPositiveAmountMinorSchema } from '../../../shared/domain/payment-money.ts';
import { GatewayHttpsUrlSchema } from '../../../shared/domain/psp-configuration.ts';
import type { GatewayMerchantIdentity } from '../../../shared/domain/psp-configuration.ts';
import { GatewayOrderReferenceSchema } from '../psp/psp-correlation.ts';
import { ProviderObjectIdSchema } from '../psp/psp-request.ts';
import type { ProviderObjectId } from '../psp/psp-request.ts';

/**
 * GoPay Payments API v4 wire shapes (https://api-docs.gopay.com/llms-full.txt and the OpenAPI document
 * https://api-docs.gopay.com/spec/en/payments.yaml: `Payment-Create-Request`, `Payment-Details`, `Customer`,
 * `Refund-Create-Request`, `Refund-Details`). Every response is decoded through these schemas; nothing is cast.
 * Unknown response fields are ignored on decode and never interpreted. `Payment-Details.payment_secret` ("Do not
 * embed in URLs, log or store!") is deliberately absent from the payment schema, so a decoded payment never holds
 * it; `customer` and `charge` are absent as well.
 */

/**
 * A v4 identifier as text (`Payment-Details.id`, `Refund-Details.id`: `type: string`, every documented example is
 * digits, e.g. `"300000001"`, `"3050123456"`). Only an unsigned base-10 integer without a leading zero is accepted
 * (fail closed: an id of another shape makes the response undecodable instead of guessed); it is placed into
 * request paths and into the ledger reference text, so no separator can ever reach either.
 */
const GopayIdSchema = ProviderObjectIdSchema.check(Schema.isPattern(/^[1-9][0-9]{0,19}$/u));

/** GoID of the eshop (`/eshops/{goid}/...`): an unsigned base-10 integer without a leading zero. */
const GOPAY_GOID_PATTERN = /^[1-9][0-9]{0,15}$/u;

/** An upper-case ISO 4217 code as GoPay reports it. Any currency decodes; Launch money is checked later. */
const GopayCurrencyCodeSchema = Schema.String.check(Schema.isPattern(/^[A-Z]{3}$/u));

/** v4 `Payment-State` enum. */
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
export type GopayPaymentState = typeof GopayPaymentStateSchema.Type;

/**
 * The kept part of `Payment-Details`, returned by `POST /eshops/{goid}/payments` (201, state CREATED) and by
 * `GET /payments/{payment_id}`. v4 carries no GoID: the payment is bound to OntOS by its `order_number`, which is
 * kept as provider text and compared with the operation's order reference after decoding, never trusted as one.
 */
export const GopayPaymentSchema = Schema.Struct({
  amount: PaymentAmountMinorSchema,
  currency: GopayCurrencyCodeSchema,
  gw_url: Schema.optionalKey(Schema.String),
  id: GopayIdSchema,
  order_number: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  state: GopayPaymentStateSchema,
});
export type GopayPayment = typeof GopayPaymentSchema.Type;

/** JSON text codec of a payment response body. */
export const GopayPaymentFromJsonSchema = Schema.fromJsonString(GopayPaymentSchema);

/** `Customer.email` (required, `maxLength: 128`); no other customer field is ever sent. */
export const GopayCustomerEmailSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128));

/**
 * Body of `POST /eshops/{goid}/payments`. The shape has no `order_description`, `additional_params`, customer name,
 * phone or address field, and v4 has no preauthorization or recurrence on this request, so a direct one-shot
 * payment with the payer's email is the only request it can express (#1154).
 */
export const GopayCreatePaymentRequestSchema = Schema.Struct({
  amount: PaymentPositiveAmountMinorSchema,
  callback: Schema.Struct({
    notification_url: GatewayHttpsUrlSchema,
    return_url: GatewayHttpsUrlSchema,
  }),
  currency: Schema.Literal('CZK'),
  customer: Schema.Struct({ email: GopayCustomerEmailSchema }),
  order_number: GatewayOrderReferenceSchema,
});
export type GopayCreatePaymentRequest = typeof GopayCreatePaymentRequestSchema.Type;

/** JSON text codec of the create body (the client encodes with it to get the exact request bytes). */
export const GopayCreatePaymentRequestJsonSchema = Schema.fromJsonString(GopayCreatePaymentRequestSchema);

/** `Refund-Create-Request` of `POST /payments/{payment_id}/refunds`. */
const GopayRefundCreateRequestSchema = Schema.Struct({ amount: PaymentPositiveAmountMinorSchema });
export const GopayRefundCreateRequestJsonSchema = Schema.fromJsonString(GopayRefundCreateRequestSchema);

/** v4 `Refund-State` enum. */
export const GOPAY_REFUND_STATES = ['REQUESTED', 'SUCCESS', 'FAILED'] as const;
export const GopayRefundStateSchema = Schema.Literals(GOPAY_REFUND_STATES);

/**
 * A refund instant as provider text (`created_at`, `updated_at`: `format: date-time`, e.g.
 * `2025-12-10T10:30:00Z`). It is not decoded to an instant here: gopay-evidence.ts accepts only a full instant with
 * an offset and treats anything else as uncertain.
 */
const GopayInstantTextSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64));

/**
 * `Refund-Details`, returned by `POST /payments/{payment_id}/refunds` (201), `GET /refunds/{refund_id}` and, as an
 * array, by `GET /payments/{payment_id}/refunds`. It names no payment: a refund is bound to its payment by the
 * request path that produced or listed it.
 */
export const GopayRefundSchema = Schema.Struct({
  amount: PaymentAmountMinorSchema,
  created_at: GopayInstantTextSchema,
  currency: GopayCurrencyCodeSchema,
  id: GopayIdSchema,
  state: GopayRefundStateSchema,
  /** `type: [string, 'null']`, null until the state first changes; absent and null are both None. */
  updated_at: Schema.OptionFromOptionalNullOr(GopayInstantTextSchema),
});
export type GopayRefund = typeof GopayRefundSchema.Type;
export const GopayRefundFromJsonSchema = Schema.fromJsonString(GopayRefundSchema);

export const GopayRefundListSchema = Schema.Array(GopayRefundSchema);
export type GopayRefundList = typeof GopayRefundListSchema.Type;
export const GopayRefundListFromJsonSchema = Schema.fromJsonString(GopayRefundListSchema);

/** Parses a GoPay id from text (notification `?id=`, a stored provider object id); anything else is None. */
export const parseGopayId = (text: string): Option.Option<ProviderObjectId> =>
  Schema.decodeUnknownOption(GopayIdSchema)(text);

/** The GoID of a GOPAY merchant identity; None for another family or a non-canonical GoID. */
export const gopayGoidOf = (identity: GatewayMerchantIdentity): Option.Option<string> =>
  Match.value(identity).pipe(
    Match.tag('GOPAY', ({ goid }) => (GOPAY_GOID_PATTERN.test(goid) ? Option.some(goid) : Option.none<string>())),
    Match.orElse(() => Option.none<string>()),
  );
