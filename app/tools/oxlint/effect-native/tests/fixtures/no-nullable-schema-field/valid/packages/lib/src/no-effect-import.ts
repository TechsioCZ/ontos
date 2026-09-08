import { Schema } from 'some-other-library';

export const RowSchema = Schema.Struct({
  archivedAt: Schema.NullOr(Schema.String),
});
