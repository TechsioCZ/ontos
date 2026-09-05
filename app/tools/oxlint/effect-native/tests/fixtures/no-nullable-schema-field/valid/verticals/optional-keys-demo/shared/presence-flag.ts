import { Schema } from 'effect';

// `includeOptionalKeys: true` here, yet a single-literal presence flag stays valid.
export const IdentitySchema = Schema.Struct({
  impersonating: Schema.optionalKey(Schema.Literal(true)),
  legacyFlag: Schema.optional(Schema.Literal('yes')),
  nickname: Schema.OptionFromOptionalKey(Schema.String),
});
