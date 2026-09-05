// expect-count: 7
import { Schema } from 'effect';

// 1 tenantId, 2 principalId (checked UUID), 3 legalEntityId (NullOr), 4 moduleId (optionalKey)
export const IdentitySchema = Schema.Struct({
  tenantId: Schema.String,
  principalId: Schema.String.check(Schema.isUUID()),
  legalEntityId: Schema.NullOr(Schema.String),
  moduleId: Schema.optionalKey(Schema.String.check(Schema.isMinLength(3))),
  displayName: Schema.String,
  createdAt: Schema.String,
});

// 5 idempotencyKey inside a nested Struct field bag
export const RequestSchema = Schema.Struct({
  meta: Schema.Struct({
    idempotencyKey: Schema.NonEmptyString,
    attempt: Schema.Number,
  }),
});

// 6 actionId via annotate chain, 7 deploymentId via Schema.Array
export const AuditSchema = Schema.Struct({
  actionId: Schema.String.annotate({ description: 'action' }),
  deploymentId: Schema.Array(Schema.Trim),
  status: Schema.Literals(['ok', 'failed']),
});
