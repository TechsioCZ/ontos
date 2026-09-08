// expect-count: 7
import { Schema } from 'effect';

// 1 createdAt, 2 revokedAt (NullOr), 3 expiresAt (optionalKey + check), 4 occurredAt (annotate)
export const ApiKeySchema = Schema.Struct({
  createdAt: Schema.String,
  revokedAt: Schema.NullOr(Schema.String),
  expiresAt: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1))),
  occurredAt: Schema.String.annotate({ description: 'emitted at' }),
  name: Schema.String,
  format: Schema.String,
  attempts: Schema.Number,
});

// 5 bindingCreatedAt inside a nested Struct field bag
export const BindingSchema = Schema.Struct({
  meta: Schema.Struct({
    bindingCreatedAt: Schema.NonEmptyString,
    bindingRevokedAt: Schema.DateTimeUtc,
  }),
});

// 6 dissolvedOn — a branded string is still a string, not a DateTime.Utc
export const CustomerSchema = Schema.Struct({
  dissolvedOn: Schema.String.pipe(Schema.brand('DissolvedOn')),
  legalFormCode: Schema.String,
});

// 7 validUntil through a spread field bag
const auditFields = {
  validUntil: Schema.Trim,
  actor: Schema.String,
};

export const AuditSchema = Schema.Struct({
  ...auditFields,
  reason: Schema.String,
});
