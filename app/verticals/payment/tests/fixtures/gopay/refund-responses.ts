/**
 * GoPay refund bodies captured from the real REST API v3 sandbox on 2026-11-13 (C17 L4 run 2): adapter requests
 * recorded by a passive fetch recorder, receipts `gopay-hosted-offline-http.jsonl` (bank transfer, partial refund)
 * and `gopay-card-full-http.jsonl` (card, full refund). The bodies are verbatim.
 *
 * Two facts differ from the documentation example (https://doc.gopay.com/#history-of-refunds), and both decide
 * how a refund can be proven:
 * - every history row carries its own id, not the payment id (row 4493293835 under payment 3311079577);
 * - `date_requested` and `date_last_change` are days (`"2026-11-13"`), never instants.
 * The refund response `{id, result}` does carry the payment id and nothing that names the refund.
 */

/** Bank-transfer payment of the captured partial refund (`amount=4000` of 10000 CZK minor units). */
export const GOPAY_BANK_REFUND_PAYMENT_ID = '3311079577';
export const GOPAY_BANK_REFUND_ROW_ID = '4493293835';

/** `POST /payments/payment/3311079577/refund` with `amount=4000`, HTTP 200. */
export const gopayBankPartialRefundResponseBody = '{"id":3311079577,"result":"FINISHED"}';

/** `GET /payments/payment/3311079577/refunds` after that refund, HTTP 200. */
export const gopayBankPartialRefundHistoryBody =
  '[{"id":4493293835,"state":"SUCCESS","amount":4000,"currency":"CZK","date_requested":"2026-11-13","date_last_change":"2026-11-13"}]';

/**
 * Card payment 3311079655 of the captured full refund (`amount=10000`); its refund response had the same shape as the
 * bank one (`{"id":3311079655,"result":"FINISHED"}`).
 */
export const GOPAY_CARD_REFUND_ROW_ID = '4493293846';

/** `GET /payments/payment/3311079655/refunds` after that refund, HTTP 200. */
export const gopayCardFullRefundHistoryBody =
  '[{"id":4493293846,"state":"SUCCESS","amount":10000,"currency":"CZK","date_requested":"2026-11-13","date_last_change":"2026-11-13"}]';

/**
 * A refund response of the captured shape for another documented `result` (ACCEPTED, FINISHED, FAILED) or another
 * payment id.
 */
export const gopayRefundResponseBody = (paymentId: string, result: string): string =>
  `{"id":${paymentId},"result":"${result}"}`;

export interface GopayRefundHistoryRow {
  readonly amount: number;
  readonly currency?: string;
  readonly id: string;
  readonly state: string;
}

/**
 * A refund history of the captured row shape (own row id, date-only dates of the capture day) for scenarios the
 * sandbox run did not produce: earlier rows, several new rows, a FAILED or REQUESTED row, another amount.
 */
export const gopayRefundHistoryBody = (rows: readonly GopayRefundHistoryRow[]): string =>
  `[${rows
    .map(
      (row) =>
        `{"id":${row.id},"state":"${row.state}","amount":${row.amount},"currency":"${row.currency ?? 'CZK'}","date_requested":"2026-11-13","date_last_change":"2026-11-13"}`,
    )
    .join(',')}]`;

/**
 * The history before a payment's first refund. Captured from the real GoPay sandbox on 2026-11-13: HTTP 200 with body
 * `[]` for PAID payments 3311081865 (card) and 3311081930 (bank transfer) that had no refunds, read by the adapter
 * before the refund was dispatched.
 */
export const gopayEmptyRefundHistoryBody = '[]';
