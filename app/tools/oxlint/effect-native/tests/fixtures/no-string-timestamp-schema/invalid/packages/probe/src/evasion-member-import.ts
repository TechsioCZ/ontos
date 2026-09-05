// expect-count: 3
// Evasion: the field-bag constructor and the string leaf are imported directly, so no `Schema.`
// member expression ever appears. Same anti-pattern, one import statement away.
import { NonEmptyString, NullOr, String as SchemaString, Struct } from 'effect/Schema';

export const ApiKeySchema = Struct({
  // 1 createdAt
  createdAt: SchemaString,
  // 2 revokedAt through a transparent wrapper
  revokedAt: NullOr(SchemaString),
  // 3 expiresAt
  expiresAt: NonEmptyString,
  name: SchemaString,
});
