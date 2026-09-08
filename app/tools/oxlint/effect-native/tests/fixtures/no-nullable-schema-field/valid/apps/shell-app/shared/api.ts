import { HttpApiSchema, Schema } from '@modern-js/plugin-bff/effect-client';

// The audit blesses HttpApi-driven bodies and Drizzle JSONB; `OptionFromNullOr` keeps the wire form.
export const ApiKeyResponseSchema = Schema.Struct({
  expiresAt: Schema.OptionFromNullOr(Schema.String),
  payload: Schema.Json,
  empty: HttpApiSchema.Empty(204),
});
