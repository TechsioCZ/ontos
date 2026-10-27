import { env } from 'cloudflare:workers';
import { ConfigProvider, Effect, Schema } from 'effect';
import type { Config } from 'effect';

import { CloudflareEmailBindingSchema, CloudflareEmailDeliveryLive } from './cloudflare.ts';
import { configuredProvider, emailSettings } from './transport-runtime.ts';
import type { EmailTransportRuntime } from './transport-runtime.ts';

const deployment = ConfigProvider.fromUnknown(env);
export const emailEnvironment = emailSettings.parse(deployment);

export const emailTransport = Effect.gen(function* workerEmailTransport(): Effect.fn.Return<
  EmailTransportRuntime,
  Config.ConfigError
> {
  const environment = yield* emailEnvironment;
  const provider = yield* configuredProvider.parse(deployment);
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
