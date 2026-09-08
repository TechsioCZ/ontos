import { Schema } from 'effect';

// Optional keys are allowed by default (`includeOptionalKeys: false`).
export const IdentitySchema = Schema.Struct({
  impersonating: Schema.optionalKey(Schema.Literal(true)),
  displayName: Schema.String,
  note: Schema.optional(Schema.String),
  status: Schema.optionalKey(Schema.Literals(['active', 'archived'])),
});

// Literal arguments are values, never schemas.
export const ModeSchema = Schema.Literals(['read', 'write']);
export const FlagSchema = Schema.Literal(true);
