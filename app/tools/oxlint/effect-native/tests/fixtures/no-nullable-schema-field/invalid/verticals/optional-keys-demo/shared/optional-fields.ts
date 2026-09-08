// expect-count: 3
import { Schema } from 'effect';

// `includeOptionalKeys: true` in this directory (see .oxlintrc.json overrides).
export const ProfileSchema = Schema.Struct({
  nickname: Schema.optionalKey(Schema.String),
  bio: Schema.optional(Schema.String),
  status: Schema.optionalKey(Schema.Literals(['active', 'archived'])),
  impersonating: Schema.optionalKey(Schema.Literal(true)),
});
