import { env } from 'cloudflare:workers';
import { makeCloudflareEmailDelivery } from './cloudflare.ts';
import type { CloudflareEmailBinding } from './cloudflare.ts';
import type { EmailEnvironment, EmailTransportRuntime } from './transport-runtime.ts';

const bindings = env as unknown as Readonly<Record<string, unknown>>;
export const emailEnvironment: EmailEnvironment = Object.fromEntries(
  Object.entries(bindings).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
);
const binding = bindings['EMAIL'] as CloudflareEmailBinding | undefined;
const configured =
  typeof binding?.send === 'function' &&
  /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/u.test(emailEnvironment['ONTOS_EMAIL_FROM'] ?? '');

export const emailTransport: EmailTransportRuntime = {
  kind: 'cloudflare',
  provider: configured ? { configured: true, label: 'Cloudflare Email Service' } : { configured: false, label: null },
  makeDelivery: (from) => makeCloudflareEmailDelivery(binding, from),
};
