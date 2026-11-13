/**
 * GoPay payment response bodies, taken from the GoPay REST API documentation:
 * - create response: https://doc.gopay.com/#standard-payment-creation ("Minimal payment creation")
 * - inquiry response: https://doc.gopay.com/#payment-inquiry
 * - archived payment error: https://doc.gopay.com/#payment-data-archivation
 *
 * Substitutions: the documentation placeholder `{{YOUR-GOID}}` is the documentation's example GoID
 * 8123456789; `order_number` "123456" is replaced by an OntOS order reference where a test needs one
 * (`withOrderNumber`); `state`/`amount` variants are produced by the tests from the documented body.
 * Raw text is kept so the tests decode it through the same JSON codecs as the client.
 */

export const GOPAY_FIXTURE_GOID = '8123456789';
export const GOPAY_FIXTURE_PAYMENT_ID = '3123456789';

/** https://doc.gopay.com/#standard-payment-creation, response of "Minimal payment creation". */
export const gopayCreateResponseBody = (orderNumber: string): string => `{
  "id": 3123456789,
  "order_number": "${orderNumber}",
  "state": "CREATED",
  "amount": 10000,
  "currency": "CZK",
  "payer": {
    "contact": {
      "email": "john.doe@example.com"
    }
  },
  "target": {
    "type": "ACCOUNT",
    "goid": 8123456789
  },
  "gw_url": "https://gw.sandbox.gopay.com/gw/v3/..."
}`;

/** https://doc.gopay.com/#payment-inquiry, the documented PAID inquiry response. */
export const gopayInquiryResponseBody = (input: {
  readonly amount: number;
  readonly goid: string;
  readonly orderNumber: string;
  readonly state: string;
}): string => `{
  "id": 3123456789,
  "order_number": "${input.orderNumber}",
  "state": "${input.state}",
  "payment_instrument": "PAYMENT_CARD",
  "amount": ${input.amount},
  "currency": "CZK",
  "payer": {
    "payment_card": {
      "card_number": "440507******4448",
      "card_expiration": "9912",
      "card_brand": "Visa",
      "card_issuer_country": "CZE",
      "card_issuer_bank": "CESKA SPORITELNA, A.S (CZECH SAVINGS BANK)",
      "card_fingerprint": "0c823534ec582c97fa85c0bf7b020ee25a0a5af13974709bb329a709a79c2b3e"
    },
    "contact": {
      "email": "john.doe@example.com"
    }
  },
  "target": {
    "type": "ACCOUNT",
    "goid": ${input.goid}
  },
  "lang": "en",
  "gw_url": "https://gw.sandbox.gopay.com/gw/v3/..."
}`;

/**
 * Real v3 sandbox shapes (C17 L4 run 2, 2026-11-13, receipts `gopay-basic-http.jsonl` and
 * `gopay-hosted-offline-http.jsonl`), with the binding GoID and order reference substituted like the documented
 * bodies above. They differ from the documentation: a minimal create answers `payer: {}` and `lang: "cs"`, the
 * hosted page lives under `/gw-ui/rest/v3/` (the receipt redacts its 32-character token; a zero placeholder of the
 * same shape stands in), and a bank-transfer inquiry names `BANK_ACCOUNT`, `payer.bank_account` and a `sub_state`
 * instead of a payment card.
 */
export const GOPAY_SANDBOX_GW_URL = 'https://gw.sandbox.gopay.com/gw-ui/rest/v3/00000000000000000000000000000000';

/** `POST /payments/payment` without payer contact, HTTP 200 (captured payment 3311079330). */
export const gopayMinimalCreateResponseBody = (input: {
  readonly goid: string;
  readonly orderNumber: string;
}): string =>
  `{"id":3311079330,"order_number":"${input.orderNumber}","state":"CREATED","amount":10000,"currency":"CZK","payer":{},"target":{"type":"ACCOUNT","goid":${input.goid}},"lang":"cs","gw_url":"${GOPAY_SANDBOX_GW_URL}"}`;

/** `GET /payments/payment/3311079577` of the offline bank transfer once paid (captured state PAID, sub_state _3001). */
export const gopayBankTransferInquiryResponseBody = (input: {
  readonly goid: string;
  readonly orderNumber: string;
  readonly state: string;
}): string =>
  `{"id":3311079577,"order_number":"${input.orderNumber}","state":"${input.state}","sub_state":"_3001","payment_instrument":"BANK_ACCOUNT","amount":10000,"currency":"CZK","payer":{"bank_account":{"account_number":"7654322","bank_code":"0100"},"contact":{"email":"c17-sandbox@example.test","country_code":"CZE"}},"target":{"type":"ACCOUNT","goid":${input.goid}},"lang":"cs","gw_url":"${GOPAY_SANDBOX_GW_URL}"}`;

/** https://doc.gopay.com/#payment-data-archivation, the error body of an archived (not found) payment. */
export const gopayPaymentNotFoundBody = '{"result": "FAILED", "errors": [{"error_code": "PAYMENT_NOT_FOUND"}]}';
