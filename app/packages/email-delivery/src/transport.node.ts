import { Effect, Option } from 'effect';
import type { Config } from 'effect';

import { isTestRecipient, testCaptureConfiguration } from './dispatcher/recipients.ts';
import { SmtpEmailDeliveryLive, smtpConfiguration } from './smtp.ts';
import { configuredProvider, emailSettings } from './transport-runtime.ts';
import type { EmailEnvironment, EmailTransportRuntime } from './transport-runtime.ts';

export const emailEnvironment: Effect.Effect<EmailEnvironment, Effect.Error<typeof emailSettings>> = emailSettings;

export const emailTransport = Effect.gen(function* nodeEmailTransport(): Effect.fn.Return<
  EmailTransportRuntime,
  Config.ConfigError
> {
  const smtp = yield* smtpConfiguration;
  const provider = yield* configuredProvider;
  const testCapture = yield* testCaptureConfiguration;
  const configured = provider !== 'none' && smtp.host.trim() !== '';
  return {
    deliveryLayer: (from: string, recipient: string) => {
      if (Option.isSome(testCapture) && isTestRecipient(recipient)) {
        return SmtpEmailDeliveryLive({
          from,
          host: testCapture.value.host,
          port: testCapture.value.port,
          secure: false,
          timeoutMs: smtp.timeoutMs ?? 10_000,
        });
      }
      return SmtpEmailDeliveryLive({ ...smtp, from });
    },
    kind: 'smtp',
    provider: configured
      ? { configured: true, label: `SMTP server ${smtp.host}:${smtp.port}${smtp.port === 1025 ? ' (Mailpit)' : ''}` }
      : { configured: false, label: null },
  };
});
