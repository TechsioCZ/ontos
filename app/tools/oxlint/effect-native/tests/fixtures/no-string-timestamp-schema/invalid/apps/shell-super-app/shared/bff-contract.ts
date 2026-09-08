// expect-count: 3
import { HttpApiSchema, Schema } from '@modern-js/plugin-bff/effect-client';

// The BFF client re-exports Effect's Schema; 1 createdAt, 2 expiresAt, 3 occurredAt.
export const ApiKeyLifecycleResponseSchema = Schema.Struct({
  authBindingId: Schema.String.check(Schema.isUUID()),
  cleanupPending: Schema.Boolean,
  createdAt: Schema.String,
  expiresAt: Schema.NullOr(Schema.String),
  name: Schema.NullOr(Schema.String),
});

export const ShellTimelineEntrySchema = Schema.Struct({
  occurredAt: Schema.String,
  summary: Schema.String.check(Schema.isMinLength(1)),
});

export const empty = HttpApiSchema;
