/**
 * GoPay Payments API v4 payment bodies, built from the OpenAPI document https://api-docs.gopay.com/spec/en/payments.yaml
 * (`Payment-Details`, `Customer`, `Error-Response-Body`, with their documented `examples`) and the guides in
 * https://api-docs.gopay.com/llms-full.txt ("Creating a payment", "Payment states", "Errors").
 *
 * Substitutions: `order_number` is the OntOS order reference of the test's collection (the documented example is
 * `"2025010199"`); `state`, `amount` and `currency` are set by each test from the documented enums; `gw_url` is the
 * documented example address on the sandbox host. `payment_secret` is the documented example value
 * (`ps_4d2f9a51b7e30c68a1c5e9f03b7d2e46`, not a credential): it is present so tests prove the adapter never keeps it.
 * Raw text is kept so the tests decode it through the same JSON codecs as the client.
 */

/** The eshop GoID of the test binding (synthetic). */
export const GOPAY_FIXTURE_GOID = '8123456789';
/** `Payment-Details.id` example of the OpenAPI document. */
export const GOPAY_FIXTURE_PAYMENT_ID = '300000001';
/** `Payment-Details.gw_url` example path on the sandbox host. */
export const GOPAY_FIXTURE_GATEWAY_URL = 'https://gw.sandbox.gopay.com/gw/123456789';
/** `Payment-Details.payment_secret` example of the OpenAPI document; never a real secret. */
export const GOPAY_FIXTURE_PAYMENT_SECRET = 'ps_4d2f9a51b7e30c68a1c5e9f03b7d2e46';

export interface GopayPaymentFixture {
  readonly amount?: number;
  readonly currency?: string;
  readonly id?: string;
  readonly orderNumber: string;
  readonly state: string;
}

/** A `Payment-Details` body (201 of `POST /eshops/{goid}/payments`, 200 of `GET /payments/{payment_id}`). */
export const gopayPaymentBody = (input: GopayPaymentFixture): string => `{
  "id": "${input.id ?? GOPAY_FIXTURE_PAYMENT_ID}",
  "order_number": "${input.orderNumber}",
  "state": "${input.state}",
  "amount": ${input.amount ?? 10_000},
  "currency": "${input.currency ?? 'CZK'}",
  "customer": {
    "email": "john.doe@example.com"
  },
  "gw_url": "${GOPAY_FIXTURE_GATEWAY_URL}",
  "payment_secret": "${GOPAY_FIXTURE_PAYMENT_SECRET}"
}`;

/** The 201 `Payment-Details` of a new payment (state `CREATED`). */
export const gopayCreateResponseBody = (orderNumber: string, amount = 10_000): string =>
  gopayPaymentBody({ amount, orderNumber, state: 'CREATED' });

/** `Error-Response-Body` of a 404 (llms-full.txt "Errors" > `404 Not Found`: a `payment_id` never issued). */
export const gopayNotFoundBody = `{
  "code": 404,
  "error": "NOT_FOUND",
  "message": "Payment not found",
  "detail": "The payment does not exist",
  "path": "/payments/${GOPAY_FIXTURE_PAYMENT_ID}",
  "timestamp": "2025-12-10T10:30:00Z"
}`;

/** `Error-Response-Body` of a 409 (llms-full.txt "Errors" > `409 Conflict`: DELETE or refund in a wrong state). */
export const gopayConflictBody = `{
  "code": 409,
  "error": "CONFLICT",
  "message": "Operation not allowed in the current payment state",
  "detail": "The payment is not in the required state",
  "path": "/payments/${GOPAY_FIXTURE_PAYMENT_ID}",
  "timestamp": "2025-12-10T10:30:00Z"
}`;
