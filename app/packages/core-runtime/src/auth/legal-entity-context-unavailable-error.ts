import { Data } from 'effect';

export class LegalEntityContextUnavailableError extends Data.TaggedError('LegalEntityContextUnavailableError')<{
  readonly cause?: unknown;
  readonly reason: string;
}> {}
