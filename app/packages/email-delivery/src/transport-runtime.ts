import type { EmailProviderView } from './dispatcher/contract.ts';
import type { EmailDeliveryServiceContract } from './server.ts';

export type EmailEnvironment = Readonly<Record<string, string | undefined>>;

/** Deployment seam: selects an adapter, never retries or falls back to another provider. */
export interface EmailTransportRuntime {
  readonly kind: 'cloudflare' | 'smtp';
  readonly provider: EmailProviderView;
  readonly makeDelivery: (from: string, recipient: string) => EmailDeliveryServiceContract;
}
