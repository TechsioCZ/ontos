import { expect, it } from '@app/effect-rstest';
import { Effect, Schema, Predicate } from 'effect';
import {
  defineOutboxWorker,
  getOutboxWorkerHandler,
  retryBackoffMs,
  validateOutboxWorkerRegistrations,
  validateOutboxWorkerSubscriptions,
} from '../../src/outbox/definition.ts';
import { defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import { OutboxWorkerDescriptorError } from '../../src/outbox/errors.ts';

const MessageKey = Schema.String.pipe(Schema.brand('MessageKey'));
const payloadSchema = Schema.Struct({ messageKey: MessageKey });
const makeWorker = (workerKey = 'consumer.message-logger') =>
  defineOutboxWorker(
    {
      consumerModuleKey: 'consumer',
      entrypoint: defineTenantModuleEntrypoint({
        access: 'background',
        authorization: { kind: 'owner_local_background' },
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
    (payload) => Effect.sync(() => expect(Predicate.isString(payload.messageKey)).toBe(true)),
  );
it.effect('defines an exact immutable registration while keeping the handler opaque', () =>
  Effect.gen(function* immutableRegistration() {
    const worker = makeWorker();
    expect(worker.descriptor).toEqual({
      consumerModuleKey: 'consumer',
      entrypoint: {
        access: 'background',
        authorization: { kind: 'owner_local_background' },
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
    expect(Object.isFrozen(worker)).toBe(true);
    expect(Object.isFrozen(worker.descriptor)).toBe(true);
    expect(Object.isFrozen(worker.descriptor.retryPolicy)).toBe(true);
    expect('handler' in worker).toBe(false);
    expect(Object.keys(worker)).toEqual(['descriptor']);
    const payload = yield* Schema.decodeUnknownEffect(payloadSchema)({ messageKey: 'message-1' });
    yield* getOutboxWorkerHandler(worker)(payload, {
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
    });
  }),
);
it.effect('preserves schema inference for a typed handler payload', () =>
  Effect.sync(() => {
    defineOutboxWorker(
      {
        consumerModuleKey: 'consumer',
        entrypoint: defineTenantModuleEntrypoint({
          access: 'background',
          authorization: { kind: 'owner_local_background' },
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
        return Effect.sync(() => expect(key).toBe(payload.messageKey));
      },
    );
  }),
);
it.effect('rejects invalid identities, retry policies, and lease policies', () =>
  Effect.sync(() => {
    const valid = makeWorker().descriptor;
    const invalidDescriptors = [
      { ...valid, workerKey: 'producer.foreign-worker' },
      {
        ...valid,
        entrypoint: defineTenantModuleEntrypoint({
          access: 'background',
          authorization: { kind: 'owner_local_background' },
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
      expect(() => defineOutboxWorker(descriptor, () => Effect.void)).toThrow(
        OutboxWorkerDescriptorError,
      );
    }
  }),
);
it.effect('rejects duplicate worker keys and calculates bounded exponential backoff', () =>
  Effect.sync(() => {
    const worker = makeWorker();
    expect(() => validateOutboxWorkerRegistrations([worker, worker])).toThrow(
      expect.objectContaining({
        name: 'OutboxWorkerDescriptorError',
        reason: expect.stringMatching(/duplicate Outbox Worker key/u),
      }),
    );
    expect(validateOutboxWorkerRegistrations([worker])).toEqual([worker]);
    expect(retryBackoffMs(worker.descriptor.retryPolicy, 1)).toBe(1000);
    expect(retryBackoffMs(worker.descriptor.retryPolicy, 3)).toBe(4000);
    expect(retryBackoffMs(worker.descriptor.retryPolicy, 10)).toBe(10_000);
  }),
);
it.effect('validates and freezes the schema-free installed subscription catalog', () =>
  Effect.sync(() => {
    const worker = makeWorker();
    const subscription = {
      consumerModuleKey: worker.descriptor.consumerModuleKey,
      entrypoint: worker.descriptor.entrypoint,
      producerModuleKey: worker.descriptor.producerModuleKey,
      topic: worker.descriptor.topic,
      workerKey: worker.descriptor.workerKey,
    };
    const validated = validateOutboxWorkerSubscriptions([subscription]);
    expect(validated).toEqual([subscription]);
    expect(Object.isFrozen(validated)).toBe(true);
    expect(Object.isFrozen(validated[0])).toBe(true);
    expect(() => validateOutboxWorkerSubscriptions([subscription, subscription])).toThrow(
      expect.objectContaining({
        name: 'OutboxWorkerDescriptorError',
        reason: expect.stringMatching(/duplicate Outbox Worker key/u),
      }),
    );
  }),
);
