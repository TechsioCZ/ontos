import { Schema } from 'effect';

export class OAuthGrantRegistryUnavailable extends Schema.TaggedError<OAuthGrantRegistryUnavailable>()(
  'OAuthGrantRegistryUnavailable',
  { cause: Schema.Unknown },
) {}
