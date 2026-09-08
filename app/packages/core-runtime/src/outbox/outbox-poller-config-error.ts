import { Schema } from 'effect';

export class OutboxPollerConfigError extends Schema.TaggedError<OutboxPollerConfigError>()(
  'OutboxPollerConfigError',
  { code: Schema.Literal('outbox_poller_config_invalid'), reason: Schema.String },
) {}
