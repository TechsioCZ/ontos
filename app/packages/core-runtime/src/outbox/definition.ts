import { Predicate } from 'effect';
import type { Effect, Schema } from 'effect';
import { OutboxWorkerDescriptorError } from './errors.ts';
import type { TenantModuleEntrypoint } from '../modules/module-entrypoint.ts';

const outboxWorkerRegistration: unique symbol = Symbol(
  '@app/core-runtime/outbox/worker-registration',
);
const outboxWorkerHandler: unique symbol = Symbol(
  '@app/core-runtime/outbox/worker-registration/handler',
);

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

const verifiedHandlerContexts = new WeakSet<OutboxWorkerHandlerContext>();

/** Core-private construction seam: caller-created context objects are not trusted worker claims. */
export const attestOutboxWorkerHandlerContext = (
  context: OutboxWorkerHandlerContext,
): OutboxWorkerHandlerContext => {
  const verified = Object.freeze({ ...context });
  verifiedHandlerContexts.add(verified);
  return verified;
};

export const isVerifiedOutboxWorkerHandlerContext = (
  context: OutboxWorkerHandlerContext,
): boolean => verifiedHandlerContexts.has(context);

export interface OutboxWorkerDescriptor<
  PayloadSchema extends Schema.ConstraintDecoder<unknown>,
  Consumer extends string,
  Producer extends string,
> {
  readonly consumerModuleKey: Consumer;
  readonly entrypoint: TenantModuleEntrypoint<'worker', 'background', Consumer>;
  readonly leaseDurationMs: number;
  readonly payloadSchema: PayloadSchema;
  readonly producerModuleKey: Producer;
  readonly retryPolicy: OutboxWorkerRetryPolicy;
  readonly topic: string;
  readonly workerKey: string;
}

export type OutboxWorkerSubscription = Readonly<
  Pick<
    OutboxWorkerDescriptor<Schema.ConstraintDecoder<unknown>, string, string>,
    'consumerModuleKey' | 'entrypoint' | 'producerModuleKey' | 'topic' | 'workerKey'
  >
>;

export type OutboxWorkerHandler<Payload, Error, Requirements = never> = (
  payload: Payload,
  context: OutboxWorkerHandlerContext,
) => Effect.Effect<void, Error, Requirements>;

declare class OutboxWorkerHandlerVariance<Payload, Error, Requirements> {
  invoke(
    payload: Payload,
    context: OutboxWorkerHandlerContext,
  ): Effect.Effect<void, Error, Requirements>;
}

type BivariantOutboxWorkerHandler<Payload, Error, Requirements> = OutboxWorkerHandlerVariance<
  Payload,
  Error,
  Requirements
>['invoke'];

export interface OutboxWorkerRegistration<
  PayloadSchema extends Schema.ConstraintDecoder<unknown>,
  Consumer extends string,
  Producer extends string,
  HandlerError,
  HandlerRequirements = never,
> {
  readonly _handlerError?: HandlerError;
  readonly _handlerRequirements?: HandlerRequirements;
  readonly descriptor: Readonly<OutboxWorkerDescriptor<PayloadSchema, Consumer, Producer>>;
  readonly [outboxWorkerHandler]: BivariantOutboxWorkerHandler<
    PayloadSchema['Type'],
    HandlerError,
    HandlerRequirements
  >;
  readonly [outboxWorkerRegistration]: true;
}

export type AnyOutboxWorkerRegistration = OutboxWorkerRegistration<
  Schema.ConstraintDecoder<unknown>,
  string,
  string,
  unknown,
  unknown
>;

/** Derive the schema-free deployment catalog without importing an owner's unrelated entrypoints. */
export const extractOutboxWorkerSubscriptions = (
  registrations: readonly AnyOutboxWorkerRegistration[],
): readonly OutboxWorkerSubscription[] =>
  Object.freeze(
    registrations
      .map(({ descriptor }) =>
        Object.freeze({
          consumerModuleKey: descriptor.consumerModuleKey,
          entrypoint: descriptor.entrypoint,
          producerModuleKey: descriptor.producerModuleKey,
          topic: descriptor.topic,
          workerKey: descriptor.workerKey,
        }),
      )
      .toSorted((left, right) => left.workerKey.localeCompare(right.workerKey)),
  );

export type OutboxWorkerRequirements<Registration extends AnyOutboxWorkerRegistration> =
  Registration extends OutboxWorkerRegistration<
    Schema.ConstraintDecoder<unknown>,
    string,
    string,
    unknown,
    infer Requirements
  >
    ? Requirements
    : never;

type OutboxWorkerHandlerError<Registration extends AnyOutboxWorkerRegistration> =
  Registration extends OutboxWorkerRegistration<
    Schema.ConstraintDecoder<unknown>,
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
  PayloadSchema extends Schema.ConstraintDecoder<unknown>,
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
  if (
    descriptor.entrypoint.scope !== 'tenant' ||
    descriptor.entrypoint.role !== 'worker' ||
    descriptor.entrypoint.access !== 'background' ||
    descriptor.entrypoint.moduleKey !== descriptor.consumerModuleKey ||
    descriptor.entrypoint.entrypointKey !== descriptor.workerKey ||
    !Object.isFrozen(descriptor.entrypoint)
  ) {
    throw descriptorError(
      'Worker entrypoint must be an immutable tenant worker/background descriptor owned by consumerModuleKey',
    );
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
  if (!Predicate.isFunction(handler)) {
    throw descriptorError('handler must be an Effect function');
  }

  const registration = Object.freeze({
    descriptor: Object.freeze({
      ...descriptor,
      entrypoint: descriptor.entrypoint,
      retryPolicy: Object.freeze({ ...descriptor.retryPolicy }),
    }),
    [outboxWorkerHandler]: handler,
    [outboxWorkerRegistration]: true as const,
  });
  return registration;
};

export const validateOutboxWorkerRegistrations = <Registration extends AnyOutboxWorkerRegistration>(
  registrations: readonly Registration[],
): readonly Registration[] => {
  const workerKeys = new Set<string>();
  for (const registration of registrations) {
    if (!registration[outboxWorkerRegistration] || !Object.isFrozen(registration)) {
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
    if (
      subscription.entrypoint.scope !== 'tenant' ||
      subscription.entrypoint.role !== 'worker' ||
      subscription.entrypoint.access !== 'background' ||
      subscription.entrypoint.moduleKey !== subscription.consumerModuleKey ||
      subscription.entrypoint.entrypointKey !== subscription.workerKey ||
      !Object.isFrozen(subscription.entrypoint)
    ) {
      throw descriptorError(
        'installed Worker entrypoint is inconsistent with its subscription owner',
      );
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
export function getOutboxWorkerHandler<Registration extends AnyOutboxWorkerRegistration>(
  registration: Registration,
): OutboxWorkerHandler<
  Registration['descriptor']['payloadSchema']['Type'],
  OutboxWorkerHandlerError<Registration>,
  OutboxWorkerRequirements<Registration>
>;
export function getOutboxWorkerHandler(registration: AnyOutboxWorkerRegistration) {
  return registration[outboxWorkerHandler];
}

export const retryBackoffMs = (
  policy: OutboxWorkerRetryPolicy,
  completedAttempts: number,
): number =>
  Math.min(
    policy.maxBackoffMs,
    Math.round(policy.initialBackoffMs * policy.multiplier ** Math.max(0, completedAttempts - 1)),
  );
