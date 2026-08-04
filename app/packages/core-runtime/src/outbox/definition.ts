import type { Effect, Schema } from 'effect';
import { OutboxWorkerDescriptorError } from './errors.ts';

const outboxWorkerRegistration: unique symbol = Symbol(
  '@app/core-runtime/outbox/worker-registration',
);
const outboxWorkerHandlers = new WeakMap<object, OutboxWorkerHandler<unknown, unknown, unknown>>();

export interface OutboxWorkerRetryPolicy {
  readonly initialBackoffMs: number;
  readonly maxAttempts: number;
  readonly maxBackoffMs: number;
  readonly multiplier: number;
}

export interface OutboxWorkerHandlerContext {
  readonly attemptNumber: number;
  readonly claimId: string;
  readonly correlationId?: string;
  readonly deliveryId: string;
  readonly domainEventId: string;
  readonly messageId: string;
  readonly producerModuleKey: string;
  readonly tenantId: string;
  readonly tenantSequenceNo: bigint;
  readonly topic: string;
  readonly workerKey: string;
}

export interface OutboxWorkerDescriptor<
  PayloadSchema extends Schema.ConstraintDecoder<unknown, never>,
  Consumer extends string,
  Producer extends string,
> {
  readonly consumerModuleKey: Consumer;
  readonly leaseDurationMs: number;
  readonly payloadSchema: PayloadSchema;
  readonly producerModuleKey: Producer;
  readonly retryPolicy: OutboxWorkerRetryPolicy;
  readonly topic: string;
  readonly workerKey: string;
}

export type OutboxWorkerSubscription = Readonly<
  Pick<
    OutboxWorkerDescriptor<Schema.ConstraintDecoder<unknown, never>, string, string>,
    'consumerModuleKey' | 'producerModuleKey' | 'topic' | 'workerKey'
  >
>;

export type OutboxWorkerHandler<Payload, Error, Requirements = never> = (
  payload: Payload,
  context: OutboxWorkerHandlerContext,
) => Effect.Effect<void, Error, Requirements>;

export interface OutboxWorkerRegistration<
  PayloadSchema extends Schema.ConstraintDecoder<unknown, never>,
  Consumer extends string,
  Producer extends string,
  HandlerError,
  HandlerRequirements = never,
> {
  readonly [outboxWorkerRegistration]: true;
  readonly descriptor: Readonly<OutboxWorkerDescriptor<PayloadSchema, Consumer, Producer>>;
  readonly _handlerError?: HandlerError;
  readonly _handlerRequirements?: HandlerRequirements;
}

export type AnyOutboxWorkerRegistration = OutboxWorkerRegistration<
  Schema.ConstraintDecoder<unknown, never>,
  string,
  string,
  unknown,
  unknown
>;

export type OutboxWorkerRequirements<Registration extends AnyOutboxWorkerRegistration> =
  Registration extends OutboxWorkerRegistration<
    Schema.ConstraintDecoder<unknown, never>,
    string,
    string,
    unknown,
    infer Requirements
  >
    ? Requirements
    : never;

type OutboxWorkerHandlerError<Registration extends AnyOutboxWorkerRegistration> =
  Registration extends OutboxWorkerRegistration<
    Schema.ConstraintDecoder<unknown, never>,
    string,
    string,
    infer HandlerError,
    unknown
  >
    ? HandlerError
    : unknown;

const moduleKeyPattern = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u;
const workerSlugPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const topicPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*)+$/u;

const descriptorError = (reason: string): OutboxWorkerDescriptorError =>
  new OutboxWorkerDescriptorError({ code: 'outbox_worker_descriptor_invalid', reason });

const assertFiniteInteger = (
  value: number,
  minimum: number,
  maximum: number,
  label: string,
): void => {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw descriptorError(`${label} must be an integer from ${minimum} through ${maximum}`);
  }
};

export const defineOutboxWorker = <
  PayloadSchema extends Schema.ConstraintDecoder<unknown, never>,
  const Consumer extends string,
  const Producer extends string,
  HandlerError,
  HandlerRequirements,
>(
  descriptor: OutboxWorkerDescriptor<PayloadSchema, Consumer, Producer>,
  handler: OutboxWorkerHandler<PayloadSchema['Type'], HandlerError, HandlerRequirements>,
): OutboxWorkerRegistration<
  PayloadSchema,
  Consumer,
  Producer,
  HandlerError,
  HandlerRequirements
> => {
  if (!moduleKeyPattern.test(descriptor.consumerModuleKey)) {
    throw descriptorError('consumerModuleKey must be a stable module key');
  }
  if (!moduleKeyPattern.test(descriptor.producerModuleKey)) {
    throw descriptorError('producerModuleKey must be a stable module key');
  }
  if (!topicPattern.test(descriptor.topic)) {
    throw descriptorError('topic must be an exact lowercase dot-separated identifier');
  }
  const expectedWorkerPrefix = `${descriptor.consumerModuleKey}.`;
  const workerSlug = descriptor.workerKey.slice(expectedWorkerPrefix.length);
  if (
    !descriptor.workerKey.startsWith(expectedWorkerPrefix) ||
    !workerSlugPattern.test(workerSlug)
  ) {
    throw descriptorError(
      'workerKey must be owned by consumerModuleKey and end in lower-kebab-case',
    );
  }
  assertFiniteInteger(descriptor.leaseDurationMs, 1000, 3_600_000, 'leaseDurationMs');
  assertFiniteInteger(descriptor.retryPolicy.maxAttempts, 1, 100, 'retryPolicy.maxAttempts');
  assertFiniteInteger(
    descriptor.retryPolicy.initialBackoffMs,
    0,
    86_400_000,
    'retryPolicy.initialBackoffMs',
  );
  assertFiniteInteger(
    descriptor.retryPolicy.maxBackoffMs,
    descriptor.retryPolicy.initialBackoffMs,
    86_400_000,
    'retryPolicy.maxBackoffMs',
  );
  if (
    !Number.isFinite(descriptor.retryPolicy.multiplier) ||
    descriptor.retryPolicy.multiplier < 1 ||
    descriptor.retryPolicy.multiplier > 100
  ) {
    throw descriptorError('retryPolicy.multiplier must be a finite number from 1 through 100');
  }
  if (typeof handler !== 'function') {
    throw descriptorError('handler must be an Effect function');
  }

  const registration = Object.freeze({
    [outboxWorkerRegistration]: true as const,
    descriptor: Object.freeze({
      ...descriptor,
      retryPolicy: Object.freeze({ ...descriptor.retryPolicy }),
    }),
  });
  outboxWorkerHandlers.set(registration, handler as OutboxWorkerHandler<unknown, unknown, unknown>);
  return registration;
};

export const validateOutboxWorkerRegistrations = <Registration extends AnyOutboxWorkerRegistration>(
  registrations: readonly Registration[],
): readonly Registration[] => {
  const workerKeys = new Set<string>();
  for (const registration of registrations) {
    if (registration[outboxWorkerRegistration] !== true || !Object.isFrozen(registration)) {
      throw descriptorError('every Outbox Worker must be created by defineOutboxWorker');
    }
    const { workerKey } = registration.descriptor;
    if (workerKeys.has(workerKey)) {
      throw descriptorError(`duplicate Outbox Worker key ${workerKey}`);
    }
    workerKeys.add(workerKey);
  }
  return Object.freeze([...registrations]);
};

export const validateOutboxWorkerSubscriptions = (
  subscriptions: readonly OutboxWorkerSubscription[],
): readonly OutboxWorkerSubscription[] => {
  const workerKeys = new Set<string>();
  for (const subscription of subscriptions) {
    if (!moduleKeyPattern.test(subscription.consumerModuleKey)) {
      throw descriptorError('consumerModuleKey must be a stable module key');
    }
    if (!moduleKeyPattern.test(subscription.producerModuleKey)) {
      throw descriptorError('producerModuleKey must be a stable module key');
    }
    if (!topicPattern.test(subscription.topic)) {
      throw descriptorError('topic must be an exact lowercase dot-separated identifier');
    }
    const expectedWorkerPrefix = `${subscription.consumerModuleKey}.`;
    const workerSlug = subscription.workerKey.slice(expectedWorkerPrefix.length);
    if (
      !subscription.workerKey.startsWith(expectedWorkerPrefix) ||
      !workerSlugPattern.test(workerSlug)
    ) {
      throw descriptorError(
        'workerKey must be owned by consumerModuleKey and end in lower-kebab-case',
      );
    }
    if (workerKeys.has(subscription.workerKey)) {
      throw descriptorError(`duplicate Outbox Worker key ${subscription.workerKey}`);
    }
    workerKeys.add(subscription.workerKey);
  }
  return Object.freeze(subscriptions.map((subscription) => Object.freeze({ ...subscription })));
};

/** Internal Core seam. Worker handlers are absent from public registrations. */
export const getOutboxWorkerHandler = <Registration extends AnyOutboxWorkerRegistration>(
  registration: Registration,
): OutboxWorkerHandler<
  unknown,
  OutboxWorkerHandlerError<Registration>,
  OutboxWorkerRequirements<Registration>
> => {
  const handler = outboxWorkerHandlers.get(registration);
  if (handler === undefined) {
    throw descriptorError('Outbox Worker registration was not created by defineOutboxWorker');
  }
  return handler as OutboxWorkerHandler<
    unknown,
    OutboxWorkerHandlerError<Registration>,
    OutboxWorkerRequirements<Registration>
  >;
};

export const retryBackoffMs = (
  policy: OutboxWorkerRetryPolicy,
  completedAttempts: number,
): number =>
  Math.min(
    policy.maxBackoffMs,
    Math.round(policy.initialBackoffMs * policy.multiplier ** Math.max(0, completedAttempts - 1)),
  );
