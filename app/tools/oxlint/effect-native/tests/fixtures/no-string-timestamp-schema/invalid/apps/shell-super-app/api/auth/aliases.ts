// expect-count: 4
import * as Effect from 'effect';
import * as S from 'effect/Schema';
import { pipe } from 'effect';

// 1 issuedAt via submodule namespace import
export const TokenSchema = S.Struct({
  issuedAt: S.String,
  subject: S.String,
});

// 2 rotatedAt via the effect barrel (`Effect.Schema.Struct`)
export const KeySchema = Effect.Schema.Struct({
  rotatedAt: Effect.Schema['String'],
  material: Effect.Schema.String,
});

// 3 notBefore via point-free pipe
export const WindowSchema = S.Struct({
  notBefore: pipe(S.String, S.annotate({ description: 'nbf' })),
});

// 4 the hand-rolled timestamp codec, via a directly imported `isPattern`
export const IssuedAtSchema = S.String.check(S.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u));
