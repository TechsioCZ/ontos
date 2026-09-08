import { Schema } from 'effect';

// Words that merely end in the letters "id"/"key" are not identifiers.
export const RowSchema = Schema.Struct({
  valid: Schema.Boolean,
  monkey: Schema.String,
  hybrid: Schema.String,
  uuid: Schema.String,
  overpaid: Schema.String,
  grid: Schema.String,
  key: Schema.String,
  identity: Schema.String,
});
