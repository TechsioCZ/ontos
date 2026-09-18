import { Schema } from 'effect';

export class EmailDeliveryInvalidMessage extends Schema.TaggedError<EmailDeliveryInvalidMessage>()(
  'EmailDeliveryInvalidMessage',
  {
    field: Schema.Literals(['from', 'html', 'idempotencyKey', 'subject', 'text', 'to']),
    reason: Schema.Literals(['control_character', 'empty', 'invalid_format', 'too_long']),
  },
) {}
