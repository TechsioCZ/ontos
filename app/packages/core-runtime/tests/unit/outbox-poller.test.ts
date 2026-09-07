import { makeEffectTestCallback } from '@app/core-runtime/testing/effect-runtime';
import assert from 'node:assert/strict';
import test from 'node:test';
import { Effect, Fiber, Layer, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { defineOutboxWorker } from '../../src/outbox/definition.ts';
import { defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import { OutboxPersistenceError, OutboxPollerConfigError } from '../../src/outbox/errors.ts';
import { parseOutboxPollingConfig, runOutboxPollingLoop } from '../../src/outbox/poller.ts';
import type { OutboxCycleRunner } from '../../src/outbox/poller.ts';

const registration = defineOutboxWorker(
  {
    consumerModuleKey: 'consumer',
    entrypoint: defineTenantModuleEntrypoint({
      access: 'background',
      authorization: { kind: 'owner_local_background' },
      entrypointKey: 'consumer.logger',
      moduleKey: 'consumer',
      role: 'worker',
    }),
    leaseDurationMs: 30_000,
    payloadSchema: Schema.Struct({
      messageKey: Schema.String.pipe(Schema.brand('MessageKey')),
    }),
    producerModuleKey: 'producer',
    retryPolicy: {
      initialBackoffMs: 1000,
      maxAttempts: 5,
      maxBackoffMs: 60_000,
      multiplier: 2,
    },
    topic: 'producer.message-created',
    workerKey: 'consumer.logger',
  },
  () => Effect.void,
);

const emptyResult = {
  claimed: 0,
  dead: 0,
  deliveriesCreated: 0,
  failed: 0,
  messagesMatched: 0,
  retried: 0,
  succeeded: 0,
} as const;

void test(
  'uses safe one-second defaults and accepts bounded scalar overrides',
  makeEffectTestCallback(
    Effect.gen(function* validPollingConfiguration() {
      assert.deepEqual(
        yield* parseOutboxPollingConfig({
          defaultClaimOwner: 'consumer:default',
          environment: {},
        }),
        {
          claimOwner: 'consumer:default',
          maxDeliveries: 100,
          pollIntervalMs: 1000,
        },
      );

      assert.deepEqual(
        yield* parseOutboxPollingConfig({
          defaultClaimOwner: 'consumer:default',
          environment: {
            OUTBOX_WORKER_CLAIM_OWNER: 'consumer:configured',
            OUTBOX_WORKER_MAX_DELIVERIES: '25',
            OUTBOX_WORKER_POLL_INTERVAL_MS: '250',
          },
        }),
        {
          claimOwner: 'consumer:configured',
          maxDeliveries: 25,
          pollIntervalMs: 250,
        },
      );
    }),
  ),
);

void test(
  'rejects invalid polling values instead of falling back to a busy loop',
  makeEffectTestCallback(
    Effect.gen(function* invalidPollingConfiguration() {
      const error = yield* Effect.flip(
        parseOutboxPollingConfig({
          defaultClaimOwner: 'consumer:default',
          environment: { OUTBOX_WORKER_POLL_INTERVAL_MS: '0' },
        }),
      );
      assert.equal(Schema.is(OutboxPollerConfigError)(error), true);
    }),
  ),
);

void test(
  'runs immediately, survives a typed cycle failure, and continues polling',
  makeEffectTestCallback(
    Effect.gen(function* pollingWithTestClock() {
      const testClockServices = yield* Layer.build(TestClock.layer());
      return yield* Effect.gen(function* pollingContinuesAfterFailure() {
        let calls = 0;
        const healthTransitions: string[] = [];
        const runCycle: OutboxCycleRunner<typeof registration, never> = () =>
          Effect.suspend(() => {
            calls += 1;
            return calls === 1
              ? Effect.fail(
                  new OutboxPersistenceError({
                    code: 'outbox_persistence_failed',
                    reason: 'controlled test failure',
                  }),
                )
              : Effect.succeed(emptyResult);
          });
        const running = yield* runOutboxPollingLoop(
          {
            config: { claimOwner: 'consumer:test', maxDeliveries: 10, pollIntervalMs: 10 },
            health: {
              cycleFailed: Effect.sync(() => healthTransitions.push('failed')),
              cycleSucceeded: Effect.sync(() => healthTransitions.push('ready')),
            },
            registrations: [registration],
            subscriptions: [registration.descriptor],
          },
          runCycle,
        ).pipe(Effect.forkChild);

        yield* TestClock.adjust('20 millis');
        yield* Fiber.interrupt(running);
        assert.equal(calls, 3, 'polling loop did not continue');
        assert.deepEqual(healthTransitions, ['failed', 'ready', 'ready']);
      }).pipe(Effect.provide(testClockServices));
    }).pipe(Effect.scoped),
  ),
);
