import { env } from 'cloudflare:workers';
import { ConfigProvider, Effect, Schema } from 'effect';
import type { Config } from 'effect';

import { CloudflareEmailBindingSchema, CloudflareEmailDeliveryLive } from './cloudflare.ts';
import { configuredProvider, emailSettings } from './transport-runtime.ts';
import type { EmailTransportRuntime } from './transport-runtime.ts';

const deployment = Effect.sync(() => ConfigProvider.fromUnknown(env, { preserveEmptyStrings: true }));
export const emailEnvironment = deployment.pipe(Effect.flatMap((provider) => emailSettings.parse(provider)));

export const emailTransport = Effect.gen(function* workerEmailTransport(): Effect.fn.Return<
  EmailTransportRuntime,
  Config.ConfigError
> {
  const configuration = yield* deployment;
  const { environment, provider } = yield* Effect.all(
    { environment: emailSettings.parse(configuration), provider: configuredProvider.parse(configuration) },
    { concurrency: 1 },
  );
  const configured =
    provider !== 'none' &&
    Schema.is(CloudflareEmailBindingSchema)(env.EMAIL) &&
    /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/u.test(environment.ONTOS_EMAIL_FROM ?? '');
  return {
    deliveryLayer: (from: string) => CloudflareEmailDeliveryLive(env.EMAIL, from),
    kind: 'cloudflare',
    provider: configured ? { configured: true, label: 'Cloudflare Email Service' } : { configured: false, label: null },
  };
});
