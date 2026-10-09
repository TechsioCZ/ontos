import { Data } from 'effect';

export class SystemPrincipalContextInvalidError extends Data.TaggedError('SystemPrincipalContextInvalidError')<{
  readonly cause?: unknown;
  readonly code: 'system_principal_context_invalid';
  readonly reason: string;
}> {}
