// Blessed by the audit's "Existing patterns to preserve": outbox payloads and audit evidence carry
// `Schema.Json` as an *opaque payload field* inside a typed envelope, not as a document contract.
import { Schema } from 'effect';

export const OutboxMessage = Schema.Struct({
  headers: Schema.Record(Schema.String, Schema.Json),
  history: Schema.Array(Schema.Json),
  messageId: Schema.String,
  payloadJson: Schema.Json,
  trace: Schema.optional(Schema.Json),
});

export const NestedEnvelope = Schema.Struct({
  inner: Schema.Struct({ evidence: Schema.NullOr(Schema.Json) }),
});

export class OutboxDeliveryFailed extends Schema.TaggedError<OutboxDeliveryFailed>()(
  'OutboxDeliveryFailed',
  { evidencePayloadJson: Schema.optionalKey(Schema.Json), reason: Schema.String },
) {}

export const decodeOutboxMessage = Schema.decodeUnknownEffect(OutboxMessage);
