// Credential-shaped names whose Schema value is not an unstructured string.
import { Schema } from 'effect';

export const ProviderSchema = Schema.Struct({
  apiKey: Schema.Literals(['rotating', 'static']),
  credential: Schema.Union([Schema.Number, Schema.Boolean]),
  password: Schema.Struct({ algorithm: Schema.String, hash: Schema.String }),
  secret: Schema.Number,
});
