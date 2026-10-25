import { Schema } from 'effect';

export class OAuthCredentialsUnavailable extends Schema.TaggedError<OAuthCredentialsUnavailable>()(
  'OAuthCredentialsUnavailable',
  { cause: Schema.Unknown },
) {}
