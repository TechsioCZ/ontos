// expect-count: 2
import { Schema } from 'effect';
const document = Schema.Record(Schema.String, Schema.Json);
export const readDocument = (value: Schema.Json): Schema.Json => {
  if (Schema.is(document)(value)) { return value; }
  return value;
};
