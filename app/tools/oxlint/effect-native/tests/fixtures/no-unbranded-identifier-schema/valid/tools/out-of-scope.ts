import { Schema } from 'effect';

// `tools/**` is outside the rule's default `include` scope, so nothing is reported.
export const ToolingSchema = Schema.Struct({
  tenantId: Schema.String,
  moduleId: Schema.String,
});
