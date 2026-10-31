import { Data } from 'effect';

export class OAuthAuthenticationAuditUnavailable extends Data.TaggedError('OAuthAuthenticationAuditUnavailable')<{
  readonly cause: unknown;
  readonly reason: string;
}> {}
