import { ConfigProvider, Context, Effect, Option } from 'effect';
import type { Config } from 'effect';

import {
  CloudflareEmailApiDeliveryLive,
  cloudflareEmailApiConfiguration,
  isCloudflareEmailApiConfigured,
} from './cloudflare-api.ts';
import { isTestRecipient, testCaptureConfiguration } from './dispatcher/recipients.ts';
import { SmtpEmailDeliveryLive, smtpConfiguration } from './smtp.ts';
import { configuredProvider, emailSettings } from './transport-runtime.ts';
import type { EmailEnvironment, EmailTransportRuntime } from './transport-runtime.ts';

// Keep an explicitly supplied request provider. The native environment fallback must not erase explicit blank values.
const deployment = Effect.context().pipe(
  Effect.map(
    (context) =>
      Context.getOrUndefined(context, ConfigProvider.ConfigProvider) ??
      ConfigProvider.fromEnv({ preserveEmptyStrings: true }),
  ),
);

export const emailEnvironment: Effect.Effect<EmailEnvironment, Effect.Error<typeof emailSettings>> = deployment.pipe(
  Effect.flatMap((provider) => emailSettings.parse(provider)),
);

export const emailTransport = Effect.gen(function* nodeEmailTransport(): Effect.fn.Return<
  EmailTransportRuntime,
  Config.ConfigError
> {
  const configuration = yield* deployment;
  const [smtp, cloudflareApi, provider, testCapture] = yield* Effect.all(
    [
      smtpConfiguration.parse(configuration),
      cloudflareEmailApiConfiguration.parse(configuration),
      configuredProvider.parse(configuration),
      testCaptureConfiguration.pipe(Effect.provideContext(Context.make(ConfigProvider.ConfigProvider, configuration))),
    ],
    { concurrency: 1 },
  );
  if (provider === 'cloudflare-api') {
    const configured = isCloudflareEmailApiConfigured(cloudflareApi);
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
        return CloudflareEmailApiDeliveryLive({ ...cloudflareApi, from });
      },
      kind: 'cloudflare-api',
      provider: configured
        ? { configured: true, label: 'Cloudflare Email Service API' }
        : { configured: false, label: null },
    };
  }
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
