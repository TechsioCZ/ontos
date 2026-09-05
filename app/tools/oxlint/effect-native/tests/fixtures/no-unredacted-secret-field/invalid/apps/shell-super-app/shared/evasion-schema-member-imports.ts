// expect-count: 3
// Evasion: import the Schema *members* rather than the namespace. `collectEffectBindings` already
// records `SchemaString -> String`, but `isStringSchema` only ever asks `resolveMember`, which
// requires a MemberExpression, so a bare identifier schema is invisible.
import { NonEmptyString, optional, String as SchemaString, Struct } from 'effect/Schema';

export const SignInPayloadSchema = Struct({
  email: SchemaString,
  password: SchemaString,
  preSharedKey: NonEmptyString,
  refreshToken: optional(SchemaString),
});
