/* eslint-disable max-classes-per-file -- The typed Outbox runtime error union is intentionally co-located. */
import { Cause, Schema } from 'effect';

const reason = { reason: Schema.String } as const;

export class OutboxWorkerDescriptorError extends Schema.TaggedError<OutboxWorkerDescriptorError>()(
  'OutboxWorkerDescriptorError',
  { code: Schema.Literal('outbox_worker_descriptor_invalid'), ...reason },
) {}

export class OutboxPayloadDecodeError extends Schema.TaggedError<OutboxPayloadDecodeError>()(
  'OutboxPayloadDecodeError',
  { code: Schema.Literal('outbox_payload_invalid'), ...reason },
) {}

export class OutboxPersistenceError extends Schema.TaggedError<OutboxPersistenceError>()(
  'OutboxPersistenceError',
  { code: Schema.Literal('outbox_persistence_failed'), ...reason },
) {
  #persistenceCause: unknown = undefined;

  static withCause<FailureCause>(cause: FailureCause): OutboxPersistenceError {
    const failure = new OutboxPersistenceError({
      code: 'outbox_persistence_failed',
      reason: 'The Outbox Worker persistence operation failed',
    });
    failure.#persistenceCause = cause;
    return failure;
  }

  static getCause(failure: OutboxPersistenceError): Cause.Cause<never> | undefined {
    const cause = failure.#persistenceCause;
    return cause === undefined ? undefined : Cause.die(cause);
  }
}

export class OutboxClaimLostError extends Schema.TaggedError<OutboxClaimLostError>()(
  'OutboxClaimLostError',
  { code: Schema.Literal('outbox_claim_lost'), ...reason },
) {}

export class OutboxModuleStateError extends Schema.TaggedError<OutboxModuleStateError>()(
  'OutboxModuleStateError',
  { code: Schema.Literal('outbox_consumer_module_inactive'), ...reason },
) {}

export class OutboxHandlerExecutionError extends Schema.TaggedError<OutboxHandlerExecutionError>()(
  'OutboxHandlerExecutionError',
  { code: Schema.Literal('outbox_handler_execution_failed'), ...reason },
) {}

export class OutboxPollerConfigError extends Schema.TaggedError<OutboxPollerConfigError>()(
  'OutboxPollerConfigError',
  { code: Schema.Literal('outbox_poller_config_invalid'), ...reason },
) {}

export type OutboxWorkerError =
  | OutboxClaimLostError
  | OutboxHandlerExecutionError
  | OutboxModuleStateError
  | OutboxPayloadDecodeError
  | OutboxPollerConfigError
  | OutboxPersistenceError
  | OutboxWorkerDescriptorError;

export const outboxPersistenceError = <FailureCause>(cause: FailureCause): OutboxPersistenceError =>
  OutboxPersistenceError.withCause(cause);

export const getOutboxPersistenceCause = (
  failure: OutboxPersistenceError,
): Cause.Cause<never> | undefined => OutboxPersistenceError.getCause(failure);

export const sanitizeOutboxErrorMessage = (message: string): string =>
  message
    .replaceAll(/[\r\n\t]+/gu, ' ')
    .trim()
    .slice(0, 500) || 'Outbox Worker processing failed';
