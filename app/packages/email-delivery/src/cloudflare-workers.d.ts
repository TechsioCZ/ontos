declare module 'cloudflare:workers' {
  import type { CloudflareEmailBinding, EmailEnvironmentInput } from '@app/email-delivery/transport';

  export const env: EmailEnvironmentInput & {
    readonly EMAIL?: CloudflareEmailBinding;
  };
}
