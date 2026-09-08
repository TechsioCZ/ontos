import { Schema } from 'effect';

import { TenantIdSchema } from './branded.ts';

const ModuleStatus = Schema.Literals(['installed', 'pending']);

// Imported identifier schemas own their brand in the declaring module; nothing to report here.
export const RowSchema = Schema.Struct({
  tenantId: TenantIdSchema,
  moduleId: ModuleStatus,
  attemptId: Schema.Number,
  revisionId: Schema.BigInt,
  payloadKey: Schema.Json,
  nestedId: Schema.Struct({ inner: Schema.String }),
  name: Schema.String,
  reason: Schema.String,
  createdAt: Schema.String,
  key: Schema.NullOr(Schema.Boolean),
});

// Outbox payloads keep Drizzle JSONB / Schema.Json exactly as the audit blesses them.
export const OutboxRowSchema = Schema.Struct({
  payload: Schema.Json,
  headerKey: Schema.Json,
});
