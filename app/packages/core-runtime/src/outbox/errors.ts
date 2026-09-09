import { Schema } from 'effect';

export { OutboxClaimLostError } from './outbox-claim-lost-error.ts';
export { OutboxHandlerExecutionError } from './outbox-handler-execution-error.ts';
export { OutboxPayloadDecodeError } from './outbox-payload-decode-error.ts';
export { OutboxPollerConfigError } from './outbox-poller-config-error.ts';
export { OutboxWorkerDescriptorError } from './outbox-worker-descriptor-error.ts';

export class OutboxPersistenceError extends Schema.TaggedError<OutboxPersistenceError>()('OutboxPersistenceError', {
  code: Schema.Literal('outbox_persistence_failed'),
  reason: Schema.String,
}) {}

const PERSISTENCE_CAUSE_PROPERTY = 'ontosOutboxPersistenceCause';

export const outboxPersistenceError = <FailureCause>(cause: FailureCause): OutboxPersistenceError => {
  const failure = new OutboxPersistenceError({
    code: 'outbox_persistence_failed',
    reason: 'The Outbox Worker persistence operation failed',
  });
  Object.defineProperty(failure, PERSISTENCE_CAUSE_PROPERTY, { value: cause });
  return failure;
};

export const sanitizeOutboxErrorMessage = (message: string): string =>
  message
    .replaceAll(/[\r\n\t]+/gu, ' ')
    .trim()
    .slice(0, 500) || 'Outbox Worker processing failed';
