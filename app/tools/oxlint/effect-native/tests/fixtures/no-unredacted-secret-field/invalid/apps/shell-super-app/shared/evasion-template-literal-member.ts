// expect-count: 1
// Evasion: `memberName` accepts `Schema["String"]` but not the equivalent template form.
import { Schema } from 'effect';

export const CredentialSchema = Schema.Struct({
  secret: Schema[`String`],
});
