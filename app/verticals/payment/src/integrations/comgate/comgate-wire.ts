import { Option, Schema, SchemaTransformation } from 'effect';

import { GatewayHttpsUrlSchema } from '../../../shared/domain/psp-configuration.ts';
import { GatewayOrderReferenceSchema } from '../psp/psp-correlation.ts';
import { ProviderObjectIdSchema } from '../psp/psp-request.ts';

/**
 * Comgate REST v2 wire shapes (#1154, #1156, #1157). Sources, read 2026-11-12:
 * - create, status, cancel, refund, transferList, singleTransfer: https://apidoc.comgate.cz/en/api/rest/
 * - status vocabulary: https://apidoc.comgate.cz/en/stavy-plateb
 * - push notification: https://apidoc.comgate.cz/en/push-notifikace
 *
 * Every response is decoded through these schemas; nothing is cast. Unknown response fields
 * (payerName, fee, cardNumber, ...) are ignored on decode and never interpreted. Fields are kept as
 * provider text where Comgate types them as strings (`price`, `test`, `refId`) and interpreted only in
 * comgate-evidence.ts / comgate-push.ts after decoding.
 */

export const COMGATE_BASE_URL = 'https://payments.comgate.cz';

/** Adapter-owned endpoint references (`PreparedProviderRequest.endpointRef`). `{transId}` is filled at send time. */
export const COMGATE_ENDPOINTS = {
  cancel: 'comgate:DELETE:/v2.0/payment/transId/{transId}.json',
  create: 'comgate:POST:/v2.0/payment.json',
  refund: 'comgate:POST:/v2.0/refund.json',
  singleTransfer: 'comgate:GET:/v2.0/singleTransfer/transferId/{transferId}.json',
  status: 'comgate:GET:/v2.0/payment/transId/{transId}.json',
  transferList: 'comgate:GET:/v2.0/transferList/date/{date}.json',
} as const;

/** The only success code. Every other value, documented or not, is never success (donor gap C-5). */
export const COMGATE_SUCCESS_CODE = 0;

/** Cancel: "the payment cannot be changed to CANCELLED status (payment not found, not PENDING, unauthorized)". */
export const COMGATE_CANCEL_NOT_CHANGEABLE_CODE = 1400;

/**
 * Refund codes that prove no refund was made: 1401 (refunded payment is in CANCELLED status) and 1402
 * (refund amount higher than allowed) are documented refusals. 1400 is documented only as "bad request";
 * reading it as "no refund was created" is OntOS's interpretation of a validation rejection (UNVERIFIED,
 * https://apidoc.comgate.cz/en/api/rest/ refund response codes).
 */
export const COMGATE_REFUND_REFUSED_CODES: readonly number[] = [1400, 1401, 1402];

const ComgateCodeSchema = Schema.Finite.check(Schema.isInt());
const ComgateMessageSchema = Schema.String.check(Schema.isMaxLength(2000));

/** An upper-case ISO 4217 code as Comgate reports it. Any currency decodes; Launch money is checked later. */
const ComgateCurrencyCodeSchema = Schema.String.check(Schema.isPattern(/^[A-Z]{3}$/u));

/**
 * Comgate `transId` (e.g. `AB12-CD34-EF56`), opaque printable ASCII. Bounded to 64 characters so every
 * source occurrence id built from it stays inside the 200-character evidence identity.
 */
export const ComgateTransIdSchema = ProviderObjectIdSchema.check(Schema.isMaxLength(64));

/** Comgate status vocabulary ("Payment states"). PAID and CANCELLED are terminal. */
export const COMGATE_PAYMENT_STATUSES = ['PENDING', 'PAID', 'CANCELLED', 'AUTHORIZED'] as const;
export const ComgatePaymentStatusSchema = Schema.Literals(COMGATE_PAYMENT_STATUSES);
export type ComgatePaymentStatus = typeof ComgatePaymentStatusSchema.Type;

/**
 * Comgate `test` flag. The create and refund requests type it as a JSON boolean; the status response
 * and the push type it as the string `"true"` / `"false"` (both documented examples show `"false"`).
 * VERIFIED string form for status and push; the boolean form is accepted on decode too because the
 * REST schema is inconsistent across endpoints (UNVERIFIED which form a live v2 status returns).
 * Any other value fails decoding (never defaults to production).
 */
export const ComgateTestFlagSchema = Schema.Union([
  Schema.Boolean,
  Schema.Literals(['true', 'false']).pipe(
    Schema.decodeTo(
      Schema.Boolean,
      SchemaTransformation.transform({
        decode: (value) => value === 'true',
        encode: (value) => (value ? 'true' : 'false'),
      }),
    ),
  ),
]);

/**
 * Comgate merchant identifier. Documented as a string in the push (`"merchant": "123456"`); the
 * `/config` example shows a bare number, so an exact non-negative integer is accepted and compared as
 * its decimal text.
 */
export const ComgateMerchantSchema = Schema.Union([
  Schema.String.check(Schema.isPattern(/^[0-9]{1,20}$/u)),
  Schema.Finite.check(Schema.isInt(), Schema.isBetween({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 })).pipe(
    Schema.decodeTo(
      Schema.String,
      SchemaTransformation.transform({
        decode: (value) => `${value}`,
        encode: Number,
      }),
    ),
  ),
]);

/**
 * Comgate `refId` as Comgate echoes it. Kept as provider text and compared with the OntOS order
 * reference after decoding, never trusted as one.
 */
export const ComgateRefIdSchema = Schema.String.check(Schema.isMaxLength(200)).pipe(Schema.brand('ComgateRefId'));
export type ComgateRefId = typeof ComgateRefIdSchema.Type;

const contactText = (maximumLength: number) =>
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maximumLength));

/**
 * Body of `POST /v2.0/payment.json` for a one-time direct-capture payment. The shape has no
 * `preauth`, `initRecurring` or `verification` field, so it can express nothing else (#1154). `price`
 * is bounded to the Comgate CZK limits (1 CZK .. 1 000 000 CZK). Comgate requires `email` or `phone`.
 */
export const ComgateCreatePaymentRequestSchema = Schema.Struct({
  curr: Schema.Literal('CZK'),
  email: Schema.optionalKey(contactText(254)),
  fullName: contactText(200),
  label: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16)),
  method: Schema.Literal('ALL'),
  phone: Schema.optionalKey(contactText(40)),
  price: Schema.Finite.check(Schema.isInt(), Schema.isBetween({ maximum: 100_000_000, minimum: 100 })),
  refId: GatewayOrderReferenceSchema,
  test: Schema.Boolean,
  url_cancelled: Schema.optionalKey(GatewayHttpsUrlSchema),
  url_paid: Schema.optionalKey(GatewayHttpsUrlSchema),
  url_pending: Schema.optionalKey(GatewayHttpsUrlSchema),
});
export type ComgateCreatePaymentRequest = typeof ComgateCreatePaymentRequestSchema.Type;
export const ComgateCreatePaymentRequestJsonSchema = Schema.fromJsonString(ComgateCreatePaymentRequestSchema);

/**
 * Create response. `transId` and `redirect` are present only for `code: 0`; their absence on code 0
 * is interpreted in comgate-evidence.ts (an unclassifiable mutation response, never success).
 */
export const ComgateCreatePaymentResponseSchema = Schema.Struct({
  code: ComgateCodeSchema,
  message: ComgateMessageSchema,
  redirect: Schema.optionalKey(Schema.String),
  transId: Schema.optionalKey(ComgateTransIdSchema),
});
export const ComgateCreatePaymentResponseFromJsonSchema = Schema.fromJsonString(ComgateCreatePaymentResponseSchema);

/** `{code, message}` of cancel (`DELETE /v2.0/payment/transId/{id}.json`) and refund (`POST /v2.0/refund.json`). */
export const ComgateResultResponseSchema = Schema.Struct({
  code: ComgateCodeSchema,
  message: ComgateMessageSchema,
});
export const ComgateResultResponseFromJsonSchema = Schema.fromJsonString(ComgateResultResponseSchema);

/** Body of `POST /v2.0/refund.json`. `amount` is integer minor units; no refund id exists. */
export const ComgateRefundRequestSchema = Schema.Struct({
  amount: Schema.Finite.check(Schema.isInt(), Schema.isBetween({ maximum: 100_000_000, minimum: 1 })),
  refId: GatewayOrderReferenceSchema,
  test: Schema.Boolean,
  transId: ComgateTransIdSchema,
});
export type ComgateRefundRequest = typeof ComgateRefundRequestSchema.Type;
export const ComgateRefundRequestJsonSchema = Schema.fromJsonString(ComgateRefundRequestSchema);

/**
 * A `code: 0` status response. `price` is a string ("10000") parsed exactly later; `merchant` is not
 * documented on the v2 status response and is checked only when present. `status` is kept as text so
 * an undocumented value is an INDETERMINATE finding rather than a decode failure.
 */
export const ComgateStatusFoundSchema = Schema.Struct({
  code: Schema.Literal(COMGATE_SUCCESS_CODE),
  curr: ComgateCurrencyCodeSchema,
  merchant: Schema.optionalKey(ComgateMerchantSchema),
  message: ComgateMessageSchema,
  price: Schema.String.check(Schema.isMaxLength(32)),
  refId: ComgateRefIdSchema,
  status: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  test: ComgateTestFlagSchema,
  transId: ComgateTransIdSchema,
});

export type ComgateStatusFound = typeof ComgateStatusFoundSchema.Type;
const ComgateStatusFoundFromJsonSchema = Schema.fromJsonString(ComgateStatusFoundSchema);

/** Any status response that is not a complete `code: 0` answer (not found, unauthorized, error). */
const ComgateStatusErrorFromJsonSchema = Schema.fromJsonString(ComgateResultResponseSchema);

/**
 * A classified status response of `GET /v2.0/payment/transId/{id}.json`:
 * - FOUND: a complete `code: 0` answer;
 * - PROVIDER_ERROR: `{code ≠ 0, message}` (not found, unauthorized, provider error);
 * - INVALID: not JSON, or a `code: 0` body missing a required field. Never read as absence.
 */
export const ComgateStatusAnswerSchema = Schema.Union([
  Schema.TaggedStruct('FOUND', { status: ComgateStatusFoundSchema }),
  Schema.TaggedStruct('PROVIDER_ERROR', { code: ComgateCodeSchema }),
  Schema.TaggedStruct('INVALID', {}),
]);
export type ComgateStatusAnswer = typeof ComgateStatusAnswerSchema.Type;

export const decodeComgateStatusBody = (bodyText: string): ComgateStatusAnswer => {
  const found = Schema.decodeUnknownOption(ComgateStatusFoundFromJsonSchema)(bodyText);
  if (Option.isSome(found)) {
    return { _tag: 'FOUND', status: found.value };
  }
  const failure = Schema.decodeUnknownOption(ComgateStatusErrorFromJsonSchema)(bodyText);
  if (Option.isSome(failure) && failure.value.code !== COMGATE_SUCCESS_CODE) {
    return { _tag: 'PROVIDER_ERROR', code: failure.value.code };
  }
  return { _tag: 'INVALID' };
};

/**
 * Push body fields OntOS reads (JSON for REST v2 payments, urlencoded for v1). All are documented as
 * required strings; `secret` is the shared shop secret in plain text and never leaves comgate-push.ts.
 */
export const ComgatePushSchema = Schema.Struct({
  curr: ComgateCurrencyCodeSchema,
  merchant: ComgateMerchantSchema,
  price: Schema.String.check(Schema.isMaxLength(32)),
  refId: ComgateRefIdSchema,
  secret: Schema.RedactedFromValue(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200))),
  status: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  test: ComgateTestFlagSchema,
  transId: ComgateTransIdSchema,
});
export type ComgatePush = typeof ComgatePushSchema.Type;

/* ------------------------------------------------------------------------------------------------ */
/* Settlement statements (production only)                                                           */
/* ------------------------------------------------------------------------------------------------ */

/**
 * Bounds of one statement read. A larger answer is never truncated: it fails decoding, so a lookup
 * proves nothing instead of reading a partial statement.
 */
export const COMGATE_STATEMENT_LIMITS = { rowsPerTransfer: 10_000, transfersPerDate: 50 } as const;

/** A transfer id from `transferList` (documented as an integer, e.g. `1234567`). */
export const ComgateTransferIdSchema = Schema.Finite.check(
  Schema.isInt(),
  Schema.isBetween({ maximum: Number.MAX_SAFE_INTEGER, minimum: 1 }),
);
export type ComgateTransferId = typeof ComgateTransferIdSchema.Type;

/**
 * `GET /v2.0/transferList/date/{date}.json`: the transfers made on one Europe/Prague date. Only
 * `transferId` is read; `transferDate`, the accounts and the variable symbol are ignored.
 */
export const ComgateTransferListFromJsonSchema = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ transferId: ComgateTransferIdSchema })).check(
    Schema.isMaxLength(COMGATE_STATEMENT_LIMITS.transfersPerDate),
  ),
);

/**
 * `GET /v2.0/singleTransfer/transferId/{id}.json`: the rows of one transfer, kept as JSON objects so an
 * unrelated row (another payment, a field this mapping does not read) never breaks the decode. Each
 * candidate row is decoded strictly with `ComgateStatementRowSchema`.
 */
export const ComgateSingleTransferFromJsonSchema = Schema.fromJsonString(
  Schema.Array(Schema.Record(Schema.String, Schema.Json)).check(
    Schema.isMaxLength(COMGATE_STATEMENT_LIMITS.rowsPerTransfer),
  ),
);
/** One row of a transfer before selection: a JSON object, not yet trusted. */
export type ComgateStatementRawRow = (typeof ComgateSingleTransferFromJsonSchema.Type)[number];

/** The two fields that select a statement row for one refund: the shop (`Merchant`) and `ID od klienta` (refId). */
export const ComgateStatementRowKeySchema = Schema.Struct({
  'ID od klienta': Schema.String.check(Schema.isMaxLength(200)),
  Merchant: ComgateMerchantSchema,
});

/**
 * A statement amount as Comgate prints it: decimal comma, exactly two decimals, optional leading minus
 * (`"-422,00"`, `"10,00"`). Parsed into integer minor units in comgate-money.ts; never a float.
 */
export const ComgateStatementAmountTextSchema = Schema.String.check(
  Schema.isPattern(/^-?(?:0|[1-9][0-9]{0,12}),[0-9]{2}$/u),
);

/**
 * `Datum založení` as Comgate prints it: Europe/Prague wall-clock text `YYYY-MM-DD HH:mm:ss`, kept as
 * provider text here and decoded into calendar fields by `parseComgatePragueWallClock`.
 */
export const ComgateStatementLocalTimeSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32));

/**
 * The fields of a selected statement row OntOS reads (Czech names as documented for singleTransfer).
 * `Datum založení` of a refund row is the time the refund was entered (official monthly sample, rows
 * "Refundace ze dne ..."); `Potvrzená částka` of a refund row is negative.
 */
export const ComgateStatementRowSchema = Schema.Struct({
  'Datum založení': ComgateStatementLocalTimeSchema,
  'ID od klienta': ComgateRefIdSchema,
  Měna: ComgateCurrencyCodeSchema,
  Merchant: ComgateMerchantSchema,
  'Potvrzená částka': ComgateStatementAmountTextSchema,
});
