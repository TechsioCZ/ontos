import { Schema } from 'effect';
import type { Cause } from 'effect';

const reason = { reason: Schema.String } as const;

const OutboxWorkerDescriptorErrorContract = Schema.TaggedStruct('OutboxWorkerDescriptorError', {
  code: Schema.Literal('outbox_worker_descriptor_invalid'),
  ...reason,
});
type OutboxWorkerDescriptorErrorSelf = typeof OutboxWorkerDescriptorErrorContract.Type &
  Cause.YieldableError;
const OutboxWorkerDescriptorErrorValue = Schema.TaggedError<OutboxWorkerDescriptorErrorSelf>()(
  'OutboxWorkerDescriptorError',
  { code: Schema.Literal('outbox_worker_descriptor_invalid'), ...reason },
);
export type OutboxWorkerDescriptorError = InstanceType<typeof OutboxWorkerDescriptorErrorValue>;
export { OutboxWorkerDescriptorErrorValue as OutboxWorkerDescriptorError };

const OutboxPayloadDecodeErrorContract = Schema.TaggedStruct('OutboxPayloadDecodeError', {
  code: Schema.Literal('outbox_payload_invalid'),
  ...reason,
});
type OutboxPayloadDecodeErrorSelf = typeof OutboxPayloadDecodeErrorContract.Type &
  Cause.YieldableError;
const OutboxPayloadDecodeErrorValue = Schema.TaggedError<OutboxPayloadDecodeErrorSelf>()(
  'OutboxPayloadDecodeError',
  { code: Schema.Literal('outbox_payload_invalid'), ...reason },
);
export type OutboxPayloadDecodeError = InstanceType<typeof OutboxPayloadDecodeErrorValue>;
export { OutboxPayloadDecodeErrorValue as OutboxPayloadDecodeError };

const OutboxPersistenceErrorContract = Schema.TaggedStruct('OutboxPersistenceError', {
  code: Schema.Literal('outbox_persistence_failed'),
  ...reason,
});
type OutboxPersistenceErrorSelf = typeof OutboxPersistenceErrorContract.Type & Cause.YieldableError;
const OutboxPersistenceErrorValue = Schema.TaggedError<OutboxPersistenceErrorSelf>()(
  'OutboxPersistenceError',
  { code: Schema.Literal('outbox_persistence_failed'), ...reason },
);
export type OutboxPersistenceError = InstanceType<typeof OutboxPersistenceErrorValue>;
export { OutboxPersistenceErrorValue as OutboxPersistenceError };

const OutboxClaimLostErrorContract = Schema.TaggedStruct('OutboxClaimLostError', {
  code: Schema.Literal('outbox_claim_lost'),
  ...reason,
});
type OutboxClaimLostErrorSelf = typeof OutboxClaimLostErrorContract.Type & Cause.YieldableError;
const OutboxClaimLostErrorValue = Schema.TaggedError<OutboxClaimLostErrorSelf>()(
  'OutboxClaimLostError',
  { code: Schema.Literal('outbox_claim_lost'), ...reason },
);
export type OutboxClaimLostError = InstanceType<typeof OutboxClaimLostErrorValue>;
export { OutboxClaimLostErrorValue as OutboxClaimLostError };

const OutboxHandlerExecutionErrorContract = Schema.TaggedStruct('OutboxHandlerExecutionError', {
  code: Schema.Literal('outbox_handler_execution_failed'),
  ...reason,
});
type OutboxHandlerExecutionErrorSelf = typeof OutboxHandlerExecutionErrorContract.Type &
  Cause.YieldableError;
const OutboxHandlerExecutionErrorValue = Schema.TaggedError<OutboxHandlerExecutionErrorSelf>()(
  'OutboxHandlerExecutionError',
  { code: Schema.Literal('outbox_handler_execution_failed'), ...reason },
);
export type OutboxHandlerExecutionError = InstanceType<typeof OutboxHandlerExecutionErrorValue>;
export { OutboxHandlerExecutionErrorValue as OutboxHandlerExecutionError };

const OutboxPollerConfigErrorContract = Schema.TaggedStruct('OutboxPollerConfigError', {
  code: Schema.Literal('outbox_poller_config_invalid'),
  ...reason,
});
type OutboxPollerConfigErrorSelf = typeof OutboxPollerConfigErrorContract.Type &
  Cause.YieldableError;
const OutboxPollerConfigErrorValue = Schema.TaggedError<OutboxPollerConfigErrorSelf>()(
  'OutboxPollerConfigError',
  { code: Schema.Literal('outbox_poller_config_invalid'), ...reason },
);
export type OutboxPollerConfigError = InstanceType<typeof OutboxPollerConfigErrorValue>;
export { OutboxPollerConfigErrorValue as OutboxPollerConfigError };

const PERSISTENCE_CAUSE_PROPERTY = 'ontosOutboxPersistenceCause';

export const outboxPersistenceError = <FailureCause>(
  cause: FailureCause,
): OutboxPersistenceError => {
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
