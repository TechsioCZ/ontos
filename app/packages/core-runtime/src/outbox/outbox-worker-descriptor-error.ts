import { Schema } from 'effect';

export class OutboxWorkerDescriptorError extends Schema.TaggedError<OutboxWorkerDescriptorError>()(
  'OutboxWorkerDescriptorError',
  {
    code: Schema.Literal('outbox_worker_descriptor_invalid'),
    reason: Schema.String,
  },
) {}
