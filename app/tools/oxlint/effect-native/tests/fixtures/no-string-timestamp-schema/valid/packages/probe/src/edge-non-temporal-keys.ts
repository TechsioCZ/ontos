import { Schema } from 'effect';

// Keys that merely contain a temporal word but do not end in one.
export const Preferences = Schema.Struct({
  dateFormat: Schema.String,
  timeZone: Schema.String,
  formatName: Schema.String,
  season: Schema.String,
  comparison: Schema.String,
  location: Schema.String,
  attributes: Schema.String,
});

// Annotation payloads are ordinary data, not field bags.
export const Annotated = Schema.Struct({ createdAt: Schema.DateTimeUtc }).annotate({
  examples: [{ createdAt: '2024-01-01T00:00:00Z' }],
  default: { createdAt: 'unset' },
});

// A plain options object with the same keys is not a Schema field bag.
export const defaults = { createdAt: '', expiresAt: '' };
