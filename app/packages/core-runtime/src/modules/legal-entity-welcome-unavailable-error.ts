import { Data } from 'effect';

export class LegalEntityWelcomeUnavailableError extends Data.TaggedError('LegalEntityWelcomeUnavailableError')<{
  readonly cause?: unknown;
  readonly code: 'legal_entity_welcome_unavailable';
  readonly reason: string;
}> {}
