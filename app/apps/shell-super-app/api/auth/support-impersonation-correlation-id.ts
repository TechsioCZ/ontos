import { Context } from 'effect';

export class SupportImpersonationCorrelationId extends Context.Reference<string>(
  '@app/shell-super-app/api/auth/support-impersonation-correlation-id/SupportImpersonationCorrelationId',
  { defaultValue: () => 'missing' }
) {}
