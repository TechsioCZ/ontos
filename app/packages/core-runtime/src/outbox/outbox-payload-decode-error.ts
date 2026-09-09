import { Schema } from 'effect';

export class OutboxPayloadDecodeError extends Schema.TaggedError<OutboxPayloadDecodeError>()(
  'OutboxPayloadDecodeError',
  { code: Schema.Literal('outbox_payload_invalid'), reason: Schema.String },
) {}
