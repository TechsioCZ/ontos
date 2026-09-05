// expect-count: 6
import { Schema } from 'effect';

const uuid = Schema.String.check(Schema.isUUID());

// 1 revokedAt, 2 nextOffset (pagination), 3 authBindingId, 4 bindingStatus (closed vocabulary)
export const PrincipalRowSchema = Schema.Struct({
  revokedAt: Schema.NullOr(Schema.String),
  nextOffset: Schema.NullOr(Schema.Finite),
  authBindingId: Schema.NullOr(uuid),
  bindingStatus: Schema.NullOr(Schema.Literals(['active', 'disabled', 'revoked'])),
  principalId: uuid,
});

// 5 a shared nullable schema const is the same decode, shared by every consumer
export const RevokedAtSchema = Schema.NullOr(Schema.String);

// 6 nested struct field
export const PageSchema = Schema.Struct({
  page: Schema.Struct({
    cursor: Schema.UndefinedOr(Schema.String),
  }),
});
