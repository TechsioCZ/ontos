import type { SendEmail } from '@cloudflare/workers-types';
import { Effect, Layer, Predicate, Redacted, Schema } from 'effect';

import type { EmailDeliveryMessage } from './server.ts';
import {
  EmailDeliveryAcceptanceIndeterminate,
  EmailDeliveryInvalidMessage,
  EmailDeliveryService,
  EmailDeliveryUnavailable,
} from './server.ts';

/** Foreign Workers send_email binding. Its SDK contract requires a Promise. */
export type CloudflareEmailBinding = Pick<SendEmail, 'send'>;

export const CloudflareEmailBindingSchema = Schema.Struct({
  send: Schema.declare<CloudflareEmailBinding['send']>((value): value is CloudflareEmailBinding['send'] =>
    Predicate.isFunction(value),
  ),
});
const CloudflareMessageIdSchema = Schema.String.check(Schema.isPattern(/\S/u)).pipe(
  Schema.brand('CloudflareEmailMessageId'),
);
const ReceiptSchema = Schema.Struct({ messageId: CloudflareMessageIdSchema });
const hasHeaderControl = (value: string) => value.includes('\r') || value.includes('\n') || value.includes('\0');

/** One submission. A timeout or binding failure cannot establish non-acceptance and is never retried here. */
export const CloudflareEmailDeliveryLive = (binding: CloudflareEmailBinding | undefined, from: string) =>
  Layer.succeed(EmailDeliveryService, {
    send: Effect.fn('CloudflareEmail.send')(function* sendMessage(message: EmailDeliveryMessage) {
      if (binding === undefined || from.trim() === '' || hasHeaderControl(from)) {
        return yield* new EmailDeliveryUnavailable({ reason: 'configuration' });
      }
      if (!/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/u.test(message.to)) {
        return yield* new EmailDeliveryInvalidMessage({ field: 'to', reason: 'invalid_format' });
      }
      if (message.subject.length === 0 || hasHeaderControl(message.subject)) {
        return yield* new EmailDeliveryInvalidMessage({ field: 'subject', reason: 'control_character' });
      }
      const envelope = { from, subject: message.subject, text: Redacted.value(message.text), to: message.to };
      const submission = message.html === undefined ? envelope : { ...envelope, html: Redacted.value(message.html) };
      const receipt = yield* Effect.tryPromise({
        // A redacted private cause preserves diagnostics without exposing message content or recipients.
        catch: (cause) =>
          Object.defineProperty(new EmailDeliveryAcceptanceIndeterminate({ reason: 'transport' }), 'cause', {
            value: Redacted.make(cause),
          }),
        try: binding.send.bind(binding, submission),
      }).pipe(
        Effect.timeoutOrElse({
          duration: '10 seconds',
          orElse: () => Effect.fail(new EmailDeliveryAcceptanceIndeterminate({ reason: 'timeout' })),
        }),
      );
      const decoded = yield* Schema.decodeEffect(ReceiptSchema)(receipt).pipe(
        Effect.mapError((cause) =>
          Object.defineProperty(new EmailDeliveryAcceptanceIndeterminate({ reason: 'response_invalid' }), 'cause', {
            value: Redacted.make(cause),
          }),
        ),
      );
      return { accepted: true as const, id: decoded.messageId };
    }),
  });
