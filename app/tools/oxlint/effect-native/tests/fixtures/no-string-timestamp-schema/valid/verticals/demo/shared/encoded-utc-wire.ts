import { Schema } from 'effect';

// A JSON view of the temporal codec deliberately retains its transport representation.
export const UtcWire = Schema.toEncoded(Schema.DateTimeUtcFromString).check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u),
);
