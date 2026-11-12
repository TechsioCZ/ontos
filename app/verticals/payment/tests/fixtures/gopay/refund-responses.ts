/**
 * GoPay Payments API v4 refund bodies, from https://api-docs.gopay.com/llms-full.txt ("Refunds": the documented
 * `POST /payments/{payment_id}/refunds` 201 response and the `GET /refunds/{refund_id}` response) and the OpenAPI
 * `Refund-Details` schema (https://api-docs.gopay.com/spec/en/payments.yaml). The documented refund id is
 * `"3050123456"`; amounts, states and instants are set by each test.
 */

export const GOPAY_FIXTURE_REFUND_ID = '3050123456';

/** `created` and `updated` are the raw `created_at` / `updated_at` texts (`updated: null` writes a JSON null). */
export interface GopayRefundFixture {
  readonly amount: number;
  readonly created?: string;
  readonly currency?: string;
  readonly id?: string;
  readonly state: string;
  readonly updated?: string | null;
}

const updatedField = (updated: string | null | undefined): string => {
  if (updated === undefined) {
    return '';
  }
  return updated === null ? ',\n  "updated_at": null' : `,\n  "updated_at": "${updated}"`;
};

/** One `Refund-Details` object. */
export const gopayRefundBody = (input: GopayRefundFixture): string => `{
  "id": "${input.id ?? GOPAY_FIXTURE_REFUND_ID}",
  "state": "${input.state}",
  "amount": ${input.amount},
  "currency": "${input.currency ?? 'CZK'}",
  "created_at": "${input.created ?? '2026-11-12T10:00:30Z'}"${updatedField(input.updated)}
}`;

/** `GET /payments/{payment_id}/refunds`: an array of `Refund-Details`. */
export const gopayRefundListBody = (refunds: readonly GopayRefundFixture[]): string =>
  `[${refunds.map(gopayRefundBody).join(',')}]`;
