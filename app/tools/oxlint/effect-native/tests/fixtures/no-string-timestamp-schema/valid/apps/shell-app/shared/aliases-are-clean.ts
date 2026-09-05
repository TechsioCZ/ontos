import * as Effect from 'effect';
import * as S from 'effect/Schema';

// Alias + barrel forms that are already temporal.
export const TokenSchema = S.Struct({
  issuedAt: S.DateTimeUtc,
  subject: S.String,
});

export const KeySchema = Effect.Schema.Struct({
  rotatedAt: Effect.Schema.DateTimeUtc,
  material: Effect.Schema.String,
});
