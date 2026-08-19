import assert from 'node:assert/strict';
// @effect-diagnostics anyUnknownInErrorContext:off asyncFunction:off
/* eslint-disable promise/prefer-await-to-callbacks -- Node assertions intentionally receive synchronous callbacks. */
import test from 'node:test';
import { Effect, Schema, Predicate } from 'effect';
import {
  defineOutboxWorker,
  getOutboxWorkerHandler,
  retryBackoffMs,
  validateOutboxWorkerRegistrations,
  validateOutboxWorkerSubscriptions,
} from '../../src/outbox/definition.ts';
import { defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';

const payloadSchema = Schema.Struct({ messageKey: Schema.String });

const makeWorker = (workerKey = 'consumer.message-logger') =>
  defineOutboxWorker(
    {
      consumerModuleKey: 'consumer',
      entrypoint: defineTenantModuleEntrypoint({
        access: 'background',
        entrypointKey: workerKey,
        moduleKey: 'consumer',
        role: 'worker',
      }),
      leaseDurationMs: 30_000,
      payloadSchema,
      producerModuleKey: 'producer',
      retryPolicy: {
        initialBackoffMs: 1000,
        maxAttempts: 5,
        maxBackoffMs: 10_000,
        multiplier: 2,
      },
      topic: 'producer.message-created',
      workerKey,
    },
    (payload) => Effect.sync(() => assert.equal(Predicate.isString(payload.messageKey), true)),
  );

test('defines an exact immutable registration while keeping the handler opaque', async () => {
  const worker = makeWorker();

  assert.deepEqual(worker.descriptor, {
    consumerModuleKey: 'consumer',
    entrypoint: {
      access: 'background',
      entrypointKey: 'consumer.message-logger',
      moduleKey: 'consumer',
      role: 'worker',
      scope: 'tenant',
    },
    leaseDurationMs: 30_000,
    payloadSchema,
    producerModuleKey: 'producer',
    retryPolicy: {
      initialBackoffMs: 1000,
      maxAttempts: 5,
      maxBackoffMs: 10_000,
      multiplier: 2,
    },
    topic: 'producer.message-created',
    workerKey: 'consumer.message-logger',
  });
  assert.equal(Object.isFrozen(worker), true);
  assert.equal(Object.isFrozen(worker.descriptor), true);
  assert.equal(Object.isFrozen(worker.descriptor.retryPolicy), true);
  assert.equal('handler' in worker, false);
  assert.deepEqual(Object.keys(worker), ['descriptor']);

  await Effect.runPromise(
    getOutboxWorkerHandler(worker)(
      { messageKey: 'message-1' },
      {
        attemptNumber: 1,
        claimId: 'claim-1',
        deliveryId: 'delivery-1',
        domainEventId: 'event-1',
        messageId: 'message-1',
        producerModuleKey: 'producer',
        tenantId: 'tenant-1',
        tenantSequenceNo: 1n,
        topic: 'producer.message-created',
        workerKey: 'consumer.message-logger',
      },
    ),
  );
});

test('preserves schema inference for a typed handler payload', () => {
  defineOutboxWorker(
    {
      consumerModuleKey: 'consumer',
      entrypoint: defineTenantModuleEntrypoint({
        access: 'background',
        entrypointKey: 'consumer.inference-proof',
        moduleKey: 'consumer',
        role: 'worker',
      }),
      leaseDurationMs: 1000,
      payloadSchema,
      producerModuleKey: 'producer',
      retryPolicy: {
        initialBackoffMs: 0,
        maxAttempts: 1,
        maxBackoffMs: 0,
        multiplier: 1,
      },
      topic: 'producer.message-created',
      workerKey: 'consumer.inference-proof',
    },
    (payload) => {
      const key: string = payload.messageKey;
      return Effect.sync(() => assert.equal(key, payload.messageKey));
    },
  );
});

test('rejects invalid identities, retry policies, and lease policies', () => {
  const valid = makeWorker().descriptor;
  const invalidDescriptors = [
    { ...valid, workerKey: 'producer.foreign-worker' },
    {
      ...valid,
      entrypoint: defineTenantModuleEntrypoint({
        access: 'background',
        entrypointKey: valid.workerKey,
        moduleKey: 'foreign',
        role: 'worker',
      }),
    },
    { ...valid, topic: 'Invalid' },
    { ...valid, leaseDurationMs: 999 },
    { ...valid, retryPolicy: { ...valid.retryPolicy, maxAttempts: 0 } },
    {
      ...valid,
      retryPolicy: { ...valid.retryPolicy, initialBackoffMs: 11_000 },
    },
    { ...valid, retryPolicy: { ...valid.retryPolicy, multiplier: 0 } },
  ];

  for (const descriptor of invalidDescriptors) {
    assert.throws(
      () => defineOutboxWorker(descriptor, () => Effect.void),
      (error: { readonly _tag?: string }) => error._tag === 'OutboxWorkerDescriptorError',
    );
  }
});

test('rejects duplicate worker keys and calculates bounded exponential backoff', () => {
  const worker = makeWorker();
  assert.throws(
    () => validateOutboxWorkerRegistrations([worker, worker]),
    (error: { readonly reason?: string }) =>
      /duplicate Outbox Worker key/u.test(error.reason ?? ''),
  );
  assert.deepEqual(validateOutboxWorkerRegistrations([worker]), [worker]);
  assert.equal(retryBackoffMs(worker.descriptor.retryPolicy, 1), 1000);
  assert.equal(retryBackoffMs(worker.descriptor.retryPolicy, 3), 4000);
  assert.equal(retryBackoffMs(worker.descriptor.retryPolicy, 10), 10_000);
});

test('validates and freezes the schema-free installed subscription catalog', () => {
  const worker = makeWorker();
  const subscription = {
    consumerModuleKey: worker.descriptor.consumerModuleKey,
    entrypoint: worker.descriptor.entrypoint,
    producerModuleKey: worker.descriptor.producerModuleKey,
    topic: worker.descriptor.topic,
    workerKey: worker.descriptor.workerKey,
  };
  const validated = validateOutboxWorkerSubscriptions([subscription]);
  assert.deepEqual(validated, [subscription]);
  assert.equal(Object.isFrozen(validated), true);
  assert.equal(Object.isFrozen(validated[0]), true);
  assert.throws(
    () => validateOutboxWorkerSubscriptions([subscription, subscription]),
    (error: { readonly reason?: string }) =>
      /duplicate Outbox Worker key/u.test(error.reason ?? ''),
  );
});
