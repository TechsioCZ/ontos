// expect-count: 4
// The BFF barrel re-exports `effect/Schema` verbatim; every shared contract imports Schema this way.
import { HttpApiSchema, Schema } from '@modern-js/plugin-bff/effect-client';

export const ApiKeyLifecycleResponseSchema = Schema.Struct({
  expiresAt: Schema.NullOr(Schema.String),
  name: Schema.NullOr(Schema.String),
  start: Schema.NullishOr(Schema.String),
});

export const ApiKeyListResponseSchema = Schema.Struct({
  key: Schema.NullOr(ApiKeyLifecycleResponseSchema),
  status: HttpApiSchema.Empty(204),
});
