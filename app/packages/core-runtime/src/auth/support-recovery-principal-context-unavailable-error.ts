import { Data } from 'effect';

export class SupportRecoveryPrincipalContextUnavailableError extends Data.TaggedError(
  'SupportRecoveryPrincipalContextUnavailableError',
)<{
  readonly cause?: unknown;
  readonly code: 'support_recovery_context_unavailable';
  readonly reason: string;
}> {}
