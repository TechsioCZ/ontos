// expect-count: 2
// Evasion: `mentionsRedacted` is a raw substring test over the whole value subtree, so any
// annotation, brand or comment-free string containing "Redacted" disables the check on a
// field that is still a plain `Schema.String`.
import { Schema } from 'effect';

export const ProviderRecordSchema = Schema.Struct({
  clientSecret: Schema.String.annotate({ description: 'Redacted downstream' }),
  displayName: Schema.String,
  password: Schema.String.check(Schema.isMinLength(8)).annotate({ title: 'Redacted' }),
});
