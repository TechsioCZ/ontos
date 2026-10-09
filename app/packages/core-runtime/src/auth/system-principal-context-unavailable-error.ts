import { Data } from 'effect';

export class SystemPrincipalContextUnavailableError extends Data.TaggedError('SystemPrincipalContextUnavailableError')<{
  readonly cause?: unknown;
  readonly code: 'system_principal_context_unavailable';
  readonly reason: string;
}> {}
