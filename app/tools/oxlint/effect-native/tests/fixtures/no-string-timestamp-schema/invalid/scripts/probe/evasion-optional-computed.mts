// expect-count: 4
// Optional chaining, computed access, `as`/`satisfies` wrappers and a top-level await around the
// constructor are all syntax noise, not a different anti-pattern.
import * as Schema from 'effect/Schema';

// 1 optional chaining on both the constructor and the leaf
export const TokenSchema = Schema?.Struct({
  issuedAt: Schema?.String,
});

export const KeySchema = Schema.Struct({
  // 2 computed access behind a double cast
  rotatedAt: Schema['String'] as unknown as typeof Schema.String,
  // 3 `satisfies` around a wrapped string
  expiresAt: Schema.NullOr(Schema.String) satisfies unknown,
} as const);

// 4 the field bag is built inside a top-level await
export const settled = await Promise.resolve(Schema.Struct({ settledAt: Schema.NonEmptyString }));
