/**
 * GoPay refund response bodies, taken from the GoPay REST API documentation:
 * - refund response: https://doc.gopay.com/#payment-refund ("Refund request")
 * - refund history: https://doc.gopay.com/#history-of-refunds
 *
 * The documented history example is malformed JSON (two objects with a stray trailing comma and no
 * enclosing array); `gopayDocumentedRefundHistoryBody` is that example repaired into the array the
 * endpoint returns, with the documented day-only dates. `gopayTimestampedRefundHistoryBody` keeps the
 * same entry shape with full instants, to exercise `date_requested >= dispatchedAt` binding.
 */

/** https://doc.gopay.com/#payment-refund, response of the documented refund request. */
export const gopayRefundResponseBody = (result: string): string => `{
  "id": 3123456789,
  "result": "${result}"
}`;

/** https://doc.gopay.com/#history-of-refunds, the documented example repaired into a JSON array. */
export const gopayDocumentedRefundHistoryBody = `[
  {
    "id": 3123456789,
    "state": "FAILED",
    "amount": 50000,
    "currency": "CZK",
    "date_requested": "2024-04-04"
  },
  {
    "id": 3123456789,
    "state": "SUCCESS",
    "amount": 20000,
    "currency": "CZK",
    "date_requested": "2024-04-05",
    "date_last_change": "2024-04-05"
  }
]`;

export interface GopayRefundHistoryFixtureEntry {
  readonly amount: number;
  readonly dateRequested: string;
  readonly state: string;
}

/** The documented entry shape with full instants (`date_requested` with a UTC offset). */
export const gopayTimestampedRefundHistoryBody = (entries: readonly GopayRefundHistoryFixtureEntry[]): string =>
  `[${entries
    .map(
      (entry) => `{
    "id": 3123456789,
    "state": "${entry.state}",
    "amount": ${entry.amount},
    "currency": "CZK",
    "date_requested": "${entry.dateRequested}",
    "date_last_change": "${entry.dateRequested}"
  }`,
    )
    .join(',')}]`;
