import { Data } from 'effect';

/** Internal persistence failure; public transports map it to their own sanitized error contract. */
export class OAuthCredentialsUnavailable extends Data.TaggedError('OAuthCredentialsUnavailable')<{
  readonly cause: unknown;
}> {}
