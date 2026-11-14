import { Effect, Schema } from 'effect';
import { HttpApiClient } from 'effect/http-api';
import { EmailDeliveryReceiptsQuerySchema, EmailReceiptsApi } from './receipt-api.ts';
import type { EmailDeliveryReceiptsQuery } from './receipt-api.ts';

const receiptClient = HttpApiClient.make(EmailReceiptsApi, { baseUrl: '/shell-super-app-api' });

/** Schema-derived Shell client. Interruption cancels the request; it never submits or retries an e-mail. */
export const listEmailDeliveries = Effect.fn('EmailReceipts.list')(function* listEmailDeliveries(
  query: EmailDeliveryReceiptsQuery,
) {
  const decoded = yield* Schema.decodeEffect(EmailDeliveryReceiptsQuerySchema)(query);
  const client = yield* receiptClient;
  return yield* client.emailReceipts.list({ query: decoded });
});

/** Public provider status uses the same uncached Shell transport and retains its typed failure. */
export const getEmailProvider = Effect.fn('EmailReceipts.provider')(function* getEmailProvider() {
  const client = yield* receiptClient;
  return yield* client.emailReceipts.provider({});
});
