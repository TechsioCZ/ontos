import { Schema } from 'effect';

// Tests are in scope by default; this one is already Effect-native.
export const FixtureSchema = Schema.Struct({
  createdAt: Schema.DateTimeUtc,
  expiresAt: Schema.NullOr(Schema.DateTimeUtc),
});
