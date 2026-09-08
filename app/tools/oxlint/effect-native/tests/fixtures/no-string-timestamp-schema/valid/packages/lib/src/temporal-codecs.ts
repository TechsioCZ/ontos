import { Schema } from 'effect';

// The audit's own target shapes.
export const AuditSchema = Schema.Struct({
  createdAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtcFromDate,
  revokedAt: Schema.OptionFromNullOr(Schema.DateTimeUtc),
  expiresAt: Schema.NullOr(Schema.DateTimeUtc),
  occurredAt: Schema.DateTimeUtc.annotate({ description: 'occurred' }),
  attempts: Schema.Number,
  // Non-temporal keys keep plain strings.
  format: Schema.String,
  name: Schema.String,
  timeZoneName: Schema.String,
  reason: Schema.NullOr(Schema.String),
});

// An explicit date-only codec built from a dedicated combinator, not a regex over a string.
export const DateOnlySchema = Schema.DateTimeUtcFromDate;

export const OrderSchema = Schema.Struct({
  placedOn: DateOnlySchema,
  shippedAt: Schema.DateTimeUtc,
});

// A non-temporal regex check must not trip the hand-rolled-codec lane.
export const IcoSchema = Schema.String.check(Schema.isPattern(/^\d{8}$/u));
export const SlugSchema = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]*$/u));
