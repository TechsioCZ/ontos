// @effect-diagnostics *:off
import { Effect, Redacted } from 'effect';
import type { EmailDeliveryServiceContract } from './server.ts';
import {
  EmailDeliveryAcceptanceIndeterminate,
  EmailDeliveryInvalidMessage,
  EmailDeliveryUnavailable,
} from './server.ts';

/** Cloudflare Email Service's Workers send_email binding (not the email-routing forward API). */
export interface CloudflareEmailBinding {
  readonly send: (message: {
    readonly from: string;
    readonly to: string;
    readonly subject: string;
    readonly text: string;
    readonly html?: string;
  }) => Promise<{ readonly messageId: string }>;
}

/** One submission, no automatic retry. A thrown binding error cannot prove non-acceptance. */
export const makeCloudflareEmailDelivery = (
  binding: CloudflareEmailBinding | undefined,
  from: string,
): EmailDeliveryServiceContract => ({
  send: (message) =>
    Effect.gen(function* () {
      if (binding === undefined || from.trim() === '' || /[\r\n\x00]/u.test(from)) {
        return yield* Effect.fail(new EmailDeliveryUnavailable({ reason: 'configuration' }));
      }
      if (!/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/u.test(message.to)) {
        return yield* Effect.fail(new EmailDeliveryInvalidMessage({ field: 'to', reason: 'invalid_format' }));
      }
      if (message.subject.length === 0 || /[\r\n\x00]/u.test(message.subject)) {
        return yield* Effect.fail(new EmailDeliveryInvalidMessage({ field: 'subject', reason: 'control_character' }));
      }
      const receipt = yield* Effect.tryPromise({
        try: () =>
          binding.send({
            from,
            to: message.to,
            subject: message.subject,
            text: Redacted.value(message.text),
            ...(message.html === undefined ? {} : { html: Redacted.value(message.html) }),
          }),
        // Do not log binding errors: they may contain message content or addresses.
        catch: () => new EmailDeliveryAcceptanceIndeterminate({ reason: 'transport' }),
      });
      if (typeof receipt?.messageId !== 'string' || receipt.messageId.trim() === '') {
        return yield* Effect.fail(new EmailDeliveryAcceptanceIndeterminate({ reason: 'response_invalid' }));
      }
      return { accepted: true as const, id: receipt.messageId };
    }),
});
