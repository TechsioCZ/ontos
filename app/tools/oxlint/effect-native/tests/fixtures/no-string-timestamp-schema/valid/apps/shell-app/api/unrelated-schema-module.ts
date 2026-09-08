// A `Schema` that comes from an unrelated module is not Effect's Schema.
import { Schema } from 'some-orm/schema-builder';

export const RowSchema = Schema.Struct({
  createdAt: Schema.String,
  expiresAt: Schema.NullOr(Schema.String),
});
