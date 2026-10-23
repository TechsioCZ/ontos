import type { EmailProviderView } from './dispatcher/contract.ts';
import type { EmailDeliveryServiceContract } from './server.ts';

/** Runtime deployment settings. AKROS_INQUIRY_EMAIL_TO is a private Shell release setting, never browser configuration. */
export type EmailEnvironment = Readonly<Record<string, string | undefined>> & {
  /** Staff notification mailbox; unset means no inquiry e-mail is planned. No placeholder or recipient fallback. */
  readonly AKROS_INQUIRY_EMAIL_TO?: string;
};

/** Deployment seam: selects an adapter, never retries or falls back to another provider. */
export interface EmailTransportRuntime {
  readonly kind: 'cloudflare' | 'smtp';
  readonly provider: EmailProviderView;
  readonly makeDelivery: (from: string, recipient: string) => EmailDeliveryServiceContract;
}
